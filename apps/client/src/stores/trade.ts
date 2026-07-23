/**
 * useTradeStore — Pinia-store для торговли на клиенте (v2).
 *
 * Управляет двухэкранным UI:
 *  - Экран 1: «Выберите партнёра для обмена»
 *  - Экран 2: «Двухсторонняя панель обмена» (мои активы слева, его — справа)
 *  - Экран 3: «Уведомление о результате сделки» (показывается сразу после
 *    завершения обмена: принят/отклонён/отменён). Закрывается ТОЛЬКО кнопкой
 *    «Принять» в нижней части окна.
 *
 * Также предоставляет методы:
 *  - proposeOffer: создать новое предложение (TRADE_OFFER)
 *  - counter: встречное предложение (TRADE_COUNTER)
 *  - accept / reject / cancel
 *  - toggleBlock: блокировка/разблокировка игрока
 *  - setResult: выставить результат сделки (вызывается из game.ts при
 *    получении game:event с TRADE_COMPLETED / TRADE_REJECTED / TRADE_CANCELLED)
 *
 * Является UI-проекцией `state.trade` с сервера + локальная draft-копия
 * оффера во время редактирования.
 */
import { computed, ref } from "vue";
import { defineStore } from "pinia";
import { useGameStore } from "./game";
import type { GameState, Player, TradeOffer } from "@monopoly/shared";

/** Локальный draft оффера во время редактирования. */
export interface TradeDraft {
  fromProperties: number[];
  fromCash: number;
  fromJailCards: number;
  toProperties: number[];
  toCash: number;
  toJailCards: number;
}

/** Статус завершённой сделки (для экрана уведомления). */
export type TradeResultStatus = "accepted" | "rejected" | "cancelled";

/** Информация о результате завершённой сделки. */
export interface TradeResult {
  status: TradeResultStatus;
  /** Имя партнёра, с которым была сделка. */
  partnerName: string;
  /** Краткий заголовок (например, «Сделка состоялась!»). */
  title: string;
  /** Детали (что было передано, кто отказался и т.п.). */
  details: string;
}

function emptyDraft(): TradeDraft {
  return {
    fromProperties: [],
    fromCash: 0,
    fromJailCards: 0,
    toProperties: [],
    toCash: 0,
    toJailCards: 0,
  };
}

export const useTradeStore = defineStore("trade", () => {
  const game = useGameStore();

  // Setup

  const myPlayerId = ref<string | null>(null);
  function setMyPlayerId(id: string | null) {
    myPlayerId.value = id;
  }

  // Local state

  /** Экран UI: "closed" | "select-partner" | "compose" | "result" */
  const screen = ref<"closed" | "select-partner" | "compose" | "result">("closed");

  /** Выбранный партнёр (ID) — на экране выбора и в форме. */
  const selectedRecipientId = ref<string | null>(null);

  /** Локальный draft оффера во время редактирования. */
  const draft = ref<TradeDraft>(emptyDraft());

  /** Сообщение об ошибке (от сервера) для отображения в модалке. */
  const lastError = ref<string | null>(null);

  /**
   * Результат последней завершённой сделки (accepted/rejected/cancelled).
   * Используется для показа модального окна уведомления с кнопкой «Принять».
   * Пока `lastResult !== null`, модалка не может быть закрыта иначе как
   * нажатием на «Принять» в экране `result`.
   */
  const lastResult = ref<TradeResult | null>(null);

  // Computed (server-of-truth)

  const state = computed<GameState | null>(() => game.state);

  /** Текущая активная торговля (на сервере). */
  const trade = computed(() => state.value?.trade ?? null);

  /** Текущая фаза. */
  const phase = computed(() => state.value?.phase ?? "IDLE");

  /**
   * Текущая активная торговля ИЛИ черновик на экране compose ИЛИ экран
   * уведомления о результате. Пока хотя бы одно из этого активно — модалка
   * должна быть открыта.
   */
  const isOpen = computed<boolean>(
    () => trade.value !== null || screen.value !== "closed" || lastResult.value !== null,
  );

  /** Показывается ли сейчас экран уведомления о результате. */
  const isResultScreen = computed<boolean>(
    () => screen.value === "result" && lastResult.value !== null,
  );

  /** ID моего плеера (фолбэк — первый человек). */
  const me = computed<Player | null>(() => {
    if (!state.value) return null;
    if (myPlayerId.value) {
      return state.value.players.find((p) => p.id === myPlayerId.value) ?? null;
    }
    return state.value.players.find((p) => p.kind === "human") ?? null;
  });

  const myId = computed<string | null>(() => me.value?.id ?? null);

  /** Доступные партнёры: все живые, кроме меня. */
  const partners = computed<Player[]>(() => {
    if (!state.value || !myId.value) return [];
    return state.value.players.filter((p) => p.id !== myId.value && !p.isBankrupt);
  });

  /** Текущий выбранный партнёр. */
  const recipient = computed<Player | null>(() => {
    if (!selectedRecipientId.value || !state.value) return null;
    return state.value.players.find((p) => p.id === selectedRecipientId.value) ?? null;
  });

  /** Являюсь ли я текущим инициатором активного обмена? */
  const isInitiator = computed<boolean>(
    () => trade.value !== null && trade.value.initiatorId === myId.value,
  );

  /** Являюсь ли я стороной, которая сейчас должна ответить? */
  const isOnClock = computed<boolean>(
    () => trade.value !== null && trade.value.currentPartyId === myId.value,
  );

  /** В активном ли обмене мы сейчас (с сервера)? */
  const inActiveTrade = computed<boolean>(
    () =>
      trade.value !== null &&
      (phase.value === "TRADING_NEGOTIATE" || phase.value === "TRADING_CONFIRM"),
  );

  /** CONFIRM-фаза: показываем кнопки подтверждения, а не редактирование. */
  const isConfirmPhase = computed<boolean>(
    () => phase.value === "TRADING_CONFIRM" && trade.value !== null,
  );

  /** Свойства текущего партнёра (для UI). */
  const recipientProperties = computed(() => {
    if (!state.value || !recipient.value) return [];
    return state.value.board.filter((c) => c.ownerId === recipient.value!.id);
  });

  /** Мои свойства (для UI). */
  const myProperties = computed(() => {
    if (!state.value || !me.value) return [];
    return state.value.board.filter((c) => c.ownerId === me.value!.id);
  });

  /** Свойства, которые я могу отдать (без зданий). */
  const myTradableProperties = computed(() => {
    return myProperties.value.filter((c) => c.houses === 0);
  });

  /** Заблокировал ли партнёр меня (тогда инициировать нельзя). */
  const isBlockedByPartner = computed<boolean>(() => {
    if (!recipient.value) return false;
    return recipient.value.blockedPlayers?.includes(myId.value ?? "") ?? false;
  });

  /** Заблокировал ли я партнёра. */
  const iBlockedPartner = computed<boolean>(() => {
    if (!recipient.value || !me.value) return false;
    return me.value.blockedPlayers?.includes(recipient.value.id) ?? false;
  });

  // Actions

  /** Открыть экран выбора партнёра. */
  function openPartnerSelection(): void {
    // Нельзя открыть новую форму, пока висит уведомление о результате
    if (lastResult.value !== null) return;
    screen.value = "select-partner";
    selectedRecipientId.value = null;
    draft.value = emptyDraft();
    lastError.value = null;
  }

  /** Выбрать партнёра и перейти к экрану compose. */
  function selectPartner(playerId: string): void {
    selectedRecipientId.value = playerId;
    draft.value = emptyDraft();
    screen.value = "compose";
    lastError.value = null;
  }

  /** Вернуться к выбору партнёра. */
  function backToPartnerSelection(): void {
    screen.value = "select-partner";
    selectedRecipientId.value = null;
    draft.value = emptyDraft();
  }

  /**
   * Закрыть модалку.
   *  - Если на экране result — нельзя закрыть иначе как через acknowledgeResult().
   *  - Если активная торговля на сервере — нельзя закрыть.
   */
  function close(): void {
    if (isResultScreen.value) return; // закрывается только через «Принять»
    if (inActiveTrade.value) return; // нельзя закрыть, пока сервер ждёт
    screen.value = "closed";
    selectedRecipientId.value = null;
    draft.value = emptyDraft();
    lastError.value = null;
  }

  /**
   * Выставить результат сделки и переключиться на экран уведомления.
   * Вызывается из game.ts при получении game:event.
   */
  function setResult(result: TradeResult): void {
    lastResult.value = result;
    // Очищаем локальный draft и выбранного партнёра — сделка завершена
    selectedRecipientId.value = null;
    draft.value = emptyDraft();
    lastError.value = null;
    // Закрываем экран compose/waiting, чтобы перейти на result
    screen.value = "result";
  }

  /**
   * Закрыть экран уведомления о результате (нажатие «Принять»).
   * После этого модалка полностью скрывается, и игрок возвращается в игру.
   */
  function acknowledgeResult(): void {
    if (lastResult.value === null) return;
    lastResult.value = null;
    screen.value = "closed";
  }

  /** Переключить свою клетку в оффере (toggle). */
  function toggleMyProperty(cellId: number): void {
    const idx = draft.value.fromProperties.indexOf(cellId);
    if (idx >= 0) draft.value.fromProperties.splice(idx, 1);
    else draft.value.fromProperties.push(cellId);
  }

  /** Переключить клетку партнёра в оффере. */
  function toggleRecipientProperty(cellId: number): void {
    const idx = draft.value.toProperties.indexOf(cellId);
    if (idx >= 0) draft.value.toProperties.splice(idx, 1);
    else draft.value.toProperties.push(cellId);
  }

  /** Обновить сумму наличных. */
  function setFromCash(value: number): void {
    draft.value.fromCash = Math.max(0, Math.floor(value));
  }
  function setToCash(value: number): void {
    draft.value.toCash = Math.max(0, Math.floor(value));
  }

  /** Проверить draft на пустоту. */
  function isDraftEmpty(): boolean {
    const d = draft.value;
    return (
      d.fromProperties.length === 0 &&
      d.toProperties.length === 0 &&
      d.fromCash === 0 &&
      d.toCash === 0 &&
      d.fromJailCards === 0 &&
      d.toJailCards === 0
    );
  }

  /** Отправить оффер на сервер. */
  function proposeOffer(): boolean {
    if (!selectedRecipientId.value) {
      lastError.value = "Выберите партнёра";
      return false;
    }
    if (isDraftEmpty()) {
      lastError.value = "Сделка не может быть пустой";
      return false;
    }
    const offer: TradeOffer = {
      fromProperties: [...draft.value.fromProperties],
      fromCash: draft.value.fromCash,
      fromJailCards: draft.value.fromJailCards,
      toProperties: [...draft.value.toProperties],
      toCash: draft.value.toCash,
      toJailCards: draft.value.toJailCards,
    };
    game.sendAction({ type: "TRADE_OFFER", recipientId: selectedRecipientId.value, offer });
    return true;
  }

  /** Принять активный оффер. */
  function accept(): void {
    game.sendAction({ type: "TRADE_ACCEPT" });
  }

  /** Отклонить активный оффер. */
  function reject(): void {
    game.sendAction({ type: "TRADE_REJECT" });
  }

  /** Отменить активный оффер (только инициатор). */
  function cancel(): void {
    game.sendAction({ type: "TRADE_CANCEL" });
  }

  /** Встречное предложение (использует текущий draft). */
  function counter(): boolean {
    if (!trade.value) return false;
    if (isDraftEmpty()) {
      lastError.value = "Сделка не может быть пустой";
      return false;
    }
    const offer: TradeOffer = {
      fromProperties: [...draft.value.fromProperties],
      fromCash: draft.value.fromCash,
      fromJailCards: draft.value.fromJailCards,
      toProperties: [...draft.value.toProperties],
      toCash: draft.value.toCash,
      toJailCards: draft.value.toJailCards,
    };
    game.sendAction({ type: "TRADE_COUNTER", offer });
    return true;
  }

  /** Загрузить активный оффер в draft (для counter). */
  function loadActiveOfferIntoDraft(): void {
    if (!trade.value) return;
    const o = trade.value.offer;
    draft.value = {
      fromProperties: [...o.fromProperties],
      fromCash: o.fromCash,
      fromJailCards: o.fromJailCards,
      toProperties: [...o.toProperties],
      toCash: o.toCash,
      toJailCards: o.toJailCards,
    };
  }

  /** Переключить блокировку. */
  function toggleBlock(targetId: string): void {
    game.sendAction({ type: "TRADE_TOGGLE_BLOCK", targetId });
  }

  /** Установить сообщение об ошибке. */
  function setError(msg: string | null): void {
    lastError.value = msg;
  }

  return {
    // setup
    setMyPlayerId,
    // state
    screen,
    selectedRecipientId,
    draft,
    lastError,
    lastResult,
    // computed
    state,
    trade,
    phase,
    isOpen,
    isResultScreen,
    me,
    myId,
    partners,
    recipient,
    isInitiator,
    isOnClock,
    inActiveTrade,
    isConfirmPhase,
    recipientProperties,
    myProperties,
    myTradableProperties,
    isBlockedByPartner,
    iBlockedPartner,
    // actions
    openPartnerSelection,
    selectPartner,
    backToPartnerSelection,
    close,
    setResult,
    acknowledgeResult,
    toggleMyProperty,
    toggleRecipientProperty,
    setFromCash,
    setToCash,
    isDraftEmpty,
    proposeOffer,
    accept,
    reject,
    cancel,
    counter,
    loadActiveOfferIntoDraft,
    toggleBlock,
    setError,
  };
});
