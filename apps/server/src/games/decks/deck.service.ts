/**
 * DeckService — бизнес-логика работы с картами колоды.
 *
 * ОТВЕТСТВЕННОСТЬ:
 *  - взять верхнюю карту из колоды (DRAW);
 *  - положить карту в низ колоды (RETURN);
 *  - перевести карту в RESOLVING (для UI);
 *  - перевести карту в IN_HAND (HOLD, только если `holdInHand`);
 *  - сжечь карту (USE, IN_HAND → USED);
 *  - передать карту другому игроку (TRANSFER);
 *  - перемешать пустую/снятую колоду (RESHUFFLE).
 *
 * СЕРВИС ЧИСТО ФУНКЦИОНАЛЬНЫЙ: НЕ мутирует `state`, а возвращает новые
 * списки колод/карт и список событий. Это упрощает тестирование и
 * интеграцию в `GamesService.applyAction`.
 *
 * ЗАВИСИМОСТИ (через параметры):
 *  - шаблоны карт (`templatesById`) — для проверок `holdInHand`, `transferable`;
 *  - RNG — для reshuffle.
 */
import { randomUUID } from "crypto";

import type {
  CardInstance,
  CardState,
  CardTemplate,
  DeckInstance,
  DeckType,
  EmptyDeckPolicy,
} from "./types";
import {
  CardCannotBeHeldError,
  CardCannotBeTransferredError,
  CardNotFoundError,
  CardNotInHandError,
  CardOriginMismatchError,
  DeckEmptyError,
  DeckNotFoundError,
  InvalidCardStateError,
} from "./errors";
import type { Rng } from "./rng";
import { fisherYates } from "./shuffle";
import type { DeckEvent } from "./events";

// Контекст сервиса — всё, что нужно для операций.

/**
 * Контекст для операций DeckService.
 *
 * Передаётся как параметр во все методы вместо глобального `state`.
 * Так сервис остаётся чисто-функциональным и легко тестируется.
 */
export interface DeckContext {
  /** ID партии. */
  readonly gameId: string;
  /** Все колоды партии (по всем типам и клеткам). */
  readonly decks: readonly DeckInstance[];
  /** Глобальный список всех карт партии. */
  readonly cards: readonly CardInstance[];
  /** Шаблоны, индексированные по `templateId` (для проверок hold/transfer). */
  readonly templatesById: ReadonlyMap<string, CardTemplate>;
  /** Политика для пустых колод (как обрабатывать `drawCard` на пустой колоде). */
  readonly emptyDeckPolicy: EmptyDeckPolicy;
  /** Опциональный RNG; если не задан — необходим для reshuffle. */
  readonly rng?: Rng;
}

/**
 * Результат операции: новые колоды, карты и список событий.
 */
export interface DeckOperationResult {
  readonly decks: DeckInstance[];
  readonly cards: CardInstance[];
  readonly events: DeckEvent[];
}

// Утилиты поиска

function findDeckById(ctx: DeckContext, deckId: string): DeckInstance {
  const deck = ctx.decks.find((d) => d.deckId === deckId);
  if (!deck) throw new DeckNotFoundError(deckId);
  return deck;
}

function findCardById(ctx: DeckContext, cardId: string): CardInstance {
  const card = ctx.cards.find((c) => c.cardId === cardId);
  if (!card) throw new CardNotFoundError(cardId);
  return card;
}

/**
 * Экспортированная версия `findCardById` для использования из адаптеров.
 * Не бросает — возвращает `undefined` для безопасного использования в реестрах.
 */
export function findCardByIdSafe(
  cards: readonly CardInstance[],
  cardId: string,
): CardInstance | undefined {
  return cards.find((c) => c.cardId === cardId);
}

/**
 * Ищет колоду, к которой привязана карта (по `originDeckId`).
 */
function findOriginDeck(ctx: DeckContext, card: CardInstance): DeckInstance {
  return findDeckById(ctx, card.originDeckId);
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Хелпер: добавляет к событию `gameId` и `timestamp`, возвращает `DeckEvent`.
 *
 * Используем `Record<string, unknown>` для свободного literal-объекта,
 * чтобы избежать проблем TS с `Omit<DiscriminatedUnion, ...>`.
 * Типизация обеспечивается вызывающим (см. `satisfies`-паттерн ниже
 * и явные `as` в каждой ветке).
 */
function makeEvent(ev: { type: DeckEvent["type"] } & Record<string, unknown>): DeckEvent {
  return { ...ev, gameId: "", timestamp: nowIso() } as DeckEvent;
}

// DRAW: вытянуть верхнюю карту из колоды.

/**
 * Параметры DRAW.
 */
export interface DrawParams {
  readonly boardFieldId: number;
  readonly playerId: string;
}

/**
 * Результат DRAW.
 */
export interface DrawResult {
  readonly cards: CardInstance[];
  readonly decks: DeckInstance[];
  readonly drawnCard: CardInstance;
  readonly deck: DeckInstance;
  readonly events: DeckEvent[];
}

/**
 * DRAW карты из колоды на конкретной клетке.
 */
export function drawCard(ctx: DeckContext, params: DrawParams): DrawResult {
  // 1) Поиск колоды по `boardFieldId`.
  const deck = ctx.decks.find((d) => d.boardFieldId === params.boardFieldId);
  if (!deck) {
    throw new DeckNotFoundError(`by boardFieldId=${params.boardFieldId}`);
  }

  let workingDecks = ctx.decks as readonly DeckInstance[];
  let workingCards = ctx.cards as readonly CardInstance[];
  let topCardId: string | undefined = deck.topToBottom[0];
  /** События, появившиеся на шаге empty-policy (RETURN_HELD_CARDS). */
  let policyEvents: DeckEvent[] = [];

  // 2) Пустая колода — применяем политику.
  if (!topCardId) {
    if (ctx.emptyDeckPolicy === "SKIP_DRAW") {
      throw new DeckEmptyError(deck.deckId, { operation: "draw" });
    }
    if (ctx.emptyDeckPolicy === "ERROR") {
      throw new DeckEmptyError(deck.deckId, { operation: "draw" });
    }
    if (ctx.emptyDeckPolicy === "WAIT") {
      // В MVP — same as SKIP_DRAW: колода пуста — карту взять нельзя.
      throw new DeckEmptyError(deck.deckId, { operation: "draw", policy: "WAIT" });
    }
    // RETURN_HELD_CARDS: пытаемся вернуть IN_HAND карты этой колоды в её низ,
    // затем повторить добор.
    if (ctx.emptyDeckPolicy === "RETURN_HELD_CARDS") {
      const returned = returnAllHeldCardsInternal(
        { ...ctx, cards: workingCards, decks: workingDecks },
        deck,
      );
      workingCards = returned.cards;
      workingDecks = returned.decks;
      policyEvents = returned.events;
      // Используем обновлённую колоду, а не старую ссылку.
      const updatedDeck = workingDecks.find((d) => d.deckId === deck.deckId)!;
      topCardId = updatedDeck.topToBottom[0];
      if (!topCardId) {
        throw new DeckEmptyError(deck.deckId, {
          operation: "draw",
          policy: "RETURN_HELD_CARDS",
        });
      }
    }
  }

  // 3) Снимаем верхнюю.
  const drawnCard = findCardById({ ...ctx, cards: workingCards }, topCardId);
  if (drawnCard.state !== "IN_DECK") {
    throw new InvalidCardStateError(drawnCard.cardId, drawnCard.state, "IN_DECK");
  }
  if (drawnCard.originDeckId !== deck.deckId) {
    throw new CardOriginMismatchError(drawnCard.cardId, drawnCard.originDeckId, deck.deckId);
  }

  const newTopToBottom = deck.topToBottom.slice(1);
  const drawnAt = nowIso();
  const newCard: CardInstance = {
    ...drawnCard,
    state: "DRAWN",
    drawnAt,
  };

  const newDecks = (workingDecks as DeckInstance[]).map((d) =>
    d.deckId === deck.deckId ? { ...d, topToBottom: newTopToBottom } : d,
  );
  const newCards = (workingCards as CardInstance[]).map((c) =>
    c.cardId === drawnCard.cardId ? newCard : c,
  );

  const event = makeEvent({
    type: "CARD_DRAWN",
    deckId: deck.deckId,
    cardId: drawnCard.cardId,
    deckType: deck.deckType,
    playerId: params.playerId,
    fromIndex: 0,
  });
  // Гейтвей для `gameId` — GamesService перезапишет при желании.
  (event as { gameId: string }).gameId = ctx.gameId;

  return {
    cards: newCards,
    decks: newDecks,
    drawnCard: newCard,
    deck: { ...deck, topToBottom: newTopToBottom },
    events: [...policyEvents, event],
  };
}

// RETURN: вернуть карту в низ колоды.

/**
 * Параметры RETURN.
 */
export interface ReturnParams {
  readonly cardId: string;
  /** Причина: `RESOLVED` — обычный stay; `DROPPED` — игрок сознательно сбросил. */
  readonly reason: "RESOLVED" | "DROPPED";
}

/**
 * Возвращает карту в НИЗ колоды (как требуют правила Монополии).
 *
 * Состояние карты: `DRAWN` или `RESOLVING` → `IN_DECK`.
 */
export function returnCardToDeck(ctx: DeckContext, params: ReturnParams): DeckOperationResult {
  const card = findCardById(ctx, params.cardId);
  if (card.state !== "DRAWN" && card.state !== "RESOLVING") {
    throw new InvalidCardStateError(card.cardId, card.state, "DRAWN | RESOLVING → IN_DECK");
  }
  const deck = findOriginDeck(ctx, card);

  const newTopToBottom = [...deck.topToBottom, card.cardId];
  const newDecks = (ctx.decks as DeckInstance[]).map((d) =>
    d.deckId === deck.deckId ? { ...d, topToBottom: newTopToBottom } : d,
  );
  const newCard: CardInstance = {
    ...card,
    state: "IN_DECK",
    holderPlayerId: undefined,
    drawnAt: undefined,
  };
  const newCards = (ctx.cards as CardInstance[]).map((c) =>
    c.cardId === card.cardId ? newCard : c,
  );

  const event = makeEvent({
    type: "CARD_RETURNED",
    deckId: deck.deckId,
    cardId: card.cardId,
    reason: params.reason,
    toIndex: newTopToBottom.length - 1,
  });
  (event as { gameId: string }).gameId = ctx.gameId;

  return {
    decks: newDecks,
    cards: newCards,
    events: [event],
  };
}

// RESOLVE: перевести карту в RESOLVING (для UI и для move-эффектов).

export function markCardResolving(
  ctx: DeckContext,
  cardId: string,
  playerId: string,
): DeckOperationResult {
  const card = findCardById(ctx, cardId);
  if (card.state !== "DRAWN") {
    throw new InvalidCardStateError(card.cardId, card.state, "DRAWN");
  }
  const deck = findOriginDeck(ctx, card);

  const newCard: CardInstance = { ...card, state: "RESOLVING" };
  const newCards = (ctx.cards as CardInstance[]).map((c) => (c.cardId === cardId ? newCard : c));

  const event = makeEvent({
    type: "CARD_RESOLVING",
    deckId: deck.deckId,
    cardId: card.cardId,
    playerId,
    nextState: "RESOLVING" as const,
  });
  (event as { gameId: string }).gameId = ctx.gameId;

  return {
    decks: ctx.decks as DeckInstance[],
    cards: newCards,
    events: [event as DeckEvent],
  };
}

// HOLD: перевести карту в IN_HAND (только для holdable).

/**
 * Параметры HOLD.
 */
export interface HoldParams {
  readonly cardId: string;
  readonly playerId: string;
}

/**
 * Перевести карту в руку игрока (IN_HAND).
 *
 * Требует, чтобы шаблон карты имел `holdInHand = true` (например, "Выход из тюрьмы").
 * Состояние: `DRAWN` или `RESOLVING` → `IN_HAND`.
 */
export function holdCardInHand(ctx: DeckContext, params: HoldParams): DeckOperationResult {
  const card = findCardById(ctx, params.cardId);
  if (card.state !== "DRAWN" && card.state !== "RESOLVING") {
    throw new InvalidCardStateError(card.cardId, card.state, "DRAWN | RESOLVING → IN_HAND");
  }
  const template = ctx.templatesById.get(card.templateId);
  if (!template) {
    throw new InvalidCardStateError(card.cardId, card.state, "IN_HAND (template not found)");
  }
  if (!template.holdInHand) {
    throw new CardCannotBeHeldError(card.cardId, card.templateId);
  }

  const newCard: CardInstance = {
    ...card,
    state: "IN_HAND",
    holderPlayerId: params.playerId,
  };
  const newCards = (ctx.cards as CardInstance[]).map((c) =>
    c.cardId === card.cardId ? newCard : c,
  );

  const event = makeEvent({
    type: "CARD_HELD",
    deckId: card.originDeckId,
    cardId: card.cardId,
    playerId: params.playerId,
    attached: true as const,
  });
  (event as { gameId: string }).gameId = ctx.gameId;

  return {
    decks: ctx.decks as DeckInstance[],
    cards: newCards,
    events: [event as DeckEvent],
  };
}

// USE: сжечь карту из руки (IN_HAND → USED).

export interface UseCardParams {
  readonly cardId: string;
  readonly playerId: string;
}

/**
 * Результат использования карты.
 */
export interface UseCardResult extends DeckOperationResult {
  readonly card: CardInstance;
  readonly template: CardTemplate;
}

/**
 * Использовать карту из руки (IN_HAND → USED).
 */
export function useCardFromHand(ctx: DeckContext, params: UseCardParams): UseCardResult {
  const card = findCardById(ctx, params.cardId);
  if (card.state !== "IN_HAND") {
    // Бросаем CardNotInHandError с контекстом текущего состояния.
    throw new CardNotInHandError(card.cardId, { currentState: card.state });
  }

  const template = ctx.templatesById.get(card.templateId);
  if (!template) {
    throw new InvalidCardStateError(card.cardId, card.state, "USED (template missing)");
  }

  const usedAt = nowIso();
  const newCard: CardInstance = {
    ...card,
    state: "USED",
    usedAt,
  };
  const newCards = (ctx.cards as CardInstance[]).map((c) =>
    c.cardId === card.cardId ? newCard : c,
  );

  const event = makeEvent({
    type: "CARD_USED",
    deckId: card.originDeckId,
    cardId: card.cardId,
    playerId: params.playerId,
  });
  (event as { gameId: string }).gameId = ctx.gameId;

  return {
    decks: ctx.decks as DeckInstance[],
    cards: newCards,
    card: newCard,
    template,
    events: [event],
  };
}

// TRANSFER: передать карту другому игроку (IN_HAND → IN_HAND, новый owner).

export interface TransferParams {
  readonly cardId: string;
  readonly fromPlayerId: string;
  readonly toPlayerId: string;
}

/**
 * Передать карту другому игроку.
 *
 * Требует:
 *  - `template.transferable = true`;
 *  - `card.state === "IN_HAND"`.
 *
 * Физически карта остаётся в той же колоде (одинаковый `originDeckId`),
 * но смену владельца отслеживает `GamesService` через `holdableCards[playerId]`.
 */
export function transferCard(ctx: DeckContext, params: TransferParams): DeckOperationResult {
  const card = findCardById(ctx, params.cardId);
  if (card.state !== "IN_HAND") {
    throw new CardNotInHandError(card.cardId, { currentState: card.state });
  }

  const template = ctx.templatesById.get(card.templateId);
  if (!template || !template.transferable) {
    throw new CardCannotBeTransferredError(card.cardId, card.templateId);
  }

  const newCard: CardInstance = {
    ...card,
    holderPlayerId: params.toPlayerId,
  };
  const newCards = (ctx.cards as CardInstance[]).map((c) =>
    c.cardId === card.cardId ? newCard : c,
  );

  const event = makeEvent({
    type: "CARD_TRANSFERRED",
    deckId: card.originDeckId,
    cardId: card.cardId,
    fromPlayerId: params.fromPlayerId,
    toPlayerId: params.toPlayerId,
  });
  (event as { gameId: string }).gameId = ctx.gameId;

  return {
    decks: ctx.decks as DeckInstance[],
    cards: newCards,
    events: [event],
  };
}

// RESHUFFLE — перемешать колоду (например, RESHUFFLE_AT_EMPTY).

export interface ReshuffleParams {
  readonly deckId: string;
}

/**
 * Принудительно перемешать колоду.
 *
 * Карты должны быть в состоянии `IN_DECK` (USЕD — фильтруем).
 * После reshuffle порядок `topToBottom` полностью пересоздаётся.
 */
export function reshuffleDeck(ctx: DeckContext, params: ReshuffleParams): DeckOperationResult {
  const deck = findDeckById(ctx, params.deckId);
  return reshuffleDeckInternal(ctx, deck);
}

function reshuffleDeckInternal(ctx: DeckContext, deck: DeckInstance): DeckOperationResult {
  const deckCardIds = ctx.cards
    .filter((c) => c.originDeckId === deck.deckId && c.state === "IN_DECK")
    .map((c) => c.cardId);

  const rng = ctx.rng;
  if (!rng) {
    throw new InvalidCardStateError(deck.deckId, "no rng", "rng required for reshuffle");
  }
  const newOrder = fisherYates(deckCardIds, rng);

  const newDecks = (ctx.decks as DeckInstance[]).map((d) =>
    d.deckId === deck.deckId ? { ...d, topToBottom: newOrder } : d,
  );

  const event = makeEvent({
    type: "DECK_RESHUFFLED",
    deckId: deck.deckId,
    deckType: deck.deckType,
    seed: rng.seed,
    cardCount: newOrder.length,
  });
  (event as { gameId: string }).gameId = ctx.gameId;

  return {
    decks: newDecks,
    cards: ctx.cards as CardInstance[],
    events: [event],
  };
}

/**
 * Принудительно вернуть все IN_HAND карты указанной колоды в её конец.
 * Используется политикой `RETURN_HELD_CARDS`.
 *
 * НЕ мутирует `ctx`, возвращает новые `cards`/`decks`.
 */
function returnAllHeldCardsInternal(ctx: DeckContext, deck: DeckInstance): DeckOperationResult {
  const heldCardIds = ctx.cards
    .filter((c) => c.originDeckId === deck.deckId && c.state === "IN_HAND")
    .map((c) => c.cardId);

  if (heldCardIds.length === 0) {
    return {
      decks: ctx.decks as DeckInstance[],
      cards: ctx.cards as CardInstance[],
      events: [],
    };
  }

  const newTopToBottom = [...deck.topToBottom, ...heldCardIds];
  const newDecks = (ctx.decks as DeckInstance[]).map((d) =>
    d.deckId === deck.deckId ? { ...d, topToBottom: newTopToBottom } : d,
  );
  const heldSet = new Set(heldCardIds);
  const newCards = (ctx.cards as CardInstance[]).map((c) =>
    heldSet.has(c.cardId) ? { ...c, state: "IN_DECK" as CardState, holderPlayerId: undefined } : c,
  );

  // Для каждой возвращённой карты — отдельное событие.
  const events: DeckEvent[] = heldCardIds.map((cid) => {
    const ev = makeEvent({
      type: "CARD_RETURNED" as const,
      deckId: deck.deckId,
      cardId: cid,
      reason: "RESOLVED" as const,
      toIndex: newTopToBottom.indexOf(cid),
    });
    (ev as { gameId: string }).gameId = ctx.gameId;
    return ev;
  });

  return {
    decks: newDecks,
    cards: newCards,
    events,
  };
}

// QUERY: прочитать текущее состояние без мутации.

/**
 * Получить верхнюю карту колоды БЕЗ её удаления (peek).
 *
 * Если колода пуста или не найдена — вернёт `null`.
 */
export function peekTopCard(ctx: DeckContext, boardFieldId: number): CardInstance | null {
  const deck = ctx.decks.find((d) => d.boardFieldId === boardFieldId);
  if (!deck) return null;
  const id = deck.topToBottom[0];
  if (!id) return null;
  return ctx.cards.find((c) => c.cardId === id) ?? null;
}

/**
 * Получить все карты в состоянии `IN_HAND` (без фильтра по владельцу —
 * фильтрация по `playerId` — на стороне GamesService через `holdableCards`).
 */
export function cardsInHand(ctx: DeckContext): CardInstance[] {
  return ctx.cards.filter((c) => c.state === "IN_HAND");
}

/**
 * Сгенерировать уникальный `cardId`.
 */
export function newCardId(): string {
  return randomUUID();
}

/**
 * Re-export ошибок для удобства импорта.
 */
export {
  CardCannotBeHeldError,
  CardCannotBeTransferredError,
  CardNotFoundError,
  CardNotInHandError,
  CardOriginMismatchError,
  DeckEmptyError,
  DeckNotFoundError,
  InvalidCardStateError,
} from "./errors";

export type { CardState, DeckType };
