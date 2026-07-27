/**
 * useBuildStore — Pinia-store для UI модалки «Строить» на клиенте.
 *
 * Модалка объединяет в себе:
 *  - покупку/улучшение домов и отелей;
 *  - продажу домов;
 *  - залог/выкуп недвижимости.
 *
 * ВНИМАНИЕ: Этот стор содержит ТОЛЬКО локальное UI-состояние
 * (открыта/закрыта модалка, последнее сообщение об ошибке).
 * ВСЯ валидация и финансовые расчёты делаются на сервере
 * (см. `BuildService` в apps/server). Клиент только:
 *   - открывает/закрывает модалку;
 *   - шлёт `BUILD_HOUSE` / `SELL_HOUSE` / `MORTGAGE_PROPERTY` /
 *     `UNMORTGAGE_PROPERTY` / `OPEN_BUILDING_PHASE` / `CONFIRM_BUILDING_PHASE`
 *     actions;
 *   - получает ошибки от сервера и отображает их.
 *
 * Правила «монополия / лесенка / нельзя строить при залоге в группе /
 * отель продаётся целиком» живут на сервере. Клиент рисует кнопки
 * с учётом простых эвристик (деньги, наличие домов), а сервер
 * возвращает человеко-читаемые сообщения при нарушении правил.
 */
import { computed, ref } from "vue";
import { defineStore } from "pinia";
import { useGameStore } from "./game";
import type { Cell, GameState, Player } from "@monopoly/shared";

/** Эвристика «можно ли построить» на клиенте (для UI-кнопки). */
function clientCanBuild(
  cell: Cell,
  state: GameState,
  me: Player,
): { ok: boolean; reason?: string } {
  if (cell.type !== "PROPERTY") return { ok: false, reason: "Это не обычная недвижимость" };
  if (cell.ownerId !== me.id) return { ok: false, reason: "Это не ваша клетка" };
  if (cell.isMortgaged) return { ok: false, reason: "Сначала выкупите из залога" };
  if (cell.houses === 5) return { ok: false, reason: "Уже отель" };
  if (cell.housePrice === undefined) return { ok: false, reason: "Нет цены дома" };
  // Правило лесенки: нельзя строить, если в группе есть клетка с домами
  // БОЛЬШЕ, чем у этой, или наоборот — на этой уже максимум.
  // Для отеля — все остальные клетки группы должны иметь 4 дома.
  if (cell.group) {
    const group = state.board.filter(
      (c) => c.type === "PROPERTY" && c.group === cell.group && c.ownerId === me.id,
    );
    // Полная монополия?
    if (group.length < countInGroup(state, cell)) {
      return { ok: false, reason: "Нет полной монополии" };
    }
    // Правило залога в группе.
    if (group.some((c) => c.isMortgaged)) {
      return { ok: false, reason: "В группе есть заложенные клетки" };
    }
    // Правило лесенки: минимум среди group <= cell.houses (если не отель).
    const minH = Math.min(...group.map((c) => c.houses));
    if (cell.houses < minH) {
      return { ok: false, reason: "Соблюдайте порядок строительства (лесенка)" };
    }
    // Если строим отель — на всех остальных клетках группы должно быть
    // минимум по 4 дома (т.е. либо 4 дома, либо отель). Это согласовано
    // с серверной логикой (см. BuildService.canBuild, build.service.ts:
    // `allAtLeast4 = groupCells.every((c) => c.houses >= 4)`). Раньше
    // здесь стояла проверка `c.houses === 4` — из-за неё после постройки
    // первого отеля на одной клетке клиент ошибочно блокировал кнопку
    // «ОТЕЛЬ» на остальных клетках группы (там `houses === 5`),
    // и список карточек «схлопывался» в заглушку.
    if (cell.houses === 4) {
      const othersReady = group.every((c) => c.id === cell.id || c.houses >= 4);
      if (!othersReady) {
        return { ok: false, reason: "Сначала по 4 дома на остальных клетках" };
      }
    }
  }
  if (me.money < cell.housePrice) {
    return { ok: false, reason: "Недостаточно денег" };
  }
  return { ok: true };
}

/** Сколько клеток данной группы должно быть у игрока для монополии. */
function countInGroup(state: GameState, cell: Cell): number {
  return state.board.filter((c) => c.type === "PROPERTY" && c.group === cell.group).length;
}

/**
 * Эвристика «можно ли продать» на клиенте (для UI-кнопки).
 *
 * Зеркалит `BuildService.canSell` на сервере: правило лесенки
 * (cell.houses >= любой другой клетки группы) достаточно И для домов,
 * И для отелей. Раньше был дополнительный чек «остальные = 0», который
 * создавал дедлок [5, 5, 5] — ни один отель нельзя продать. Удалён.
 */
function clientCanSell(cell: Cell, state: GameState, me: Player): { ok: boolean; reason?: string } {
  if (cell.type !== "PROPERTY") return { ok: false, reason: "Это не обычная недвижимость" };
  if (cell.ownerId !== me.id) return { ok: false, reason: "Это не ваша клетка" };
  if (cell.houses === 0) return { ok: false, reason: "Нет домов" };
  if (cell.group) {
    const group = state.board.filter(
      (c) => c.type === "PROPERTY" && c.group === cell.group && c.ownerId === me.id,
    );
    const maxH = Math.max(...group.map((c) => c.houses));
    if (cell.houses < maxH) {
      return { ok: false, reason: "Соблюдайте порядок продажи (лесенка)" };
    }
  }
  return { ok: true };
}

/** Эвристика «можно ли заложить» на клиенте (для UI-кнопки). */
function clientCanMortgage(
  cell: Cell,
  state: GameState,
  me: Player,
): { ok: boolean; reason?: string } {
  if (cell.isMortgaged) return { ok: false, reason: "Уже в залоге" };
  if (cell.ownerId !== me.id) return { ok: false, reason: "Не ваша клетка" };
  if (cell.mortgageValue === undefined) return { ok: false, reason: "Нельзя заложить" };
  if (cell.houses > 0) return { ok: false, reason: "Сначала продайте дома" };
  // Правило: нельзя закладывать, если в группе есть дома.
  if (cell.group) {
    const groupHasHouses = state.board.some(
      (c) => c.type === "PROPERTY" && c.group === cell.group && c.ownerId === me.id && c.houses > 0,
    );
    if (groupHasHouses) return { ok: false, reason: "В группе есть дома" };
  }
  return { ok: true };
}

/** Эвристика «можно ли выкупить» на клиенте (для UI-кнопки). */
function clientCanUnmortgage(
  cell: Cell,
  state: GameState,
  me: Player,
): { ok: boolean; reason?: string } {
  if (!cell.isMortgaged) return { ok: false, reason: "Не в залоге" };
  if (cell.ownerId !== me.id) return { ok: false, reason: "Не ваша клетка" };
  if (cell.mortgageValue === undefined) return { ok: false, reason: "Нет стоимости" };
  const cost = Math.ceil(cell.mortgageValue * 1.1);
  if (me.money < cost) return { ok: false, reason: "Недостаточно денег" };
  // Правило: нельзя выкупать, если в группе есть дома (по строгой версии
  // правил Монополии; мы следуем канону).
  if (cell.group) {
    const groupHasHouses = state.board.some(
      (c) => c.type === "PROPERTY" && c.group === cell.group && c.ownerId === me.id && c.houses > 0,
    );
    if (groupHasHouses) return { ok: false, reason: "Сначала продайте дома в группе" };
  }
  return { ok: true };
}

export const useBuildStore = defineStore("build", () => {
  const game = useGameStore();

  //  Local state

  /** Открыта ли модалка строительства. */
  const isOpen = ref<boolean>(false);

  /** Текст последней ошибки от сервера. */
  const lastError = ref<string | null>(null);

  //  Computed (server-of-truth)

  const state = computed<GameState | null>(() => game.state);

  /** Текущий игрок (для которого мы показываем модалку). */
  const me = computed<Player | null>(() => {
    if (!state.value) return null;
    return state.value.players.find((p) => p.kind === "human") ?? null;
  });

  /** Все клетки, принадлежащие мне. */
  const myProperties = computed<Cell[]>(() => {
    if (!state.value || !me.value) return [];
    return state.value.board.filter((c) => c.ownerId === me.value!.id);
  });

  /**
   * Клетки, на которых можно построить (для UI-кнопки «+»).
   * Возвращает массив { cell, canBuild, reason }.
   */
  const buildableProperties = computed<
    Array<{ cell: Cell; canBuild: boolean; reason?: string; cost: number; isHotelBuild: boolean }>
  >(() => {
    if (!state.value || !me.value) return [];
    return myProperties.value
      .filter((c) => c.type === "PROPERTY")
      .map((cell) => {
        const check = clientCanBuild(cell, state.value!, me.value!);
        return {
          cell,
          canBuild: check.ok,
          reason: check.reason,
          cost: cell.housePrice ?? 0,
          isHotelBuild: cell.houses === 4,
        };
      });
  });

  /** Клетки, на которых можно продать дом/отель. */
  const sellableProperties = computed<
    Array<{ cell: Cell; canSell: boolean; reason?: string; refund: number; isHotelSale: boolean }>
  >(() => {
    if (!state.value || !me.value) return [];
    return myProperties.value
      .filter((c) => c.type === "PROPERTY" && c.houses > 0)
      .map((cell) => {
        const check = clientCanSell(cell, state.value!, me.value!);
        // Возврат (refund) дублирует серверную логику `BuildService.canSell`:
        //  - для дома:  housePrice / 2;
        //  - для отеля: ТАКЖЕ housePrice / 2 (классические правила:
        //    отель «распадается» на 4 дома, refund как за 1 дом).
        const refund = cell.housePrice !== undefined ? Math.floor(cell.housePrice / 2) : 0;
        return {
          cell,
          canSell: check.ok,
          reason: check.reason,
          refund,
          isHotelSale: cell.houses === 5,
        };
      });
  });

  /** Клетки, которые можно заложить. */
  const mortgageableProperties = computed<
    Array<{ cell: Cell; canMortgage: boolean; reason?: string; amount: number }>
  >(() => {
    if (!state.value || !me.value) return [];
    return myProperties.value
      .filter((c) => c.mortgageValue !== undefined)
      .map((cell) => {
        const check = clientCanMortgage(cell, state.value!, me.value!);
        return {
          cell,
          canMortgage: check.ok,
          reason: check.reason,
          amount: cell.mortgageValue ?? 0,
        };
      });
  });

  /** Клетки, которые можно выкупить. */
  const unmortgageableProperties = computed<
    Array<{ cell: Cell; canUnmortgage: boolean; reason?: string; cost: number }>
  >(() => {
    if (!state.value || !me.value) return [];
    return myProperties.value
      .filter((c) => c.isMortgaged)
      .map((cell) => {
        const check = clientCanUnmortgage(cell, state.value!, me.value!);
        return {
          cell,
          canUnmortgage: check.ok,
          reason: check.reason,
          cost: cell.mortgageValue !== undefined ? Math.ceil(cell.mortgageValue * 1.1) : 0,
        };
      });
  });

  /**
   * Сводные счётчики для активности кнопки «Строить» в ActionsPanel.
   * (дублируют логику canOpenBuildingPhase на сервере)
   */
  const counts = computed(() => ({
    buildable: buildableProperties.value.filter((p) => p.canBuild).length,
    sellable: sellableProperties.value.filter((p) => p.canSell).length,
  }));

  //  Actions

  /** Открыть модалку. */
  function open(): void {
    lastError.value = null;
    isOpen.value = true;
  }

  /** Закрыть модалку (без отправки на сервер). */
  function close(): void {
    lastError.value = null;
    isOpen.value = false;
  }

  /**
   * Закрыть модалку и подтвердить выход (отправить CONFIRM_BUILDING_PHASE
   * на сервер). Сервер переведёт фазу обратно в BUILDING.
   */
  function confirmAndClose(): void {
    lastError.value = null;
    isOpen.value = false;
    game.sendAction({ type: "CONFIRM_BUILDING_PHASE" });
  }

  /** Построить дом/отель. */
  function build(cellId: number): void {
    lastError.value = null;
    game.sendAction({ type: "BUILD_HOUSE", cellId });
  }

  /** Продать дом/отель. */
  function sell(cellId: number): void {
    lastError.value = null;
    game.sendAction({ type: "SELL_HOUSE", cellId });
  }

  /** Заложить клетку. */
  function mortgage(cellId: number): void {
    lastError.value = null;
    game.sendAction({ type: "MORTGAGE_PROPERTY", cellId });
  }

  /** Выкупить клетку. */
  function unmortgage(cellId: number): void {
    lastError.value = null;
    game.sendAction({ type: "UNMORTGAGE_PROPERTY", cellId });
  }

  function setError(msg: string | null): void {
    lastError.value = msg;
  }

  return {
    // state
    isOpen,
    lastError,
    // computed
    state,
    me,
    myProperties,
    buildableProperties,
    sellableProperties,
    mortgageableProperties,
    unmortgageableProperties,
    counts,
    // actions
    open,
    close,
    confirmAndClose,
    build,
    sell,
    mortgage,
    unmortgage,
    setError,
  };
});
