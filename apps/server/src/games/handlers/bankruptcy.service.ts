import { Injectable, BadRequestException, ForbiddenException } from "@nestjs/common";
import type { Cell, GameState, Player } from "@monopoly/shared";

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
 *  1) Срабатывает триггер (оплата ренты/налога/покупки/штраф), и баланс
 *     уходит в минус.
 *  2) `GamesService.startBankruptcyProcedure` переводит партию в фазу
 *     `BANKRUPTCY_LIQUIDATE` и кладёт контекст долга в `state.bankruptcy`.
 *  3) Игрок (или бот) поэтапно ликвидирует имущество: продаёт дома
 *     (BANKRUPTCY_LIQUIDATE_HOUSES) → закладывает клетки (BANKRUPTCY_MORTGAGE)
 *     → при необходимости продаёт уже заложенные клетки Банку за
 *     дополнительные 50% (BANKRUPTCY_SELL_MORTGAGED_PROPERTY).
 *  4) После каждой ликвидации сервер ПЕРЕСЧИТЫВАЕТ остаток долга:
 *     если `money >= debt` → долг погашен, игра возвращается в
 *     `BUILDING` (игрок продолжает ход);
 *     если нечем крыть → `BANKRUPTCY_CONFIRM` / `BANKRUPTCY_DECLARE` →
 *     финальная ликвидация, `player.isBankrupt = true`, клетки уходят
 *     кредитору или в банк.
 *
 * ## Правило «лесенки» (чётности) при ликвидации
 *
 * ВНИМАНИЕ: при ликвидации (BANKRUPTCY_LIQUIDATE) действует ТО ЖЕ
 * правило лесенки, что и при добровольной продаже (BuildService.canSell):
 *
 *  - Можно продать дом только с той клетки, у которой `houses >= houses`
 *    любой другой клетки той же цветовой группы. То есть сначала
 *    сносятся дома с «передовых» (самых застроенных) клеток группы.
 *  - Это покрывает и дома, и отели: если все участки = 5, то любой
 *    из них — максимум, и его можно снести. После продажи (5 → 4)
 *    получается [4, 5, 5], в которой новые максимумы (5) снова можно
 *    снести. И так далее — никакого дедлока.
 *  - Эта проверка симметрична `BuildService.canSell` (фаза BUILDING):
 *    ликвидация — это, по сути, форсированная продажа домов, и
 *    правила Монополии для неё те же, что и для добровольной.
 *
 * Раньше правило лесенки НЕ применялось в фазе ликвидации, что
 * позволяло игроку (или боту) продать, например, 3 дома с одной
 * клетки группы, оставив на двух других 3 дома на каждой. Это
 * нарушало правила Монополии: разница между клетками одной группы
 * должна быть не больше 1.
 *
 * ## Распределение имущества
 *
 *  - ВСЕ клетки обанкротившегося игрока уходят обратно в БАНК:
 *    `ownerId = undefined`, `isMortgaged = false`, `houses = 0`.
 *    Это касается ЛЮБОГО случая — и когда есть кредитор (другой игрок),
 *    и когда кредитора нет (налог/штраф Банку).
 *  - Строения (дома/отели) снимаются и просто теряются — Банк не
 *    компенсирует за них.
 *  - Если есть кредитор и `debt > 0` — Банк компенсирует кредитору
 *    разницу `(debt - player.money)` (но не больше, чем `debt`, и не
 *    больше того, что фактически у банкрота осталось). Это правило
 *    означает, что кредитор гарантированно получает причитающийся ему
 *    долг, даже если имущества банкрота не хватило.
 *  - Оставшиеся деньги банкрота (если есть) — сгорают.
 *  - В ЛЮБОМ случае `player.isBankrupt = true`, `money = 0`,
 *    `properties = []`.
 *  - Если кредитора нет — деньги и имущество просто уходят в Банк.
 *
 * при банкротстве имущество
 * должно становиться НИЧЕЙНЫМ и СВОБОДНЫМ для покупки.
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
   * ПРАВИЛО ЛЕСЕНКИ ПРИ ЛИКВИДАЦИИ ДОМОВ
   * Может ли игрок продать дом/отель на указанной клетке в фазе
   * ликвидации (BANKRUPTCY_LIQUIDATE) с учётом правила лесенки.
   *
   * Правила:
   *  1. Клетка принадлежит игроку.
   *  2. Клетка — PROPERTY (не RAILROAD/UTILITY) — дома бывают только на PROPERTY.
   *  3. Клетка НЕ заложена (на заложенной не может быть домов по правилам).
   *  4. На клетке есть хотя бы один дом (`houses > 0`).
   *  5. **Правило лесенки:** `cell.houses >= max(houses по другим клеткам
   *     группы)`. То есть сначала сносятся дома с самой «нагруженной»
   *     клетки группы. Это симметрично `BuildService.canSell` для
   *     добровольной продажи и `BuildService.canBuild` для строительства.
   *
   * Правило лесенки здесь нужно для согласованности с правилами
   * Монополии: разница между клетками одной цветовой группы не может
   * быть больше 1. Без этой проверки игрок мог бы «слить» все дома с
   * одной клетки, оставив остальные застроенными — это нарушение правил.
   *
   * @returns `true`, если дом с этой клетки можно продать прямо сейчас.
   */
  canSellHouseForLiquidation(state: GameState, player: Player, cellId: number): boolean {
    const cell = state.board[cellId];
    if (!cell) return false;
    if (cell.ownerId !== player.id) return false;
    if (cell.type !== "PROPERTY") return false;
    if (cell.isMortgaged) return false;
    if ((cell.houses ?? 0) === 0) return false;
    if (cell.housePrice === undefined) return false;

    // Правило лесенки: можно продать только с клетки, у которой houses
    // НЕ МЕНЬШЕ, чем у любой другой клетки этой группы (т.е. это
    // «передовая» клетка с максимальным числом домов). Это симметрично
    // BuildService.canSell и работает И для домов, И для отелей
    // (houses === 5): все три клетки [5,5,5] — максимумы, и с любой
    // можно снести; после сноса [4,5,5] — новые максимумы (5) снова
    // доступны, и т.д. Никакого дедлока.
    if (cell.group) {
      const groupCells = state.board.filter(
        (c) => c.type === "PROPERTY" && c.group === cell.group && c.ownerId === player.id,
      );
      const maxHouses = Math.max(...groupCells.map((c) => c.houses ?? 0));
      if ((cell.houses ?? 0) < maxHouses) {
        return false;
      }
    }
    return true;
  }

  /**
   * Список клеток игрока, с которых МОЖНО продать дом в фазе ликвидации
   * (с учётом правила лесенки). Используется UI (BankruptcyModal) и
   * ботом (`BotService.decideBankruptcy`) для подсветки доступных
   * клеток и выбора оптимальной.
   *
   * Сортировка: сначала самые дорогие дома (максимальный возврат за
   * один шаг), как и в боте.
   */
  listHousesSellableForLiquidation(state: GameState, player: Player): Cell[] {
    return state.board
      .filter((c) => this.canSellHouseForLiquidation(state, player, c.id))
      .sort((a, b) => (b.housePrice ?? 0) - (a.housePrice ?? 0));
  }

  /**
   * Вычислить максимальную ликвидность, которую игрок может получить,
   * продав ВСЕ дома/отели и заложив/допродав ВСЕ клетки.
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
   *  - Клетка (если не заложена): берём максимум из
   *      - залог: `mortgageValue` (50%)
   *      - продажа Банку: `cell.price` (100% номинала)
   *  - Клетка (если уже заложена): допродажа Банку за `mortgageValue`
   *    (дополнительные 50%). В сумме с предыдущим залогом получается
   *    100% номинала.
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
      //   - залог: mortgageValue (50%) — только если клетка ещё не заложена
      //   - продажа Банку: cell.price (100% номинала) — только если клетка не заложена
      //   - допродажа уже заложенной клетки: mortgageValue (дополнительные 50%)
      let cellLiq = 0;
      if (!cell.isMortgaged && (cell.mortgageValue ?? 0) > 0) {
        cellLiq = Math.max(cellLiq, cell.mortgageValue ?? 0);
      }
      if (!cell.isMortgaged && (cell.price ?? 0) > 0) {
        cellLiq = Math.max(cellLiq, cell.price ?? 0);
      }
      if (cell.isMortgaged && (cell.mortgageValue ?? 0) > 0) {
        // Допродажа уже заложенной клетки Банку (50% mortgageValue).
        // Считаем, что игрок сначала уже получил 50% при залоге, теперь
        // может «допродать» её Банку за оставшиеся 50% (mortgageValue).
        cellLiq = Math.max(cellLiq, cell.mortgageValue ?? 0);
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
   * Продать клетку Банку за 100% номинала.
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
   * Может ли игрок продать уже заложенную клетку Банку за дополнительные
   * 50% (`mortgageValue`).
   *
   * В сумме с предыдущим залогом (50% номинала) игрок получает 100%
   * номинала — клетка уходит в банк (UNOWNED, не заложена, без построек).
   *
   * Правила:
   *  1. Клетка принадлежит игроку.
   *  2. Клетка заложена (`isMortgaged === true`).
   *  3. `mortgageValue > 0` (иначе нечего платить).
   *  4. На самой клетке нет построек (на заложенной клетке их и так
   *     быть не может по правилам, но проверим для устойчивости).
   */
  canSellMortgagedPropertyToBank(state: GameState, player: Player, cellId: number): boolean {
    const cell = state.board[cellId];
    if (!cell) return false;
    if (cell.ownerId !== player.id) return false;
    if (!cell.isMortgaged) return false;
    if ((cell.houses ?? 0) > 0) return false;
    if ((cell.mortgageValue ?? 0) <= 0) return false;
    return true;
  }

  /**
   * Продать уже заложенную клетку Банку за дополнительные 50%
   * (`mortgageValue`).
   *
   * ВАЖНО: это допустимо ТОЛЬКО во время ликвидации (BANKRUPTCY_LIQUIDATE).
   * В обычном ходу Монополия не разрешает «допродать» заложенную клетку
   * Банку — её можно только выкупить обратно за 110% mortgageValue.
   *
   * После продажи:
   *  - player.money += cell.mortgageValue
   *  - cell.ownerId = undefined, isMortgaged = false, houses = 0
   *  - player.properties очищается от cellId
   */
  sellMortgagedPropertyToBank(state: GameState, player: Player, cellId: number): number {
    const cell = state.board[cellId];
    if (!cell) throw new BadRequestException(`Клетка ${cellId} не найдена`);
    if (cell.ownerId !== player.id) throw new ForbiddenException("Это не ваша клетка");
    if ((cell.mortgageValue ?? 0) <= 0) {
      throw new BadRequestException("Нет залоговой стоимости");
    }
    if (!this.canSellMortgagedPropertyToBank(state, player, cellId)) {
      throw new ForbiddenException("Невозможно продать (клетка не заложена или есть постройки)");
    }
    const value = cell.mortgageValue!;
    player.money += value;
    cell.ownerId = undefined;
    cell.isMortgaged = false;
    cell.houses = 0;
    player.properties = player.properties.filter((id) => id !== cellId);
    return value;
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
   * @param creditor кредитор (другой игрок), либо null (Банк)
   * @param debt начальная сумма долга (сколько игрок был должен до
   *             распродажи). Нужна для расчёта компенсации кредитору.
   *
   * ## Правило:
   *
   *  1) ВСЕ клетки обанкротившегося игрока → БАНК: `ownerId = undefined`,
   *     `isMortgaged = false`, `houses = 0`. Клетки полностью очищаются
   *     и могут быть куплены на аукционе / при заходе на них.
   *  2) Дома/отели на клетках просто теряются (Банк не компенсирует).
   *  3) Оставшиеся деньги банкрота (если есть) — сгорают.
   *  4) Если есть кредитор — Банк компенсирует ему разницу
   *     `(debt - player.money)`, но НЕ больше, чем `debt`, и не больше,
   *     чем реально осталось у банкрота. Это гарантирует, что кредитор
   *     получает причитающийся ему долг (т.к. по правилам банкрот
   *     сначала распродаёт всё что мог, и `|player.money| <= debt`).
   *  5) `player.isBankrupt = true`, `money = 0`, `properties = []`.
   *     Сам объект остаётся в `state.players` (его будут пропускать
   *     при `endTurn` и в `applyAction`).
   *  6) Если остался один не обанкротившийся игрок — партия завершается.
   */
  handle(state: GameState, player: Player, creditor: Player | null, debt: number = 0): void {
    // 1) ВСЁ имущество → БАНК (UNOWNED, без залога, без домов).
    //    Это ГЛАВНОЕ правило: ни кредитор, ни кто-либо ещё не забирает
    //    клетки банкрота. Они становятся свободными для покупки.
    for (const pid of player.properties) {
      const cell = state.board[pid];
      if (!cell) continue;
      cell.ownerId = undefined;
      cell.isMortgaged = false;
      cell.houses = 0;
    }

    // 2) Если есть кредитор — Банк компенсирует ему разницу между
    //    исходным долгом и тем, что осталось у банкрота после распродажи.
    //    - player.money здесь может быть < 0 (если распродажа не дала
    //      нужной суммы) или >= 0 (если что-то осталось).
    //    - compensation = clamp(debt - 0, 0, debt) фактически всегда
    //      равен `debt`, т.к. распродажа уже прошла в BANKRUPTCY_LIQUIDATE.
    //    - защита: compensation не больше debt и не больше того, что
    //      банкрот МОГ бы отдать (debt + 0 = debt при пустом кошельке).
    if (creditor && debt > 0) {
      // Кредитор получает ровно `debt` — это его полный долг, который
      // банкрот был должен. По правилам Монополии Банк выступает
      // гарантом: он доплачивает кредитору разницу из своих средств.
      creditor.money += debt;
    }
    // Если кредитора нет (налог/штраф Банку) — деньги банкрота сгорают.
    // Банк уже получил долг в исходном платеже (например, налог
    // списывался как `player.money -= tax`), так что здесь ничего
    // не начисляем.

    // 3) Очищаем имущество и деньги банкрота.
    player.properties = [];
    player.money = 0;

    // 4) Помечаем банкротом.
    player.isBankrupt = true;

    // 5) Проверка условия победы.
    const alivePlayers = state.players.filter((p) => !p.isBankrupt);
    if (alivePlayers.length === 1 && alivePlayers[0]) {
      state.status = "finished";
      state.winnerId = alivePlayers[0].id;
    }
  }
}
