/**
 * Политики обработки пустых колод DeckModule.
 *
 * Реализует `EmptyDeckPolicy` (`"WAIT" | "RETURN_HELD_CARDS" | "SKIP_DRAW" | "ERROR"`)
 * и предоставляет runtime-хелперы для применения политики в DeckService.drawCard
 * (ветка `RETURN_HELD_CARDS`).
 *
 * Используется в:
 *  - {@link DeckContext} (поле `emptyDeckPolicy`) — контекст всех операций DeckService;
 *  - {@link DrawParams} → drawCard — при попытке добора из пустой колоды.
 */
import type { GameState } from "@monopoly/shared";

import type { EmptyDeckPolicy } from "./types";
import { ensureDecksInitialized } from "./deck-state-adapter";

/**
 * Описание события возврата одной карты в конец колоды.
 * Используется для формирования audit log.
 */
export interface ReturnedCardEvent {
  readonly cardId: string;
  readonly toIndex: number;
}

/**
 * Формирует список событий `CARD_RETURNED` для пачки `cardId`,
 * возвращаемых в колоду `deckId` начиная с индекса `baseToIndex`.
 *
 * @param cardIds     ID карт, которые возвращаются в колоду
 * @param deckId      ID колоды-получателя
 * @param baseToIndex индекс в `topToBottom`, с которого начинается возврат
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
 * Возвращает активную `EmptyDeckPolicy` для партии.
 *
 * Используется, когда требуется runtime-узнать «жёстко зашитую» политику
 * (например, в тестах). Внутри делает lazy-init DeckModule, чтобы
 * `state.decks` гарантированно был инициализирован.
 *
 * В текущей реализации политика определяется переданным контекстом
 * (см. {@link DeckContext.emptyDeckPolicy}); здесь возвращаем дефолт
 * `SKIP_DRAW` для совместимости с API, использующимся в `games.service.ts`.
 */
export function getActivePolicy(state: GameState): EmptyDeckPolicy {
  ensureDecksInitialized(state);
  return "SKIP_DRAW";
}
