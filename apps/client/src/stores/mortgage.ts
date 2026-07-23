/**
 * useMortgageStore — Pinia-store для UI модалки «Залог/Выкуп» на клиенте.
 *
 * ВНИМАНИЕ: Этот стор содержит ТОЛЬКО локальное UI-состояние
 * (открыта/закрыта модалка, последнее сообщение об ошибке).
 * ВСЯ валидация и финансовые расчёты делаются на сервере
 * (см. `MortgageService` в apps/server). Клиент только:
 *   - открывает/закрывает модалку;
 *   - шлёт `MORTGAGE_PROPERTY` / `UNMORTGAGE_PROPERTY` actions;
 *   - получает ошибки от сервера и отображает их.
 *
 * Решение «можно ли заложить/выкупить конкретную клетку» — это
 * зона ответственности сервера. Клиентская сторона лишь помогает
 * UI: для каждой клетки рисуем кнопку «Заложить» или «Выкупить»,
 * а сервер при попытке заложить вернёт понятную ошибку
 * («Сначала продайте ВСЕ дома в этой цветовой группе» и т.п.).
 */
import { computed, ref } from "vue";
import { defineStore } from "pinia";
import { useGameStore } from "./game";
import type { Cell, GameState, Player } from "@monopoly/shared";

export const useMortgageStore = defineStore("mortgage", () => {
  const game = useGameStore();

  //  Local state

  /** Открыта ли модалка залога/выкупа. */
  const isOpen = ref<boolean>(false);

  /**
   * Текст последней ошибки от сервера (например, «Недостаточно денег для выкупа»).
   * Отображается в модалке, очищается при следующей попытке.
   */
  const lastError = ref<string | null>(null);

  //  Computed (server-of-truth)

  const state = computed<GameState | null>(() => game.state);

  /** Текущий игрок (для которого мы показываем модалку). */
  const me = computed<Player | null>(() => {
    if (!state.value) return null;
    return state.value.players.find((p) => p.kind === "human") ?? null;
  });

  /**
   * Все клетки, принадлежащие мне (и заложенные, и нет).
   * Используется для отрисовки списка в модалке.
   */
  const myProperties = computed<Cell[]>(() => {
    if (!state.value || !me.value) return [];
    return state.value.board.filter((c) => c.ownerId === me.value!.id);
  });

  /**
   * Клетки, которые можно заложить (не заложены + нет домов в группе).
   * Клиентская эвристика — отражает правило «нет домов в группе».
   * Финальное решение всё равно остаётся за сервером.
   */
  const mortgageableProperties = computed<Cell[]>(() => {
    if (!state.value || !me.value) return [];
    return myProperties.value.filter((cell) => {
      if (cell.isMortgaged) return false;
      if (cell.mortgageValue === undefined) return false;
      if (cell.houses > 0) return false;
      // То же правило, что и в MortgageService.canMortgage:
      // в группе не должно быть домов на других клетках.
      if (cell.group) {
        const groupHasHouses = state.value!.board.some(
          (c) =>
            c.type === cell.type &&
            c.group === cell.group &&
            c.ownerId === me.value!.id &&
            c.houses > 0,
        );
        if (groupHasHouses) return false;
      }
      return true;
    });
  });

  /**
   * Клетки, которые можно выкупить (заложены + хватает денег).
   */
  const unmortgageableProperties = computed<Cell[]>(() => {
    if (!state.value || !me.value) return [];
    return myProperties.value.filter((cell) => {
      if (!cell.isMortgaged) return false;
      if (cell.mortgageValue === undefined) return false;
      const cost = Math.ceil(cell.mortgageValue * 1.1);
      return me.value!.money >= cost;
    });
  });

  /**
   * Стоимость выкупа клетки (mortgageValue × 1.1, округлено вверх).
   * Зеркалит серверную формулу из MortgageService.getUnmortgageCost.
   */
  function getUnmortgageCost(cell: Cell): number {
    if (cell.mortgageValue === undefined) return 0;
    return Math.ceil(cell.mortgageValue * 1.1);
  }

  //  Actions

  /** Открыть модалку залога/выкупа. */
  function open(): void {
    lastError.value = null;
    isOpen.value = true;
  }

  /** Закрыть модалку. */
  function close(): void {
    lastError.value = null;
    isOpen.value = false;
  }

  /**
   * Подтвердить модалку (кнопка «ПРИНЯТЬ» в нижней части).
   * Закрывает модалку и очищает ошибку.
   */
  function acknowledge(): void {
    lastError.value = null;
    isOpen.value = false;
  }

  /**
   * Заложить клетку (отправить MORTGAGE_PROPERTY).
   * @param cellId id клетки для залога
   */
  function mortgage(cellId: number): void {
    lastError.value = null;
    game.sendAction({ type: "MORTGAGE_PROPERTY", cellId });
  }

  /**
   * Выкупить клетку из залога (отправить UNMORTGAGE_PROPERTY).
   * @param cellId id клетки для выкупа
   */
  function unmortgage(cellId: number): void {
    lastError.value = null;
    game.sendAction({ type: "UNMORTGAGE_PROPERTY", cellId });
  }

  /**
   * Установить сообщение об ошибке (от сервера).
   * Используется из game.ts при обработке `action:result` с `ok=false`.
   */
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
    mortgageableProperties,
    unmortgageableProperties,
    getUnmortgageCost,
    // actions
    open,
    close,
    acknowledge,
    mortgage,
    unmortgage,
    setError,
  };
});
