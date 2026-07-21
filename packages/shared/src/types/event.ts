import type { Card } from "../data/cards";

/**
 * Типы событий игрового журнала.
 *
 * Сервер присылает клиенту события в `game:event` (broadcast) и в
 * `state.events[]` (snapshot — для восстановления журнала при reconnect).
 * На клиенте `LogPanel.vue` отображает их в боковой панели.
 *
 * Дополнительно для аукциона (v2):
 *  - `AUCTION_BID`   — кто-то сделал ставку;
 *  - `AUCTION_PASS`  — кто-то спасовал (включая таймаут);
 *  - `AUCTION_WON`   — победитель определён;
 *  - `AUCTION_UNSOLD`— все спасовали до первой ставки.
 *
 * Эти 4 типа формируют ОСНОВНОЙ лог аукциона в боковой панели,
 * а полный лог (со всеми нюансами) рендерится в самой модалке аукциона
 * из `state.auction.actionLog`.
 */

export type GameEventKind =
  | "GAME_STARTED"
  | "TURN_START"
  | "DICE_ROLLED"
  | "PROPERTY_BOUGHT"
  | "PROPERTY_DECLINED"
  | "RENT_PAID"
  | "TAX_PAID"
  | "CARD_DRAWN"
  | "JAIL_ENTERED"
  | "JAIL_ESCAPED"
  | "JAIL_PAID"
  | "AUCTION_STARTED"
  | "AUCTION_BID"
  | "AUCTION_PASS"
  | "AUCTION_WON"
  | "AUCTION_UNSOLD"
  | "GAME_OVER";

export interface GameEvent {
  /** Уникальный id события (uuid, генерируется на сервере). */
  id: string;
  /** ISO-строка времени события. */
  at: string;
  kind: GameEventKind;
  /** Кто инициировал событие (если применимо). */
  playerId?: string;
  /**
   * Текст для UI — формируется на сервере одним сообщением на русском.
   * Может содержать эмодзи.
   */
  message: string;
  /**
   * Класс для подсветки в журнале:
   * "" (по умолчанию) | "move" | "rent" | "chance" | "win" | "buy"
   * | "auction" | "pass".
   */
  type: string;
  /** Доп. данные для UI (например, dice, card, amount, cellId). */
  payload?: {
    dice?: [number, number];
    card?: Card;
    amount?: number;
    cellId?: number;
    /** Для AUCTION_PASS — был ли это авто-пас по таймауту. */
    timeout?: boolean;
  };
}
