import { Injectable } from "@nestjs/common";
import type { GameState, Player } from "@monopoly/shared";

/**
 * Обработчик банкротства игрока.
 *
 * Правила:
 *  - Если есть кредитор (другой игрок, которому не смог заплатить) —
 *    ВСЕ клетки и оставшиеся деньги переходят ему.
 *  - Если кредитора нет (банк, налоги) — клетки уходят обратно в банк
 *    (ownerId = undefined), деньги сгорают.
 *  - В ЛЮБОМ случае `player.isBankrupt = true`, деньги обнуляются.
 *
 * ВАЖНО: мы НЕ удаляем игрока из `state.players` через `filter`, потому что
 * это сдвигает `currentPlayerIndex` (см. README шага 26, пункт 4).
 * Обанкротившийся игрок остаётся в массиве с `isBankrupt = true` и
 * пропускается в `GamesService.applyAction` / `endTurn`.
 *
 * Если в партии остался ровно один НЕ обанкротившийся игрок — партия
 * завершается, и его id становится `state.winnerId`.
 */
@Injectable()
export class BankruptcyService {
  /**
   * Обработать банкротство `player`.
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
