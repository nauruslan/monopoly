import { Injectable, BadRequestException, ForbiddenException } from "@nestjs/common";
import type { Cell, GameState, Player } from "@monopoly/shared";

/**
 * MortgageService — централизованная логика залога и выкупа недвижимости.
 *
 * ## Правила Монополии (классические), которые здесь реализуются
 *
 * ### 1. Правило залога: ограничение по цветовым группам
 *
 * Нельзя заложить участок, если на **ЛЮБОМ** участке этой цветовой
 * группы есть хотя бы один дом. Это логично вытекает из правила
 * равномерности строительства: если разрешить закладывать участок,
 * пока на других участках группы стоят дома, игрок мог бы обойти
 * правило равномерности (продать 1 дом → заложить участок → продавать
 * дома неравномерно). Поэтому сначала нужно продать ВСЕ дома в группе,
 * и только потом закладывать участки.
 *
 * ### 2. Правило выкупа
 *
 * Выкупить заложенный участок можно в любой момент (правилами не
 * запрещено), но:
 *  - Стоимость выкупа = `mortgageValue * 1.1` (т.е. 110% от залоговой
 *    стоимости, округление вверх до целого).
 *  - У игрока должно быть достаточно денег.
 *  - Заложенный участок не приносит ренту, поэтому чем раньше выкуп —
 *    тем лучше.
 *
 * ### 3. Фаза сбора средств
 *
 * Эта логика (когда баланс игрока < 0) в текущей итерации НЕ реализуется
 * отдельной фазой — действует существующий механизм банкротства
 * (BankruptcyService). `MortgageService` предоставляет утилиту
 * `calculateTotalLiquidValue()` для оценки того, может ли игрок
 * расплатиться при тотальной распродаже — сервер может использовать
 * это для принятия решения о банкротстве, но фактический запуск фазы
 * сбора средств делается через существующий поток (см. games.service.ts).
 *
 * ## Контракт
 *
 * Сервис НЕ мутирует `state.board[i].ownerId` или массив `properties` —
 * это делает GamesService, чтобы все события и запись в БД
 * происходили в одном месте. `MortgageService` отвечает ТОЛЬКО за
 * валидацию и расчёт стоимости.
 */
@Injectable()
export class MortgageService {
  /**
   * Может ли игрок заложить данную клетку.
   *
   * Правила:
   *  1. Клетка принадлежит игроку.
   *  2. Клетка ещё не в залоге.
   *  3. На самой клетке нет построек (houses === 0).
   *  4. **КРИТИЧНО:** На ЛЮБОМ участке цветовой группы клетки нет
   *     построек. Это правило вытекает из требования равномерности
   *     строительства.
   *
   * @param player игрок
   * @param property клетка, которую хотят заложить
   * @param state полный state партии (для проверки группы)
   */
  canMortgage(player: Player, property: Cell, state: GameState): boolean {
    // 1. Клетка должна принадлежать игроку
    if (property.ownerId !== player.id) return false;

    // 2. Клетка не должна быть уже в залоге
    if (property.isMortgaged) return false;

    // 3. На самой клетке не должно быть построек
    if (property.houses > 0) return false;

    // 4. КРИТИЧНО: На ЛЮБОМ участке этой цветовой группы не должно быть
    //    построек. Нельзя заложить участок, пока в группе стоят дома —
    //    иначе игрок мог бы обойти правило равномерности.
    if (property.group) {
      const groupHasHouses = state.board.some(
        (c) =>
          c.type === property.type &&
          c.group === property.group &&
          c.ownerId === player.id &&
          c.houses > 0,
      );
      if (groupHasHouses) return false;
    }

    return true;
  }

  /**
   * Может ли игрок выкупить заложенную клетку.
   *
   * Правила:
   *  1. Клетка принадлежит игроку.
   *  2. Клетка в залоге.
   *  3. У игрока достаточно денег (`mortgageValue * 1.1`).
   */
  canUnmortgage(player: Player, property: Cell): boolean {
    if (property.ownerId !== player.id) return false;
    if (!property.isMortgaged) return false;
    if (property.mortgageValue === undefined) return false;
    const cost = this.getUnmortgageCost(property);
    return player.money >= cost;
  }

  /**
   * Стоимость выкупа клетки из залога.
   * Формула: `mortgageValue * 1.1`, округление вверх до целого.
   * Если `mortgageValue` не задана — возвращает 0 (нельзя выкупить).
   */
  getUnmortgageCost(property: Cell): number {
    if (property.mortgageValue === undefined) return 0;
    return Math.ceil(property.mortgageValue * 1.1);
  }

  /**
   * Заложить клетку.
   *
   * @throws BadRequestException если клетка не подходит для залога
   * @throws ForbiddenException если игрок не владеет клеткой
   *
   * Возвращает сумму, которая будет зачислена игроку (`mortgageValue`).
   * Мутирует `state.board` (выставляет `isMortgaged = true`) и
   * `player.money` (зачисляет `mortgageValue`).
   */
  mortgage(state: GameState, player: Player, cellId: number): number {
    const cell = state.board[cellId];
    if (!cell) {
      throw new BadRequestException(`Клетка ${cellId} не найдена`);
    }
    if (cell.ownerId !== player.id) {
      throw new ForbiddenException("Это не ваша клетка");
    }
    if (cell.mortgageValue === undefined) {
      throw new BadRequestException("Эту клетку нельзя заложить");
    }
    if (!this.canMortgage(player, cell, state)) {
      throw new ForbiddenException(this.mortgageForbiddenReason(player, cell, state));
    }

    cell.isMortgaged = true;
    player.money += cell.mortgageValue;
    return cell.mortgageValue;
  }

  /**
   * Выкупить клетку из залога.
   *
   * @throws BadRequestException если клетка не подходит для выкупа
   * @throws ForbiddenException если не хватает денег или клетка не в залоге
   *
   * Возвращает сумму, которая будет списана у игрока
   * (`mortgageValue * 1.1`, округлено вверх).
   * Мутирует `state.board` (выставляет `isMortgaged = false`) и
   * `player.money` (списывает стоимость выкупа).
   */
  unmortgage(state: GameState, player: Player, cellId: number): number {
    const cell = state.board[cellId];
    if (!cell) {
      throw new BadRequestException(`Клетка ${cellId} не найдена`);
    }
    if (cell.ownerId !== player.id) {
      throw new ForbiddenException("Это не ваша клетка");
    }
    if (!cell.isMortgaged) {
      throw new ForbiddenException("Клетка не в залоге");
    }
    if (cell.mortgageValue === undefined) {
      throw new BadRequestException("Эту клетку нельзя выкупить");
    }
    if (!this.canUnmortgage(player, cell)) {
      throw new ForbiddenException("Недостаточно денег для выкупа");
    }

    const cost = this.getUnmortgageCost(cell);
    cell.isMortgaged = false;
    player.money -= cost;
    return cost;
  }

  /**
   * Возвращает человеко-читаемую причину, почему нельзя заложить
   * данную клетку (для ошибок валидации).
   */
  private mortgageForbiddenReason(player: Player, property: Cell, state: GameState): string {
    if (property.isMortgaged) return "Клетка уже в залоге";
    if (property.houses > 0) return "Сначала продайте дома на этой клетке";
    if (property.group) {
      const groupCells = state.board.filter(
        (c) => c.type === property.type && c.group === property.group && c.ownerId === player.id,
      );
      const housesInGroup = groupCells.filter((c) => c.houses > 0);
      if (housesInGroup.length > 0) {
        return "Сначала продайте ВСЕ дома в этой цветовой группе";
      }
    }
    return "Невозможно заложить эту клетку";
  }

  /**
   * Список ID клеток игрока, которые можно заложить прямо сейчас.
   * Используется UI для отрисовки модалки «Залог/Выкуп».
   */
  listMortgageableProperties(player: Player, state: GameState): Cell[] {
    return state.board.filter((c) => c.ownerId === player.id && this.canMortgage(player, c, state));
  }

  /**
   * Список ID клеток игрока, которые можно выкупить прямо сейчас
   * (заложены + хватает денег на выкуп).
   */
  listUnmortgageableProperties(player: Player, state: GameState): Cell[] {
    return state.board.filter((c) => c.ownerId === player.id && this.canUnmortgage(player, c));
  }

  /**
   * Подсчитать максимально возможную ликвидную стоимость игрока,
   * если он продаст и заложит ВСЁ.
   *
   * Формула:
   *  1. Начинаем с текущего баланса (может быть отрицательным).
   *  2. Группируем недвижимость по цветам. Для каждой группы считаем:
   *     - Стоимость продажи ВСЕХ домов/отелей (по 50% от цены постройки).
   *     - Стоимость залога ВСЕХ участков (по 50% от номинала),
   *       ВОЗМОЖНОГО только после продажи всех домов.
   *  3. Утилиты и ж/д (без цветовых групп с домами) — залоговая
   *     стоимость напрямую.
   *
   * Интерпретация:
   *  - `totalValue >= 0` — игрок теоретически может расплатиться.
   *  - `totalValue < 0`   — игрок не может расплатиться даже при
   *                         тотальной распродаже → банкротство.
   *
   * Используется сервером (и потенциально UI) для оценки платёжеспособности.
   */
  calculateTotalLiquidValue(player: Player, state: GameState): number {
    let totalValue = player.money;

    // Группируем клетки по группам (включая utility/railroad для отдельной ветки).
    const byGroup = new Map<string, Cell[]>();
    for (const cell of state.board) {
      if (cell.ownerId !== player.id) continue;
      if (cell.type !== "PROPERTY" && cell.type !== "RAILROAD" && cell.type !== "UTILITY") {
        continue;
      }
      // PROPERTY группируем по color-group; RAILROAD/UTILITY — отдельно.
      const key = cell.type === "PROPERTY" && cell.group ? cell.group : `__${cell.type}__`;
      if (!byGroup.has(key)) byGroup.set(key, []);
      byGroup.get(key)!.push(cell);
    }

    for (const [key, cells] of byGroup) {
      // 1) Продажа всех домов в группе (только для PROPERTY с группой).
      if (key.startsWith("__") === false) {
        for (const cell of cells) {
          if (cell.houses > 0 && cell.houses < 5) {
            // Обычные дома: цена дома / 2 за каждый.
            const housePrice = cell.housePrice ?? 0;
            totalValue += cell.houses * (housePrice / 2);
          } else if (cell.houses === 5) {
            // Отель: 50% от housePrice * 5 (т.е. 5 домов по полной цене,
            // каждый продаётся за полцены). Упрощённо: 5 × housePrice/2.
            const housePrice = cell.housePrice ?? 0;
            totalValue += 5 * (housePrice / 2);
          }
        }
      }

      // 2) Залог всех участков в группе (возможно только после продажи домов).
      for (const cell of cells) {
        if (!cell.isMortgaged && cell.mortgageValue !== undefined) {
          totalValue += cell.mortgageValue;
        }
      }
    }

    return totalValue;
  }
}
