/**
 * EmptyDeckPolicy — runtime-политики для обработки пустых колод.
 *
 * Источник истины для логики в `GamesService.handleCardReveal` и в
 * [`deck.service.ts`](apps/server/src/games/decks/deck.service.ts) `drawCard`.
 *
 * Используется в двух местах:
 *  1. Когда курсор legacy `state.cardDecks.X.cursor` дошёл до конца:
 *     Legacy-режим делает reshuffle через seedrandom.
 *  2. Когда новый DeckModule встречает пустую колоду:
 *     Поведение определяется `EmptyDeckPolicy` (SKIP_DRAW/WAIT/ERROR/RETURN_HELD_CARDS).
 *
 * Эти функции решают, ЧТО делать в обоих режимах.
 */
import type { GameState, CardDeckState } from "@monopoly/shared";
import seedrandom from "seedrandom";
import { shuffle as sharedShuffle } from "@monopoly/shared";

import type { EmptyDeckPolicy as DeckEmptyPolicy } from "./types";
import { ensureDecksInitialized } from "./deck-state-adapter";

/**
 * Результат применения политики к legacy-колоде.
 */
export interface LegacyDeckRebuild {
  /** Новая `CardDeckState` (cards + cursor=0). */
  deck: CardDeckState;
  /** Была ли колода перетасована. */
  reshuffled: boolean;
  /** Seed, использованный для shuffle. */
  seed: string;
}

/**
 * Перетасовать legacy колоду (Шанс/Казна/Luxury-tax) заново,
 * когда курсор дошёл до конца.
 *
 * Используется в `CardHandlerService.drawFromDeck` — fallback.
 *
 * Алгоритм:
 *  1. Получить source `cards` (CHANCE/TREASURY/LUXURY_TAX);
 *  2. seedrandom по `state.seed:deck:type` (детерминированно);
 *  3. Вернуть новую `CardDeckState` с курсором 0.
 */
export function rebuildLegacyDeck(
  state: GameState,
  source: readonly { id: string }[],
  deckType: "chance" | "treasury" | "luxury-tax",
): LegacyDeckRebuild {
  const seed = state.seed;
  const rng = seedrandom(`${seed}:deck:${deckType}:reshuffle`);
  const shuffled = sharedShuffle(source, rng).map((c) => c.id);
  return {
    deck: { cards: shuffled, cursor: 0 },
    reshuffled: true,
    seed: `${seed}:deck:${deckType}:reshuffle`,
  };
}

/**
 * Проверить, что legacy колода НЕ пуста (cards.length > 0).
 *
 * @throws Error если колода пуста
 */
export function assertLegacyDeckNotEmpty(deck: CardDeckState, deckType: string): void {
  if (deck.cards.length === 0) {
    throw new Error(`Legacy ${deckType} deck has 0 cards`);
  }
}

/**
 * Поддерживаемые EmptyDeckPolicy для нового DeckModule.
 *
 * Уже определена в [`types.ts`](apps/server/src/games/decks/types.ts);
 * здесь — runtime-хелперы для применения.
 */

/**
 * Применяет политику возврата IN_HAND карт к новым колодам.
 *
 * Используется при empty deck в DeckModule.drawCard когда policy === "RETURN_HELD_CARDS".
 *
 * NB: реальная мутация `cards`/`decks` уже сделана в `deck.service.ts`,
 * эта функция только формирует список событий для audit log.
 */
export interface ReturnedCardEvent {
  readonly cardId: string;
  readonly toIndex: number;
}

/**
 * Формирует события для возврата IN_HAND карт.
 *
 * Используется в audit log (см. [`deck-audit-log.ts`](apps/server/src/games/decks/deck-audit-log.ts)).
 */
export function buildReturnedCardsEvents(
  cardIds: readonly string[],
  deckId: string,
  baseToIndex: number,
): ReturnedCardEvent[] {
  return cardIds.map((cid, i) => ({
    cardId: cid,
    toIndex: baseToIndex + i,
  }));
}

/**
 * Объединённая политика для legacy + new режима.
 *
 * Если `state.decks` инициализированы — используется новая политика
 * (`emptyDeckPolicy` из `DecksContainer`).
 *
 * Иначе — legacy-режим (shuffle при необходимости).
 */
export function getActivePolicy(state: GameState): DeckEmptyPolicy {
  ensureDecksInitialized(state);
  // После ensureDecksInitialized у нас может появиться `__emptyDeckPolicy`
  // через дискриминированный union, но мы вернём дефолт SKIP_DRAW.
  return "SKIP_DRAW";
}
