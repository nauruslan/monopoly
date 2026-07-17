import type { Player } from "./player";
import type { Cell } from "./cell";
import type { GameEvent } from "./event";
import type { Card } from "../data/cards";

/**
 * Phase — конечный автомат игрового цикла.
 *
 * 1. **Global** — `IDLE`, `LOBBY`, `FINISHED`
 * 2. **Turn** — `START_TURN`, `ROLLING`, `DICE_ANIMATION`, `MOVE_ANIMATION`,
 *              `RESOLVING_LANDING`, `PAY_RENT`, `TAX_PAYMENT`, `BUY_DECISION`,
 *              `CARD_REVEAL`, `CARD_EFFECT`, `BUILDING`, `END_TURN`
 * 3. **Special / Interrupt** — `JAIL_DECISION`, `AUCTION_BIDDING`,
 *              `AUCTION_RESOLVE`, `BANKRUPTCY_LIQUIDATE`,
 *              `BANKRUPTCY_TRANSFER`, `TRADING_NEGOTIATE`, `TRADING_CONFIRM`
 * 4. **UX-фаза** `BOT_THINKING` — декоратор, не часть FSM (просто визуальная пауза).
 *
 * ## КРИТИЧНО: каждая фаза имеет ЧЁТКИЙ СОБЫТИЙНЫЙ КРИТЕРИЙ ЗАВЕРШЕНИЯ.
 *
 * ### Полный жизненный цикл одного хода
 *
 * ```
 *  START_TURN  (мгновенная: сброс флагов → ROLLING или JAIL_DECISION)
 *      ↓
 *  ROLLING
 *      │ триггер: игрок жмёт "Бросить кубики"
 *      │ сервер бросает кости, присылает game:dice
 *      │ событие завершения: клиент/бот-таймер прислал CONFIRM_DICE_ANIMATION
 *      ↓
 *  DICE_ANIMATION
 *      │ клиент 2 секунды крутит кубики
 *      │ событие завершения: клиент/бот-таймер прислал CONFIRM_DICE_ANIMATION
 *      ↓
 *  MOVE_ANIMATION
 *      │ фишка шагает по клеткам; на КАЖДОЙ промежуточной клетке
 *      │ НИЧЕГО НЕ ПРОИСХОДИТ (не срабатывают карточки, налоги и т.д.)
 *      │ событие завершения: клиент/бот-таймер прислал CONFIRM_MOVE_ANIMATION
 *      ↓
 *  RESOLVING_LANDING
 *      │ сервер: фишка остановилась на клетке X
 *      │ ВЫБИРАЕТ ветку по типу клетки
 *      │ мгновенная фаза → сразу переход
 *      ↓
 *  ┌─────────────────────┬─────────────────┬──────────────────┐
 *  ↓                     ↓                 ↓                  ↓
 *  PAY_RENT         BUY_DECISION     CARD_REVEAL      TAX_PAYMENT
 *  (списываем)      (модалка)       (модалка:         (Подоходный
 *                                    ПОКАЗ карточки,   налог:
 *                                    НО ЭФФЕКТ         «Заплатите
 *                                    НЕ ПРИМЕНЯЕТСЯ)    N₽», ОК)
 *  ↓                     ↓                 ↓                  ↓
 *  └──────────────────►  ↓            CARD_EFFECT             ↓
 *                        ↓            (применяем              ↓
 *                        ↓             эффект:               ↓
 *                        ↓             money/move/            ↓
 *                        ↓             goto-jail/             ↓
 *                        ↓             luxury-tax)            ↓
 *                        ↓                 ↓                  ↓
 *                        ↓     ┌───────────┴────────────┐     ↓
 *                        ↓     ↓                        ↓     ↓
 *                        ↓   END_TURN             → MOVE_  END_TURN
 *                        ↓   (новый ход)             ANIM.
 *                        ↓     ↓                  (если
 *                        ↓     ↓                   карта
 *                        ↓     ↓                   телепорт.)
 *                        ↓     ↓                        ↓     ↓
 *                        └─────┴────────────────────────┴─────┘
 *                                            ↓
 *                                       END_TURN
 *                                            │
 *                                            ↓
 *                                       START_TURN (след. игрок)
 * ```
 *
 * ## Универсальность Human/Bot
 *
 * Фазы **одинаковы** для человека и бота. Разница только в том, КТО отправляет
 * `GameAction` (UI-человек vs `BotService.decide()`).
 * Для ботов сервер сам шлёт `CONFIRM_DICE_ANIMATION` и `CONFIRM_MOVE_ANIMATION`
 * по таймеру (согласованному с клиентом).
 */
export type Phase =
  // Global
  | "IDLE"
  | "LOBBY"
  | "FINISHED"

  // Turn: основной цикл хода
  | "START_TURN"
  | "ROLLING"
  | "DICE_ANIMATION"
  | "MOVE_ANIMATION"
  | "RESOLVING_LANDING"
  | "PAY_RENT"
  | "TAX_PAYMENT"
  | "BUY_DECISION"
  | "CARD_REVEAL"
  | "CARD_EFFECT"
  | "BUILDING"
  | "END_TURN"

  // Special
  | "JAIL_DECISION"

  // Interrupt: Аукцион
  | "AUCTION_BIDDING"
  | "AUCTION_RESOLVE"

  // Interrupt: Банкротство
  | "BANKRUPTCY_LIQUIDATE"
  | "BANKRUPTCY_TRANSFER"

  // Interrupt: Торговля
  | "TRADING_NEGOTIATE"
  | "TRADING_CONFIRM"

  // UX-декоратор
  | "BOT_THINKING";

/**
 * GameSettings — настройки партии
 */
export interface GameSettings {
  startingMoney: number;
  goSalary: number;
  housingLimit: "limited" | "unlimited";
  auctionEnabled: boolean;
  turnTimeoutMs: number;
  freeParkingVariant: "classic" | "tax-pot";
  /** Лимит итераций counter-offer в торговле (защита от бесконечного цикла). */
  tradingMaxCounterOffers?: number;
  /** Длительность аукциона на одну ставку (мс). */
  auctionBidTimeoutMs?: number;
  /** Длительность торговли между сторонами (мс). */
  tradingResponseTimeoutMs?: number;
  /** Длительность анимации броска кубиков (мс). Сервер ждёт это время. */
  diceAnimationMs?: number;
  /** Длительность анимации движения на 1 клетку (мс). Сервер ждёт это × N. */
  moveStepMs?: number;
}

/**
 * CardDeckState — состояние одной колоды карточек.
 *
 * При инициализации партии каждая колода (`chance`, `treasury`, `luxury-tax`)
 * перемешивается детерминированно (через `state.seed`), и в дальнейшем
 * карты выдаются строго по индексу `cursor` — по кругу.
 *
 * При исчерпании колоды (`cursor >= cards.length`) сервер снова перемешивает
 * её тем же RNG и сбрасывает `cursor = 0`. Это и есть «в начале игры
 * случайно упорядочены — идут друг за другом».
 */
export interface CardDeckState {
  /** ID карточек в текущем порядке (после shuffle). */
  cards: string[];
  /** Следующий индекс для выдачи. */
  cursor: number;
}

/**
 * GameState — главный объект состояния игры
 */
export interface GameState {
  id: string;
  version: number;
  status: "waiting" | "active" | "paused" | "finished";
  currentPlayerIndex: number;
  phase: Phase;
  round: number;
  players: Player[];
  board: Cell[];
  /**
   * Настройки текущей партии.
   */
  settings: GameSettings;
  /**
   * Журнал событий.
   */
  events?: GameEvent[];
  /**
   * Зерно (seed) для детерминированного RNG.
   */
  seed: string;
  /**
   * Внутренний счётчик RNG — для детерминированного воспроизведения.
   * Сервер инкрементирует при каждом `roll` или `drawCard`.
   * На клиент не отдаётся в чистом виде (используется только в логике).
   */
  rngCounter?: number;
  winnerId?: string;
  createdAt: string;
  lastActivityAt: string;
  /**
   * Информация о текущей «фазе размышления» бота (UX-декоратор).
   */
  botThinking?: {
    playerId: string;
    endsAt: string;
  };
  /**
   * Контекст аукциона (когда `phase ∈ {AUCTION_BIDDING, AUCTION_RESOLVE}`).
   */
  auction?: {
    /** Клетка, которая продаётся с аукциона. */
    cellId: number;
    /** Текущая максимальная ставка. */
    currentBid: number;
    /** ID лидирующего игрока. */
    highestBidderId: string | null;
    /** Порядок участников (начиная со следующего после инициатора). */
    bidderOrder: string[];
    /** Индекс текущего участника в `bidderOrder`. */
    currentBidderIndex: number;
    /** Активные (не выбывшие) участники. */
    activeBidders: string[];
    /** ISO-время, когда текущий участник должен сделать ставку. */
    bidDeadline: string;
  };
  /**
   * Контекст торговли (когда `phase ∈ {TRADING_NEGOTIATE, TRADING_CONFIRM}`).
   */
  trade?: {
    /** ID инициатора обмена. */
    initiatorId: string;
    /** ID получателя предложения. */
    recipientId: string;
    /** Сторона, которая сейчас должна ответить. */
    currentPartyId: string;
    /** Текущее активное предложение. */
    offer: TradeOffer;
    /** Количество counter-offer'ов (ограничение). */
    counterCount: number;
  };
  /**
   * Контекст банкротства (когда `phase ∈ {BANKRUPTCY_LIQUIDATE, BANKRUPTCY_TRANSFER}`).
   */
  bankruptcy?: {
    /** ID обанкротившегося игрока. */
    playerId: string;
    /** Кредитор (null = Банк). */
    creditorId: string | null;
    /** Сумма долга, которую нужно покрыть. */
    debt: number;
    /** Этап процедуры (1-5, см. спеку). */
    stage: 1 | 2 | 3 | 4 | 5;
  };
  /**
   * Контекст вытянутой карточки (когда `phase ∈ {CARD_REVEAL, CARD_EFFECT}`).
   * Содержит саму карту и (опционально) эффект, который ещё НЕ применён.
   *
   * `deck` теперь включает "luxury-tax" — Роскошный налог тоже показывается
   * как карточка, эффект которой применяется после подтверждения.
   */
  cardContext?: {
    /** ID игрока, вытянувшего карту. */
    playerId: string;
    /** Тип колоды. */
    deck: "chance" | "treasury" | "luxury-tax";
    /** Сама карта (с полным текстом и эффектом). */
    card: Card;
    /**
     * Применён ли эффект.
     * `false` — фаза CARD_REVEAL (показали модалку, эффект НЕ применён).
     * `true`  — фаза CARD_EFFECT (модалка закрыта, эффект уже применён на сервере).
     */
    applied: boolean;
  };
  /**
   * Контекст ренты (фаза `PAY_RENT`).
   *
   * Сервер рассчитывает сумму аренды и ID владельца при входе в `PAY_RENT`,
   * кладёт их сюда. Деньги НЕ списываются до получения `CONFIRM_RENT_PAYMENT`
   * от клиента — иначе игрок не увидит сумму, прежде чем её потеряет.
   *
   * Клиент показывает модалку с этой информацией.
   */
  rentContext?: {
    /** ID владельца клетки, которому пойдёт аренда. */
    ownerId: string;
    /** Имя владельца (для отображения в модалке). */
    ownerName: string;
    /** Сумма аренды, рассчитанная сервером. */
    amount: number;
  };
  /**
   * Контекст последнего броска кубиков (когда `phase ∈ {DICE_ANIMATION, MOVE_ANIMATION}`).
   * Нужен, чтобы клиент знал, сколько клеток анимировать, и для налётов ренты на UTILITY.
   */
  lastDice?: {
    dice: [number, number];
    isDouble: boolean;
  };
  /**
   * Контекст текущего движения фишки (фаза `MOVE_ANIMATION`).
   * Сервер устанавливает `from`/`to` при входе в MOVE_ANIMATION, и `position`
   * игрока меняется только после CONFIRM_MOVE_ANIMATION. Клиент читает это
   * поле, чтобы знать, откуда и куда анимировать фишку.
   *
   * `direction` указывает, каким образом фишка движется по доске:
   *  - `"forward"`  — по часовой стрелке (номер клетки увеличивается, `from < to`,
   *                   с оборачиванием через 0). Используется для обычного броска
   *                   кубиков и для большинства карточек Шанс/Казна.
   *  - `"backward"` — против часовой стрелки (номер клетки уменьшается, `from > to`,
   *                   с оборачиванием через 39). Используется для карточек,
   *                   предписывающих «вернуться назад» (например, «Вернитесь на 3 клетки
   *                   назад»).
   *
   * Если `direction` не задан — клиент трактует движение как `forward`
   * (обратная совместимость со старыми снапшотами).
   */
  moveAnimation?: {
    playerId: string;
    from: number;
    to: number;
    steps: number;
    isDouble: boolean;
    direction?: "forward" | "backward";
  };
  /**
   * Состояние колод карточек (Шанс, Общественная казна, Роскошный налог).
   * Заполняется при инициализации партии, обновляется на сервере при
   * каждом `drawCard`. На клиент отдаётся как есть (нужно для синхронизации
   * и потенциального отображения «счётчика» колоды).
   */
  cardDecks?: {
    chance: CardDeckState;
    treasury: CardDeckState;
    "luxury-tax": CardDeckState;
  };
  /**
   * Свежее попадание в тюрьму (true) — игрок в ЭТОМ ходу только что
   * попал в тюрьму (через GOTO_JAIL / карту / 3 дубля). По правилам
   * Монополии в текущем ходу ему разрешено ТОЛЬКО завершить ход —
   * модалка тюрьмы с тремя способами выхода появится в СЛЕДУЮЩЕМ ходу.
   *
   * - `true`  — игрок только что попал в тюрьму, фаза = JAIL_DECISION,
   *             допустимо только END_TURN / CONFIRM_END_TURN.
   * - `false` (или undefined) — обычная ситуация: JAIL_DECISION
   *             наступила в начале хода, игрок может использовать
   *             USE_JAIL_CARD / PAY_JAIL_FINE / TRY_DOUBLE.
   */
  justEnteredJail?: boolean;
  /**
   * Свежее попадание на парковку (id=20) по карточке Шанс/Казна
   * «Отправляйтесь на парковку» (move target=20). По правилам
   * Монополии это «отдых»: цепочка «бросок → движение → эффект»
   * обрывается, право на ещё один бросок (после дубля) ТЕРЯЕТСЯ.
   *
   * - `true`  — игрок ТОЛЬКО ЧТО отправлен на парковку по карточке
   *             в текущем ходу, фаза = BUILDING. `canRollDice` блокирует
   *             повторный бросок, `canEndTurn` разрешает завершить ход
   *             (как и для обычного хода без дубля).
   * - `false` (или undefined) — обычная ситуация: на клетку 20 игрок
   *             мог попасть либо «проездом» (handleResolvingLanding,
   *             phase=BUILDING, без этого флага — `canRollDice`
   *             зависит только от `mustRollAgain`/`phase`), либо
   *             в ПРОШЛОМ ходу (флаг уже сброшен в handleStartTurn).
   *
   * Сбрасывается в `handleStartTurn` при начале СЛЕДУЮЩЕГО хода —
   * тогда игрок снова может бросать кубики.
   */
  justArrivedAtParking?: boolean;
}

/**
 * TradeOffer — структура предложения обмена.
 *
 * Содержит массивы ID клеток и суммы денег, которые участники
 * обменивают друг с другом.
 */
export interface TradeOffer {
  /** ID клеток, которые отдаёт initiator. */
  fromProperties: number[];
  /** Деньги, которые отдаёт initiator (может быть отрицательным = получить). */
  fromCash: number;
  /** ID клеток, которые initiator хочет получить. */
  toProperties: number[];
  /** Деньги, которые initiator хочет получить. */
  toCash: number;
}

export const DEFAULT_SETTINGS: GameSettings = {
  startingMoney: 1500,
  goSalary: 200,
  housingLimit: "limited",
  auctionEnabled: true,
  turnTimeoutMs: 120000,
  freeParkingVariant: "classic",
  tradingMaxCounterOffers: 3,
  auctionBidTimeoutMs: 15000,
  tradingResponseTimeoutMs: 30000,
  diceAnimationMs: 2000,
  moveStepMs: 450,
};
