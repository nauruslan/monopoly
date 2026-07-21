import type { TradeOffer } from "./game";

/**
 * GameAction — дискриминированное объединение игровых команд,
 * которые клиент отправляет на сервер через WebSocket.
 *
 * Сервер (`GamesService.applyAction`) использует поле `type` для
 * маршрутизации обработки и проверки допустимости в текущей фазе.
 * Неизвестные `type` отклоняются.
 *
 * Действия сгруппированы по уровням FSM:
 *
 * 1. **Turn Actions** — основной цикл хода
 * 2. **Special Actions** — тюрьма
 * 3. **Interrupt: Auction Actions** — AUCTION_ACTIVE (ход игрока)
 * 4. **Interrupt: Trade Actions** — TRADING_NEGOTIATE → TRADING_CONFIRM
 * 5. **Interrupt: Bankruptcy Actions** — автоматические, не от клиента
 * 6. **Property Actions** — застройка/ипотека (BUILDING)
 *
 * ## Новые actions для синхронизации анимаций
 *
 * - `CONFIRM_DICE_ANIMATION` — клиент досмотрел анимацию кубиков (фаза `DICE_ANIMATION`).
 * - `CONFIRM_MOVE_ANIMATION` — клиент досмотрел анимацию движения фишки (фаза `MOVE_ANIMATION`).
 * - `CONFIRM_CARD`          — клиент закрыл модалку карточки (фаза `CARD_REVEAL` → `CARD_EFFECT`).
 * - `CONFIRM_TAX`           — клиент подтвердил оплату фиксированного налога (фаза `TAX_PAYMENT`).
 * - `CONFIRM_LANDING`       — клиент подтвердил, что фишка приземлилась (фаза `LANDING` — пауза).
 * - `CONFIRM_END_TURN`      — клиент подтвердил, что ход передан (фаза `END_TURN` — пауза).
 */
export type GameAction =
  // Turn Actions
  | { type: "ROLL_DICE" }
  /** Клиент/бот закончил просмотр анимации кубиков (DICE_ANIMATION). */
  | { type: "CONFIRM_DICE_ANIMATION" }
  /** Клиент/бот закончил просмотр анимации движения фишки (MOVE_ANIMATION). */
  | { type: "CONFIRM_MOVE_ANIMATION" }
  /** Клиент/бот подтвердил, что фишка приземлилась (RESOLVING_LANDING → следующая фаза). */
  | { type: "CONFIRM_LANDING" }
  /** Клиент закрыл модалку карточки Шанс/Казна/Роскошный налог (CARD_REVEAL → CARD_EFFECT). */
  | { type: "CONFIRM_CARD" }
  /** Клиент закрыл модалку фиксированного налога (TAX_PAYMENT). */
  | { type: "CONFIRM_TAX" }
  | { type: "BUY_PROPERTY" }
  | { type: "DECLINE_BUY" }
  | { type: "CONFIRM_RENT_PAYMENT" } // для PAY_RENT фазы: игрок подтверждает, что увидел
  /** Клиент подтвердил окончание хода (END_TURN → START_TURN). */
  | { type: "CONFIRM_END_TURN" }
  | { type: "END_TURN" }

  // Special: Jail
  | { type: "PAY_JAIL_FINE" }
  | { type: "USE_JAIL_CARD" }
  /** Попытка выйти дублем (то же, что ROLL_DICE, но отправляется из JAIL_DECISION). */
  | { type: "TRY_DOUBLE" }

  // Property Actions (BUILDING)
  | { type: "BUILD_HOUSE"; cellId: number }
  | { type: "SELL_HOUSE"; cellId: number } // продажа дома банку за 50% стоимости
  | { type: "MORTGAGE_PROPERTY"; cellId: number } // залог
  | { type: "UNMORTGAGE_PROPERTY"; cellId: number } // выкуп из залога (+10%)

  // Interrupt: Auction (новая логика, v2)
  /**
   * Сделать ставку в аукционе. Сервер валидирует:
   *  - `amount` > текущей ставки (строго);
   *  - `amount` <= наличных игрока;
   *  - игрок сейчас «на часах»;
   *  - аукцион в фазе AUCTION_ACTIVE.
   */
  | { type: "AUCTION_MAKE_BID"; amount: number }
  /** Пропустить ход в аукционе (Pass). Игрок НАВСЕГДА выбывает из текущего аукциона. */
  | { type: "AUCTION_PASS" }
  /**
   * Клиент закрыл модалку с результатом аукциона (AUCTION_FINISHED).
   * После этого сервер очищает state.auction и переходит к следующей фазе.
   */
  | { type: "CONFIRM_AUCTION" }

  // Interrupt: Trading
  /** Инициировать торговое предложение (открывает TRADING_NEGOTIATE). */
  | { type: "TRADE_OFFER"; recipientId: string; offer: TradeOffer }
  /** Принять текущее предложение. */
  | { type: "TRADE_ACCEPT" }
  /** Отклонить предложение. */
  | { type: "TRADE_REJECT" }
  /** Сделать встречное предложение (counter-offer). */
  | { type: "TRADE_COUNTER"; offer: TradeOffer }
  /** Отменить торговлю (инициатор). */
  | { type: "TRADE_CANCEL" }

  // Interrupt: Bankruptcy (client-driven)
  /** На этапе BANKRUPTCY_LIQUIDATE: игрок решает, продавать ли дома/закладывать. */
  | { type: "BANKRUPTCY_LIQUIDATE_HOUSES"; cellId: number }
  | { type: "BANKRUPTCY_MORTGAGE"; cellId: number }
  /** На этапе BANKRUPTCY_LIQUIDATE: подтвердить, что деньги собраны (или что их нет). */
  | { type: "BANKRUPTCY_CONFIRM" }
  | { type: "BANKRUPTCY_DECLARE" }; // признать себя банкротом (сдаться)
