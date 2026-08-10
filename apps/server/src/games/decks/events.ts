/**
 * Типизированные события жизненного цикла карт колоды.
 *
 * События используются для:
 *  - логирования (через существующий `LogService`);
 *  - восстановления состояния при reconnect;
 *  - аналитики и аудита решений игроков/ботов.
 *
 * Источник истины: {@link CardInstance.state}.
 * Эти события — derived-обёртка над фактическими мутациями карты, нужная
 * для отделения побочных эффектов (UI, логи, метрики) от основной бизнес-логики.
 */
import type { CardState, DeckType } from "./types";

/**
 * Базовое событие колоды.
 *
 * Все события привязаны к:
 *  - `gameId` — игра;
 *  - `deckId` — колода, в которой живёт карта (или жила);
 *  - `cardId` — конкретный {@link CardInstance}.
 */
export interface DeckEventBase {
  readonly gameId: string;
  readonly deckId: string;
  readonly cardId: string;
  /** ISO-таймстемп события (UTC). */
  readonly timestamp: string;
}

/**
 * Карта вытянута из колоды (IN_DECK → DRAWN).
 */
export interface DeckCardDrawnEvent extends DeckEventBase {
  readonly type: "CARD_DRAWN";
  /** `deckType` нужен для фильтрации и быстрого UI (CHANCE/CHEST/TAX). */
  readonly deckType: DeckType;
  /** Игрок, вытянувший карту. */
  readonly playerId: string;
  /** Из какой позиции в `topToBottom` была взята (0 = верх). */
  readonly fromIndex: number;
}

/**
 * Карта в процессе применения эффекта (DRAWN → RESOLVING).
 *
 * Используется для индикации в UI и в логах, когда карта показана игроку,
 * но эффект ещё не применён (например, ожидание выбора).
 */
export interface DeckCardResolvingEvent extends DeckEventBase {
  readonly type: "CARD_RESOLVING";
  /** Игрок-цель эффекта (может отличаться от вытянувшего для move-cards). */
  readonly playerId: string;
  /** Текущий state карты — должен быть RESOLVING. */
  readonly nextState: Extract<CardState, "RESOLVING">;
}

/**
 * Карта возвращена в низ колоды (как правило, не удерживается в руке).
 *
 * NB: это НЕ то же, что "карта осталась сверху" — для этого события нет,
 * т.к. это нормальная часть {@link DeckCardDrawnEvent} с `toIndex = 0`.
 */
export interface DeckCardReturnedEvent extends DeckEventBase {
  readonly type: "CARD_RETURNED";
  /** Причина: `RESOLVED` (обычный stay-эффект) или `DROPPED` (игрок сбросил). */
  readonly reason: "RESOLVED" | "DROPPED";
  /** Куда ушла карта в колоде (индекс в `topToBottom` после возврата). */
  readonly toIndex: number;
}

/**
 * Карта взята в руку игрока (DRAWN/RESOLVING → IN_HAND).
 *
 * Это событие фиксируется только для шаблонов с `holdInHand = true`.
 */
export interface DeckCardHeldEvent extends DeckEventBase {
  readonly type: "CARD_HELD";
  readonly playerId: string;
  /** Снимок `holdableCards[id]` — `true` после события. */
  readonly attached: true;
}

/**
 * Карта использована игроком из руки (IN_HAND → USED).
 */
export interface DeckCardUsedEvent extends DeckEventBase {
  readonly type: "CARD_USED";
  readonly playerId: string;
}

/**
 * Карта передана другому игроку (IN_HAND → IN_HAND с новым владельцем).
 *
 * Только если `transferable = true` и сделка/передача разрешена правилами.
 */
export interface DeckCardTransferredEvent extends DeckEventBase {
  readonly type: "CARD_TRANSFERRED";
  readonly fromPlayerId: string;
  readonly toPlayerId: string;
}

/**
 * Колода перемешана — например, после `RESHUFFLE_AT_EMPTY`.
 */
export interface DeckReshuffledEvent {
  readonly type: "DECK_RESHUFFLED";
  readonly gameId: string;
  readonly deckId: string;
  readonly deckType: DeckType;
  readonly timestamp: string;
  /** Использованный seed (для воспроизводимости). */
  readonly seed: string;
  /** Количество карт в колоде после reshuffle. */
  readonly cardCount: number;
}

/**
 * Дискриминированное объединение всех событий колоды.
 */
export type DeckEvent =
  | DeckCardDrawnEvent
  | DeckCardResolvingEvent
  | DeckCardReturnedEvent
  | DeckCardHeldEvent
  | DeckCardUsedEvent
  | DeckCardTransferredEvent
  | DeckReshuffledEvent;

/**
 * Тип-список всех событий колоды (для exhaustive switch).
 */
export type DeckEventKind = DeckEvent["type"];

/**
 * Хелпер для type-guard: проверяет, что событие относится к конкретной карте.
 */
export function isCardEvent(ev: DeckEvent): ev is Exclude<DeckEvent, DeckReshuffledEvent> {
  return ev.type !== "DECK_RESHUFFLED";
}
