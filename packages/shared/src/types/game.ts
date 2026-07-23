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
 * 3. **Special / Interrupt** — `JAIL_DECISION`,
 *              `AUCTION_AWAITING_START`, `AUCTION_ACTIVE`, `AUCTION_FINISHED`,
 *              `BANKRUPTCY_LIQUIDATE`, `BANKRUPTCY_TRANSFER`,
 *              `TRADING_NEGOTIATE`, `TRADING_CONFIRM`
 * 4. **UX-фаза** `BOT_THINKING` — декоратор, не часть FSM (просто визуальная пауза).
 *
 * ## Аукцион: три фазы (новая логика, v2)
 *
 * Аукцион — это СОБСТВЕННЫЙ мини-FSM, живущий параллельно основному ходу:
 *  - `AUCTION_AWAITING_START` — инициатор отказался покупать, аукцион СОЗДАН,
 *                               но сервер ещё не начал торги. Может длиться
 *                               один «тик», пока сервер не отправит всем
 *                               клиентам `AUCTION_START` (broadcast) и не
 *                               переведёт фазу в `AUCTION_ACTIVE`.
 *  - `AUCTION_ACTIVE`         — текущий «на часах» делает ход (ставка/пас).
 *                               Таймер 30 секунд. Сервер ждёт команды
 *                               `AUCTION_MAKE_BID` / `AUCTION_PASS` от
 *                               активного игрока или автоматически
 *                               засчитывает «пас» по таймауту.
 *  - `AUCTION_FINISHED`       — аукцион завершён (продан / ничья). Клиент
 *                               показывает финальный экран ~2 секунды, после
 *                               чего сервер сам переключает фазу на
 *                               `BUILDING` (или `ROLLING` при `mustRollAgain`).
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
 *                        ↓   (новый ход)             ANIM.  (новый ход)
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

  // Interrupt: Аукцион (v2 — три фазы)
  | "AUCTION_AWAITING_START"
  | "AUCTION_ACTIVE"
  | "AUCTION_FINISHED"

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
  /** Длительность хода в аукционе (мс). По умолчанию 30 секунд. */
  auctionBidTimeoutMs?: number;
  /** Длительность торговли между сторонами (мс). */
  tradingResponseTimeoutMs?: number;
  /** Длительность торговли, когда отвечает бот (мс). По умолчанию 3500. */
  tradingBotResponseTimeoutMs?: number;
  /** Длительность анимации броска кубиков (мс). Сервер ждёт это время. */
  diceAnimationMs?: number;
  /** Длительность анимации движения на 1 клетку (мс). Сервер ждёт это × N. */
  moveStepMs?: number;
  /**
   * Задержка перед ходом бота в аукционе (мс). Сервер ждёт это время,
   * чтобы игрок успел «увидеть», что бот думает. Дефолт: 1500 мс.
   */
  auctionBotThinkMs?: number;
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
 * AuctionActionLogEntry — одна запись в логе торгов аукциона.
 *
 * Сервер ведёт полный лог действий (ставка/пас/таймаут) и отдаёт его
 * клиенту в `state.auction.actionLog`. Клиент рендерит его в виде
 * «истории» в модалке аукциона — игрок видит, ЧТО происходило, а не
 * только финальный результат.
 */
export interface AuctionActionLogEntry {
  /** ID игрока, совершившего действие. */
  playerId: string;
  /** Тип действия. */
  action: "BID" | "PASS" | "TIMEOUT";
  /** Сумма ставки (только для `action === "BID"`). */
  amount?: number;
  /** Метка времени (ms epoch), когда произошло действие. */
  at: number;
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
   * Контекст аукциона (v2 — упрощённая модель по новой спеке).
   *
   * Жизненный цикл:
   *  1) Игрок отказался покупать (`DECLINE_BUY` в фазе `BUY_DECISION`).
   *  2) Сервер создаёт `state.auction` со `status = "AWAITING_START"`,
   *     `phase = "AUCTION_AWAITING_START"`. `active_bidders` содержит
   *     ВСЕХ живых игроков, ВКЛЮЧАЯ инициатора. Первый «на часах» — инициатор.
   *  3) Сервер шлёт WS-событие `AUCTION_START` всем клиентам и переключает
   *     фазу на `AUCTION_ACTIVE`. Таймер 30 сек на ход.
   *  4) Активный игрок присылает `AUCTION_MAKE_BID` или `AUCTION_PASS`.
   *  5) Сервер:
   *     - при `BID`    — обновляет `highest_bid` / `highest_bidder_id`,
   *       сдвигает `current_bidder_index` по кругу, перезапускает таймер,
   *       шлёт `AUCTION_TURN_UPDATE` (новый активный) и `AUCTION_ACTION`
   *       (событие для лога).
   *     - при `PASS`   — удаляет игрока из `active_bidders`, сдвигает индекс,
   *       шлёт события. Если `active_bidders.length === 0` — аукцион
   *       заканчивается ничьей (UNSOLD). Если `=== 1` — победитель.
   *     - при таймауте — то же, что `PASS`, но `reason: "TIMEOUT"`.
   *  6) Когда аукцион закрыт, сервер ставит `status = "FINISHED"`, фазу
   *     `AUCTION_FINISHED`, заполняет `winner_id` / `final_bid` (или оба
   *     `null` при UNSOLD), шлёт `AUCTION_END`. Через ~2 сек (по
   *     `setTimeout` в `GamesService`) сервер сам переводит фазу в
   *     `BUILDING` (или `ROLLING` при `mustRollAgain`).
   *
   * Правила:
   *  - **Лимит ставки**: `maxBid = player.money` (наличные, без залога).
   *  - **Строго больше**: `amount > highest_bid` (на 1₽ или больше — не важно).
   *  - **Пас безвозвратен**: выбыл — больше в этом аукционе не участвует.
   *  - **Нет денег на минимальную ставку → пас**.
   *  - **Блокировка действий**: пока `status === "AUCTION_ACTIVE"`,
   *    сервер отклоняет любые запросы на продажу/залог/обмен/покупку.
   *
   * Поля совместимы с прежним клиентом — `currentBid` / `highestBidderId`
   * сохранены как алиасы, `currentBidderId` — ID активного игрока.
   */
  auction?: {
    /** Уникальный ID аукциона. */
    id: string;
    /** Клетка, которая продаётся с аукциона. */
    cellId: number;
    /** Кто инициировал аукцион (отказался от покупки). */
    initiatorId: string;
    /**
     * Внутреннее состояние аукциона.
     *  - `AWAITING_START` — создан, но сервер ещё не отправил broadcast.
     *                       (живёт один тик).
     *  - `AUCTION_ACTIVE`  — идут торги.
     *  - `FINISHED`        — победитель определён или ничья; клиент
     *                       показывает финальный экран.
     */
    status: "AWAITING_START" | "AUCTION_ACTIVE" | "FINISHED";

    /** Текущая максимальная ставка (0 = ставок е��ё не было). */
    currentBid: number;
    /** ID лидирующего игрока (после первой ставки). */
    highestBidderId: string | null;
    /**
     * Полный порядок участников (по часовой стрелке от инициатора).
     * Используется только при инициализации; далее массив не изменяется.
     */
    bidderOrder: string[];
    /**
     * Список АКТИВНЫХ участников (кто ещё не спасовал и не был удалён
     * по таймауту). Это ЕДИНСТВЕННЫЙ источник правды о том, кто может
     * делать ход. При пасе/таймауте игрок удаляется из массива. Аукцион
     * заканчивается, когда массив пуст (UNSOLD) или в нём ровно 1 игрок
     * (победитель).
     */
    activeBidders: string[];
    /**
     * Индекс активного игрока в `activeBidders`. Сервер сдвигает его
     * по кругу через `(currentBidderIndex + 1) % activeBidders.length`
     * после каждого действия. Когда `activeBidders.length <= 1` —
     * аукцион закрывается.
     */
    currentBidderIndex: number;
    /** ID текущего «на часах» (алиас `activeBidders[currentBidderIndex]`). */
    currentBidderId: string | null;
    /**
     * Timestamp (ms epoch), когда сервер поставил таймер на текущий ход.
     * Используется для расчёта `time_left` в broadcast-событии
     * `AUCTION_TURN_UPDATE` (сервер присылает `time_left` явно).
     */
    timerStartedAt: number;
    /** Длительность одного хода в мс (из `settings.auctionBidTimeoutMs`). */
    turnDurationMs: number;

    /**
     * Полная история действий — рендерится клиентом в виде лога торгов.
     * Сервер пишет сюда каждое событие (BID / PASS / TIMEOUT) сразу при
     * обработке команды, до broadcast'а.
     */
    actionLog: AuctionActionLogEntry[];

    /** Победитель (только при `status === "FINISHED"`, sold). */
    winnerId: string | null;
    /** Финальная ставка (только при `status === "FINISHED"`, sold). */
    finalBid: number;
    /**
     * Причина закрытия. Только при `status === "FINISHED"`.
     *  - `"SOLD"`    — есть победитель, клетка передана.
     *  - `"UNSOLD"`  — все спасовали до первой ставки, клетка у Банка.
     */
    finishReason: "SOLD" | "UNSOLD" | null;

    /**
     * Время начала (ms epoch).
     */
    startedAt: number;
    /**
     * Время закрытия (ms epoch). `null` пока аукцион не закончен.
     */
    closedAt: number | null;
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
    /**
     * Фаза, в которой находилась партия ДО старта торговли.
     * Используется, чтобы корректно восстановить фазу после завершения
     * сделки (accept/reject/cancel):
     *  - если торги начались в ROLLING (игрок ещё не ходил),
     *    после них возвращаемся в ROLLING, чтобы игрок мог бросить кубики;
     *  - если в BUILDING — остаёмся в BUILDING.
     *
     * `undefined` оставлен для обратной совместимости со снапшотами,
     * сохранёнными до введения этого поля (fallback = "BUILDING").
     */
    preTradePhase?: Phase;
  };
  tradeInitiationLog?: Array<{ initiatorId: string; recipientId: string; at: number }>;
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
   * Контекст последнего броска кубиков, выполненного через `TRY_DOUBLE`
   * (попытка выйти из тюрьмы). Заполняется в `handleJailDecision`
   * при action `TRY_DOUBLE` и обрабатывается в `handleDiceAnimation`
   * после `CONFIRM_DICE_ANIMATION`. Возможные исходы:
   *
   * - `"escape"` — игрок выбросил дубль и вышел из тюрьмы.
   *                По правилам Монополии после выхода дублем из тюрьмы
   *                НЕЛЬЗЯ бросать кубики ещё раз, даже если снова
   *                выпадет дубль. Сервер сбрасывает `mustRollAgain`.
   * - `"pay"`    — игрок использовал все 3 попытки, принудительно
   *                списано 50₽, фишка выходит на клетку 10 и далее
   *                двигается как обычно. Без `mustRollAgain`.
   * - `"stay"`   — игрок не выбросил дубль, но попытки ещё остались.
   *                Фишка остаётся в тюрьме (`inJail=true`), фаза
   *                переходит в `BUILDING` (игрок завершает ход).
   *
   * Поле сбрасывается (становится `undefined`) после обработки в
   * `handleDiceAnimation`. До этого момента UI знает, что идёт
   * анимация кубиков, относящаяся к попытке выхода из тюрьмы.
   */
  jailRollOutcome?: "escape" | "pay" | "stay";
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
 * Содержит массивы ID клеток, карточки выхода из тюрьмы и суммы денег,
 * которые участники обменивают друг с другом. ВАЖНО: `fromCash` и `toCash`
 * задаются как ПОЛОЖИТЕЛЬНЫЕ числа (без отрицательных значений) — в
 * отличие от старой схемы, где «-X» означало «получить X». Теперь
 * «получить» = «противоположная сторона отдаёт».
 *
 * Карточки выхода из тюрьмы передаются как количество (`jailCards`).
 * Сервер сам уменьшает `jailCards` отправителя и увеличивает получателю.
 *
 * ВАЖНО (правила Монополии): в оффер можно включать ТОЛЬКО клетки
 * без зданий (`houses === 0`). Заложенные клетки передавать МОЖНО —
 * получатель принимает их со статусом `isMortgaged === true`.
 */
export interface TradeOffer {
  /** ID клеток, которые отдаёт initiator. */
  fromProperties: number[];
  /** Деньги, которые отдаёт initiator (≥ 0). */
  fromCash: number;
  /** Карточки выхода из тюрьмы, которые отдаёт initiator (≥ 0). */
  fromJailCards: number;
  /** ID клеток, которые initiator хочет получить. */
  toProperties: number[];
  /** Деньги, которые initiator хочет получить (≥ 0). */
  toCash: number;
  /** Карточки выхода из тюрьмы, которые initiator хочет получить (≥ 0). */
  toJailCards: number;
}

export const DEFAULT_SETTINGS: GameSettings = {
  startingMoney: 1500,
  goSalary: 200,
  housingLimit: "limited",
  auctionEnabled: true,
  turnTimeoutMs: 120000,
  freeParkingVariant: "classic",
  tradingMaxCounterOffers: 3,
  auctionBidTimeoutMs: 30_000, // 30 сек на ход в аукционе
  tradingResponseTimeoutMs: 30_000,
  tradingBotResponseTimeoutMs: 3500, // бот отвечает на торг быстро
  diceAnimationMs: 2000,
  moveStepMs: 450,
  auctionBotThinkMs: 1500,
};
