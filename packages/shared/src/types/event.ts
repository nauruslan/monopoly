import type { Card } from "../data/cards";

/**
 * Типы событий игрового журнала.
 *
 * Сервер присылает клиенту события в `game:event` (broadcast) и в
 * `state.events[]` (snapshot — для восстановления журнала при reconnect).
 * На клиенте `LogPanel.vue` отображает их в боковой панели.
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
   * "" (по умолчанию) | "move" | "rent" | "chance" | "win" | "buy".
   */
  type: string;
  /** Доп. данные для UI (например, dice, card, amount). */
  payload?: {
    dice?: [number, number];
    card?: Card;
    amount?: number;
  };
}
