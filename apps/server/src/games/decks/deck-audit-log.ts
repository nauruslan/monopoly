/**
 * DeckAuditLog — append-only журнал событий колоды для отладки и восстановления.
 *
 * Используется для:
 *  - трассировки операций с картами (когда, кем, почему);
 *  - восстановления состояния после disconnect;
 *  - аналитики и мониторинга "популярности" карт.
 *
 * Хранится в `GameState.deckAuditLog: DeckAuditEntry[]` (опционально,
 * создаётся при первой записи).
 *
 * NB: НЕ путать с [`GameEvent`](../../../../packages/shared/src/types/event.ts)
 * из FSM. Это отдельный, более детальный лог DeckModule.
 */
import type { GameState } from "@monopoly/shared";
import type { DeckEvent } from "./events";

// Тип записи.

/**
 * Одна запись в audit log.
 */
export interface DeckAuditEntry {
  /** Sequence number в рамках игры (монотонно возрастает). */
  readonly seq: number;
  /** ISO timestamp. */
  readonly at: string;
  /** Какой игрок инициировал действие (если был). */
  readonly actor?: string;
  /** Само событие. */
  readonly event: DeckEvent;
}

// Расширение GameState для audit log.

declare module "@monopoly/shared" {
  interface GameState {
    /** Append-only audit log DeckModule (опционально). */
    deckAuditLog?: DeckAuditEntry[];
  }
}

// API.

/**
 * Append событие в audit log.
 *
 * Если `state.deckAuditLog` ещё не создан — создаёт.
 * Sequence number назначается автоматически.
 */
export function appendDeckEvent(
  state: GameState,
  event: DeckEvent,
  actor?: string,
): DeckAuditEntry {
  if (!state.deckAuditLog) {
    state.deckAuditLog = [];
  }
  const seq = state.deckAuditLog.length + 1;
  const entry: DeckAuditEntry = {
    seq,
    at: new Date().toISOString(),
    ...(actor ? { actor } : {}),
    event,
  };
  state.deckAuditLog.push(entry);
  return entry;
}

/**
 * Append несколько событий (например, при RETURN_HELD_CARDS).
 */
export function appendDeckEvents(
  state: GameState,
  events: readonly DeckEvent[],
  actor?: string,
): DeckAuditEntry[] {
  return events.map((ev) => appendDeckEvent(state, ev, actor));
}

/**
 * Получить все события для конкретной карты (`cardId`).
 */
export function getCardHistory(state: GameState, cardId: string): DeckAuditEntry[] {
  return (state.deckAuditLog ?? []).filter(
    (e) => e.event.type !== "DECK_RESHUFFLED" && e.event.cardId === cardId,
  );
}

/**
 * Получить N последних событий колоды (для UI / дебага).
 */
export function tailDeckEvents(state: GameState, n: number): DeckAuditEntry[] {
  const log = state.deckAuditLog ?? [];
  return log.slice(-n);
}

/**
 * Получить все события конкретного типа.
 */
export function getEventsByType<T extends DeckEvent["type"]>(
  state: GameState,
  type: T,
): Extract<DeckEvent, { type: T }>[] {
  return (state.deckAuditLog ?? [])
    .filter((e) => e.event.type === type)
    .map((e) => e.event as Extract<DeckEvent, { type: T }>);
}

/**
 * Подсчёт событий каждого типа (для метрик).
 *
 * Возвращает `Record<DeckEvent["type"], number>`.
 */
export function countEventTypes(state: GameState): Record<DeckEvent["type"], number> {
  const counts = {
    CARD_DRAWN: 0,
    CARD_RESOLVING: 0,
    CARD_RETURNED: 0,
    CARD_HELD: 0,
    CARD_USED: 0,
    CARD_TRANSFERRED: 0,
    DECK_RESHUFFLED: 0,
  } as Record<DeckEvent["type"], number>;
  for (const entry of state.deckAuditLog ?? []) {
    counts[entry.event.type] = (counts[entry.event.type] ?? 0) + 1;
  }
  return counts;
}

/**
 * Очистить audit log (для тестов / debug).
 *
 * ВНИМАНИЕ: production-коду НЕ СЛЕДУЕТ вызывать эту функцию.
 * Только в тестах или админ-командах.
 */
export function clearDeckAuditLog(state: GameState): void {
  state.deckAuditLog = [];
}
