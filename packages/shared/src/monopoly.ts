/**
 * Утилиты для работы с понятием «монополия».
 *
 * В этой версии Монополии понятие «монополия» строже, чем в классической:
 *
 * > **Монополия** — это когда у игрока есть ВСЕ клетки одной цветовой
 * > группы (`PROPERTY`), и **все эти клетки НЕ заложены**.
 *
 * Если хотя бы одна клетка группы:
 *  - принадлежит другому игроку, или
 *  - заложена (даже если принадлежит этому же игроку),
 *
 * то группа НЕ считается монополией. Соответственно:
 *  - удвоенная рента НЕ начисляется;
 *  - строить дома нельзя (пока залог не выкуплен);
 *  - карточки «за монополию» (`money-if-monopoly`, `money-per-monopoly`)
 *    не дают денег;
 *  - продать/передать любой участок группы нельзя, пока в группе стоят
 *    дома (правило применяется и при заложенных клетках — см. trade).
 *
 * Эти хелперы — единая точка истины для сервера и клиента, чтобы
 * `RentCalculator`, `BuildService`, `CardHandlerService`,
 * `TradeService`, `CellTooltip.vue` и `PlayersPanel.vue` считали
 * одинаково.
 */
import type { Cell, PropertyGroup } from "./types/cell";

/**
 * Проверить, что у `ownerId` есть монополия по указанной цветовой
 * группе (`PROPERTY`-клетки с одинаковым `group`).
 *
 * @param ownerId  ID владельца, для которого проверяем монополию.
 * @param group    Цветовая группа.
 * @param board    Полная доска игры (массив из 40 клеток).
 * @returns `true`, если ВСЕ клетки этой группы принадлежат `ownerId`
 *          и НЕ заложены. `false`, если хотя бы одна клетка группы
 *          принадлежит другому игроку или заложена.
 */
export function hasActiveMonopoly(
  ownerId: string,
  group: PropertyGroup,
  board: readonly Cell[],
): boolean {
  let total = 0;
  for (const c of board) {
    if (c.type !== "PROPERTY" || c.group !== group) continue;
    total += 1;
    if (c.ownerId !== ownerId) return false;
    if (c.isMortgaged) return false;
  }
  return total > 0;
}

/**
 * Подсчитать количество «активных» монополий у `playerId`.
 *
 * Возвращает количество полных цветовых наборов (`PROPERTY`), у
 * которых все клетки принадлежат `playerId` и ни одна не заложена.
 *
 * Группы без `group` (RAILROAD/UTILITY) и группы, в которых у игрока
 * нет ни одной клетки, в подсчёт не входят.
 *
 * @param playerId  ID владельца.
 * @param board     Полная доска игры.
 * @returns Целое число монополий (0..N — столько PROPERTY-групп
 *          реально присутствует на доске).
 */
export function countActiveMonopolies(playerId: string, board: readonly Cell[]): number {
  // totals[g] — сколько PROPERTY-клеток в группе g на доске всего.
  const totals = new Map<PropertyGroup, number>();
  // ownedActive[g] — сколько клеток группы g принадлежит playerId
  // и не заложено.
  const ownedActive = new Map<PropertyGroup, number>();
  for (const c of board) {
    if (c.type !== "PROPERTY" || !c.group) continue;
    const g = c.group;
    totals.set(g, (totals.get(g) ?? 0) + 1);
    if (c.ownerId === playerId && !c.isMortgaged) {
      ownedActive.set(g, (ownedActive.get(g) ?? 0) + 1);
    }
  }
  let count = 0;
  for (const [g, total] of totals) {
    if (total > 0 && (ownedActive.get(g) ?? 0) === total) {
      count += 1;
    }
  }
  return count;
}

/**
 * Проверить, что в указанной цветовой группе у `ownerId` нет ни одного
 * здания (домов 1..4 или отеля).
 *
 * Используется при валидации торговли/передачи участков: пока в группе
 * хоть один дом — нельзя продавать/передавать ни одну клетку этой
 * группы, даже если на ней самой домов нет.
 *
 * @param ownerId  ID владельца группы.
 * @param group    Цветовая группа.
 * @param board    Полная доска игры.
 * @returns `true`, если во всей группе у `ownerId` нет зданий.
 */
export function groupHasNoBuildings(
  ownerId: string,
  group: PropertyGroup,
  board: readonly Cell[],
): boolean {
  for (const c of board) {
    if (c.type !== "PROPERTY") continue;
    if (c.group !== group) continue;
    if (c.ownerId !== ownerId) continue;
    if (c.houses > 0) return false;
  }
  return true;
}
