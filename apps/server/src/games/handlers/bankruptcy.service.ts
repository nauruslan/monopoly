import { Injectable, BadRequestException, ForbiddenException } from "@nestjs/common";
import type { GameState, Player } from "@monopoly/shared";

/**
 * Обработчик банкротства игрока.
 *
 * ## Правила Монополии
 *
 * Игрок считается банкротом, если его `money < 0` (ушёл в минус из-за
 * штрафа/ренты/покупки) И при этом у него нечем покрыть долг — то есть
 * после ликвидации ВСЕХ домов/отелей и залога ВСЕХ клеток у него всё
 * равно не хватает денег.
 *
 * Жизненный цикл:
 *  1) Срабатывает триггер (оплата ренты/налога/покупка/штраф), и баланс
 *     уходит в минус.
 *  2) `GamesService.startBankruptcyProcedure` переводит партию в фазу
 *     `BANKRUPTCY_LIQUIDATE` и кладёт контекст долга в `state.bankruptcy`.
 *  3) Игрок (или бот) поэтапно ликвидирует имущество: продаёт дома
 *     (BANKRUPTCY_LIQUIDATE_HOUSES) → закладывает клетки (BANKRUPTCY_MORTGAGE).
 *  4) После каждой ликвидации сервер ПЕРЕСЧИТЫВАЕТ остаток долга:
 *     если `money >= debt` → долг погашен, игра возвращается в
 *     `BUILDING` (игрок продолжает ход);
 *     если нечем крыть → `BANKRUPTCY_CONFIRM` / `BANKRUPTCY_DECLARE` →
 *     финальная ликвидация, `player.isBankrupt = true`, клетки уходят
 *     кредитору или в банк.
 *
 * ## Распределение имущества
 *
 *  - Если есть кредитор (другой игрок, которому не смог заплатить) —
 *    ВСЕ клетки и оставшиеся деньги переходят ему.
 *  - Если кредитора нет (банк, налоги) — клетки уходят обратно в банк
 *    (ownerId = undefined), деньги сгорают.
 *  - В ЛЮБОМ случае `player.isBankrupt = true`, деньги обнуляются.
 *
 * ## ВАЖНО
 *
 *  Мы НЕ удаляем игрока из `state.players` через `filter`, потому что
 *  это сдвигает `currentPlayerIndex`. Обанкротившийся игрок остаётся в
 *  массиве с `isBankrupt = true` и пропускается в `advanceToNextPlayer`.
 *
 *  Если в партии остался ровно один НЕ обанкротившийся игрок — партия
 *  завершается, и его id становится `state.winnerId`.
 */
@Injectable()
export class BankruptcyService {
  /**
   * Вычислить максимальную ликвидность, которую игрок может получить,
   * продав ВСЕ дома/отели и заложив ВСЕ клетки.
   *
   * Используется:
   *  - В `GamesService.startBankruptcyProcedure` для проверки «а есть
   *    ли вообще смысл переводить партию в `BANKRUPTCY_LIQUIDATE`,
   *    или сразу объявлять банкротство».
   *  - В `BotService.decideBankruptcy` для оценки «что ещё можно
   *    продать».
   *
   * Возвращает сумму в рублях, которую можно выручить:
   *  - Продажа дома/отеля: `housePrice / 2` за каждый дом (по правилам
   *    Монополии).
   *  - Залог клетки: `mortgageValue` (если `mortgageValue > 0`).
   *
   * ВНИМАНИЕ: при залоге клетки с домами её нельзя заложить, пока
   * не проданы дома в её цветовой группе. Но для оценки «потолка
   * ликвидности» это ограничение опускаем — мы возвращаем МАКСИМАЛЬНУЮ
   * теоретическую сумму, а реальную ликвидность с учётом правил лесенки
   * считает `BotService.decideBankruptcy` (он продаёт дома с самой
   * «нагруженной» клетки).
   */
  computeMaxLiquidity(state: GameState, player: Player): number {
    let total = 0;
    for (const cell of state.board) {
      if (cell.ownerId !== player.id) continue;
      // Дома/отели — можно продать за половину цены.
      // (для отеля `houses === 5` — продаётся как отель, возврат = housePrice).
      if ((cell.houses ?? 0) > 0 && cell.housePrice !== undefined) {
        total += cell.houses * Math.floor(cell.housePrice / 2);
      }
      // Клетка: для оценки «потолка ликвидности» берём максимум из
      //   - залог: mortgageValue (50%)
      //   - продажа Банку: cell.price (100% номинала)
      let cellLiq = 0;
      if (!cell.isMortgaged && (cell.mortgageValue ?? 0) > 0) {
        cellLiq = Math.max(cellLiq, cell.mortgageValue ?? 0);
      }
      if (!cell.isMortgaged && (cell.price ?? 0) > 0) {
        cellLiq = Math.max(cellLiq, cell.price ?? 0);
      }
      total += cellLiq;
    }
    return total;
  }

  /**
   * Может ли игрок продать клетку Банку за 100% номинала.
   * Правила:
   *  1. Клетка принадлежит игроку.
   *  2. На самой клетке нет построек.
   *  3. Клетка не заложена.
   *  4. В её цветовой группе нет других клеток с домами.
   */
  canSellPropertyToBank(state: GameState, player: Player, cellId: number): boolean {
    const cell = state.board[cellId];
    if (!cell) return false;
    if (cell.ownerId !== player.id) return false;
    if ((cell.houses ?? 0) > 0) return false;
    if (cell.isMortgaged) return false;
    if ((cell.price ?? 0) <= 0) return false;
    if (cell.group) {
      const groupHasHouses = state.board.some(
        (c) =>
          c.type === cell.type &&
          c.group === cell.group &&
          c.ownerId === player.id &&
          (c.houses ?? 0) > 0 &&
          c.id !== cellId,
      );
      if (groupHasHouses) return false;
    }
    return true;
  }

  /**
   * Продать клетку Банку за 100% номинала (правило ТЗ).
   *  - player.money += cell.price
   *  - cell.ownerId = undefined, isMortgaged = false, houses = 0
   *  - player.properties очищается от cellId
   */
  sellPropertyToBank(state: GameState, player: Player, cellId: number): number {
    const cell = state.board[cellId];
    if (!cell) throw new BadRequestException(`Клетка ${cellId} не найдена`);
    if (cell.ownerId !== player.id) throw new ForbiddenException("Это не ваша клетка");
    if ((cell.price ?? 0) <= 0) throw new BadRequestException("Нет номинальной цены");
    if (!this.canSellPropertyToBank(state, player, cellId)) {
      throw new ForbiddenException("Невозможно продать (проверьте дома и залог)");
    }
    const price = cell.price!;
    player.money += price;
    cell.ownerId = undefined;
    cell.isMortgaged = false;
    cell.houses = 0;
    player.properties = player.properties.filter((id) => id !== cellId);
    return price;
  }

  /**
   * Проверить, может ли игрок покрыть долг за счёт ликвидности.
   *
   * Возвращает:
   *  - `true`  — после полной ликвидации имущества (`player.money` +
   *               `computeMaxLiquidity`) долг покрывается;
   *  - `false` — даже после полной ликвидации денег не хватит,
   *               нужно сразу объявлять банкротство.
   *
   * Используется в `GamesService.startBankruptcyProcedure` для решения:
   * переводить ли партию в `BANKRUPTCY_LIQUIDATE` (даём шанс
   * продать/заложить), или сразу вызывать `handle()` (банкрот).
   */
  canCoverDebt(state: GameState, player: Player, debt: number): boolean {
    const total = Math.max(0, player.money) + this.computeMaxLiquidity(state, player);
    return total >= debt;
  }

  /**
   * Обработать полное банкротство `player` (финальная ликвидация).
   *
   * @param state полное состояние партии (мутируется)
   * @param player обанкротившийся игрок (мутируется)
   * @param creditor кредитор, либо null (банк)
   */
  handle(state: GameState, player: Player, creditor: Player | null): void {
    // 1) Перераспределяем собственность.
    for (const pid of player.properties) {
      const cell = state.board[pid];
      if (!cell) continue;
      if (creditor) {
        cell.ownerId = creditor.id;
        creditor.properties.push(pid);
      } else {
        // Клетка уходит в банк: снимаем владельца, дома и залог.
        cell.ownerId = undefined;
        cell.houses = 0;
        cell.isMortgaged = false;
      }
    }

    // 2) Деньги — либо кредитору, либо сгорают.
    if (creditor) {
      // `Math.max(0, ...)` — защита от отрицательного остатка;
      // мы списываем только реально имеющиеся деньги.
      creditor.money += Math.max(0, player.money);
    }
    // Очищаем имущество игрока.
    player.properties = [];
    player.money = 0;

    // 3) Помечаем банкротом. Сам объект остаётся в state.players —
    // его будут пропускать при `endTurn` и в `applyAction`.
    player.isBankrupt = true;

    // 4) Проверка условия победы.
    const alivePlayers = state.players.filter((p) => !p.isBankrupt);
    if (alivePlayers.length === 1 && alivePlayers[0]) {
      state.status = "finished";
      state.winnerId = alivePlayers[0].id;
    }
  }
}
