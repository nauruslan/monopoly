/**
 * HoldableCardsRegistry — единый источник истины для holdable карт игрока.
 *
 * DeckModule: `player.holdableCards: Record<cardId, HoldableCardEntry>`.
 *
 * Этот модуль предоставляет:
 *  - `countHoldableCards(player)` — сколько карт у игрока;
 *  - `syncHoldableCards(player, state, { delta, cardId, templateId })` — добавить/убрать карту;
 *  - `grantJailFreeCard(player, state, templateId)` — применить `jail-free` эффект через DeckService;
 *  - `consumeHoldableJailCard(player, state)` — использовать holdable jail-free карту;
 *  - `backfillHoldableCards(state)` — инициализация пустых `holdableCards` для всех игроков;
 *  - `hasHoldableCard`, `listHoldableCardIds`, `pickHoldableCardIds` — утилиты.
 */
import type { Player, GameState, Card } from "@monopoly/shared";
import { CHANCE_CARDS, TREASURY_CARDS, LUXURY_TAX_CARDS } from "@monopoly/shared";
import type { CardInstance, HoldableCardEntry, CardTemplate } from "./types";
import { findCardByIdSafe, holdCardInHand, useCardFromHand } from "./deck.service";
import { ensureDecksInitialized } from "./deck-state-adapter";

// Расширение Player и GameState через declaration merging.

declare module "@monopoly/shared" {
  interface Player {
    /**
     * Карты, удерживаемые игроком (`holdInHand = true`).
     *
     * Ключ — `cardId` (uuid v4, см. {@link CardInstance.cardId}).
     * Значение — метаданные для UI/логики.
     */
    holdableCards?: Record<string, HoldableCardEntry>;
  }

  interface GameState {
    /** Обратный индекс: playerId → карты этого игрока (кэш для UI). */
    holdableCardsByPlayer?: Record<string, string[]>;
  }
}

// API.

/**
 * Количество holdable карт у игрока.
 */
export function countHoldableCards(player: Player): number {
  if (!player.holdableCards) return 0;
  return Object.keys(player.holdableCards).length;
}

/**
 * Синхронизация `holdableCards` (новый слой) с обновлением `state.holdableCardsByPlayer`.
 *
 * Если `delta > 0` — добавляет запись в `holdableCards`;
 * Если `delta < 0` — удаляет запись по `cardId`.
 *
 * @param player целевой игрок
 * @param state GameState с инициализированным DeckModule
 * @param opts.delta +1/-1
 * @param opts.templateId ID шаблона (например, "ch7")
 * @param opts.cardId ID карты в DeckModule
 */
export function syncHoldableCards(
  player: Player,
  state: GameState,
  opts: {
    delta: 1 | -1;
    templateId?: string;
    cardId?: string;
  },
): void {
  const { delta, templateId, cardId } = opts;

  if (!player.holdableCards) player.holdableCards = {};
  if (!state.holdableCardsByPlayer) state.holdableCardsByPlayer = {};

  if (delta > 0) {
    if (!cardId || !templateId) {
      // Без cardId нельзя создать placeholder — просто no-op.
      return;
    }
    // Привязываем cardId → player.
    player.holdableCards[cardId] = {
      templateId,
      drawnAt: new Date().toISOString(),
      originDeckId: state.deckCards?.find((c) => c.cardId === cardId)?.originDeckId ?? "",
    };
    if (!state.holdableCardsByPlayer[player.id]) {
      state.holdableCardsByPlayer[player.id] = [];
    }
    if (!state.holdableCardsByPlayer[player.id]!.includes(cardId)) {
      state.holdableCardsByPlayer[player.id]!.push(cardId);
    }
  } else {
    // delta < 0: убираем.
    if (cardId) {
      delete player.holdableCards[cardId];
    }
    if (state.holdableCardsByPlayer[player.id]) {
      state.holdableCardsByPlayer[player.id] = state.holdableCardsByPlayer[player.id]!.filter(
        (id) => id !== cardId,
      );
    }
  }
}

/**
 * Применить `jail-free` эффект через DeckModule.
 *
 * Возвращает `null`, если соответствующей карты нет в колоде.
 */
export function grantJailFreeCard(
  player: Player,
  state: GameState,
  templateId: string,
  opts?: { drawnCardId?: string | null },
): { cardId: string } | null {
  ensureDecksInitialized(state);
  const cards = state.deckCards ?? [];
  let card: (typeof cards)[0] | undefined;
  if (opts?.drawnCardId) {
    // Если передан drawnCardId (только что вытянутая карта),
    // ищем её конкретным ID, а не по шаблону/состоянию.
    // Это критично: вытянутая карта в состоянии DRAWN/RESOLVING,
    // а не IN_DECK, поэтому старый поиск её не находил.
    card = cards.find((c) => c.cardId === opts.drawnCardId);
  }
  if (!card) {
    // Fallback: поиск по шаблону и состоянию IN_DECK (для совместимости).
    card = cards.find((c) => c.templateId === templateId && c.state === "IN_DECK");
  }
  if (!card) return null;

  const templatesById = new Map<string, CardTemplate>();
  templatesById.set(templateId, {
    templateId,
    deckType: card.originDeckId.includes("treasury") ? "COMMUNITY_CHEST" : "CHANCE",
    title: templateId,
    text: "",
    holdInHand: true,
    transferable: false,
    effect: { kind: "jail-free" } as never,
  });

  const ctx = {
    gameId: state.id,
    decks: state.decks ?? [],
    cards,
    templatesById,
    emptyDeckPolicy: "SKIP_DRAW" as const,
  };
  const result = holdCardInHand(ctx, { cardId: card.cardId, playerId: player.id });
  state.decks = result.decks;
  state.deckCards = result.cards;

  syncHoldableCards(player, state, {
    delta: 1,
    templateId,
    cardId: card.cardId,
  });

  return { cardId: card.cardId };
}

/**
 * Использовать holdable jail-free карту.
 *
 * @returns ID использованной карты или `null`, если у игрока нет holdable.
 */
export function consumeHoldableJailCard(player: Player, state: GameState): string | null {
  if (!player.holdableCards) return null;
  const heldCardIds = Object.keys(player.holdableCards);
  if (heldCardIds.length === 0) return null;
  const cardId = heldCardIds[0]!;

  if (!state.deckCards) return null;
  const card = findCardByIdSafe(state.deckCards, cardId);
  if (!card) return null;

  const templatesById = new Map<string, CardTemplate>();
  templatesById.set(card.templateId, {
    templateId: card.templateId,
    deckType: "CHANCE",
    title: card.templateId,
    text: "",
    holdInHand: true,
    transferable: false,
    effect: { kind: "jail-free" } as never,
  });

  const result = useCardFromHand(
    {
      gameId: state.id,
      decks: state.decks ?? [],
      cards: state.deckCards,
      templatesById,
      emptyDeckPolicy: "SKIP_DRAW",
    },
    { cardId, playerId: player.id },
  );
  state.decks = result.decks;
  state.deckCards = result.cards;

  syncHoldableCards(player, state, { delta: -1, cardId, templateId: card.templateId });
  return cardId;
}

/**
 * Инициализация `holdableCards` для всех игроков (если поле отсутствует).
 *
 * Используется в `games.service.ts` сразу после восстановления состояния
 * из БД, чтобы у всех игроков был инициализирован пустой объект
 * `holdableCards` (а не `undefined`).
 *
 * ВАЖНО: если DeckModule не инициализирован (нет `state.deckCards`),
 * функция является no-op — мы НЕ инициализируем `holdableCards = {}`
 * для игроков, потому что без колод карт всё равно нечего держать в
 * руке, а преждевременная инициализация ломает контракт «поле
 * остаётся undefined, пока не было ни одной холдабельной карты».
 */
export function backfillHoldableCards(state: GameState): void {
  // no-op если DeckModule не инициализирован (нет deckCards).
  if (!state.deckCards || state.deckCards.length === 0) {
    return;
  }
  for (const player of state.players) {
    if (!player.holdableCards) {
      player.holdableCards = {};
    }
  }
}

/**
 * Проверить, есть ли у игрока holdable карта по `cardId`.
 */
export function hasHoldableCard(player: Player, cardId: string): boolean {
  if (!player.holdableCards) return false;
  return player.holdableCards[cardId] !== undefined;
}

/**
 * Список всех `cardId` карт игрока.
 *
 * Возвращает пустой массив, если `holdableCards` нет или пуст.
 */
export function listHoldableCardIds(player: Player): string[] {
  if (!player.holdableCards) return [];
  return Object.keys(player.holdableCards);
}

/**
 * Найти шаблон карты по её `templateId` в общем справочнике.
 *
 * Используется для отображения карточки в UI (CardModal.vue работает
 * с `Card` из shared, а не с CardTemplate).
 */
export function findCardByTemplateId(templateId: string): Card | null {
  const sources: readonly (readonly Card[])[] = [CHANCE_CARDS, TREASURY_CARDS, LUXURY_TAX_CARDS];
  for (const src of sources) {
    const found = src.find((c) => c.id === templateId);
    if (found) return found;
  }
  return null;
}

export function pickHoldableCardIds(state: GameState, playerId: string, count: number): string[] {
  if (!state.deckCards || count <= 0) return [];
  const result: string[] = [];
  for (const c of state.deckCards) {
    if (c.state === "IN_HAND" && c.holderPlayerId === playerId) {
      result.push(c.cardId);
      if (result.length >= count) break;
    }
  }
  return result;
}
export type { CardInstance };
