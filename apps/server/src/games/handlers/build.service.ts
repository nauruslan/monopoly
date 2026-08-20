import { BadRequestException, ForbiddenException, Injectable } from "@nestjs/common";
import type { Cell, GameState, Player } from "@monopoly/shared";
import { hasActiveMonopoly } from "@monopoly/shared";

/**
 * BuildService — централизованная логика строительства, сноса, залога
 * и выкупа недвижимости в фазе BUILDING / BUILDING_PHASE.
 *
 * ## Кастомные правила нашей версии Монополии
 *
 * В этом сервисе ЗАШИТЫ правила, отличающие нашу версию от классической
 * Монополии. Если в будущем
 * потребуется конфигурировать эти правила (например, для классического
 * режима), нужно будет ввести GameSettings-флаги и читать их здесь.
 *
 * ### 1. Неограниченный банк домов/отелей
 *
 * В нашей версии НЕТ проверки «остались ли дома в банке». Сервер
 * просто инкрементирует `cell.houses`. Это упомянуто в GDD §5
 * («предполагается, что банк неисчерпаем»).
 *
 * ### 2. Цена отеля = цена дома
 *
 * В классической Монополии отель стоит 5 × цена дома, и при покупке
 * 4 домов «снимаются», а на участке появляется 1 отель. В нашей версии
 * отель стоит СТОЛЬКО ЖЕ, сколько один дом (см. GDD §5 и настройку
 * `settings.hotelPriceEqualsHousePrice = true` по умолчанию). Это
 * упрощает баланс и стратегию.
 *
 * ### 3. Отель продаётся ЦЕЛИКОМ
 *
 * В классике при продаже отеля он «распадается» на 4 дома, и игрок
 * получает возврат за 4 дома. В нашей версии отель продаётся ЦЕЛИКОМ:
 * `houses: 5 → 0`, игрок получает 50% от цены ОДНОГО дома (т.е. как
 * за 1 дом). Это согласовано с правилом «цена отеля = цена дома»:
 * за сколько купил — за столько половина и при продаже.
 *
 * ### 4. Правило «лесенки» (чётности) — ОБЯЗАТЕЛЬНО
 *
 * Нельзя построить дом на участке, если на каком-то ДРУГОМ участке
 * этой цветовой группы МЕНЬШЕ домов. Это «правило лесенки»: разница
 * между участками одной группы — не больше 1 дома. Аналогично для
 * сноса: нельзя продать дом с участка, если на другом участке группы
 * БОЛЬШЕ домов.
 *
 * **Постановка отеля (4 → 5):** разрешена, если на ВСЕХ остальных
 * клетках группы `houses >= 4` (т.е. либо 4 дома, либо отель). Это
 * симметрично правилу продажи: отель можно ставить, когда группа
 * «полностью застроена», и снимать, когда группа «пуста».
 *
 * **Снятие отеля (5 → 0):** разрешено, если на ВСЕХ остальных клетках
 * группы `houses === 0` (т.е. эта клетка — единственная с постройками).
 *
 * ### 5. Залог блокируется при наличии домов в группе
 *
 * Нельзя заложить участок, если на ЛЮБОМ участке этой цветовой
 * группы стоят дома. Это согласуется с правилом лесенки: сначала
 * надо снести ВСЕ дома в группе, потом закладывать. (Эту проверку
 * делает MortgageService, см. `canMortgage`.)
 *
 * ### 6. Строительство блокируется при залоге в группе
 *
 * В нашей версии правило ЖЁСТЧЕ классики: нельзя строить, если
 * ЛЮБОЙ участок цветовой группы ЗАЛОЖЕН. Классика разрешает
 * строительство при заложенных участках той же группы, но это
 * упрощает стратегию: либо группа заложена, либо строишься.
 *
 * Это правило реализовано через общий хелпер `hasActiveMonopoly`
 * из `@monopoly/shared/monopoly.ts`: функция возвращает `true`
 * ТОЛЬКО когда все клетки группы принадлежат игроку И ни одна
 * не заложена. Явная проверка «mortgagedInGroup» ниже оставлена
 * для более человеко-читаемого сообщения об ошибке (хелпер бы
 * просто вернул `false` без объяснений).
 *
 * ## Контракт
 *
 * Сервис НЕ мутирует `state.board[i].ownerId` — это делает GamesService.
 * `BuildService` отвечает ТОЛЬКО за валидацию и мутацию `houses`,
 * `isMortgaged`, `player.money`. Все события (`HOUSE_BUILT`,
 * `HOUSE_SOLD`, `PROPERTY_MORTGAGED`, `PROPERTY_UNMORTGAGED`,
 * `BUILDING_PHASE_OPENED`) формирует GamesService, чтобы id/время
 * были консистентны.
 */
@Injectable()
export class BuildService {
  // ─────────────────────────────────────────────────────────────────────
  // ВАЛИДАЦИЯ (canBuild / canSell / canMortgage / canUnmortgage)
  // ─────────────────────────────────────────────────────────────────────

  /**
   * Может ли игрок построить дом/отель на данной клетке.
   *
   * Проверки:
   *  1. Клетка принадлежит игроку.
   *  2. Клетка — PROPERTY (не RAILROAD/UTILITY).
   *  3. Клетка НЕ заложена.
   *  4. У игрока **активная** монополия на эту цветовую группу
   *     (все клетки группы принадлежат ему и ни одна не заложена).
   *  5. **Доп. проверка:** в группе нет заложенных участков — эта
   *     ветка формально дублирует (4) через `hasActiveMonopoly`,
   *     но оставлена для более понятного сообщения об ошибке.
   *  6. У игрока достаточно денег (`housePrice`).
   *  7. **Правило лесенки:** на этой клетке меньше домов, чем на
   *     любом другом участке группы +1. Т.е. разница не больше 1.
   *     - Если на клетке 4 дома — можно ставить отель, только если
   *       на ВСЕХ остальных клетках группы `houses >= 4` (т.е. тоже
   *       4 дома или отель).
   *  8. Нет предела «32 дома в банке» (см. §1).
   *
   * @returns объект `{ ok: true, cost }` если можно, иначе
   *          `{ ok: false, reason }` с человеко-читаемой причиной.
   */
  canBuild(
    player: Player,
    cell: Cell,
    state: GameState,
  ): { ok: true; cost: number; isHotel: boolean } | { ok: false; reason: string } {
    // 1. Владелец
    if (cell.ownerId !== player.id) {
      return { ok: false, reason: "Это не ваша клетка" };
    }
    // 2. Только PROPERTY
    if (cell.type !== "PROPERTY") {
      return { ok: false, reason: "На этой клетке нельзя строить" };
    }
    // 3. Не в залоге
    if (cell.isMortgaged) {
      return { ok: false, reason: "Клетка в залоге — сначала выкупите" };
    }
    // 4. Активная монополия (все клетки группы принадлежат игроку
    //    и ни одна не заложена). Используем общий хелпер shared/monopoly.
    if (!cell.group || !hasActiveMonopoly(player.id, cell.group, state.board)) {
      return { ok: false, reason: "Нужна монополия на эту цветовую группу" };
    }
    // 5. Доп. явная проверка для человеко-читаемого сообщения об ошибке.
    //    `hasActiveMonopoly` уже учитывает залог, но эта ветка даёт
    //    более конкретный текст: «в группе есть заложенный участок».
    if (cell.group) {
      const mortgagedInGroup = state.board.some(
        (c) => c.group === cell.group && c.ownerId === player.id && c.isMortgaged,
      );
      if (mortgagedInGroup) {
        return {
          ok: false,
          reason: "В группе есть заложенный участок — сначала выкупите всё",
        };
      }
    }
    // 6. Цена дома
    if (cell.housePrice === undefined) {
      return { ok: false, reason: "Не задана цена дома для этой клетки" };
    }
    const cost = cell.housePrice;
    if (player.money < cost) {
      return { ok: false, reason: "Недостаточно денег" };
    }

    // 7. Правило лесенки (вверх: разница между клетками группы <= 1 уровня).
    const groupCells = state.board.filter((c) => c.type === "PROPERTY" && c.group === cell.group);
    const minHouses = Math.min(...groupCells.map((c) => c.houses));
    if (cell.houses > minHouses) {
      return {
        ok: false,
        reason: "Сначала постройте дома на других участках группы",
      };
    }
    // Постановка отеля (4 → 5) разрешена, только если ВСЕ остальные
    // клетки группы уже имеют 4+ дома (т.е. либо 4 дома, либо отель).
    // Это симметрично правилу продажи: отель можно поставить, когда
    // группа «полностью застроена» (везде минимум 4), и можно снять,
    // когда группа «пуста» (везде 0). Раньше правило требовало строго
    // «4 на всех», из-за чего нельзя было поставить второй отель, если
    // первый уже стоит — это был баг.
    if (cell.houses === 4) {
      const allAtLeast4 = groupCells.every((c) => c.houses >= 4);
      if (!allAtLeast4) {
        return {
          ok: false,
          reason: "Сначала достройте все участки группы минимум до 4 домов",
        };
      }
    }
    if (cell.houses >= 5) {
      return { ok: false, reason: "Уже стоит отель" };
    }

    return {
      ok: true,
      cost,
      // По кастомным правилам (цена отеля = цена дома) и «5 = отель»
      // мы НЕ возвращаем отдельно isHotel=true: для UI индикатор
      // «отель» — это когда `houses` становится 5. Но мы оставляем
      // флаг для возможного расширения (если цена вдруг будет разной).
      isHotel: cell.houses === 4,
    };
  }

  /**
   * Может ли игрок продать дом/отель с данной клетки.
   *
   * Проверки:
   *  1. Клетка принадлежит игроку.
   *  2. На клетке есть дома (`houses > 0`).
   *  3. **Правило лесенки (обратное):** на этой клетке НЕ МЕНЬШЕ домов,
   *     чем на любом другом участке группы. Т.е. сначала сносим с
   *     «передовых» участков. Это правило покрывает И дома, И отели:
   *     если все участки = 5, то любой из них — максимум, и его можно
   *     снести. После такой продажи (5 → 4) получается [4, 5, 5], в
   *     которой новые максимумы (5) снова можно снести. И так далее —
   *     никакого дедлока.
   *
   * @returns `{ ok: true, refund, isHotelSale }` или
   *          `{ ok: false, reason }`.
   */
  canSell(
    player: Player,
    cell: Cell,
    state: GameState,
  ): { ok: true; refund: number; isHotelSale: boolean } | { ok: false; reason: string } {
    if (cell.ownerId !== player.id) {
      return { ok: false, reason: "Это не ваша клетка" };
    }
    if (cell.houses === 0) {
      return { ok: false, reason: "На этой клетке нет домов" };
    }
    if (cell.housePrice === undefined) {
      return { ok: false, reason: "Не задана цена дома для этой клетки" };
    }

    // Правило лесенки (обратное): продавать можно только с клетки,
    // у которой houses >= любой другой клетки в группе. Этого чека
    // достаточно И для домов, И для отелей. Дополнительной проверки
    // «остальные должны быть пустыми» НЕТ — она создаёт дедлок при
    // состоянии [5, 5, 5] (ни один отель нельзя продать).
    if (cell.group) {
      const groupCells = state.board.filter((c) => c.type === "PROPERTY" && c.group === cell.group);
      const maxHouses = Math.max(...groupCells.map((c) => c.houses));
      if (cell.houses < maxHouses) {
        return {
          ok: false,
          reason: "Сначала продайте дома на других участках группы",
        };
      }
    }

    // Возврат: для дома — половина цены; для отеля — ТАКЖЕ половина
    // цены (как за 1 дом). Отель «распадается» на 4 дома (5 → 4), см.
    // §3 в шапке файла. Игрок далее может продавать дома по одному.
    const isHotelSale = cell.houses === 5;
    const refund = cell.housePrice / 2;

    return { ok: true, refund, isHotelSale };
  }

  /**
   * Может ли игрок заложить клетку.
   *
   * Делегируе�� проверку в {@link MortgageService.canMortgage}, чтобы
   * вся логика залога была в одном месте. Здесь метод оставлен как
   * «единая точка входа» для будущих правил (например, кастомных
   * ограничений для нашей версии).
   */
  canMortgage(
    player: Player,
    cell: Cell,
    state: GameState,
  ): { ok: true } | { ok: false; reason: string } {
    // Базовая проверка правил (no houses in group, не в залоге, владелец).
    if (cell.ownerId !== player.id) return { ok: false, reason: "Это не ваша клетка" };
    if (cell.isMortgaged) return { ok: false, reason: "Клетка уже в залоге" };
    if (cell.houses > 0) return { ok: false, reason: "На клетке есть дома" };
    if (cell.mortgageValue === undefined) {
      return { ok: false, reason: "Эту клетку нельзя заложить" };
    }
    if (cell.group) {
      const groupHasHouses = state.board.some(
        (c) =>
          c.type === cell.type && c.group === cell.group && c.ownerId === player.id && c.houses > 0,
      );
      if (groupHasHouses) {
        return { ok: false, reason: "В группе есть дома — сначала снесите их" };
      }
    }
    return { ok: true };
  }

  /**
   * Стоимость выкупа клетки из залога.
   * Формула: `mortgageValue * 1.1`, округлено вверх.
   */
  getUnmortgageCost(cell: Cell): number {
    if (cell.mortgageValue === undefined) return 0;
    return Math.ceil(cell.mortgageValue * 1.1);
  }

  /**
   * Может ли игрок выкупить заложенную клетку.
   */
  canUnmortgage(
    player: Player,
    cell: Cell,
  ): { ok: true; cost: number } | { ok: false; reason: string } {
    if (cell.ownerId !== player.id) return { ok: false, reason: "Это не ваша клетка" };
    if (!cell.isMortgaged) return { ok: false, reason: "Клетка не в залоге" };
    if (cell.mortgageValue === undefined) {
      return { ok: false, reason: "Эту клетку нельзя выкупить" };
    }
    const cost = this.getUnmortgageCost(cell);
    if (player.money < cost) return { ok: false, reason: "Недостаточно денег для выкупа" };
    return { ok: true, cost };
  }

  // ─────────────────────────────────────────────────────────────────────
  // ИСПОЛНЕНИЕ (executeBuild / executeSell / executeMortgage / executeUnmortgage)
  // ─────────────────────────────────────────────────────────────────────

  /**
   * Построить дом/отель на клетке.
   * Мутирует `cell.houses` (инкремент) и `player.money` (декремент).
   *
   * @throws ForbiddenException если `canBuild` вернул ошибку.
   * @returns информация об операции: { cost, isHotel, newHousesCount }.
   */
  build(
    state: GameState,
    player: Player,
    cellId: number,
  ): { cost: number; isHotel: boolean; newHousesCount: 0 | 1 | 2 | 3 | 4 | 5 } {
    const cell = state.board[cellId];
    if (!cell) throw new BadRequestException(`Клетка ${cellId} не найдена`);

    const result = this.canBuild(player, cell, state);
    if (!result.ok) throw new ForbiddenException(result.reason);

    player.money -= result.cost;
    cell.houses = (cell.houses + 1) as 0 | 1 | 2 | 3 | 4 | 5;
    return {
      cost: result.cost,
      isHotel: result.isHotel,
      newHousesCount: cell.houses,
    };
  }

  /**
   * Продать дом/отель с клетки.
   *
   * Классические правила Монополии:
   *  - Дом: `houses -= 1`, refund = `housePrice / 2`.
   *  - Отель (5 → 4): refund = `housePrice / 2` (как за 1 дом).
   *    На участке остаётся 4 дома — отель «распадается» на дома.
   *    После этого игрок может продавать дома по одному по лесенке.
   *
   * @throws ForbiddenException если `canSell` вернул ошибку.
   * @returns информация: { refund, isHotelSale, newHousesCount }.
   */
  sell(
    state: GameState,
    player: Player,
    cellId: number,
  ): { refund: number; isHotelSale: boolean; newHousesCount: 0 | 1 | 2 | 3 | 4 | 5 } {
    const cell = state.board[cellId];
    if (!cell) throw new BadRequestException(`Клетка ${cellId} не найдена`);

    const result = this.canSell(player, cell, state);
    if (!result.ok) throw new ForbiddenException(result.reason);

    player.money += result.refund;
    // Классические правила: отель «распадается» на 4 дома (5 → 4).
    cell.houses = (cell.houses === 5 ? 4 : cell.houses - 1) as 0 | 1 | 2 | 3 | 4 | 5;
    return {
      refund: result.refund,
      isHotelSale: result.isHotelSale,
      newHousesCount: cell.houses,
    };
  }

  /**
   * Заложить клетку.
   * Мутирует `cell.isMortgaged = true` и `player.money += mortgageValue`.
   *
   * @returns зачисленная сумма.
   */
  mortgage(state: GameState, player: Player, cellId: number): number {
    const cell = state.board[cellId];
    if (!cell) throw new BadRequestException(`Клетка ${cellId} не найдена`);

    const result = this.canMortgage(player, cell, state);
    if (!result.ok) throw new ForbiddenException(result.reason);

    cell.isMortgaged = true;
    player.money += cell.mortgageValue!;
    return cell.mortgageValue!;
  }

  /**
   * Выкупить клетку из залога.
   * Мутирует `cell.isMortgaged = false` и `player.money -= cost`.
   *
   * @returns списанная сумма.
   */
  unmortgage(state: GameState, player: Player, cellId: number): number {
    const cell = state.board[cellId];
    if (!cell) throw new BadRequestException(`Клетка ${cellId} не найдена`);

    const result = this.canUnmortgage(player, cell);
    if (!result.ok) throw new ForbiddenException(result.reason);

    const cost = result.cost;
    cell.isMortgaged = false;
    player.money -= cost;
    return cost;
  }

  // ─────────────────────────────────────────────────────────────────────
  // СПИСКИ ДЛЯ UI
  // ─────────────────────────────────────────────────────────────────────

  /**
   * Список клеток игрока, на которых МОЖНО построить дом прямо сейчас.
   * Используется UI (build store) для подсветки доступных кнопок.
   */
  listBuildableProperties(player: Player, state: GameState): Cell[] {
    return state.board.filter((c) => this.canBuild(player, c, state).ok);
  }

  /**
   * Список клеток игрока, с которых МОЖНО продать дом прямо сейчас.
   */
  listSellableProperties(player: Player, state: GameState): Cell[] {
    return state.board.filter((c) => this.canSell(player, c, state).ok);
  }

  /**
   * Список клеток игрока, которые МОЖНО заложить прямо сейчас.
   * Правила: см. `canMortgage` (нет домов в группе, не в залоге, владелец).
   */
  listMortgageableProperties(player: Player, state: GameState): Cell[] {
    return state.board.filter((c) => this.canMortgage(player, c, state).ok);
  }

  /**
   * Список клеток игрока, которые МОЖНО выкупить прямо сейчас
   * (заложены + хватает денег).
   */
  listUnmortgageableProperties(player: Player, state: GameState): Cell[] {
    return state.board.filter((c) => this.canUnmortgage(player, c).ok);
  }

  /**
   * Подсчитать максимально возможную ликвидную стоимость игрока,
   * если он продаст и заложит ВСЁ.
   *
   * Формула:
   *  1. Начинаем с текущего баланса (может быть отрицательным).
   *  2. Группируем недвижимость по цветам. Для каждой группы считаем:
   *     - Стоимость продажи ВСЕХ домов/отелей (по 50% от цены постройки).
   *       Отель (классика): refund = `housePrice / 2` за сам отель +
   *       `4 * housePrice / 2` за 4 оставшихся дома после снятия
   *       отеля. Итого: `(1 + 4) * housePrice / 2 = 2.5 * housePrice`.
   *     - Стоимость залога ВСЕХ участков (по 50% от номинала),
   *       ВОЗМОЖНОГО только после продажи всех домов.
   *  3. Утилиты и ж/д (без цветовых групп с домами) — залоговая
   *     стоимость напрямую.
   *
   * Используется сервером (и потенциально UI) для оценки
   * платёжеспособности, например, при банкротстве.
   */
  calculateTotalLiquidValue(player: Player, state: GameState): number {
    let totalValue = player.money;

    const byGroup = new Map<string, Cell[]>();
    for (const cell of state.board) {
      if (cell.ownerId !== player.id) continue;
      if (cell.type !== "PROPERTY" && cell.type !== "RAILROAD" && cell.type !== "UTILITY") {
        continue;
      }
      const key = cell.type === "PROPERTY" && cell.group ? cell.group : `__${cell.type}__`;
      if (!byGroup.has(key)) byGroup.set(key, []);
      byGroup.get(key)!.push(cell);
    }

    for (const [key, cells] of byGroup) {
      // 1) Продажа всех домов/отелей в группе (только PROPERTY).
      if (!key.startsWith("__")) {
        for (const cell of cells) {
          if (cell.houses === 0) continue;
          const housePrice = cell.housePrice ?? 0;
          if (cell.houses === 5) {
            // Классика: отель распадается на 4 дома, refund за сам
            // отель (1) + за 4 дома = (1 + 4) * housePrice / 2.
            totalValue += (5 * housePrice) / 2;
          } else {
            totalValue += cell.houses * (housePrice / 2);
          }
        }
      }

      // 2) Залог всех участков (после продажи домов).
      for (const cell of cells) {
        if (!cell.isMortgaged && cell.mortgageValue !== undefined) {
          totalValue += cell.mortgageValue;
        }
      }
    }

    return totalValue;
  }
}
