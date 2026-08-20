import { Injectable } from "@nestjs/common";
import type { Cell, GameState, Player } from "@monopoly/shared";
import { hasActiveMonopoly } from "@monopoly/shared";

/**
 * Калькулятор ренты — единая точка расчёта арендной платы
 * для всех типов клеток: PROPERTY, RAILROAD, UTILITY.
 *
 * Используется:
 *  - `GamesService.applyAction` (когда игрок встал на чужую клетку);
 *  - `BankruptcyService` (когда нужно понять, сколько игрок должен);
 *  - юнит-тестами в `apps/server/test/rent-calculator.spec.ts`.
 *
 * Поведение полностью повторяет логику из `apps/client/src/stores/game.ts`
 * (метод `calculateRent`), но без зависимости от Vue/Pinia.
 *
 * ## Правило «активной монополии» (NEW)
 *
 * В этой версии Монополии понятие «монополия» строже классики:
 * монополия считается активной, только если ВСЕ клетки цветовой группы
 * принадлежат игроку И ни одна из них не заложена. Этот хелпер —
 * `hasActiveMonopoly` из `@monopoly/shared/monopoly.ts` — единая точка
 * истины (используется также в `BuildService`, `CardHandlerService`,
 * `TradeService`, `CellTooltip.vue`, `PlayersPanel.vue`).
 *
 * ## Заложенные ж/д и утилиты
 *
 * Счётчики `rrCount` и `utilCount` для определения множителя ренты
 * теперь тоже учитывают `isMortgaged`: заложенная станция/предприятие
 * не работают и не должны давать владельцу повышенную ренту.
 * Сама же рента с заложенной клетки не начисляется — это уже
 * обработано общей проверкой в `calculate()` ниже.
 */
@Injectable()
export class RentCalculator {
  /**
   * Посчитать ренту за клетку.
   * @param cell клетка, на которую приземлился атакующий
   * @param game полный state партии (нужен для проверки монополий)
   * @param diceRoll сумма кубиков (нужна только для UTILITY)
   */
  calculate(cell: Cell, game: GameState, diceRoll?: [number, number]): number {
    // Заложенная клетка не приносит ренту.
    if (cell.isMortgaged) return 0;
    // Бесхозная клетка — ренты нет.
    if (!cell.ownerId) return 0;

    const owner = game.players.find((p) => p.id === cell.ownerId);
    if (!owner) return 0;

    if (cell.type === "PROPERTY") {
      return this.calculatePropertyRent(cell, owner, game);
    }
    if (cell.type === "RAILROAD") {
      return this.calculateRailroadRent(owner, game);
    }
    if (cell.type === "UTILITY") {
      return this.calculateUtilityRent(owner, game, diceRoll);
    }
    return 0;
  }

  // --- внутренние помощники ----------------------------------------------

  private calculatePropertyRent(cell: Cell, owner: Player, game: GameState): number {
    // Шкала ренты по числу построек (houses):
    //   0  — пустой участок, без построек
    //   1  — 1 дом
    //   2  — 2 дома
    //   3  — 3 дома
    //   4  — 4 дома
    //   5  — отель (представляется как «houses = 5»)
    //
    // Таблица `rentTable` индексируется по `houses` напрямую:
    //   rentTable[0] — базовая рента (без домов)
    //   rentTable[1] — 1 дом
    //   rentTable[2] — 2 дома
    //   rentTable[3] — 3 дома
    //   rentTable[4] — 4 дома
    //   rentTable[5] — отель
    //
    // Если таблица задана — берём значение из неё.
    if (cell.rentTable) {
      const rentFromTable = cell.rentTable[cell.houses];
      if (rentFromTable !== undefined) {
        // Если домов нет и у владельца АКТИВНАЯ монополия (все клетки
        // группы принадлежат ему и ни одна не заложена) — удваиваем
        // базовую ренту (rentTable[0] хранит базовую, без надбавки).
        if (
          cell.houses === 0 &&
          cell.group &&
          hasActiveMonopoly(owner.id, cell.group, game.board)
        ) {
          return rentFromTable * 2;
        }
        return rentFromTable;
      }
    }
    // Фоллбэк для клеток без rentTable: используем cell.rent × 2 при активной монополии.
    if (cell.houses === 0 && cell.group && hasActiveMonopoly(owner.id, cell.group, game.board)) {
      return (cell.rent ?? 0) * 2;
    }
    return cell.rent ?? 0;
  }

  private calculateRailroadRent(owner: Player, game: GameState): number {
    // Считаем только НЕзаложенные ж/д: заложенная станция не работает
    // и не должна учитываться в множителе ренты.
    const rrCount = owner.properties.filter((pid) => {
      const c = game.board[pid];
      return c !== undefined && c.type === "RAILROAD" && !c.isMortgaged;
    }).length;
    // Стандартные суммы по числу железных дорог: 1→25, 2→50, 3→100, 4→200.
    const table = [25, 50, 100, 200];
    return table[rrCount - 1] ?? 25;
  }

  private calculateUtilityRent(
    owner: Player,
    game: GameState,
    diceRoll?: [number, number],
  ): number {
    // Считаем только НЕзаложенные утилиты: заложенное предприятие
    // не работает и не должно учитываться в множителе ренты.
    const utilCount = owner.properties.filter((pid) => {
      const c = game.board[pid];
      return c !== undefined && c.type === "UTILITY" && !c.isMortgaged;
    }).length;
    // 1 предприятие → ×4 от суммы кубиков; 2 предприятия → ×10.
    const multiplier = utilCount === 2 ? 10 : 4;
    if (!diceRoll) return 0;
    return multiplier * (diceRoll[0] + diceRoll[1]);
  }
}
