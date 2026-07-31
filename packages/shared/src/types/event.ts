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
 *
 * Дополнительно для строительства (BUILD/SELL):
 *  - `HOUSE_BUILT`  — игрок построил дом/отель;
 *  - `HOUSE_SOLD`   — игрок продал дом/отель банку;
 *  - `BUILDING_PHASE_OPENED` — игрок открыл модалку строительства/залога.
 *
 * Дополнительно для торговли:
 *  - `TRADE_STARTED`   — инициатор предложил обмен;
 *  - `TRADE_COUNTER`   — встречное предложение;
 *  - `TRADE_COMPLETED` — сделка совершена;
 *  - `TRADE_REJECTED`  — получатель отклонил;
 *  - `TRADE_CANCELLED` — инициатор отменил.
 *
 * Дополнительно для банкротства (v2):
 *  - `BANKRUPTCY_LIQUIDATION` — игрок распродаёт имущество (фаза).
 *  - `BANKRUPTCY_DECLARED`    — игрок объявил банкротство.
 *
 * Журнал хранит ВСЕ события партии (без удаления). В снапшоте
 * `state.events[]` лежит полная история, и при reconnect клиент видит
 * её целиком. На клиенте `LogPanel.vue` не обрезает список.
 */

export type GameEventKind =
  | "GAME_STARTED"
  | "TURN_START"
  | "DICE_ROLLED"
  | "GO_SALARY_PAID"
  | "PROPERTY_BOUGHT"
  | "PROPERTY_DECLINED"
  | "RENT_PAID"
  | "TAX_PAID"
  | "CARD_DRAWN"
  | "JAIL_ENTERED"
  | "JAIL_ESCAPED"
  | "JAIL_TRY_DOUBLE"
  | "AUCTION_STARTED"
  | "AUCTION_BID"
  | "AUCTION_PASS"
  | "AUCTION_WON"
  | "AUCTION_UNSOLD"
  | "TRADE_STARTED"
  | "TRADE_COUNTER"
  | "TRADE_COMPLETED"
  | "TRADE_REJECTED"
  | "TRADE_CANCELLED"
  | "PROPERTY_MORTGAGED"
  | "PROPERTY_UNMORTGAGED"
  | "HOUSE_BUILT"
  | "HOUSE_SOLD"
  | "BUILDING_PHASE_OPENED"
  | "BANKRUPTCY_LIQUIDATION"
  | "BANKRUPTCY_DECLARED"
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
   * | "auction" | "pass" | "trade" | "tax" | "jail" | "system".
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
    /** Для TRADE_* — ID второй стороны сделки (получатель/инициатор). */
    otherPlayerId?: string;
    /** Для TRADE_COMPLETED — сумма, автоматически списанная в счёт долга. */
    autoDebtCovered?: number;
    /**
     * Для PROPERTY_MORTGAGED / PROPERTY_UNMORTGAGED — стоимость операции:
     *  - MORTGAGED    — сумма, зачисленная игроку (mortgageValue);
     *  - UNMORTGAGED  — сумма, списанная с игрока (mortgageValue × 1.1).
     */
    mortgageAmount?: number;
    /**
     * Для HOUSE_BUILT / HOUSE_SOLD — сколько домов сейчас на клетке
     * (после операции). 5 = отель. -1 = снесли отель целиком
     * (после операции 0).
     */
    housesAfter?: number;
    /** Стоимость операции (для журнала). */
    buildAmount?: number;
    /** true, если операция — строительство/снос отеля (а не дома). */
    isHotel?: boolean;
    /**
     * Признак операции в фазе распродажи имущества (BANKRUPTCY_LIQUIDATE).
     * Используется UI для отдельной подсветки и текстовых пометок
     * "(распродажа)".
     */
    liquidation?: boolean;
    /**
     * ID второй стороны для тюрьмы: кто засадил (или null для клетки 30).
     */
    reason?: "cell" | "card" | "double" | "other" | "pay";
    /**
     * Для JAIL_TRY_DOUBLE — номер попытки (1-based).
     */
    attempt?: number;
  };
}
