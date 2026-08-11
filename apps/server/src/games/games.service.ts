import {
  Injectable,
  Logger,
  ForbiddenException,
  NotFoundException,
  BadRequestException,
  Inject,
  forwardRef,
} from "@nestjs/common";
import seedrandom from "seedrandom";
import {
  GameState,
  GameAction,
  Player,
  GameEvent,
  TradeOffer,
  Phase,
  Card,
  Cell,
  CHANCE_CARDS,
} from "@monopoly/shared";
import { GameRepository } from "../db/repositories/game.repository";
import { GameInitializerService } from "./game-initializer.service";
import { RentCalculator } from "./handlers/rent-calculator";
import { JailHandlerService } from "./handlers/jail-handler.service";
import { CardHandlerService } from "./handlers/card-handler.service";
import { BankruptcyService } from "./handlers/bankruptcy.service";
import { BotService, type BotDecision } from "./bots/bot.service";
import { AuctionService, type AuctionEvent } from "./handlers/auction.service";
import { TradeService } from "./handlers/trade.service";
import { MortgageService } from "./handlers/mortgage.service";
import { BuildService } from "./handlers/build.service";
import { LogService } from "./handlers/log.service";
import { canRollDice, canEndTurn, isCurrentPlayer } from "./turn-permissions";
import type { GameEventKind } from "@monopoly/shared";

export type GameStateChangedCallback = (
  gameId: string,
  state: GameState,
  event?: GameEvent,
  dice?: [number, number],
  card?: Card,
) => void;

@Injectable()
export class GamesService {
  private readonly logger = new Logger(GamesService.name);
  private activeGames = new Map<string, GameState>();

  onStateChanged: GameStateChangedCallback | null = null;
  private userToPlayer = new Map<string, Map<string, string>>();

  /** Таймеры ходов ботов. */
  private botTimers = new Map<string, NodeJS.Timeout>();
  /** Таймеры фазы размышления бота. */
  private botThinkingTimers = new Map<string, NodeJS.Timeout>();
  /**
   * Таймеры FALLBACK-подтверждения визуальных фаз для ботов.
   * сервер НЕ шлёт `CONFIRM_*` автоматически по таймеру для бота — он ЖДЁТ
   * клиентского подтверждения (от любого подключённого клиента).
   * Этот таймер — СТРАХОВКА: сработает, только если в комнате нет ни
   * одного клиента, способного отправить confirm (например, партия
   * ботов без людей, или все клиенты отключились). При нормальной
   * игре таймер сбрасывается сразу после получения `CONFIRM_*` и
   * никогда не срабатывает.
   * Хранится контекст (фаза, ожидаемое действие, playerId), чтобы
   * при срабатывании fallback'а корректно отправить нужный `CONFIRM_*`
   * от имени бота.
   */
  private botConfirmFallbackTimers = new Map<string, NodeJS.Timeout>();
  private botConfirmFallbackContexts = new Map<
    string,
    { phase: Phase; playerId: string; setAt: number }
  >();
  /** Таймеры аукционных ставок. */
  private auctionTimers = new Map<string, NodeJS.Timeout>();
  /** Таймеры ответа в торговле. */
  private tradeTimers = new Map<string, NodeJS.Timeout>();
  /** Таймеры авто-END_TURN для человека. */
  private turnTimers = new Map<string, NodeJS.Timeout>();

  /**
   * Сериализованные очереди записи snapshot в БД (per gameId).
   * Каждое следующее сохранение ждёт завершения предыдущего для той же
   * игры — иначе при бурных фазах (dice → move → resolve → buy → end)
   * `updateSnapshot` стартует параллельно, `state.version` уже
   * инкрементнут следующим action'ом, и в БД возникает конфликт
   * optimistic-lock: «текущая версия 87, ожидалась 123».
   * Цепочка Promise'ов гарантирует порядок и отсутствие потерь.
   */
  private snapshotQueues = new Map<string, Promise<void>>();

  constructor(
    @Inject(forwardRef(() => GameRepository)) private readonly repo: GameRepository,
    @Inject(forwardRef(() => GameInitializerService))
    private readonly initializer: GameInitializerService,
    @Inject(forwardRef(() => RentCalculator))
    private readonly rentCalc: RentCalculator,
    @Inject(forwardRef(() => JailHandlerService))
    private readonly jail: JailHandlerService,
    @Inject(forwardRef(() => CardHandlerService))
    private readonly cards: CardHandlerService,
    @Inject(forwardRef(() => BankruptcyService))
    private readonly bankruptcy: BankruptcyService,
    @Inject(forwardRef(() => BotService))
    private readonly bot: BotService,
    @Inject(forwardRef(() => AuctionService))
    private readonly auction: AuctionService,
    @Inject(forwardRef(() => TradeService))
    private readonly trade: TradeService,
    @Inject(forwardRef(() => MortgageService))
    private readonly mortgageSvc: MortgageService,
    @Inject(forwardRef(() => BuildService))
    private readonly buildSvc: BuildService,
    @Inject(forwardRef(() => LogService))
    private readonly log: LogService,
  ) {
    if (!this.rentCalc) console.error("[GamesService] RentCalculator не заинжектирован!");
    if (!this.jail) console.error("[GamesService] JailHandlerService не заинжектирован!");
    if (!this.cards) console.error("[GamesService] CardHandlerService не заинжектирован!");
    if (!this.bankruptcy) console.error("[GamesService] BankruptcyService не заинжектирован!");
    if (!this.bot) console.error("[GamesService] BotService не заинжектирован!");
    if (!this.auction) console.error("[GamesService] AuctionService не заинжектирован!");
    if (!this.trade) console.error("[GamesService] TradeService не заинжектирован!");
    if (!this.buildSvc) console.error("[GamesService] BuildService не заинжектирован!");
    if (!this.log) console.error("[GamesService] LogService не заинжектирован!");
    if (!this.onStateChanged) {
      console.error(
        "[GamesService] onStateChanged не зарегистрирован (GameGateway не подключился?)",
      );
    }
    if (!this.initializer)
      console.error("[GamesService] GameInitializerService не заинжектирован!");
    if (!this.repo) console.error("[GamesService] GameRepository не заинжектирован!");

    // Подписываем AuctionService на широковещание событий через
    // callback: события AUCTION_START / AUCTION_TURN_UPDATE /
    // AUCTION_ACTION / AUCTION_END эмитятся на отдельном WS-канале,
    // параллельно с onStateChanged (который шлёт весь state).
    this.auction.onAuctionEvent = (gameId, ev) => {
      try {
        this.broadcastAuctionEvent(gameId, ev);
      } catch (err) {
        this.logger.error(
          `broadcastAuctionEvent failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    };
  }

  /**
   * Транслирует событие аукциона в WS-комнату игры.
   * Канал: "auction:event" (для всех клиентов комнаты).
   * ВАЖНО: broadcast идёт через инжектированный GameGateway
   * (см. `setGateway`), чтобы избежать циклической зависимости.
   */
  private gateway: {
    broadcastAuctionEvent: (gameId: string, event: AuctionEvent) => void;
  } | null = null;

  setGateway(gw: { broadcastAuctionEvent: (gameId: string, event: AuctionEvent) => void }) {
    this.gateway = gw;
  }

  private broadcastAuctionEvent(gameId: string, ev: AuctionEvent): void {
    if (!this.gateway) {
      this.logger.warn("[GamesService] gateway не зарегистрирован, auction event пропущен");
      return;
    }
    this.gateway.broadcastAuctionEvent(gameId, ev);
  }

  // Создание и получение партий
  async createGame(
    playerNames: string[],
    hostUserId?: string,
  ): Promise<{ gameId: string; state: GameState }> {
    const state = this.initializer.createInitialState(playerNames, hostUserId);
    state.status = "active";
    state.phase = "ROLLING";

    const dbGame = await this.repo.create(state, hostUserId, state.seed);
    state.id = dbGame.id;
    state.seed = dbGame.rngSeed;

    // ВАЖНО: после получения реального seed из БД — перетасовываем колоды
    // ещё раз, чтобы их порядок был детерминирован этим seed'ом.
    this.initializer.reShuffleDecks(state);

    this.activeGames.set(dbGame.id, state);

    if (hostUserId) {
      const host = state.players[0];
      if (host) {
        const map = new Map<string, string>();
        map.set(hostUserId, host.id);
        this.userToPlayer.set(dbGame.id, map);
      }
    }

    this.logger.log(`Game created: ${dbGame.id}`);

    // Записываем в журнал событие «Игра началась» (GAME_STARTED) и
    // сразу же кладём в state.events, чтобы при reconnect клиент
    // увидел стартовое сообщение в LogPanel.
    const startEv = this.log.logGameStarted(
      state,
      state.players.map((p) => p.displayName),
    );
    this.onStateChanged?.(dbGame.id, state, startEv);

    this.scheduleBotIfNeeded(state, dbGame.id);

    return { gameId: dbGame.id, state };
  }

  async getGameState(gameId: string): Promise<GameState | null> {
    if (this.activeGames.has(gameId)) {
      return this.activeGames.get(gameId)!;
    }
    const game = await this.repo.findById(gameId);
    if (!game) return null;
    const state = game.stateSnapshot as GameState;
    // Backfill: для старых снапшотов DeckModule ещё не инициализирован.
    if (!state.decks || !state.deckCards || state.decks.length === 0) {
      this.initializer.reShuffleDecks(state);
    }
    this.activeGames.set(gameId, state);

    if (game.hostId && state.players[0] && !this.userToPlayer.has(gameId)) {
      const map = new Map<string, string>();
      map.set(game.hostId, state.players[0].id);
      this.userToPlayer.set(gameId, map);
    }

    return state;
  }

  resolvePlayerId(gameId: string, userId: string): string | null {
    return this.userToPlayer.get(gameId)?.get(userId) ?? null;
  }

  // Главный диспетчер FSM (applyAction)

  /**
   * Применить действие игрока.
   *
   * Маршрутизация:
   *  1) Проверка базовых прав (игрок в партии, не банкрот, его ход).
   *  2) Диспетчер по `state.phase` → выбор обработчика.
   *  3) Обработчик мутирует state и выставляет следующую фазу.
   *  4) Broadcast через `onStateChanged` + сохранение в БД.
   *  5) Планирование ботов / таймаутов.
   */
  async applyAction(
    gameId: string,
    playerId: string,
    action: GameAction,
  ): Promise<{
    state: GameState;
    dice?: [number, number];
    card?: unknown;
    event?: GameEvent;
  }> {
    // 1) Загрузить state (из кеша или БД).
    let state = this.activeGames.get(gameId);
    if (!state) {
      const loaded = await this.getGameState(gameId);
      if (!loaded) throw new NotFoundException("Партия не найдена");
      state = loaded;
    }

    // 2) Найти игрока.
    let player = state.players.find((p) => p.id === playerId);
    if (!player) throw new NotFoundException("Игрок не найден в партии");
    this.assertCanAct(state, player);

    // 2.1) Ранняя защита «от пропуска обязательного действия».
    //
    // В фазе ROLLING нельзя послать END_TURN (бросок обязателен) — раньше
    // UI мог отправить его случайно после дубля (`mustRollAgain=true`),
    // и ход перескакивал к другому игроку. Теперь для ROLL_DICE и END_TURN
    // проверяем `canRollDice`/`canEndTurn` из `turn-permissions.ts`.
    // Это даёт централизованное правило для UI и FSM-валидации.
    if (action.type === "END_TURN" && state.phase === "ROLLING" && !canEndTurn(state, player)) {
      // В ROLLING нет смысла передавать ход — нужен бросок. Если же при
      // этом `mustRollAgain=true` (правило дубля), `canRollDice` тоже
      // вернёт true. В обоих случаях сообщаем клиенту, что бросок
      // обязателен.
      if (canRollDice(state, player)) {
        throw new ForbiddenException("Сейчас нужно бросить кубики (бросок обязателен)");
      }
      throw new ForbiddenException(`Недопустимое действие END_TURN в фазе ${state.phase}`);
    }

    // 2.2) Ранняя защита «покупки в тюрьме».
    // По правилам Монополии: пока игрок в тюрьме — он НЕ может покупать
    // недвижимость в текущем ходу. `canBuyProperty` (turn-permissions.ts)
    // инкапсулирует эту проверку и уже отклоняет попытку на уровне фазы
    // BUY_DECISION. Здесь — дублирующая защита для случаев, когда фаза
    // ещё не `BUY_DECISION` (UI-баг: кнопка «Купить» была активна и
    // игрок кликнул в JAIL_DECISION после `inJail=true`).
    if (action.type === "BUY_PROPERTY" && player.inJail) {
      throw new ForbiddenException("Нельзя покупать, находясь в тюрьме");
    }

    // 2.3) Ранняя защита блокировки торговли: TRADE_OFFER получателю,
    // который добавил инициатора в `blocked_players`, отклоняется.
    if (action.type === "TRADE_OFFER") {
      const recipient = state.players.find((p) => p.id === action.recipientId);
      if (recipient?.blockedPlayers?.includes(player.id)) {
        throw new ForbiddenException("Торговля с этим игроком заблокирована");
      }
    }

    // 2.5) Торговлю и блокировку запрещено начинать во время interrupt-фаз
    // (аукцион, банкротство, уже идущая сделка) и в анимационных фазах
    // (DICE_ANIMATION, MOVE_ANIMATION), чтобы UI-тайминги оставались
    // предсказуемыми. разрешается торговля в любой момент хода
    // текущего игрока, кроме этих «защитных» фаз.
    if (action.type === "TRADE_OFFER" || action.type === "TRADE_TOGGLE_BLOCK") {
      if (state.trade && action.type === "TRADE_OFFER") {
        throw new ForbiddenException("Сделка уже идёт, дождитесь её завершения");
      }
      if (this.isInterruptPhase(state.phase)) {
        throw new ForbiddenException(`Недопустимое действие ${action.type} в фазе ${state.phase}`);
      }
      if (state.phase === "DICE_ANIMATION" || state.phase === "MOVE_ANIMATION") {
        throw new ForbiddenException(
          `Недопустимое действие ${action.type} во время анимации ${state.phase}`,
        );
      }
    }

    // 3) Проверить, что ход именно этого игрока (для не-interrupt фаз).
    // ВАЖНО: для визуальных CONFIRM_* actions (CONFIRM_DICE_ANIMATION,
    // CONFIRM_MOVE_ANIMATION, CONFIRM_LANDING, CONFIRM_RENT_PAYMENT,
    // CONFIRM_TAX, CONFIRM_CARD, CONFIRM_END_TURN) проверка «чей сейчас
    // ход» НЕ применяется. Это не игровые решения, а сигналы
    // «анимация на клиенте завершилась, можно переходить к следующей
    // фазе». Если этого не сделать, то при ходе БОТА никто из
    // подключённых клиентов-людей не сможет послать confirm, и сервер
    // будет ждать 60-секундный fallback-таймер, что приводит к
    // «зависанию» хода бота (например, фишка не двигается по клеткам,
    // потому что MOVE_ANIMATION никем не подтверждается).
    const isVisualConfirm =
      action.type === "CONFIRM_DICE_ANIMATION" ||
      action.type === "CONFIRM_MOVE_ANIMATION" ||
      action.type === "CONFIRM_LANDING" ||
      action.type === "CONFIRM_RENT_PAYMENT" ||
      action.type === "CONFIRM_TAX" ||
      action.type === "CONFIRM_CARD" ||
      action.type === "CONFIRM_END_TURN" ||
      action.type === "CONFIRM_AUCTION";

    if (!isVisualConfirm && !this.isInterruptPhase(state.phase)) {
      const currentPlayer = state.players[state.currentPlayerIndex];
      if (currentPlayer.id !== player.id) {
        throw new ForbiddenException("Сейчас не ваш ход");
      }
    }

    // ВАЖНО: для визуальных
    // CONFIRM_* actions подменяем `player` на ТЕКУЩЕГО игрока
    // (state.players[state.currentPlayerIndex]), потому что эти actions
    // обрабатывают визуальное состояние текущего хода, а не действия
    // отправителя. Без этой подмены `handleMoveAnimation`,
    // `handleResolvingLanding` и другие визуальные обработчики мутируют
    // позицию/деньги ОТПРАВИТЕЛЯ (например, человека-«зрителя»), а не
    // текущего игрока (например, бота). Это и приводило к тому, что
    // фишка бота не двигалась, а фишка человека двигалась во время хода
    // бота.
    // Подмену `player` на currentPlayer делаем ТОЛЬКО для чисто
    // визуальных confirm'ов. Для аукционных actions (AUCTION_MAKE_BID,
    // AUCTION_PASS) и CONFIRM_AUCTION сохраняем реального отправителя —
    // в `handleAuctionActive` нам нужен ИМЕННО тот, кто нажал кнопку
    // (а не инициатор аукциона), иначе движок получает NOT_ON_CLOCK,
    // когда ход перешёл к другому игроку, а submitter — это он, а
    // не `currentPlayerIndex`.
    if (isVisualConfirm && action.type !== "CONFIRM_AUCTION") {
      const currentPlayer = state.players[state.currentPlayerIndex];
      if (!currentPlayer) {
        throw new NotFoundException("Не найден текущий игрок");
      }
      player = currentPlayer;
    }

    this.logger.debug(`Action: ${action.type} by ${playerId} in phase ${state.phase}`);

    let dice: [number, number] | undefined;
    let drawnCard: Card | undefined;
    let event: GameEvent | undefined;

    try {
      const result = await this.dispatch(state, player, action);
      dice = result.dice;
      drawnCard = result.card as Card | undefined;
      event = result.event;
    } catch (err) {
      this.logger.error(
        `Action dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }

    state.version++;
    state.lastActivityAt = new Date().toISOString();

    // Кладём событие в кольцевой буфер `state.events`, чтобы при
    // reconnect новый клиент получил полную историю (а не только
    // последние N событий broadcast'а). Используем приватный хелпер
    // LogService — он сам обрежет буфер до MAX_EVENTS_IN_STATE.
    // Важно: событие в этом месте уже сформировано через makeEvent,
    // поэтому мы НЕ пересоздаём его, а просто пушим в массив.
    if (event) {
      this.log.pushToState(state, event);
    }

    this.logger.log(`[applyAction] after-dispatch gameId=${gameId} phase=${state.phase}`);

    // Планирование ботских таймеров ПОСЛЕ завершения диспатча.
    // ВАЖНО: раньше здесь стояли
    // автоматические таймеры (`scheduleBotDiceAnimDone`,
    // `scheduleBotMoveAnimDone`, `scheduleBotCardDone` и т.д.) на
    // фиксированные интервалы (2000мс для кубиков, N×450+200 для
    // движения, 2500мс для карточки, 400мс для приземления, 2000мс
    // для ренты/налога, 500мс для END_TURN). Эти таймеры НЕ
    // синхронизировались с реальной анимацией на клиенте:
    //   - на клиенте скорость анимации зависит от `settings.animationSpeed`
    //     (0.5×, 1×, 2×), а на сервере жёстко `state.settings.moveStepMs`;
    //   - клиент НЕ отправлял `CONFIRM_*` для ботов (`isMyTurn === false`),
    //     поэтому анимация на клиенте «догоняла» уже идущую следующую
    //     фазу на сервере;
    //   - в итоге один бот начинал ход, ещё не закончив анимацию, а
    //     второй бот уже бросал кубики → визуальный «рассинхрон»
    //     нескольких фишек одновременно.
    //
    // Теперь:
    //   1) Сервер НЕ шлёт `CONFIRM_*` автоматически по таймеру для
    //      визуальных фаз бота — он ЖДЁТ клиентского подтверждения.
    //      Клиент (даже если сейчас ходит бот) при завершении
    //      анимации шлёт `CONFIRM_DICE_ANIMATION` / `CONFIRM_MOVE_ANIMATION`
    //      / `CONFIRM_LANDING` / `CONFIRM_CARD` / `CONFIRM_RENT_PAYMENT`
    //      / `CONFIRM_TAX` / `CONFIRM_END_TURN` от любого подключённого
    //      игрока (см. GameView.vue).
    //   2) В качестве СТРАХОВКИ от ситуации, когда в комнате нет ни
    //      одного активного клиента (например, партия ботов без людей
    //      или все клиенты отключились), ставится ОДИН fallback-таймер
    //      `scheduleBotConfirmFallback` через 60 секунд — он сработает,
    //      только если за это время никто не прислал CONFIRM_*.
    //   3) При нормальной игре fallback-таймер сбрасывается в
    //      `applyAction` (сразу после успешного dispatch'а) и никогда
    //      не срабатывает.
    if (player.kind === "bot" && this.isWaitingForClientConfirm(state.phase)) {
      // Ждущая фаза для бота — обновляем fallback-таймер.
      // (Внутри метода старый таймер уже сбрасывается.)
      this.scheduleBotConfirmFallback(state, gameId, player);
    } else {
      // Фаза больше не требует клиентского подтверждения
      // (например, после CONFIRM_LANDING приземлились на свою клетку
      // и фаза стала BUILDING, или после CONFIRM_END_TURN ход
      // перешёл к следующему игроку) — снимаем fallback.
      this.clearBotConfirmFallback(gameId);
    }

    // Broadcast клиентам
    if (this.onStateChanged) {
      try {
        this.onStateChanged(gameId, state, event, dice, drawnCard);
      } catch (err) {
        this.logger.error(
          `onStateChanged failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } else {
      this.logger.error(`[applyAction] onStateChanged is NULL — broadcast невозможен!`);
    }
    // Планирование следующих ходов ботов (когда фаза не «ждущая»)
    // Не планируем, если сейчас фаза, где игрок должен что-то подтвердить визуально
    // (DICE_ANIMATION, MOVE_ANIMATION, CARD_REVEAL, CARD_EFFECT, TAX_PAYMENT,
    //  RESOLVING_LANDING, END_TURN) — там бот сам отправит CONFIRM_X по таймеру.
    const waitingForClientConfirm: ReadonlySet<Phase> = new Set([
      "DICE_ANIMATION",
      "MOVE_ANIMATION",
      "CARD_REVEAL",
      "CARD_EFFECT",
      "TAX_PAYMENT",
      "RESOLVING_LANDING",
      "END_TURN",
      "AUCTION_FINISHED",
      "BOT_THINKING",
    ]);
    if (!waitingForClientConfirm.has(state.phase)) {
      this.scheduleBotIfNeeded(state, gameId);
    }
    this.scheduleTurnTimeout(state, gameId);
    // Сохранение в БД (в фоне, через сериализованную очередь per gameId).
    // Без очереди несколько идущих подряд applyAction стартуют
    // updateSnapshot параллельно, и в БД возникает конфликт версий
    // (optimistic-lock в game.repository.updateSnapshot).
    this.enqueueSnapshot(gameId, state);

    return { state, dice, card: drawnCard, event };
  }

  /**
   * Маршрутизация по фазе → обработчик. Это сердце FSM.
   */
  private async dispatch(
    state: GameState,
    player: Player,
    action: GameAction,
  ): Promise<{ dice?: [number, number]; card?: unknown; event?: GameEvent }> {
    this.logger.log(
      `[dispatch] entered: action=${action.type} currentPhase=${state.phase} playerPos=${player.position}`,
    );
    // Действия, доступные на ЛЮБОМ шаге хода текущего игрока (кроме
    // interrupt-фаз: аукцион, торг, банкротство, тюрьма, FINISHED, ...):
    //  - TRADE_OFFER / TRADE_TOGGLE_BLOCK — торговля;
    //  - MORTGAGE_PROPERTY / UNMORTGAGE_PROPERTY — залог/выкуп участка.
    // Обрабатываем их ДО выбора фазы, чтобы не отказывать игроку
    // в фазе ROLLING, DICE_ANIMATION, MOVE_ANIMATION и т.п. — он
    // может, например, прикупить клетку после хода и сразу заложить.
    if (
      action.type === "TRADE_OFFER" ||
      action.type === "TRADE_TOGGLE_BLOCK" ||
      action.type === "MORTGAGE_PROPERTY" ||
      action.type === "UNMORTGAGE_PROPERTY"
    ) {
      return this.handleBuilding(state, player, action);
    }
    // OPEN_BUILDING_PHASE — UX-фаза «Строительство/Снос/Залог».
    // Игрок открывает модалку из любой «своей» Turn-фазы. Обрабатываем
    // ДО выбора фазы, чтобы не отклонять запрос только потому, что
    // игрок, например, ещё не бросал кубики (фаза ROLLING).
    if (action.type === "OPEN_BUILDING_PHASE") {
      return this.handleBuildingPhase(state, player, action);
    }
    if (action.type === "CONFIRM_BUILDING_PHASE") {
      return this.handleBuildingPhase(state, player, action);
    }
    switch (state.phase) {
      // Global
      case "IDLE":
      case "LOBBY":
        throw new ForbiddenException(`Партия ещё не активна (фаза ${state.phase})`);
      case "FINISHED":
        throw new ForbiddenException("Партия завершена");

      // Turn FSM
      case "START_TURN":
        return this.handleStartTurn(state, player, action);
      case "ROLLING":
        return this.handleRolling(state, player, action);
      case "DICE_ANIMATION":
        return this.handleDiceAnimation(state, player, action);
      case "MOVE_ANIMATION":
        return this.handleMoveAnimation(state, player, action);
      case "RESOLVING_LANDING":
        return this.handleResolvingLanding(state, player, action);
      case "PAY_RENT":
        return this.handlePayRent(state, player, action);
      case "TAX_PAYMENT":
        return this.handleTaxPayment(state, player, action);
      case "BUY_DECISION":
        return this.handleBuyDecision(state, player, action);
      case "CARD_REVEAL":
        return this.handleCardReveal(state, player, action);
      case "CARD_EFFECT":
        return this.handleCardEffect(state, player, action);
      case "BUILDING":
        return this.handleBuilding(state, player, action);
      case "BUILDING_PHASE":
        return this.handleBuildingPhase(state, player, action);
      case "END_TURN":
        return this.handleEndTurn(state, player, action);

      // Special
      case "JAIL_DECISION":
        return this.handleJailDecision(state, player, action);

      // Interrupt: Auction
      case "AUCTION_AWAITING_START":
        // Мгновенная фаза: AuctionService.startAuction уже заполнил
        // state.auction и активировал его. Переходим в AUCTION_ACTIVE.
        this.handleAuctionAwaitingStart(state);
        return {};
      case "AUCTION_ACTIVE":
        return this.handleAuctionActive(state, player, action);
      case "AUCTION_FINISHED":
        // Клиент увидел результат и нажал ОК в модалке.
        // Очищаем state.auction и переходим к следующей фазе (BUILDING/ROLLING).
        if (action.type !== "CONFIRM_AUCTION") {
          throw new ForbiddenException("В фазе AUCTION_FINISHED ожидается CONFIRM_AUCTION");
        }
        this.clearAuctionTimer(this.findGameIdByState(state));
        this.afterAuctionFinished(state);
        return {};

      // Interrupt: Bankruptcy
      case "BANKRUPTCY_LIQUIDATE":
        return this.handleBankruptcyLiquidate(state, player, action);
      case "BANKRUPTCY_TRANSFER":
        return this.handleBankruptcyTransfer(state, player, action);

      // Interrupt: Trading
      case "TRADING_NEGOTIATE":
        return this.handleTradingNegotiate(state, player, action);
      case "TRADING_CONFIRM":
        return this.handleTradingConfirm(state, player, action);

      // UX-декоратор
      case "BOT_THINKING":
        throw new ForbiddenException("Бот думает, действия не принимаются");

      default: {
        const _exhaustive: never = state.phase as never;
        throw new BadRequestException(`Unknown phase: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  // Обработчики фаз Turn FSM

  /**
   * START_TURN — инициализация контекста хода (мгновенная фаза).
   * Сразу переходит в ROLLING (или в JAIL_DECISION, если игрок в тюрьме).
   */
  /**
   * Единая точка сброса «стартовых» флагов хода. Используется и в
   * async-`handleStartTurn`, и в sync-зеркале `beginNextPlayerTurn` —
   * раньше эти две функции независимо дублировали одинаковый набор
   * сбросов, что приводило к риску рассинхрона (например, логика
   * `justEnteredJail` могла «утечь» из одного хода в другой).
   *
   * @param player  игрок, чьи личные флаги надо сбросить (mustRollAgain,
   *                consecutiveDoubles). Глобальные state-флаги
   *                (`justEnteredJail`, `justArrivedAtParking`,
   *                `preBuildingPhase`, `jailRollOutcome`,
   *                `tradeInitiationLog`) тоже сбрасываются здесь.
   */
  private resetTurnFlags(state: GameState, player: Player): void {
    player.mustRollAgain = false;
    player.consecutiveDoubles = 0;
    state.justEnteredJail = false;
    state.justArrivedAtParking = false;
    state.preBuildingPhase = undefined;
    state.jailRollOutcome = undefined;
    state.tradeInitiationLog = [];
  }

  private async handleStartTurn(
    state: GameState,
    player: Player,
    _action: GameAction,
  ): Promise<{ dice?: [number, number]; card?: unknown; event?: GameEvent }> {
    // Лог «Начало хода» — всегда в начале START_TURN, чтобы в журнале
    // LogPanel было видно, кто сейчас ходит. Возвращаем event, чтобы
    // applyAction отправил его через broadcast и положил в state.events.
    const startEv = this.log.logTurnStart(state, player, state.round);

    // Сброс обязательных флагов начала хода делегирован общему хелперу —
    // тот же набор полей сбрасывается в sync-зеркале `beginNextPlayerTurn`,
    // чтобы обе ветки инициализации хода были структурно идентичны.
    this.resetTurnFlags(state, player);
    // ВАЖНО: если у игрока отрицательный баланс к началу хода (например,
    // остался с прошлого хода, или деньги списали недавно) — принудительно
    // запускаем процедуру банкротства. Игрок НЕ может бросать кубики
    // или действовать в тюрьме, пока не ликвидирует имущество.
    if (player.money < 0 && !player.isBankrupt) {
      this.startBankruptcyProcedure(state, player, null, -player.money);
      // Возвращаем startEv, чтобы он попал в broadcast и state.events
      // даже при принудительном банкротстве (полезно для истории).
      return { event: startEv };
    }
    if (player.inJail) {
      state.phase = "JAIL_DECISION";
    } else {
      state.phase = "ROLLING";
    }
    return { event: startEv };
  }

  /**
   * ROLLING — фаза броска кубиков.
   * Допустимые actions: ROLL_DICE.
   * После броска: DICE_ANIMATION (сервер ждёт подтверждения анимации клиентом/ботом).
   */
  private async handleRolling(
    state: GameState,
    player: Player,
    action: GameAction,
  ): Promise<{ dice?: [number, number]; card?: unknown; event?: GameEvent }> {
    // Reset preBuildingPhase on entering ROLLING (protect against dirty state).
    state.preBuildingPhase = undefined;

    if (action.type !== "ROLL_DICE") {
      throw new ForbiddenException(`Недопустимое действие ${action.type} в фазе ROLLING`);
    }

    // Бросаем кости.
    const diceResult = this.roll(state);
    const isDouble = diceResult[0] === diceResult[1];

    // Сохраняем контекст броска в state, чтобы клиент знал значения для анимации.
    state.lastDice = { dice: diceResult, isDouble };
    state.phase = "DICE_ANIMATION";

    // Лог броска кубиков в журнал LogPanel.
    const diceEv = this.log.logDiceRolled(state, player, diceResult, isDouble);
    return { dice: diceResult, event: diceEv };
  }

  /**
   * DICE_ANIMATION — клиентская фаза анимации кубиков.
   * Допустимое action: CONFIRM_DICE_ANIMATION.
   * После подтверждения: MOVE_ANIMATION (если не в тюрьме) или ROLLING для следующего.
   *
   * Особый случай — попытка выхода из тюрьмы (TRY_DOUBLE):
   *   Если `state.jailRollOutcome` задан, значит этот бросок был сделан
   *   через `TRY_DOUBLE` (а не обычный ROLL_DICE). В этом случае
   *   финальный результат определяется этим outcome'ом, а не текущими
   *   `consecutiveDoubles`/`mustRollAgain`:
   *     - "escape" (дубль)         — игрок вышел, движется как обычно,
   *                                   но `mustRollAgain` НЕ ставится
   *                                   (правило «выход дублем — без
   *                                   повторного броска»).
   *     - "pay"    (3 попытки)     — игрок вышел после принудительной
   *                                   оплаты, движется как обычно,
   *                                   `mustRollAgain` не ставится.
   *     - "stay"   (промах)        — игрок остаётся в тюрьме,
   *                                   фишка НЕ двигается, фаза BUILDING
   *                                   (игрок завершает ход).
   *   Поле `state.jailRollOutcome` сбрасывается после обработки.
   */
  private async handleDiceAnimation(
    state: GameState,
    player: Player,
    action: GameAction,
  ): Promise<{ dice?: [number, number]; card?: unknown; event?: GameEvent }> {
    if (action.type !== "CONFIRM_DICE_ANIMATION") {
      throw new ForbiddenException(`Недопустимое действие ${action.type} в фазе DICE_ANIMATION`);
    }
    if (!state.lastDice) {
      throw new BadRequestException("Нет контекста последнего броска");
    }
    const dice = state.lastDice.dice;
    const isDouble = state.lastDice.isDouble;

    // Ветка: бросок из TRY_DOUBLE (попытка выхода из тюрьмы)
    if (state.jailRollOutcome) {
      const outcome = state.jailRollOutcome;
      // Сразу сбрасываем поле, чтобы при повторном заходе (теоретически)
      // не сработала повторная обработка.
      state.jailRollOutcome = undefined;

      // "stay" — игрок остаётся в тюрьме (1-я или 2-я неудачная попытка),
      // фишка не двигается, нужно завершить ход. Никаких mustRollAgain/
      // consecutiveDoubles — это не обычный ход, это попытка выхода.
      // Согласно правилам Монополии, попыток всего три; если не выпал
      // дубль на 1-м или 2-м ходу — игрок остаётся в тюрьме и его ход
      // завершается (фаза BUILDING → END_TURN).
      if (outcome === "stay") {
        player.consecutiveDoubles = 0;
        player.mustRollAgain = false;
        state.phase = "BUILDING";
        return {};
      }

      // "escape" или "pay" — игрок вышел из тюрьмы на 3-й попытке.
      // По правилам Монополии:
      //   - "pay"   (3-й промах) — принудительно списывается 50₽;
      //   - "escape" (дубль)     — деньги НЕ списываются (бесплатно).
      // В ОБОИХ случаях после показа анимации кубиков игрок должен
      // САМОСТОЯТЕЛЬНО нажать кнопку «Бросить кубики» — фишка
      // телепортируется на клетку 10 (JAIL) и движется от неё как
      // обычно. Поэтому:
      //   1) Сбрасываем серию дублей и `mustRollAgain` (после выхода
      //      дублем из тюрьмы НЕЛЬЗЯ бросать кубики ещё раз, даже
      //      если снова выпадет дубль).
      //   2) Устанавливаем `inJail=false`, `jailTurns=0`.
      //   3) При "pay" списываем 50₽.
      //   4) Переводим фазу в `ROLLING` (а не `MOVE_ANIMATION`) — это
      //      даст игроку увидеть активную кнопку «Бросить кубики» и
      //      бросить кости для выхода из тюрьмы. Классический
      //      алгоритм 3-й попытки: анимация → кнопка «Бросить» →
      //      анимация → движение фишки.
      player.consecutiveDoubles = 0;
      player.mustRollAgain = false;

      const escapedMethod: "pay" | "double" = outcome === "pay" ? "pay" : "double";
      if (outcome === "pay") {
        // 3-й промах: принудительная оплата 50₽. Списываем ПОЛНУЮ сумму
        // (без `Math.max(0, ...)`) — если денег не хватило, баланс
        // уйдёт в минус и сработает триггер банкротства.
        player.money -= 50;
        if (this.shouldStartBankruptcy(state, player, null, 50)) {
          return {};
        }
      }
      // Для "escape" (дубль) деньги НЕ списываются — игрок выходит
      // бесплатно, даже на 3-й попытке. Это правильный ход Монополии.
      player.inJail = false;
      player.jailTurns = 0;
      // Журнал: единое универсальное сообщение о выходе из тюрьмы
      // с явным указанием способа выхода (pay/double).
      this.log.logJailEscaped(state, player, escapedMethod);

      // Очищаем контекст прошлой анимации (он относился к попытке
      // выхода из тюрьмы, а не к обычному движению). После нажатия
      // «Бросить кубики» сервер сам сформирует новый `state.lastDice`
      // и `state.moveAnimation` в `handleRolling`/`handleDiceAnimation`.
      state.lastDice = undefined;
      state.moveAnimation = undefined;

      // Переходим в ROLLING: игрок увидит активную кнопку «Бросить
      // кубики». Бросок сделает он сам — фишка начнёт движение
      // от клетки 10 (JAIL) как обычно.
      state.phase = "ROLLING";
      return {};
    }

    // Обычная ветка: ROLL_DICE (не из тюрьмы)
    // Логика дублей — перенесена сюда из старого processMovement.
    if (isDouble) {
      player.consecutiveDoubles += 1;
      if (player.consecutiveDoubles >= 3) {
        // Три дубля подряд → мгновенный телепорт в тюрьму.
        // `JailHandlerService.sendToJail` сам сбрасывает:
        //  - position=10 (JAIL);
        //  - inJail=true, jailTurns=0;
        //  - consecutiveDoubles=0;
        //  - mustRollAgain=false (правило дубля не действует —
        //    в текущем ходу игрок уже не бросает).
        // В этом ходу игрок может только «Завершить ход», поэтому
        // выставляем `justEnteredJail=true` — модалка тюрьмы с тремя
        // способами выхода появится в начале СЛЕДУЮЩЕГО хода, когда
        // `handleStartTurn` сбросит флаг.
        this.jail.sendToJail(player);
        state.justEnteredJail = true;
        // Журнал: попадание в тюрьму через 3 дубля подряд.
        this.log.logJailEntered(state, player, "double");
        state.phase = "JAIL_DECISION";
        return {};
      }
      player.mustRollAgain = true;
    } else {
      player.consecutiveDoubles = 0;
      player.mustRollAgain = false;
    }

    // Вычисляем финальную клетку, но НЕ меняем player.position здесь —
    // position изменится в handleMoveAnimation после CONFIRM_MOVE_ANIMATION.
    const steps = dice[0] + dice[1];
    const boardSize = state.board.length;
    const from = player.position;
    const to = (from + steps) % boardSize;
    const passedGo = from + steps >= boardSize;

    // Клиенту нужно знать откуда/куда анимировать (position ещё не изменился).
    state.moveAnimation = {
      playerId: player.id,
      from,
      to,
      steps,
      isDouble,
    };

    // Переходим в MOVE_ANIMATION. Фишка будет двигаться по клеткам;
    // сама позиция изменится в handleMoveAnimation ПОСЛЕ анимации.
    state.phase = "MOVE_ANIMATION";
    return {};
  }

  /**
   * MOVE_ANIMATION — клиентская фаза анимации движения фишки.
   * Допустимое action: CONFIRM_MOVE_ANIMATION.
   * После подтверждения: фишка ФИНАЛЬНО перемещается на клетку назначения,
   * затем переход в RESOLVING_LANDING (мгновенная фаза → ветвление).
   *
   * ВАЖНО: на промежуточных клетках (через которые фишка «пролетает»)
   * НИКАКИХ эффектов не применяется. Все эффекты (CHANCE, TREASURY, TAX, ...)
   * срабатывают ТОЛЬКО на финальной клетке в `handleResolvingLanding`.
   *
   * Два режима:
   *  1) **Обычный бросок кубиков**: `state.moveAnimation` НЕ заполнен,
   *     позиция вычисляется здесь через `state.lastDice` (сумма кубиков).
   *  2) **Движение по карточке (move / move-relative)**:
   *     `state.moveAnimation` уже заполнен картой, и `player.position`
   *     УЖЕ равен целевой клетке (был изменён в `applyCardEffectAndAdvance`).
   *     В этом случае мы НЕ сдвигаем позицию ещё раз, а только
   *     начисляем goSalary, если было прохождение через 0 (для forward)
   *     или нет (для backward — goSalary НЕ начисляется).
   *     (Карточка «Идите на СТАРТ» с target=0 теперь НЕ даёт бонус
   *     сама — двойная выплата 2× goSalary начисляется в
   *     `handleResolvingLanding` при приземлении на 0.)
   */
  private async handleMoveAnimation(
    state: GameState,
    player: Player,
    action: GameAction,
  ): Promise<{ dice?: [number, number]; card?: unknown; event?: GameEvent }> {
    if (action.type !== "CONFIRM_MOVE_ANIMATION") {
      throw new ForbiddenException(`Недопустимое действие ${action.type} в фазе MOVE_ANIMATION`);
    }
    if (!state.lastDice) {
      throw new BadRequestException("Нет контекста последнего броска");
    }

    // Отличаем карточное движение (move / move-relative) от обычного
    // броска кубиков. Для карточного движения:
    //   - player.position УЖЕ изменён в applyCardEffectAndAdvance;
    //   - state.moveAnimation.direction задан явно ("forward" | "backward");
    //   - goSalary уже начислен (если был wrap через 0 для forward);
    //   - здесь мы только переходим в RESOLVING_LANDING.
    // Для move-карты «Идите на СТАРТ» (target=0) бонус НЕ начисляется
    // — двойная выплата 2× goSalary происходит в `handleResolvingLanding`.
    // Для обычного броска state.moveAnimation заполняется в
    // handleDiceAnimation БЕЗ поля direction - это маркер "позицию ещё
    // нужно сдвинуть здесь".
    const isCardMove =
      !!state.moveAnimation &&
      state.moveAnimation.playerId === player.id &&
      state.moveAnimation.direction !== undefined;

    if (isCardMove) {
      // Очищаем moveAnimation - он нужен был только для клиентской
      // анимации фишки, на сервере больше не требуется.
      state.moveAnimation = undefined;
      state.phase = "RESOLVING_LANDING";
      return {};
    }

    // Обычный бросок кубиков (или дабл после тюрьмы): сдвигаем позицию.
    const dice = state.lastDice.dice;
    const steps = dice[0] + dice[1];
    const oldPos = player.position;
    const newPos = (oldPos + steps) % 40;
    player.position = newPos;

    // Прохождение GO через wrap - зарплата.
    // ВАЖНО: если игрок приземлился РОВНО на клетку 0
    // (например, position=38 + бросок 2 = 40 → 0), зарплату
    // начислит `handleResolvingLanding` (ветка `cell.type === "GO"`)
    // с учётом дубля (двойная/обычная). Здесь мы начисляем goSalary
    // ТОЛЬКО за реальный wrap мимо 0 (newPos > 0 И newPos < oldPos).
    // Условие `newPos !== 0` исключает случай точного приземления
    // на 0, чтобы избежать двойной зарплаты.
    const salaryEarned = 0;
    if (newPos < oldPos && newPos !== 0) {
      player.money += state.settings.goSalary;
      // Журнал: «Получил 200₽ за проход через СТАРТ» (wrap мимо 0).
      // Сумма фиксированная — 1× goSalary.
      // Повышенная выплата 2× goSalary начисляется только когда фишка
      // ПРИЗЕМЛЯЕТСЯ ровно на 0 (логируется в handleResolvingLanding
      // отдельным сообщением «за остановку на СТАРТ»).
      this.log.logGoSalaryPassed(state, player, state.settings.goSalary);
    }

    // Очищаем moveAnimation - он использовался для анимации на клиенте.
    state.moveAnimation = undefined;

    // Переходим в RESOLVING_LANDING - мгновенная фаза-диспетчер по типу клетки.
    state.phase = "RESOLVING_LANDING";
    return {};
  }

  /**
   * RESOLVING_LANDING — мгновенный диспетчер по типу финальной клетки.
   * Допустимое action: CONFIRM_LANDING (для синхронизации с UI).
   * Переводит в PAY_RENT / TAX_PAYMENT / BUY_DECISION / CARD_REVEAL /
   * JAIL_DECISION / BUILDING.
   */
  private async handleResolvingLanding(
    state: GameState,
    player: Player,
    action: GameAction,
  ): Promise<{ card?: unknown; event?: GameEvent }> {
    if (action.type !== "CONFIRM_LANDING") {
      throw new ForbiddenException(`Недопустимое действие ${action.type} в фазе RESOLVING_LANDING`);
    }
    const cell = state.board[player.position];
    if (!cell) {
      state.phase = "BUILDING";
      return {};
    }

    // ГО/СТАРТ — если игрок ОСТАНОВИЛСЯ ровно на клетке id=0
    // (например, после тюрьмы, по карточке «Идите на СТАРТ» или
    // из-за точной длины броска), начисляем ДВОЙНУЮ зарплату
    // (2× goSalary) — правило «приземление на СТАРТ».
    //
    // Итоговая формула оплаты за клетку СТАРТ:
    //   - Проход мимо 0 (wrap в `handleMoveAnimation`) — 1× goSalary;
    //   - Приземление ровно на 0 (`handleResolvingLanding`) — 2× goSalary,
    //     НЕЗАВИСИМО от того, был ли бросок дублём.
    //
    // Правило дублей на этой клетке продолжает действовать
    // стандартно (как на любой «нейтральной» клетке): при
    // `mustRollAgain=true` после приземления — фаза ROLLING.
    if (cell.type === "GO") {
      // Двойная выплата за приземление на СТАРТ.
      player.money += state.settings.goSalary * 2;
      // Журнал: «Получил 400₽ за остановку на СТАРТ».
      // Правило «приземление на СТАРТ = 2× goSalary» действует
      // НЕЗАВИСИМО от того, был ли бросок дублём — поэтому здесь
      // используется отдельное сообщение (а не «за проход через …»).
      this.log.logGoSalaryLanded(state, player, state.settings.goSalary * 2);
      // Правило дублей: если игрок обязан бросить ещё раз (после
      // дубля) — он остаётся в ROLLING; иначе — BUILDING.
      state.phase = player.mustRollAgain ? "ROLLING" : "BUILDING";
      return {};
    }
    // GOTO_JAIL (id=30) — «попадание в тюрьму» по правилам Монополии.
    //
    // Это СПЕЦИАЛЬНОЕ событие, объединяющее в себе «бросок + вытягивание
    // карточки "Отправляйтесь в тюрьму"»:
    //  1) фишка МГНОВЕННО (без анимации) переносится на клетку 10
    //     (телепорт, не шаг);
    //  2) `inJail=true`, `jailTurns=0`;
    //  3) `consecutiveDoubles=0` (правило трёх дублей сбрасывается);
    //  4) `mustRollAgain=false` (право на ещё один бросок — даже если
    //     попали через дубль — ТЕРЯЕТСЯ; цепочка «бросок → движение →
    //     эффект» обрывается);
    //  5) `state.justEnteredJail=true` — в ЭТОМ ходу игрок может
    //     только «Завершить ход» (модалка тюрьмы с тремя способами
    //     выхода появится в начале СЛЕДУЮЩЕГО хода, когда
    //     `handleStartTurn` сбросит флаг);
    //  6) фаза = JAIL_DECISION (только END_TURN/CONFIRM_END_TURN
    //     допустимы, см. handleJailDecision).
    //
    // UX-flow: показываем модалку-объявление через стандартный
    // `CARD_REVEAL` -> `CardModal` (как для Chance). При подтверждении
    // CONFIRM_CARD идёт `handleCardEffect` -> `applyCardEffectAndAdvance`
    // (outcome.kind === "goto-jail") -> `sendToJail()` + JAIL_DECISION.
    // Сама фишка НЕ двигается по клеткам (нет MOVE_ANIMATION) —
    // клиент при `justEnteredJail=true` ставит её на `player.position`
    // мгновенно через watcher в GameView.vue.
    //
    // ВАЖНО: логика «попадание в тюрьму» идентична и для клетки 30,
    // и для карточки «Отправляйтесь в тюрьму» (Ch ch4, Tr tr4). Это
    // единая точка истины: sendToJail() в JailHandlerService.
    if (cell.type === "GOTO_JAIL") {
      const jailCard = CHANCE_CARDS.find((c) => c.effect.kind === "goto-jail");
      if (jailCard) {
        // Сбрасываем mustRollAgain/consecutiveDoubles СРАЗУ при попадании
        // на 30 — иначе на фазе CARD_REVEAL флаг «обязан бросить ещё раз»
        // висит, и при подтверждении CONFIRM_CARD поведение было бы
        // неконсистентным. Здесь же, до показа модалки, мы выравниваем
        // флаги по правилам «попадание в тюрьму» (сбросить всё).
        player.mustRollAgain = false;
        player.consecutiveDoubles = 0;
        // Для карточки GOTO_JAIL с клетки 30 мы НЕ вызываем DeckModule
        // здесь: cardContext.card приходит из CHANCE_CARDS (это уже
        // вытянутая карта). deckCardId ставим null — в
        // applyCardEffectAndAdvance карта просто сгорает (DRAWN → USED)
        // через логику goto-jail, без возврата в колоду.
        state.cardContext = {
          playerId: player.id,
          deck: "chance",
          card: jailCard,
          applied: false,
          deckCardId: null,
        };
        state.phase = "CARD_REVEAL";
        return { card: jailCard };
      }
      // fallback (если карточка не найдена в деке — теоретически невозможно)
      this.jail.sendToJail(player);
      state.justEnteredJail = true;
      // Журнал: попадание в тюрьму через клетку 30 (fallback).
      this.log.logJailEntered(state, player, "cell");
      state.phase = "JAIL_DECISION";
      return {};
    }
    // CHANCE / TREASURY — двухфазная обработка:
    //   1) CARD_REVEAL  — сервер вытягивает карту, кладёт её в state.cardContext,
    //                     НО НЕ применяет эффект. Клиент показывает модалку.
    //   2) CARD_EFFECT  — после CONFIRM_CARD эффект применяется.
    if (cell.type === "CHANCE" || cell.type === "TREASURY") {
      // Per-field: тянем из колоды, привязанной к КОНКРЕТНОЙ клетке (cell.id).
      const drawResult = this.cards.drawFromCell(cell.id, state);
      const card = drawResult.card;
      const deckName = cell.type === "CHANCE" ? "chance" : "treasury";
      // Журнал: фиксируем, какая карточка была вытянута.
      this.log.logCardDrawn(state, player, deckName, card.text);
      state.cardContext = {
        playerId: player.id,
        deck: deckName,
        card: drawResult.card,
        applied: false,
        deckCardId: drawResult.deckCardId || null,
      };
      state.phase = "CARD_REVEAL";
      return { card: drawResult.card };
    }
    // PROPERTY / RAILROAD / UTILITY.
    if (cell.type === "PROPERTY" || cell.type === "RAILROAD" || cell.type === "UTILITY") {
      // На всякий случай чистим прошлый контекст.
      if (!cell.ownerId) {
        state.rentContext = undefined;
        state.phase = "BUY_DECISION";
      } else if (cell.ownerId === player.id) {
        // Своя клетка: раньше здесь ВСЕГДА ставилась фаза
        // BUILDING, без проверки `mustRollAgain`. Это приводило к
        // ступору после дубля:
        //   canEndTurn=false (т.к. mustRollAgain=true в BUILDING)
        //   canRoll=false (т.к. фаза ≠ ROLLING)
        //   → ни одна кнопка не активна.
        //
        // По правилам Монополии: PROPERTY/RAILROAD/UTILITY — это
        // «нейтральные» клетки, на которые правило дублей ДЕЙСТВУЕТ
        // (как и на парковку/тюрьму-визит). После дубля на СВОЕЙ
        // клетке игрок должен бросить ещё раз. Без дубля — обычный
        // переход в BUILDING (можно строить, торговать, завершить ход).
        state.rentContext = undefined;
        state.phase = player.mustRollAgain ? "ROLLING" : "BUILDING";
      } else {
        // Чужая — рассчитываем ренту заранее и кладём в state.rentContext,
        // затем переходим в PAY_RENT. Деньги НЕ списываем — клиент должен
        // сначала показать модалку и отправить CONFIRM_RENT_PAYMENT.
        // После CONFIRM_RENT_PAYMENT сервер сам переведёт фазу в
        // ROLLING (если `mustRollAgain=true`) — см. `afterRentOrTax`.
        state.rentContext = this.buildRentContext(state, cell);
        state.phase = "PAY_RENT";
      }
      return {};
    }
    // TAX.
    if (cell.type === "TAX") {
      // Вариант "luxury" (id=38) — карточка-формула из колоды LUXURY_TAX_CARDS.
      // Сервер вытягивает карту, кладёт её в cardContext, фаза CARD_REVEAL
      // (модалка с описанием формулы; списывание — после CONFIRM_CARD в CARD_EFFECT).
      if (cell.taxVariant === "luxury") {
        const drawResult = this.cards.drawFromDeck("luxury-tax", state);
        const card = drawResult.card;
        // Журнал: фиксируем «вытянутую карточку-формулу».
        this.log.logCardDrawn(state, player, "luxury-tax", card.text);
        state.cardContext = {
          playerId: player.id,
          deck: "luxury-tax",
          card,
          applied: false,
          // deckCardId нужен applyCardEffectAndAdvance для возврата карты
          // в низ колоды (правило «discard to bottom»).
          deckCardId: drawResult.deckCardId || null,
        };
        state.phase = "CARD_REVEAL";
        return { card };
      }
      // Вариант "income" (id=4) — фиксированная сумма в модалке «Заплатите N₽».
      // Списание — только после CONFIRM_TAX (фаза TAX_PAYMENT).
      if (cell.taxVariant === "income" && cell.taxAmount) {
        state.phase = "TAX_PAYMENT";
        return {};
      }
      // Legacy fallback: если `taxAmount` задан без `taxVariant`, списываем
      // сразу (старая логика, чтобы не сломать существующие данные).
      if (cell.taxAmount) {
        state.phase = "PAY_RENT";
        return {};
      }
      state.phase = "BUILDING";
      return {};
    }
    // PARKING (id=20) — «отдых» по правилам Монополии: цепочка
    // «бросок → движение → эффект» обрывается.
    //
    // ВАЖНО: правило дублей действует и здесь, как для Тюрьмы-визита:
    //  - Без дубля: фаза BUILDING, `mustRollAgain` сбрасывается.
    //  - С дублём: `mustRollAgain` СОХРАНЯЕТСЯ, фаза ROLLING — игрок
    //    бросает ещё раз (правило дублей действует на любой
    //    «нейтральной» клетке, в т.ч. Бесплатная парковка).
    //
    // Флаг `state.justArrivedAtParking` ставится ТОЛЬКО при попадании
    // по карточке «Отправляйтесь на парковку» (см.
    // applyCardEffectAndAdvance в `move`-ветке). В этом случае
    // право на ещё один бросок (после дубля) ТЕРЯЕТСЯ по правилам
    // Монополии — фаза становится BUILDING безусловно (даже если
    // бы `mustRollAgain` был `true`, он уже сброшен в
    // applyCardEffectAndAdvance).
    if (cell.type === "PARKING") {
      if (state.justArrivedAtParking) {
        // Карточка «Отправляйтесь на парковку»: «отдых» (аналог
        // ареста), цепочка дублей обрывается. `mustRollAgain` уже
        // сброшен в applyCardEffectAndAdvance. Фаза = BUILDING,
        // можно только завершить ход.
        state.phase = "BUILDING";
      } else if (player.mustRollAgain) {
        // Дубль: сохраняем право на повторный бросок.
        state.phase = "ROLLING";
      } else {
        // Без дубля: обычный отдых, можно завершить ход.
        state.phase = "BUILDING";
      }
      return {};
    }
    // JAIL (id=10) — после анимации, инициированной карточкой
    // «В тюрьму» (move-эффект `target=10` или goto-jail outcome),
    // выполняем `sendToJail` для централизованной установки
    // `inJail=true`, `jailTurns=0`, `consecutiveDoubles=0`,
    // `mustRollAgain=false`, `justEnteredJail=true` + фаза =
    // JAIL_DECISION.
    //
    // Раньше этот шаг делался сразу в `applyCardEffectAndAdvance`
    // (как «мгновенный телепорт»). Теперь он отложен — сначала
    // фишка АНИМИРУЕТСЯ backward к клетке 10, и только здесь, в
    // `handleResolvingLanding`, выполняется фактическая отправка
    // в тюрьму.
    //
    // Маркер `state.pendingJailFromCard` ставится в
    // `applyCardEffectAndAdvance` для move-target=10 и goto-jail
    // outcome. Без этого маркера обычный visit на JAIL через кубики
    // тоже попадал бы сюда (старая регрессия).
    if (cell.type === "JAIL" && !player.inJail && state.pendingJailFromCard) {
      this.jail.sendToJail(player);
      state.justEnteredJail = true;
      this.log.logJailEntered(state, player, "card");
      state.pendingJailFromCard = false;
      state.phase = "JAIL_DECISION";
      return {};
    }
    // JAIL (visit, id=10) — «просто посещение», ничего не делаем.
    //
    // Правило дублей действует и здесь, как для Парковки/Тюрьмы:
    //  - Без дубля: `mustRollAgain=false`, фаза BUILDING.
    //  - С дублём: `mustRollAgain` СОХРАНЯЕТСЯ, фаза ROLLING — игрок
    //    бросает ещё раз (правило дублей на любой «нейтральной»
    //    клетке, в т.ч. Тюрьма-визит).
    //
    // В обоих случаях `inJail` НЕ меняется — это НЕ арест, а просто
    // посещение (правила Монополии).
    if (player.mustRollAgain) {
      state.phase = "ROLLING";
    } else {
      state.phase = "BUILDING";
    }
    return {};
  }
  /**
   * PAY_RENT — двухфазная оплата ренты (аренда чужой собственности):
   *
   *  1) При входе в фазу (в `handleResolvingLanding`) сервер рассчитывает
   *     `rent` и кладёт его в `state.rentContext` (плюс ID владельца).
   *     Деньги НЕ списываются.
   *  2) Клиент показывает модалку с суммой и владельцем. По «OK» клиент
   *     отправляет `CONFIRM_RENT_PAYMENT` — и только тогда сервер списывает
   *     деньги и переходит в `BUILDING` (или `ROLLING` при `mustRollAgain`).
   *
   * Допустимые actions: CONFIRM_RENT_PAYMENT.
   *
   * НЕ используется для налогов — те идут через TAX_PAYMENT (income)
   * и CARD_EFFECT (luxury).
   */
  private async handlePayRent(
    state: GameState,
    player: Player,
    action: GameAction,
  ): Promise<{ card?: unknown; event?: GameEvent }> {
    if (action.type !== "CONFIRM_RENT_PAYMENT") {
      throw new ForbiddenException(`Недопустимое действие ${action.type} в фазе PAY_RENT`);
    }

    const cell = state.board[player.position];
    if (!cell) {
      state.phase = "BUILDING";
      state.rentContext = undefined;
      this.advanceToNextPlayer(state);
      return {};
    }

    if (cell.type === "PROPERTY" || cell.type === "RAILROAD" || cell.type === "UTILITY") {
      // Заложенная, бесхозная или своя — ренты нет.
      if (cell.isMortgaged || !cell.ownerId || cell.ownerId === player.id) {
        state.rentContext = undefined;
        this.afterRentOrTax(state, player);
        return {};
      }
      // Берём сумму из rentContext, если он есть; иначе считаем на лету.
      const ctx = state.rentContext;
      const rent = ctx?.amount ?? this.rentCalc.calculate(cell, state, state.lastDice?.dice);
      const ownerId = ctx?.ownerId ?? cell.ownerId;
      const owner = state.players.find((p) => p.id === ownerId);
      if (owner && rent > 0) {
        // ВАЖНО: НЕ используем `Math.max(0, ...)` — пусть баланс
        // уйдёт в минус. Это сигнал для триггера банкротства.
        // По правилам Монополии рента списывается полностью, а
        // отрицательный остаток — это именно «нечем платить».
        player.money -= rent;
        owner.money += rent;
        state.rentContext = undefined;
        // Триггер банкротства: один-единственный вызов.
        // ВАЖНО (исправление бага «BUILDING вместо ROLLING после
        // банкротства»): раньше `shouldStartBankruptcy` вызывался
        // ДВАЖДЫ — сначала для лога, потом повторно. Если первый
        // вызов уже сработал (банкротство, переход к следующему
        // игроку, `state.phase = "ROLLING"` через `beginNextPlayerTurn`),
        // второй вызов шёл с УЖЕ обнулённым `money` (bankruptcy.handle
        // ставит money=0) и возвращал `false`. Тогда `return {};` не
        // срабатывал, выполнение падало дальше на
        // `this.afterRentOrTax(state, player)` — а там `state.phase
        // = "BUILDING"`, что ПЕРЕТИРАЛО только что установленный
        // ROLLING. Следующий игрок оказывался в фазе BUILDING без
        // контекста, кнопка «Бросить кубики» неактивна.
        // Теперь: ОДИН вызов + ранний return при банкротстве, никаких
        // побочных эффектов `afterRentOrTax` поверх банкротства.
        if (this.shouldStartBankruptcy(state, player, owner, rent)) {
          return {};
        }
        // Банкротства нет — логируем факт оплаты ренты.
        this.log.logRentPaid(state, player, owner, cell.name, rent);
      } else {
        state.rentContext = undefined;
      }
      this.afterRentOrTax(state, player);
      return {};
    }

    // Legacy-fallback: TAX без taxVariant (старые данные).
    if (cell.type === "TAX" && cell.taxAmount) {
      // ВАЖНО: НЕ клампим в 0 — пусть баланс уйдёт в минус и
      // сработает триггер банкротства.
      player.money -= cell.taxAmount;
      state.rentContext = undefined;
      if (this.shouldStartBankruptcy(state, player, null, cell.taxAmount)) {
        return {};
      }
      this.afterRentOrTax(state, player);
      return {};
    }

    // На всякий случай — fallback.
    state.rentContext = undefined;
    this.afterRentOrTax(state, player);
    return {};
  }

  /**
   * TAX_PAYMENT — модальная фаза для фиксированного налога (Подоходный).
   * Клиент показывает «Заплатите N₽» и шлёт `CONFIRM_TAX`.
   * Допустимое action: CONFIRM_TAX.
   */
  private async handleTaxPayment(
    state: GameState,
    player: Player,
    action: GameAction,
  ): Promise<{ card?: unknown; event?: GameEvent }> {
    if (action.type !== "CONFIRM_TAX") {
      throw new ForbiddenException(`Недопустимое действие ${action.type} в фазе TAX_PAYMENT`);
    }
    const cell = state.board[player.position];
    if (!cell || cell.type !== "TAX" || cell.taxVariant !== "income" || !cell.taxAmount) {
      // Не income-налог — откатываемся.
      this.afterRentOrTax(state, player);
      return {};
    }
    // ВАЖНО: НЕ клампим в 0 — пусть баланс уйдёт в минус,
    // сработает триггер банкротства.
    player.money -= cell.taxAmount;
    // Журнал: фиксированный «Подоходный налог N₽» (клетка id=4).
    // «Игрок заплатил подоходный налог 200₽».
    this.log.logIncomeTaxPaid(state, player, cell.taxAmount);
    if (this.shouldStartBankruptcy(state, player, null, cell.taxAmount)) {
      return {};
    }
    this.afterRentOrTax(state, player);
    return {};
  }

  /**
   * Хелпер: после PAY_RENT/TAX_PAYMENT/TREASURY(money)/CardEffect(money/jail-free)
   * переходим в BUILDING (своя клетка) или передаём ход.
   */
  private afterRentOrTax(state: GameState, player: Player) {
    if (player.mustRollAgain) {
      state.phase = "ROLLING";
    } else {
      state.phase = "BUILDING";
    }
  }

  /**
   * Хелпер: рассчитать ренту для чужой клетки и вернуть контекст
   * для `state.rentContext`. Не учитывает возможное банкротство — это
   * уже решается в `handlePayRent` по факту `CONFIRM_RENT_PAYMENT`.
   *
   * Принимает `Cell` (мы всегда зовём с `state.board[player.position]`).
   */
  private buildRentContext(state: GameState, cell: Cell): GameState["rentContext"] {
    if (!cell.ownerId) return undefined;
    if (cell.isMortgaged) return undefined;
    const owner = state.players.find((p) => p.id === cell.ownerId);
    if (!owner) return undefined;
    const rent = this.rentCalc.calculate(cell, state, state.lastDice?.dice);
    if (rent <= 0) return undefined;
    return {
      ownerId: owner.id,
      ownerName: owner.displayName,
      amount: rent,
    };
  }

  /**
   * BUY_DECISION — решение о покупке. Допустимые: BUY_PROPERTY, DECLINE_BUY.
   * DECLINE_BUY может запустить аукцион (если `settings.auctionEnabled`).
   */
  private async handleBuyDecision(
    state: GameState,
    player: Player,
    action: GameAction,
  ): Promise<{ card?: unknown; event?: GameEvent }> {
    const cell = state.board[player.position];
    if (!cell) throw new NotFoundException("Клетка не найдена");

    if (action.type === "BUY_PROPERTY") {
      if (cell.ownerId) throw new ForbiddenException("Клетка уже куплена");
      if (cell.price === undefined) throw new BadRequestException("Клетка не продаётся");
      if (player.money < cell.price) throw new ForbiddenException("Недостаточно денег");
      // Покупка идёт по полной стоимости. Если у игрока ровно хватает
      // (player.money === cell.price) — баланс уходит в 0, но это НЕ
      // банкротство (правильно: долга нет, имущество приобретено). Если
      // покупка привела к отрицательному балансу (например, баг/гонка)
      // — списываем как есть и проверяем триггер банкротства.
      player.money -= cell.price;
      player.properties.push(cell.id);
      cell.ownerId = player.id;
      // Журнал: фиксируем покупку собственности. Добавляем в state.events
      // (через logService), а сам event не возвращаем — иначе applyAction
      // продублирует его. Запись попадает на клиент в следующем snapshot.
      this.log.logPropertyBought(state, player, cell.name, cell.price);
      if (this.shouldStartBankruptcy(state, player, null, cell.price)) {
        return {};
      }
      state.phase = player.mustRollAgain ? "ROLLING" : "BUILDING";
      return {};
    }

    if (action.type === "DECLINE_BUY") {
      // Журнал: фиксируем отказ от покупки. Полезно для истории партии:
      // видно, кто и какую клетку пропустил (а на следующем ходу
      // выясняется, что она ушла на аукционе или осталась свободной).
      this.log.logPropertyDeclined(state, player, cell.name);
      if (state.settings.auctionEnabled) {
        // Запускаем аукцион: AuctionService выставляет state.auction
        // (статус AWAITING_START → AUCTION_ACTIVE) и эмитит
        // AUCTION_START + AUCTION_TURN_UPDATE через onAuctionEvent.
        const started = this.auction.startAuction(
          this.findGameIdByState(state),
          state,
          cell,
          player,
        );
        if (!started) {
          // Никто не может участвовать (все банкроты) — пропускаем фазу.
          state.phase = player.mustRollAgain ? "ROLLING" : "BUILDING";
          return {};
        }
        // ВАЖНО: AuctionService.startAuction уже активировал движок
        // (state.auction.status === "AUCTION_ACTIVE"). Ставим фазу сразу
        // в AUCTION_ACTIVE, иначе scheduleAuctionTimer в начале проверит
        // state.phase !== "AUCTION_ACTIVE" и вернётся (return) — таймер
        // для бота не запустится, и аукцион «зависнет» на ходу первого
        // участника. Раньше фаза AUCTION_AWAITING_START ждала
        // dispatch → handleAuctionAwaitingStart, но в реальности
        // никто из клиентов не присылает confirm для этой фазы —
        // переход должен происходить синхронно при DECLINE_BUY.
        state.phase = "AUCTION_ACTIVE";
        this.scheduleAuctionTimer(state);
        return {};
      }
      // Без аукциона — сразу следующая фаза.
      state.phase = player.mustRollAgain ? "ROLLING" : "BUILDING";
      return {};
    }

    throw new ForbiddenException(`Недопустимое действие ${action.type} в фазе BUY_DECISION`);
  }

  /**
   * CARD_REVEAL — фаза показа карточки. Сервер уже вытянул карту и положил её
   * в `state.cardContext` (в `handleResolvingLanding`). Эффект НЕ применён.
   * Клиент показывает модалку. После того, как игрок её прочитал и закрыл,
   * клиент отправляет `CONFIRM_CARD`, и сервер переходит в `CARD_EFFECT`.
   *
   * Допустимое action: CONFIRM_CARD.
   */
  private async handleCardReveal(
    state: GameState,
    player: Player,
    action: GameAction,
  ): Promise<{ card?: unknown; event?: GameEvent }> {
    if (action.type !== "CONFIRM_CARD") {
      throw new ForbiddenException(`Недопустимое действие ${action.type} в фазе CARD_REVEAL`);
    }
    if (!state.cardContext) {
      throw new BadRequestException("Нет контекста карты");
    }
    if (state.cardContext.playerId !== player.id) {
      throw new ForbiddenException("Эта карта не для вас");
    }
    // Применяем эффект сразу при CONFIRM_CARD и сразу выставляем финальную фазу.
    // Раньше здесь был промежуточный переход в CARD_EFFECT, но клиент не
    // отправлял второй CONFIRM_CARD → партия зависала.
    return this.applyCardEffectAndAdvance(state, player);
  }

  /**
   * CARD_EFFECT — фаза применения эффекта карты (вызывается, если
   * `handleCardReveal` оставил партию в CARD_EFFECT без применения
   * — например, для ботов или для восстановления после reconnect).
   *
   * На этом этапе мы ПРИМЕНЯЕМ эффект, и в зависимости от результата:
   *  - `money` / `jail-free` / `luxury-tax-house` → BUILDING (или ROLLING при mustRollAgain)
   *  - `move` (телепорт)    → MOVE_ANIMATION (фишка полетит на новую клетку)
   *  - `move-relative`      → MOVE_ANIMATION
   *  - `goto-jail`          → JAIL_DECISION
   */
  private async handleCardEffect(
    state: GameState,
    player: Player,
    _action: GameAction,
  ): Promise<{ card?: unknown; event?: GameEvent }> {
    if (!state.cardContext) {
      throw new BadRequestException("Нет контекста карты");
    }
    if (state.cardContext.playerId !== player.id) {
      throw new ForbiddenException("Эта карта не для вас");
    }
    if (state.cardContext.applied) {
      // Эффект уже применён в CARD_REVEAL. Просто продвигаем фазу.
      this.advanceFromCardEffect(state, player);
      return { card: state.cardContext.card };
    }
    return this.applyCardEffectAndAdvance(state, player);
  }

  /**
   * Общая логика применения эффекта карточки (вызывается из CARD_REVEAL
   * или CARD_EFFECT). Идемпотентно — если эффект уже применён, просто
   * выставляет фазу.
   *
   * ВАЖНО: после применения эффекта `cardContext`
   * ОБЯЗАТЕЛЬНО очищается во всех ветках. Раньше для `move` и `move-relative`
   * клиент продолжал видеть `state.cardContext.card` в фазе `MOVE_ANIMATION`,
   * и при повторном получении `game:state` (reconnect, повторный mount, ...)
   * watcher заново открывал модалку карточки.
   */
  private applyCardEffectAndAdvance(
    state: GameState,
    player: Player,
  ): { card?: unknown; event?: GameEvent } {
    if (!state.cardContext) {
      throw new BadRequestException("Нет контекста карты");
    }
    if (state.cardContext.applied) {
      this.advanceFromCardEffect(state, player);
      return { card: state.cardContext.card };
    }

    const card = state.cardContext.card;
    const outcome = this.cards.applyEffect(card, player, state);
    state.cardContext.applied = true;

    // ─── Правило «дубль + карточка» ─────────────────────────────────────
    // раньше здесь безусловно сбрасывались `mustRollAgain`
    // и `consecutiveDoubles` для ЛЮБЫХ карт `move` и `move-relative`. Это
    // ломало правило дублей для карточек «Вернитесь на N клеток назад»:
    // игрок выбрасывал дубль, попадал на Шанс, вытягивал такую карту,
    // и вместо повторного броска получал фазу BUILDING с заблокированными
    // обеими кнопками (canEndTurn=false из-за mustRollAgain=true,
    // canRoll=false из-за фазы ≠ ROLLING) → ступор.
    //
    // Корректные правила Монополии:
    //  - money / jail-free / luxury-tax-house (stay) — игрок остаётся
    //    на той же клетке, `mustRollAgain` СОХРАНЯЕТСЯ (бросок ещё раз).
    //  - move-relative (шаг вперёд/назад, любая дистанция) — это НЕ
    //    «выводящая» карточка: игрок остаётся в основном цикле хода,
    //    `mustRollAgain` СОХРАНЯЕТСЯ.
    //  - move на СТАРТ (target=0) — игрок остаётся в основном цикле,
    //    `mustRollAgain` СОХРАНЯЕТСЯ. Денежная выплата за приземление
    //    на СТАРТ начисляется автоматически в `handleResolvingLanding`
    //    (ветка `cell.type === "GO"`): 2× goSalary НЕЗАВИСИМО от дубля.
    //    Карточка бонус НЕ даёт (раньше давала +goSalary).
    //  - move на конкретную клетку вроде ул. Арбат (target=37) — тоже
    //    НЕ «выводящая» карточка, `mustRollAgain` СОХРАНЯЕТСЯ.
    //  - move на парковку (target=20) — «выводящая» (отдых), сброс
    //    делается в специальной ветке ниже (там ставится
    //    `justArrivedAtParking=true` и фаза BUILDING).
    //  - move в тюрьму (target=10) и goto-jail — `sendToJail` уже
    //    сбрасывает `mustRollAgain` и `consecutiveDoubles`.
    //
    // Поэтому здесь НЕ сбрасываем флаги. Они сбрасываются только
    // в спецветках (парковка, тюрьма) или в `afterRentOrTax` (для
    // stay-исходов, если `mustRollAgain=false`).
    // (Сброс `mustRollAgain`/`consecutiveDoubles` намеренно НЕ
    // делается здесь — см. правила выше. Для «выводящих» карточек
    // (парковка, тюрьма) сброс делается в специальных ветках ниже.)

    if (outcome.kind === "move") {
      // ВАЖНО: для карточек «move» (включая «Идите на СТАРТ» с
      // target=0) мы НЕ начисляем goSalary на этом шаге.
      // Выплата за приземление на СТАРТ (2× goSalary, НЕЗАВИСИМО от
      // дубля) происходит автоматически в `handleResolvingLanding`
      // (ветка `cell.type === "GO"`). Раньше здесь начислялся +goSalary
      // за target=0, что давало 200₽ от карточки + 400₽ от
      // приземления = 600₽ (и больше при дубле). По новым правилам
      // карточка бонус НЕ даёт.
      // Переставляем позицию игрока.
      const from = player.position;
      const to = outcome.target;
      player.position = to;

      // ─── Направление анимации для move-карточек ───────────────────
      // Правила:
      //  1) «Идите на СТАРТ» (target=0) — ВСЕГДА "forward". Это
      //     правило игры: фишка останавливается на СТАРТ и получает
      //     двойной бонус 2× goSalary. Идти НАЗАД через 0 и потом
      //     «наматывать» круг до 0 запрещено (бессмысленно).
      //  2) «Отправляйтесь в тюрьму» (target=10) — ВСЕГДА "backward".
      //     Это тюрьма, никакого goSalary за проход через СТАРТ, и
      //     визуально фишка «уезжает назад» к клетке 10.
      //  3) «Отправляйтесь на парковку» (target=20) — ВСЕГДА "backward".
      //     Аналогично тюрьме: парковка — это «отдых», а не путешествие,
      //     и фишка не должна проходить через СТАРТ ради 200₽ бонуса.
      //  4) «Клетка В тюрьму» (target=30) — ВСЕГДА "backward".
      //     Чтобы фишка не «наматывала» через СТАРТ ради goSalary.
      //  5) Все остальные move-карточки (например, «ул. Арбат» target=37):
      //     направление = "backward" если from > target, иначе "forward".
      //     Тот же принцип: фишка НЕ проходит через СТАРТ и не получает
      //     goSalary-бонус за wrap.
      //
      // Шаги анимации:
      //  - forward:  (to - from + 40) % 40
      //  - backward: (from - to + 40) % 40
      //
      // goSalary начисляется ТОЛЬКО в forward-ветке, и ТОЛЬКО если
      // произошел wrap (oldPos + steps >= 40). Но в нашей текущей
      // логике для move-карточек мы намеренно ИЗБЕГАЕМ wrap через
      // СТАРТ (выбирая "backward" вместо "forward", если возможно).
      // Поэтому goSalary за wrap для move-карточек НЕ начисляем —
      // двойная выплата 2× goSalary происходит только при приземлении
      // ровно на клетку 0 (в `handleResolvingLanding`, ветка `cell.type
      // === "GO"`).
      let direction: "forward" | "backward";
      let steps: number;
      if (to === 0) {
        // Идите на СТАРТ — всегда вперёд (по часовой).
        // Это единственное исключение: чтобы фишка получила двойной
        // бонус 2× goSalary, она должна прийти на клетку 0 движением
        // ВПЕРЁД (по часовой), а не «наматывать круг назад» через 0
        // (что бессмысленно).
        direction = "forward";
        steps = (to - from + 40) % 40;
      } else if (to === 10 || to === 20 || to === 30) {
        // В тюрьму (id=10) / Парковка (id=20) / GOTO_JAIL (id=30).
        //
        // Универсальное правило «кратчайший путь без прохода через СТАРТ»:
        //   - from < to  → ВПЕРЁД по часовой  (напр., 7→10, 17→20, 17→30);
        //   - from > to  → НАЗАД против часовой (напр., 30→10, 30→20, 35→30).
        //
        // Никогда не наматываем через клетку 0 (СТАРТ) — это лишний
        // обход доски и потенциально goSalary-бонус, который для
        // этих клеток НЕ полагается (тюрьма/парковка — «отдых»,
        // GOTO_JAIL — телепорт, а не путешествие).
        //
        // Эта логика полностью симметрична `goto-jail` outcome ниже
        // (см. ветку `outcome.kind === "goto-jail"`), чтобы движение
        // по карточкам было предсказуемым и одинаковым во всех ветках.
        if (from < to) {
          direction = "forward";
          steps = to - from;
        } else {
          direction = "backward";
          steps = from - to;
        }
      } else {
        // Остальные move-карточки (например, «ул. Арбат» target=37):
        // то же правило «кратчайший путь без прохода через СТАРТ»:
        //   - from > to  → НАЗАД (короче, и не проходим через 0);
        //   - from < to  → ВПЕРЁД (короче, и не проходим через 0);
        //   - from === to → не движение (steps=0, direction=forward по умолчанию).
        if (from > to) {
          direction = "backward";
          steps = from - to;
        } else {
          direction = "forward";
          steps = to - from;
        }
      }

      // ─── Спецслучай: «Отправляйтесь на парковку» (id=20) ──────────
      // По правилам Монополии парковка — это «отдых»: цепочка
      // «бросок → движение → эффект» обрывается, право на ещё один
      // бросок (после дубля) ТЕРЯЕТСЯ. АНИМАЦИЯ фишки СОХРАНЯЕТСЯ
      // (раньше был мгновенный телепорт — это был баг: фишка
      // «телепортировалась» без визуального отображения перемещения).
      // После анимации `handleResolvingLanding` → ветка `cell.type
      // === "PARKING"` → если `justArrivedAtParking=true`, фаза
      // становится `BUILDING` (см. override ниже).
      //
      // Флаг `justArrivedAtParking` блокирует `canRollDice`
      // (см. turn-permissions.ts) — в этом ходу игрок может только
      // завершить ход. Сбрасывается в `handleStartTurn` при начале
      // СЛЕДУЮЩЕГО хода.
      const PARKING_ID = 20;
      if (to === PARKING_ID) {
        // «выводящая» карточка парковки обрывает цепочку дублей.
        // Сбрасываем `mustRollAgain`/`consecutiveDoubles` явно ЗДЕСЬ,
        // потому что общий безусловный сброс удалён выше (он ломал
        // move-relative).
        player.mustRollAgain = false;
        player.consecutiveDoubles = 0;
        state.justArrivedAtParking = true;
      }

      // ─── Спецслучай: «В тюрьму» (move target=10) ──────────────────
      // До этой правки карточка «В тюрьму» ТОЖЕ была телепортом
      // (через ветку `goto-jail` ниже или прямую `sendToJail`).
      // Теперь фишка АНИМИРУЕТСЯ backward к клетке 10, и только
      // ПОСЛЕ анимации (в `handleResolvingLanding` → ветка для
      // JAIL/target=10) вызывается `sendToJail` + ставится
      // `justEnteredJail=true` + фаза = JAIL_DECISION.
      //
      // Чтобы после анимации корректно сработала отправка в тюрьму,
      // ставим `player.inJail = true` сразу. `sendToJail` ещё раз
      // продублирует это в `handleResolvingLanding` (idempotent).
      const JAIL_ID = 10;
      if (to === JAIL_ID) {
        // Сбрасываем mustRollAgain / consecutiveDoubles — тюрьма
        // обрывает цепочку дублей (как и через клетку 30).
        player.mustRollAgain = false;
        player.consecutiveDoubles = 0;
        // Маркер для handleResolvingLanding: приземление через
        // карточку, а не обычный JAIL-visit через кубики.
        state.pendingJailFromCard = true;
      }

      // Заполняем moveAnimation — клиент использует его для анимации фишки.
      state.moveAnimation = {
        playerId: player.id,
        from,
        to,
        steps,
        isDouble: false,
        direction,
      };
      // Правило Монополии «discard to bottom»: возвращаем вытянутую
      // не-holdable карту в НИЗ её исходной колоды (state.deckCards).
      // Для holdable карт (ch7) — no-op: карта осталась бы в IN_HAND,
      // но мы тут обрабатываем только move-эффекты, holdable их не имеют.
      this.cards.returnDrawnCardIfNeeded(state, state.cardContext.deckCardId);
      // Очищаем cardContext — карта «съедена», эффект move применён.
      // Без этого клиент видел ту же карту в MOVE_ANIMATION и мог
      // повторно открыть модалку.
      state.cardContext = undefined;
      state.phase = "MOVE_ANIMATION";
      // lastDice — нужно для расчёта moveStepMs ботом.
      // Кладём steps как сумму кубиков (аналогично move-relative):
      // это влияет только на длительность анимации (moveStepMs × N).
      state.lastDice = {
        dice: direction === "forward" ? [0, steps] : [steps, 0],
        isDouble: false,
      };
      // Передаём карту наверх (для логов и broadcast).
      return { card };
    }

    if (outcome.kind === "move-relative") {
      // Движение на N клеток вперёд/назад.
      //
      // ВАЖНО: раньше здесь для `steps < 0`
      // фишка вычислялась как `(oldPos + steps + 40) % 40` — это давало
      // правильную ЦЕЛЕВУЮ позицию, но клиент в GameView.animatePlayerTo
      // использовал `(to - from + 40) % 40` для определения шагов и
      // `(from + i) % 40` для промежуточных клеток, что всегда давало
      // движение ВПЕРЁД по часовой стрелке. В результате игрок на
      // клетке 38, получив «вернитесь на 3 клетки назад», «пролетал»
      // через всю доску 38 → 39 → 0 → 1 → 2 → ... → 35.
      //
      // Теперь мы явно передаём `direction: outcome.direction` в
      // `state.moveAnimation`, и клиент анимирует фишку в правильном
      // направлении (вперёд/назад).
      const oldPos = player.position;
      const steps = Math.abs(outcome.steps);
      const direction: "forward" | "backward" = outcome.direction;

      // Новая позиция: для "forward" — oldPos + steps (с wrap через 0),
      // для "backward" — oldPos - steps (с wrap через 39).
      let newPos: number;

      if (direction === "forward") {
        newPos = (oldPos + steps) % 40;
        // Прохождение GO начисляет зарплату (только при движении вперёд).
        // ВНИМАНИЕ: начисляем ТОЛЬКО если игрок РЕАЛЬНО прошёл через 0
        // (т.е. его позиция обернулась), а не оказался на 0 в результате
        // точного броска — этот случай уже обработан в handleResolvingLanding
        // (клетка GO): 2× goSalary НЕЗАВИСИМО от дубля.
        if (oldPos + steps >= 40) {
          player.money += state.settings.goSalary;
        }
      } else {
        // Назад: (oldPos - steps + 40) % 40.
        // Прохождение GO в обратном направлении НЕ начисляет зарплату
        // (правила Монополии: goSalary начисляется только при движении
        // вперёд через клетку 0, и при приземлении ровно на неё).
        newPos = (oldPos - steps + 40) % 40;
      }

      player.position = newPos;

      // Заполняем moveAnimation — клиент анимирует фишку в указанном
      // направлении.
      state.moveAnimation = {
        playerId: player.id,
        from: oldPos,
        to: newPos,
        steps,
        isDouble: false,
        direction,
      };
      // Правило «discard to bottom» (см. ветку `move`).
      this.cards.returnDrawnCardIfNeeded(state, state.cardContext.deckCardId);
      // Очищаем cardContext (см. комментарий в ветке `move`).
      state.cardContext = undefined;
      state.phase = "MOVE_ANIMATION";
      // lastDice для moveStepMs (используется ботом для таймера
      // CONFIRM_MOVE_ANIMATION). Кладём steps как сумму кубиков —
      // это влияет только на длительность анимации (moveStepMs × N),
      // а реальное направление берётся из moveAnimation.direction.
      state.lastDice = {
        dice: direction === "forward" ? [0, steps] : [steps, 0],
        isDouble: false,
      };
      return { card };
    }

    if (outcome.kind === "goto-jail") {
      // Карточка «Отправляйтесь в тюрьму». Анимация фишки к клетке 10
      // с правилом «не через СТАРТ»:
      //   - from меньше 10 → forward (напр., 7→10);
      //   - from больше 10 → backward (напр., 30→10).
      const from = player.position;
      const to = 10;
      let direction: "forward" | "backward";
      let stepsAbs: number;
      if (from < to) {
        direction = "forward";
        stepsAbs = to - from;
      } else {
        direction = "backward";
        stepsAbs = from - to;
      }
      player.position = to;
      player.mustRollAgain = false;
      player.consecutiveDoubles = 0;
      state.pendingJailFromCard = true;
      state.moveAnimation = {
        playerId: player.id,
        from,
        to,
        steps: stepsAbs,
        isDouble: false,
        direction,
      };
      // Правило «discard to bottom» (см. ветку `move`).
      this.cards.returnDrawnCardIfNeeded(state, state.cardContext.deckCardId);
      state.cardContext = undefined;
      state.phase = "MOVE_ANIMATION";
      state.lastDice = {
        dice: direction === "forward" ? [0, stepsAbs] : [stepsAbs, 0],
        isDouble: false,
      };
      return { card };
    }

    // stay: money / jail-free / luxury-tax-house
    //
    // ВАЖНО: после списания (особенно luxury-tax-house) баланс может
    // уйти в минус. Триггер банкротства должен сработать ДО перехода
    // в BUILDING/ROLLING — иначе игрок просто продолжит ход с
    // отрицательным балансом.
    //
    // Спецслучай: `money` с положительным amount (карточка «получите N₽»)
    // не может привести к минусу, но мы всё равно вызываем проверку —
    // она no-op, если `player.money >= 0`.
    if (card.effect.kind === "luxury-tax-house") {
      // Журнал: Роскошный налог с разбивкой по участкам/домам/отелям.
      // «Игрок заплатил Роскошный налог — сумма (формула
      // сумма=участки+дома+отели)».
      // Пересчитываем properties/houses/hotels для UI-сообщения.
      let houses = 0;
      let hotels = 0;
      let properties = 0;
      for (const cellId of player.properties) {
        const c = state.board[cellId];
        if (!c || c.isMortgaged) continue;
        properties += 1;
        if (c.houses >= 1 && c.houses <= 4) houses += c.houses;
        else if (c.houses === 5) hotels += 1;
      }
      const { perHouse, perHotel, perProperty } = card.effect;
      const total = perHouse * houses + perHotel * hotels + perProperty * properties;
      this.log.logLuxuryTaxPaid(state, player, total, houses, hotels, properties);
    }

    // Правило «discard to bottom»: возвращаем не-holdable карту в
    // НИЗ её колоды. Для holdable (jail-free / ch7) — no-op
    // (карта уже в IN_HAND внутри grantJailFreeCard).
    this.cards.returnDrawnCardIfNeeded(state, state.cardContext.deckCardId);
    if (this.shouldStartBankruptcy(state, player, null, 0)) {
      // shouldStartBankruptcy уже изменил фазу на BANKRUPTCY_LIQUIDATE
      // (или объявил банкрота) — возвращаемся, дальнейшие шаги не нужны.
      return { card };
    }
    this.afterRentOrTax(state, player);
    state.cardContext = undefined;
    return { card };
  }

  /**
   * Продвижение фазы для уже применённой карты.
   * Используется в CARD_EFFECT, если эффект уже применён в CARD_REVEAL,
   * и нужно просто выставить финальную фазу.
   */
  private advanceFromCardEffect(state: GameState, player: Player) {
    // Если это move/move-relative — фаза уже MOVE_ANIMATION.
    if (state.phase === "MOVE_ANIMATION" && state.moveAnimation) {
      return;
    }
    if (state.phase === "JAIL_DECISION") {
      return;
    }
    this.afterRentOrTax(state, player);
    state.cardContext = undefined;
  }

  /**
   * BUILDING — игрок может строить/сносить/закладывать/выкупать/торговать.
   *
   * Допустимые actions:
   *  - BUILD_HOUSE, SELL_HOUSE         — через BuildService
   *                                       (правила лесенки, монополия, лимит).
   *  - MORTGAGE_PROPERTY, UNMORTGAGE_PROPERTY — через MortgageService.
   *  - TRADE_OFFER, TRADE_TOGGLE_BLOCK — торги.
   *  - END_TURN                         — завершить ход.
   *  - OPEN_BUILDING_PHASE              — UX-фаза: открыть модалку строительства
   *                                        (включая залог/выкуп). Сервер переключит
   *                                        фазу на BUILDING_PHASE; модалка появится
   *                                        у клиента автоматически.
   *
   * Все правила строительства/сноса централизованы в `BuildService`,
   * все правила залога — в `MortgageService`. Этот метод — только
   * диспетчер + формирование событий для UI-журнала.
   */
  private async handleBuilding(
    state: GameState,
    player: Player,
    action: GameAction,
  ): Promise<{ card?: unknown; event?: GameEvent }> {
    switch (action.type) {
      case "BUILD_HOUSE": {
        const result = this.buildSvc.build(state, player, action.cellId);
        const cell = state.board[action.cellId];
        // Проверяем триггер банкротства: BuildService мог списать
        // больше, чем у игрока есть (теоретически — если housePrice
        // выставлен криво). В нормальной игре BuildService валидирует
        // наличие денег и кидает ошибку, но для устойчивости —
        // проверяем.
        if (this.shouldStartBankruptcy(state, player, null, result.cost)) {
          // Возвращаем пустой результат — событие постройки НЕ
          // формируем (банкротство перебило событие). Событие
          // банкротства будет сформировано в startBankruptcyProcedure.
          return {};
        }
        const isHotel = result.isHotel;
        const emoji = isHotel ? "🏨" : "🏠";
        const noun = isHotel ? "отель" : "дом";
        return {
          event: this.makeEvent("HOUSE_BUILT", player, {
            message: `${emoji} ${player.displayName} построил(а) ${noun} на «${cell.name}» за $${result.cost}`,
            type: "buy",
            payload: {
              cellId: action.cellId,
              housesAfter: result.newHousesCount,
              buildAmount: result.cost,
              isHotel,
            },
          }),
        };
      }

      case "SELL_HOUSE": {
        const result = this.buildSvc.sell(state, player, action.cellId);
        const cell = state.board[action.cellId];
        const emoji = result.isHotelSale ? "🏨" : "🏠";
        const noun = result.isHotelSale ? "отель" : "дом";
        return {
          event: this.makeEvent("HOUSE_SOLD", player, {
            message: `💸 ${player.displayName} продал(а) ${emoji} ${noun} на «${cell.name}» за $${result.refund}`,
            type: "buy",
            payload: {
              cellId: action.cellId,
              housesAfter: result.newHousesCount,
              buildAmount: result.refund,
              isHotel: result.isHotelSale,
            },
          }),
        };
      }

      case "MORTGAGE_PROPERTY": {
        // Используем MortgageService, который:
        //  - проверяет правило "нет домов в цветовой группе" (canMortgage);
        //  - зачисляет mortgageValue игроку;
        //  - выставляет isMortgaged = true.
        const mortgageAmount = this.mortgageSvc.mortgage(state, player, action.cellId);
        const cellName = state.board[action.cellId]?.name ?? `клетку #${action.cellId}`;
        return {
          event: this.makeEvent("PROPERTY_MORTGAGED", player, {
            message: `🏦 ${player.displayName} заложил «${cellName}» и получил ${mortgageAmount}₽`,
            type: "buy",
            payload: { cellId: action.cellId, mortgageAmount },
          }),
        };
      }

      case "UNMORTGAGE_PROPERTY": {
        // Используем MortgageService, который:
        //  - проверяет, что клетка в залоге и хватает денег;
        //  - списывает mortgageValue * 1.1 (округлено вверх);
        //  - выставляет isMortgaged = false.
        const unmortgageAmount = this.mortgageSvc.unmortgage(state, player, action.cellId);
        const cellName = state.board[action.cellId]?.name ?? `клетку #${action.cellId}`;
        return {
          event: this.makeEvent("PROPERTY_UNMORTGAGED", player, {
            message: `💰 ${player.displayName} выкупил «${cellName}» за ${unmortgageAmount}₽`,
            type: "buy",
            payload: { cellId: action.cellId, mortgageAmount: unmortgageAmount },
          }),
        };
      }

      case "TRADE_OFFER": {
        // Запоминаем фазу, в которой находилась партия ДО начала торговли,
        // чтобы корректно восстановить её после accept/reject/cancel.
        // Если игрок ещё не бросал кубики (фаза ROLLING), он должен
        // вернуться в ROLLING после сделки, чтобы мочь бросить.
        // Если игрок уже в BUILDING (т.е. строится или конец хода) —
        // возвращаемся в BUILDING.
        // Передаём preTradePhase в startTrade — теперь он сохраняется
        // сразу при инициализации state.trade (а не мутацией после), и
        // остаётся устойчивым после counter-offer'ов.
        const preTradePhase = state.phase;
        this.trade.startTrade(state, player, action.recipientId, action.offer, preTradePhase);
        state.phase = "TRADING_NEGOTIATE";
        // Фиксируем попытку инициации за этот ход (чтобы бот не спамил).
        if (!state.tradeInitiationLog) state.tradeInitiationLog = [];
        state.tradeInitiationLog.push({
          initiatorId: player.id,
          recipientId: action.recipientId,
          at: Date.now(),
        });
        const gameId = this.findGameIdByState(state);
        this.scheduleTradeTimer(state, gameId, state.trade!);
        const recipient = state.players.find((p) => p.id === action.recipientId);
        return {
          event: this.makeEvent("TRADE_STARTED", player, {
            message: `🤝 ${player.displayName} предлагает обмен игроку ${recipient?.displayName ?? "?"}`,
            type: "trade",
            payload: { otherPlayerId: action.recipientId },
          }),
        };
      }

      case "TRADE_TOGGLE_BLOCK": {
        if (this.isInterruptPhase(state.phase)) {
          throw new ForbiddenException(`Нельзя менять блокировки в interrupt-фазе ${state.phase}`);
        }
        if (!isCurrentPlayer(state, player)) {
          throw new ForbiddenException("Сейчас не ваш ход");
        }
        this.trade.toggleBlock(state, player, action.targetId);
        return {};
      }

      case "OPEN_BUILDING_PHASE": {
        // UX-фаза: открыть модалку строительства/сноса/залога/выкупа.
        // Допустимо ТОЛЬКО если у игрока есть хоть один объект, к которому
        // применима хотя бы одна из операций. Иначе — кнопка должна быть
        // неактивна, но на сервере всё равно валидируем.
        //
        // В тюрьме строительство/залог/выкуп РАЗРЕШЕНЫ (правила Hasbro):
        // заключённый волен управлять своей недвижимостью.
        if (player.mustRollAgain) {
          throw new ForbiddenException("Сначала бросьте кубики ещё раз");
        }
        // Открытие меню строительства НЕ логируется — это
        // UX-фаза без реального действия. В журнал попадут
        // только конкретные события: постройка/снос дома,
        // залог/выкуп клетки.
        state.phase = "BUILDING_PHASE";
        return {};
      }

      case "END_TURN": {
        // ВАЖНО: по правилам Монополии игрок НЕ может завершить ход с
        // отрицательным балансом — он обязан сначала ликвидировать
        // имущество (продать дома, заложить клетки) и выйти в 0+.
        // Если баланс >= 0 — обычный переход.
        if (player.money < 0) {
          // Запускаем процедуру банкротства: переводим фазу в
          // BANKRUPTCY_LIQUIDATE. Кредитор = null (никто конкретный,
          // это «нечем крыть» в целом).
          this.startBankruptcyProcedure(state, player, null, -player.money);
          return {};
        }
        if (player.mustRollAgain) {
          player.mustRollAgain = false;
          player.consecutiveDoubles = 0;
          state.phase = "ROLLING";
        } else {
          state.phase = "END_TURN";
        }
        return {};
      }

      default:
        throw new ForbiddenException(`Недопустимое действие ${action.type} в фазе BUILDING`);
    }
  }

  /**
   * BUILDING_PHASE — UX-фаза «модалка строительства открыта».
   *
   * Допустимые actions:
   *  - BUILD_HOUSE, SELL_HOUSE                — через BuildService.
   *  - MORTGAGE_PROPERTY, UNMORTGAGE_PROPERTY — через MortgageService.
   *  - CONFIRM_BUILDING_PHASE                 — закрыть модалку и вернуться в BUILDING.
   *
   * ЗАПРЕЩЕНЫ:
   *  - END_TURN              — сначала закрой модалку.
   *  - TRADE_OFFER           — открой обмен отдельной кнопкой (это задел на будущее,
   *                            сейчас через модалку торговли).
   *  - ROLL_DICE             — нельзя бросать, пока открыта модалка строительства.
   *
   * Действия внутри модалки (BUILD_HOUSE и т.д.) валидируются так же,
   * как и в фазе BUILDING. После операции фаза НЕ меняется — игрок
   * остаётся в модалке, чтобы совершить несколько действий подряд.
   */
  private async handleBuildingPhase(
    state: GameState,
    player: Player,
    action: GameAction,
  ): Promise<{ card?: unknown; event?: GameEvent }> {
    if (!isCurrentPlayer(state, player)) {
      throw new ForbiddenException("Сейчас не ваш ход");
    }
    // В тюрьме строительство/залог/выкуп РАЗРЕШЕНЫ (правила Hasbro):
    // заключённый волен управлять своей недвижимостью.
    // `mustRollAgain` НЕ блокирует открытие строительной модалки —
    // это согласовано с `canTrade` («в любой момент хода»).
    // Игрок может открыть модалку, посмотреть варианты и, если ничего
    // не хочет делать, просто закрыть её и бросить кубики.

    switch (action.type) {
      case "BUILD_HOUSE": {
        const result = this.buildSvc.build(state, player, action.cellId);
        const cell = state.board[action.cellId];
        const isHotel = result.isHotel;
        const emoji = isHotel ? "🏨" : "🏠";
        const noun = isHotel ? "отель" : "дом";
        return {
          event: this.makeEvent("HOUSE_BUILT", player, {
            message: `${emoji} ${player.displayName} построил(а) ${noun} на «${cell.name}» за $${result.cost}`,
            type: "buy",
            payload: {
              cellId: action.cellId,
              housesAfter: result.newHousesCount,
              buildAmount: result.cost,
              isHotel,
            },
          }),
        };
      }

      case "SELL_HOUSE": {
        const result = this.buildSvc.sell(state, player, action.cellId);
        const cell = state.board[action.cellId];
        const emoji = result.isHotelSale ? "🏨" : "🏠";
        const noun = result.isHotelSale ? "отель" : "дом";
        return {
          event: this.makeEvent("HOUSE_SOLD", player, {
            message: `💸 ${player.displayName} продал(а) ${emoji} ${noun} на «${cell.name}» за $${result.refund}`,
            type: "buy",
            payload: {
              cellId: action.cellId,
              housesAfter: result.newHousesCount,
              buildAmount: result.refund,
              isHotel: result.isHotelSale,
            },
          }),
        };
      }

      case "MORTGAGE_PROPERTY": {
        const mortgageAmount = this.mortgageSvc.mortgage(state, player, action.cellId);
        const cellName = state.board[action.cellId]?.name ?? `клетку #${action.cellId}`;
        return {
          event: this.makeEvent("PROPERTY_MORTGAGED", player, {
            message: `🏦 ${player.displayName} заложил «${cellName}» и получил ${mortgageAmount}₽`,
            type: "buy",
            payload: { cellId: action.cellId, mortgageAmount },
          }),
        };
      }

      case "UNMORTGAGE_PROPERTY": {
        const unmortgageAmount = this.mortgageSvc.unmortgage(state, player, action.cellId);
        const cellName = state.board[action.cellId]?.name ?? `клетку #${action.cellId}`;
        return {
          event: this.makeEvent("PROPERTY_UNMORTGAGED", player, {
            message: `💰 ${player.displayName} выкупил «${cellName}» за ${unmortgageAmount}₽`,
            type: "buy",
            payload: { cellId: action.cellId, mortgageAmount: unmortgageAmount },
          }),
        };
      }

      case "CONFIRM_BUILDING_PHASE": {
        // Закрыть модалку и вернуться в фазу, из которой открыли.
        // БЕЗ `preBuildingPhase` (старые снапшоты) — fallback в BUILDING.
        // С `preBuildingPhase` — возвращаемся в исходную фазу:
        //  - ROLLING — если игрок открыл меню до броска (например, чтобы
        //    ознакомиться со списком и тут же закрыть). Без этого кнопка
        //    «Бросить кубики» оставалась бы неактивной, т.к. canRoll
        //    требует phase === "ROLLING".
        //  - BUILDING — после покупки/события (классический случай).
        //  - PAY_RENT, TAX_PAYMENT и т.п. — крайне редкий случай
        //    (если игрок нажал «Строить» прямо во время фазы оплаты,
        //    что допустимо «в любой момент хода»).
        const restoreTo = state.preBuildingPhase ?? "BUILDING";
        state.phase = restoreTo;
        // Сбрасываем сохранённую фазу, чтобы случайно не «прилипла»
        // к следующему циклу, если игрок переоткроет модалку.
        state.preBuildingPhase = undefined;
        return {};
      }

      case "OPEN_BUILDING_PHASE": {
        // Игрок нажал «Строить». Маршрутизация в `dispatch` идёт
        // ВСЕГДА в `handleBuildingPhase` (даже если фаза ещё BUILDING),
        // поэтому переключение фазы на BUILDING_PHASE делаем здесь.
        // Если уже в BUILDING_PHASE (повторный клик при открытой модалке)
        // — no-op.
        //
        // Открытие меню НЕ логируется — это UX-фаза без реального
        // действия. В журнал попадают только конкретные события:
        // постройка/снос дома, залог/выкуп клетки.
        if (state.phase !== "BUILDING_PHASE") {
          // Запоминаем фазу, из которой открыли модалку, чтобы
          // CONFIRM_BUILDING_PHASE мог корректно вернуться именно в неё.
          state.preBuildingPhase = state.phase;
          state.phase = "BUILDING_PHASE";
        }
        return {};
      }

      default:
        throw new ForbiddenException(
          `Недопустимое действие ${action.type} в фазе BUILDING_PHASE. Сначала закройте меню строительства.`,
        );
    }
  }

  /**
   * END_TURN — фаза анимации передачи хода.
   * Допустимые actions: CONFIRM_END_TURN.
   * После подтверждения: advanceToNextPlayer + ROLLING (или END при банкротстве).
   */
  private async handleEndTurn(
    state: GameState,
    player: Player,
    action: GameAction,
  ): Promise<{ dice?: [number, number]; card?: unknown; event?: GameEvent }> {
    if (action.type !== "CONFIRM_END_TURN" && action.type !== "END_TURN") {
      throw new ForbiddenException(`Недопустимое действие ${action.type} в фазе END_TURN`);
    }
    // ВАЖНО: финальная защита от «завершения с минусом». Если баланс
    // ушёл в минус по любой причине (не поймали в handleBuilding /
    // handlePayRent / handleTaxPayment) — принудительно запускаем
    // банкротство. Игрок НЕ может закончить ход с минусом.
    if (player.money < 0 && !player.isBankrupt) {
      this.startBankruptcyProcedure(state, player, null, -player.money);
      return {};
    }
    if (player.mustRollAgain) {
      player.mustRollAgain = false;
      player.consecutiveDoubles = 0;
      // После дубля в этом ходу продолжаем тот же ход — START_TURN не нужен.
      state.phase = "ROLLING";
    } else {
      this.advanceToNextPlayer(state);
      // Мгновенная фаза START_TURN: сбрасывает флаги следующего игрока
      // и решает, ROLLING или JAIL_DECISION ему дать. Вызываем сразу
      // здесь, чтобы не зависнуть в фазе, ожидающей клиентского confirm'а.
      const next = state.players[state.currentPlayerIndex];
      if (next) {
        state.phase = "ROLLING"; // сразу, чтобы dispatch не ругался
        // Защита: если у следующего игрока минус (например, остался
        // с прошлого хода) — принудительно запускаем банкротство.
        if (next.money < 0 && !next.isBankrupt) {
          this.startBankruptcyProcedure(state, next, null, -next.money);
        } else {
          await this.handleStartTurn(state, next, action);
        }
      } else {
        state.phase = "ROLLING";
      }
    }
    // Очищаем контекст броска и анимации, чтобы в следующем ходу
    // `handleMoveAnimation` корректно интерпретировал `state.moveAnimation`
    // (если он заполнен с прошлого хода картой — может ошибочно
    // сработать ветка `isCardMove` и не сдвинуть позицию).
    state.lastDice = undefined;
    state.cardContext = undefined;
    state.moveAnimation = undefined;
    // Сбрасываем outcome попытки выхода из тюрьмы — он уже должен
    // быть обработан в `handleDiceAnimation` после CONFIRM_DICE_ANIMATION.
    // На всякий случай (если каким-то образом остался) — чистим здесь,
    // чтобы он не «протёк» в следующий ход.
    state.jailRollOutcome = undefined;
    return {};
  }

  /**
   * JAIL_DECISION — решение в тюрьме. Допустимые: PAY_JAIL_FINE, USE_JAIL_CARD, TRY_DOUBLE.
   * После TRY_DOUBLE — если дубль, фишка сразу движется (MOVE_ANIMATION);
   * если промах — advanceToNextPlayer.
   */
  /**
   * Вспомогательный «pass-the-turn» сценарий для handleJailDecision:
   * игрок УЖЕ не в тюрьме — значит текущий ход больше не JAIL-сценарий,
   * передаём эстафету следующему через мгновенный START_TURN.
   * Используется в обоих нижестоящих ветках (justEnteredJail / !inJail),
   * чтобы не дублировать код (раньше здесь было два одинаковых блока).
   */
  private async advanceToNextFromJailDecision(
    state: GameState,
    trigger: GameAction,
  ): Promise<{ dice?: [number, number]; card?: unknown; event?: GameEvent }> {
    this.advanceToNextPlayer(state);
    const next = state.players[state.currentPlayerIndex];
    if (next) {
      state.phase = "ROLLING";
      return this.handleStartTurn(state, next, trigger);
    }
    state.phase = "ROLLING";
    return {};
  }

  private async handleJailDecision(
    state: GameState,
    player: Player,
    action: GameAction,
  ): Promise<{ dice?: [number, number]; card?: unknown; event?: GameEvent }> {
    if (!player.inJail) {
      // Уже вышли (применили карту / заплатили штраф / вышли по дублю
      // — но в случае дубля `jailRollOutcome` уже задан и обрабатывается
      // в handleDiceAnimation, сюда мы попадём лишь если игрок вышел
      // по другому механизму). Передаём ход дальше.
      // Покрывает прежние ДУБЛИРУЮЩИЕСЯ блоки на !inJail:
      // был один на самом верху и ещё один ниже по коду.
      return this.advanceToNextFromJailDecision(state, action);
    }

    // Только что попал в тюрьму (в ЭТОМ ходу): по правилам Монополии
    // игрок НЕ принимает решение о выходе в том же ходу — только END_TURN.
    // Модальное окно с тремя способами выхода появится в начале
    // СЛЕДУЮЩЕГО хода, когда handleStartTurn сбросит justEnteredJail.
    if (state.justEnteredJail) {
      if (action.type === "END_TURN" || action.type === "CONFIRM_END_TURN") {
        // Следующий ход: мгновенный START_TURN (handleStartTurn сбросит
        // justEnteredJail и переведёт нового игрока в ROLLING/JAIL_DECISION).
        return this.advanceToNextFromJailDecision(state, action);
      }
      throw new ForbiddenException(
        `Только что попал в тюрьму — в этом ходу можно только завершить ход, а не ${action.type}`,
      );
    }

    if (action.type === "PAY_JAIL_FINE") {
      if (player.money < 50) throw new ForbiddenException("Недостаточно денег");
      // Списываем полную сумму. Если у игрока ровно 50₽ — баланс
      // уйдёт в 0, и это НЕ банкротство (долга нет, штраф оплачен).
      // Если по какой-то причине игрок в минусе (например, с
      // прошлого хода) — триггер банкротства сработает.
      player.money -= 50;
      player.inJail = false;
      player.jailTurns = 0;
      // Журнал: «Игрок заплатил 50₽ штрафа и вышел из тюрьмы».
      // «Игрок заплатил 50₽ и вышел из тюрьмы».
      this.log.logJailEscaped(state, player, "pay");
      if (this.shouldStartBankruptcy(state, player, null, 50)) {
        return {};
      }
      state.phase = "ROLLING";
      return {};
    }

    if (action.type === "USE_JAIL_CARD") {
      if (Object.keys(player.holdableCards ?? {}).length === 0)
        throw new ForbiddenException("Нет карточек выхода");
      // Удаляем первую попавшуюся holdable jail-free карту.
      const firstJailFreeId = Object.keys(player.holdableCards ?? {}).find(
        (cid) => player.holdableCards?.[cid]?.templateId === "ch7",
      );
      if (firstJailFreeId) {
        delete player.holdableCards![firstJailFreeId];
      }
      player.inJail = false;
      player.jailTurns = 0;
      // Журнал: «Игрок использует карточку выхода из тюрьмы».
      this.log.logJailEscaped(state, player, "card");
      state.phase = "ROLLING";
      return {};
    }

    if (action.type === "TRY_DOUBLE") {
      const diceResult = this.roll(state);
      const isDouble = diceResult[0] === diceResult[1];
      state.lastDice = { dice: diceResult, isDouble };
      // Журнал: «Игрок пытается бросить дубль для выхода из тюрьмы»
      // — пишется ДО outcome, чтобы читатель видел намерение независимо
      // от результата (попал/не попал).
      this.log.logJailTryDouble(state, player, player.jailTurns + 1, 3);
      // Сохраняем outcome в state.jailRollOutcome — итог (escape / pay / stay)
      // будет обработан в `handleDiceAnimation` после CONFIRM_DICE_ANIMATION.
      // Это позволяет клиенту увидеть анимацию кубиков и в случае «промаха»
      // (stay) — и в случае «выхода» (escape/pay).
      const outcome = this.jail.tryDoubleOrPay(player, diceResult);
      state.jailRollOutcome = outcome;
      state.phase = "DICE_ANIMATION";
      return { dice: diceResult };
    }

    throw new ForbiddenException(`Недопустимое действие ${action.type} в фазе JAIL_DECISION`);
  }

  // Interrupt: Auction

  /**
   * AUCTION_ACTIVE — текущий участник делает ставку или пасует.
   * Допустимые: AUCTION_MAKE_BID, AUCTION_PASS.
   *
   * Логика делегирована `AuctionService.applyCommand`, который
   * использует чистый `AuctionEngine`.
   */
  private async handleAuctionActive(
    state: GameState,
    player: Player,
    action: GameAction,
  ): Promise<{ card?: unknown; event?: GameEvent }> {
    if (!state.auction) {
      state.phase = "BUILDING";
      return {};
    }

    if (action.type === "AUCTION_MAKE_BID") {
      const result = this.auction.applyCommand(this.findGameIdByState(state), state, {
        type: "placeBid",
        playerId: player.id,
        amount: action.amount,
      });
      if (!result.ok) {
        throw new ForbiddenException(this.auctionErrorMessage(result.error));
      }
    } else if (action.type === "AUCTION_PASS") {
      const result = this.auction.applyCommand(this.findGameIdByState(state), state, {
        type: "pass",
        playerId: player.id,
      });
      if (!result.ok) {
        throw new ForbiddenException(this.auctionErrorMessage(result.error));
      }
    } else {
      throw new ForbiddenException(`Недопустимое действие ${action.type} в фазе AUCTION_ACTIVE`);
    }

    return this.afterAuctionTurn(state);
  }

  /**
   * afterAuctionFinished — очистка state.auction и переход к
   * следующей фазе (вызывается из dispatch при AUCTION_FINISHED).
   *
   * Сервер уже сделал передачу клетки/списание денег на этапе `sold`
   * (внутри `applyAuctionCommand → finalizeSold`). Тут мы только
   * очищаем `state.auction` и переключаем фазу.
   *
   * Сохраняем mustRollAgain: если аукцион был начат после дубля
   * (например через карточку move-relative → BUY_DECISION →
   * DECLINE_BUY → AUCTION), игрок должен иметь право на ещё
   * один бросок.
   */
  private afterAuctionFinished(state: GameState): void {
    // Журнал: фиксируем итог аукциона ДО finalize (потому что finalize
    // только логирует в свой logger, а state.auction ещё жив). Берём
    // cellId/winnerId/finalBid/finishReason — всё уже установлено движком
    // при AUCTION_END.
    if (state.auction && state.auction.status === "FINISHED") {
      const { cellId, winnerId, finalBid, finishReason } = state.auction;
      if (finishReason === "SOLD" && winnerId) {
        const winner = state.players.find((p) => p.id === winnerId);
        if (winner) {
          this.log.logAuctionWon(state, winner, cellId, finalBid);
        }
      } else if (finishReason === "UNSOLD") {
        this.log.logAuctionUnsold(state, cellId);
      }
    }
    this.auction.finalize(state);
    // ВАЖНО: тут же очищаем state.auction, иначе клиент продолжает
    // показывать модалку аукциона (auctionStore.status === "FINISHED"
    // → isOpen === true). Клиент уже подтвердил просмотр результата
    // (CONFIRM_AUCTION), дальше state.auction ему не нужен.
    delete state.auction;
    const player = state.players[state.currentPlayerIndex];
    state.phase = player?.mustRollAgain ? "ROLLING" : "BUILDING";
  }

  /**
   * AUCTION_AWAITING_START — мгновенная фаза. AuctionService.startAuction
   * уже сделал init+activate и заэмитил AUCTION_START + AUCTION_TURN_UPDATE
   * в handleBuyDecision. Здесь только переходим в AUCTION_ACTIVE и
   // ставим таймер для "на часах".
   */
  private handleAuctionAwaitingStart(state: GameState): void {
    state.phase = "AUCTION_ACTIVE";
    this.scheduleAuctionTimer(state);
  }

  /**
   * После хода аукциона (ставка/пас):
   *   - если аукцион закрылся (SOLD/UNSOLD) — переходим в AUCTION_FINISHED
   *     и через 2 секунды очищаем state.auction;
   *   - если нет — перепланировать таймер на нового «на часах».
   */
  private afterAuctionTurn(state: GameState): { card?: unknown; event?: GameEvent } {
    if (!state.auction || state.auction.status !== "AUCTION_ACTIVE") {
      // Аукцион закрылся. Переходим в AUCTION_FINISHED и ждём
      // клиентского подтверждения (кнопка «ОК» в AuctionModal).
      // Сервер не очищает state.auction сам — это делает dispatch()
      // по приходу CONFIRM_AUCTION.
      const gameId = this.findGameIdByState(state);
      this.clearAuctionTimer(gameId);
      if (state.phase !== "AUCTION_FINISHED") {
        state.phase = "AUCTION_FINISHED";
      }
      return {};
    }
    // Продолжаем — ставим новый таймер на нового «на часах».
    this.scheduleAuctionTimer(state);
    return {};
  }

  /**
   * Хелпер: синхронно инициализировать ход СЛЕДУЮЩЕГО живого игрока
   * (после `advanceToNextPlayer`). Используется в местах, где
   * `handleStartTurn` нельзя вызвать через `await` (например, из
   * синхронного `shouldStartBankruptcy`, который вызывается из
   * 11 sync-мест) — или там, где `void this.handleStartTurn(...)`
   * ломает тесты из-за fire-and-forget Promise'а (фаза успевает
   * измениться ПОСЛЕ того, как applyAction уже вернул state).
   *
   * Логика — зеркало `handleStartTurn`:
   *   1) сбросить флаги хода (mustRollAgain, consecutiveDoubles,
   *      justEnteredJail, justArrivedAtParking, jailRollOutcome,
   *      preBuildingPhase, tradeInitiationLog, lastDice, cardContext,
   *      moveAnimation);
   *   2) выставить фазу в ROLLING (или JAIL_DECISION, если в тюрьме);
   *   3) записать в журнал «Начало хода N» (через `log.logTurnStart`).
   *
   * Если у нового игрока отрицательный баланс (теоретически) — снова
   * запускаем `startBankruptcyProcedure` (как и в `handleStartTurn`).
   *
   * ВАЖНО: при активной анимации/контексте (например, `state.lastDice`
   * не пустой) их сброс НЕ делаем — `advanceToNextPlayer` уже чистит
   * `lastDice`/`cardContext`/`botThinking` (см. реализацию).
   */
  private beginNextPlayerTurn(state: GameState): void {
    const next = state.players[state.currentPlayerIndex];
    if (!next) {
      state.phase = "BUILDING";
      return;
    }
    // Лог «Начало хода» — как в handleStartTurn.
    this.log.logTurnStart(state, next, state.round);
    // Используем тот же хелпер, что и async-`handleStartTurn`,
    // чтобы обе ветки синхронно сбрасывали ИДЕНТИЧНЫЙ набор полей.
    // Раньше набор полей сброса был продублирован в двух местах, и
    // при добавлении нового поля легко было забыть одну из веток.
    this.resetTurnFlags(state, next);
    // ВАЖНО: полная очистка контекста, оставшегося от ПРЕДЫДУЩЕГО хода.
    // Без этого клиент может видеть «застрявшую» модалку (например,
    // BANKRUPTCY от старого игрока) и блокировать свои кнопки
    // (canRoll=false/canEndTurn=false) из-за остатков phase != ROLLING.
    state.bankruptcy = undefined;
    state.cardContext = undefined;
    state.lastDice = undefined;
    state.moveAnimation = undefined;
    state.rentContext = undefined;
    state.botThinking = undefined;
    // Если у нового игрока остался долг — принудительное банкротство.
    if (next.money < 0 && !next.isBankrupt) {
      this.startBankruptcyProcedure(state, next, null, -next.money);
      return;
    }
    // Обычное начало хода: ROLLING или JAIL_DECISION.
    state.phase = next.inJail ? "JAIL_DECISION" : "ROLLING";
  }

  /**
   * Таймер 2-секундного показа результата аукциона. После этого —
   * очищаем state.auction и переключаем фазу.
   */
  private scheduleAuctionFinishClear(gameId: string): void {
    // Чистим предыдущий (если был).
    const prev = this.auctionTimers.get(gameId);
    if (prev) {
      clearTimeout(prev);
      this.auctionTimers.delete(gameId);
    }
    const timer = setTimeout(() => {
      this.auctionTimers.delete(gameId);
      const s = this.activeGames.get(gameId);
      if (!s) return;
      if (s.phase !== "AUCTION_FINISHED") return;
      this.afterAuctionFinished(s);
    }, 2000);
    this.auctionTimers.set(gameId, timer);
  }

  /** Преобразует код ошибки движка в человеко-читаемое сообщение. */
  private auctionErrorMessage(err: string): string {
    switch (err) {
      case "NOT_ON_CLOCK":
        return "Сейчас не ваша очередь ставить";
      case "BANKRUPT":
        return "Игрок не участвует в аукционе";
      case "BID_TOO_LOW":
        return "Ставка ниже минимальной";
      case "INSUFFICIENT_FUNDS":
        return "Недостаточно денег";
      case "ALREADY_CLOSED":
        return "Аукцион уже завершён";
      case "NOT_ACTIVE":
      default:
        return "Аукцион не активен";
    }
  }

  // Interrupt: Bankruptcy

  /**
   * Единая точка входа в логику банкротства.
   *
   * Правила:
   *  1. Если `player.money >= 0` — банкротства нет, возвращаем `false`.
   *  2. Если `player.money < 0` и при этом игрок способен покрыть долг
   *     (полной ликвидацией — продажа всех домов + залог всех клеток)
   *     → переходим в фазу `BANKRUPTCY_LIQUIDATE` с актуальным долгом
   *     (сколько нужно, чтобы выйти в плюс или хотя бы в ноль).
   *  3. Если покрыть невозможно (или `debt === 0`) — сразу объявляем
   *     банкротство через `bankruptcy.handle(...)` и переключаем фазу.
   *
   * @returns `true` если банкротство сработало (фаза уже изменена, дальше
   *          обрабатывать текущее действие нельзя); `false` если игрок
   *          продолжает обычную игру.
   */
  /**
   * Обёртка над startBankruptcyProcedure, которая дополнительно
   * пишет в журнал «Игрок распродаёт имущество». Все вызовы
   * процедуры банкротства из логики оплаты (рента/налог/постройка)
   * идут ЧЕРЕЗ эту обёртку — благодаря этому в журнале всегда
   * ровно одна запись о начале распродажи.
   *
   * Прямые вызовы `startBankruptcyProcedure` (например, из
   * `handleBuilding` при `END_TURN` с отрицательным балансом)
   * оборачиваются этой же обёрткой с `creditor=null`, чтобы
   * поведение было консистентным.
   */
  private shouldStartBankruptcy(
    state: GameState,
    player: Player,
    creditor: Player | null,
    debt: number,
  ): boolean {
    if (player.money >= 0) {
      return false;
    }

    // debt здесь — это сколько игрок должен был заплатить (например, рента).
    // Актуальный долг для ликвидации: max(0, -player.money). Если creditor-а
    // нет (налог/штраф), долг равен просто -money; если есть — нужно ещё
    // учесть, что рента может уходить частично кредитору, но для ликвидации
    // нас интересует абсолютная сумма, которой игроку не хватает.
    const need = -player.money;

    // Можно ли покрыть? Если да — даём шанс продать/заложить. Иначе —
    // немедленное банкротство.
    if (this.bankruptcy.canCoverDebt(state, player, need)) {
      // Лог «Игрок распродаёт имущество» пишется ИЗНУТРИ
      // `startBankruptcyProcedure` — здесь второй раз не вызываем,
      // иначе в журнале будут дубли при повторных вызовах (боты +
      // фоновые таймеры в `scheduleBotIfNeeded`).
      this.startBankruptcyProcedure(state, player, creditor, need);
      return true;
    }

    // Нет возможности покрыть — сразу банкрот.
    // По правилу: всё имущество → БАНК, кредитор получает
    // компенсацию `debt` от Банка.
    // Журнал: финальное объявление банкротства.
    this.log.logBankruptcyDeclared(state, player, creditor?.displayName ?? "Банк");
    this.bankruptcy.handle(state, player, creditor, need);
    this.checkGameOver(state);
    // ВАЖНО: после банкротства — `advanceToNextPlayer` уже пропустил
    // обанкротившегося игрока (и других банкротов) и подвинул
    // `currentPlayerIndex` на следующего ЖИВОГО. Если игра ещё не
    // завершена — нужно:
    //   1) синхронизировать state.phase с ROLLING, иначе
    //      `canRollDice` на клиенте вернёт `false` (фаза ≠ ROLLING)
    //      → кнопка «Бросить кубики» неактивна, игрок застрял;
    //   2) вызвать `handleStartTurn` для нового игрока — он сбросит
    //      флаги (mustRollAgain/consecutiveDoubles/justEnteredJail) и
    //      решит, переводить ли в ROLLING или JAIL_DECISION.
    // Без этого фикс цикла «банкрот → ход следующему» сломан, и
    // следующий игрок не может бросить кубики (см. canRollDice в
    // turn-permissions.ts).
    this.advanceToNextPlayer(state);
    // ВАЖНО: после банкротства нужно СРАЗУ инициализировать ход
    // следующего живого игрока (а не оставлять фазу `BUILDING`, как
    // раньше). Иначе:
    //   - `canRollDice` на клиенте возвращает `false` (фаза ≠ ROLLING);
    //   - кнопка «Бросить кубики» неактивна, игрок застрял;
    //   - бот не делает ROLL_DICE по таймеру.
    // Используем СИНХРОННЫЙ хелпер `beginNextPlayerTurn` —
    // `handleStartTurn` (async) тут не подходит: fire-and-forget
    // Promise оставляет фазу `BUILDING` в моменте, когда
    // applyAction уже вернул state, и тесты/UI видят «застрявшую»
    // фазу до разрешения микротасок.
    const next = state.players[state.currentPlayerIndex];
    if (state.status === "active" && next && !next.isBankrupt) {
      this.beginNextPlayerTurn(state);
    } else {
      state.phase = "BUILDING";
    }
    return true;
  }

  private startBankruptcyProcedure(
    state: GameState,
    player: Player,
    creditor: Player | null,
    debt: number,
  ) {
    // Защита от повторного лога: если для ЭТОГО игрока в `state.events`
    // уже есть событие BANKRUPTCY_LIQUIDATION за последние ~30 секунд,
    // не пишем второе. Это спасает от дублей при бот-цикле, когда
    // `applyAction` вызывается несколько раз подряд (например,
    // shouldStartBankruptcy → scheduleBotIfNeeded повторно проверяет
    // баланс — для одного банкротства образуется две записи).
    const recentlyLogged = (state.events ?? []).some((ev) => {
      if (ev.kind !== "BANKRUPTCY_LIQUIDATION") return false;
      if (ev.playerId !== player.id) return false;
      const ageMs = Date.now() - new Date(ev.at).getTime();
      return ageMs < 30_000;
    });
    state.bankruptcy = {
      playerId: player.id,
      creditorId: creditor?.id ?? null,
      debt,
      stage: 1,
    };
    state.phase = "BANKRUPTCY_LIQUIDATE";
    // Журнал: одно сообщение о начале распродажи. Эта функция —
    // ЕДИНСТВЕННОЕ место, откуда пишется «Игрок распродаёт
    // имущество». Любые внешние вызовы (handleStartTurn, handleBuilding,
    // handleEndTurn, advanceToNextPlayer и shouldStartBankruptcy)
    // делегируют сюда.
    if (!recentlyLogged) {
      const creditorName = creditor?.displayName ?? "Банк";
      this.log.logBankruptcyLiquidationStarted(state, player, creditorName, debt);
    }
  }

  private async handleBankruptcyLiquidate(
    state: GameState,
    player: Player,
    action: GameAction,
  ): Promise<{ card?: unknown; event?: GameEvent }> {
    if (!state.bankruptcy) {
      state.phase = "BUILDING";
      return {};
    }

    if (player.id !== state.bankruptcy.playerId) {
      throw new ForbiddenException("Эта фаза не для вас");
    }

    if (action.type === "BANKRUPTCY_LIQUIDATE_HOUSES") {
      // Правило «лесенки» при ликвидации: нельзя асимметрично продавать дома
      // внутри одной цветовой группы. Сначала продаём по 1 дому на каждом
      // участке группы, затем ещё по одному, и т.д.
      if (!this.bankruptcy.canSellHouseForLiquidation(state, player, action.cellId)) {
        throw new ForbiddenException(
          "Сначала продайте дома на других участках группы (правило лесенки)",
        );
      }
      const cell = state.board[action.cellId];
      if (!cell) throw new NotFoundException("Клетка не найдена");
      if (cell.ownerId !== player.id) throw new ForbiddenException("Это не ваша клетка");
      if ((cell.houses ?? 0) === 0) throw new ForbiddenException("Нет домов");
      if (cell.housePrice === undefined) throw new BadRequestException("Нет цены дома");
      // Отель (houses === 5) продаётся за 5 housePrice, но превращается в 4 дома.
      // Списываем 1 юнит (дом) с клетки; для отеля это даёт 4 дома.
      const newHouses = cell.houses === 5 ? 4 : cell.houses - 1;
      const refundLiquidation = cell.housePrice / 2;
      const wasHotelLiquidation = cell.houses === 5;
      player.money += refundLiquidation;
      cell.houses = newHouses as 0 | 1 | 2 | 3 | 4 | 5;
      const nounLiquidation = wasHotelLiquidation ? "отель" : "дом";
      this.log.logBankruptcyHouseSold(
        state,
        player,
        cell.name,
        nounLiquidation,
        refundLiquidation,
        newHouses,
        wasHotelLiquidation,
      );
      return {};
    }

    if (action.type === "BANKRUPTCY_MORTGAGE") {
      const cell = state.board[action.cellId];
      if (!cell) throw new NotFoundException("Клетка не найдена");
      if (cell.ownerId !== player.id) throw new ForbiddenException("Это не ваша клетка");
      if (cell.houses > 0) throw new ForbiddenException("Сначала продайте дома");
      if (cell.mortgageValue === undefined) throw new BadRequestException("Нельзя заложить");
      player.money += cell.mortgageValue;
      cell.isMortgaged = true;
      this.log.logBankruptcyMortgage(state, player, cell.name, cell.mortgageValue);
      return {};
    }

    if (action.type === "BANKRUPTCY_SELL_PROPERTY") {
      // Продажа клетки Банку за 100% номинала.
      // Делегируем в BankruptcyService.sellPropertyToBank — там вся
      // валидация (нет домов, не заложена, в группе нет домов) и
      // сброс состояния клетки (ownerId = undefined, isMortgaged = false,
      // houses = 0).
      const soldCellName = state.board[action.cellId]?.name ?? `#${action.cellId}`;
      const soldCellPrice = state.board[action.cellId]?.price ?? 0;
      this.bankruptcy.sellPropertyToBank(state, player, action.cellId);
      this.log.logPropertySoldToBank(state, player, soldCellName, soldCellPrice);
      return {};
    }

    if (action.type === "BANKRUPTCY_SELL_MORTGAGED_PROPERTY") {
      // Продажа уже заложенной клетки Банку за дополнительные 50% (mortgageValue).
      // В сумме с предыдущим залогом игрок получает 100% номинала. Клетка уходит
      // в банк (UNOWNED, isMortgaged=false, houses=0). Делегируем в
      // BankruptcyService.sellMortgagedPropertyToBank.
      this.bankruptcy.sellMortgagedPropertyToBank(state, player, action.cellId);
      return {};
    }
    if (action.type === "BANKRUPTCY_CONFIRM" || action.type === "BANKRUPTCY_DECLARE") {
      // Перед подтверждением/объявлением пересчитываем долг исходя из
      // ТЕКУЩЕГО баланса. После ликвидации игрок мог выйти в плюс — тогда
      // долг становится 0, и мы просто закрываем процедуру.
      const remainingDebt = Math.max(0, -player.money);
      state.bankruptcy.debt = remainingDebt;

      if (player.money >= 0 && remainingDebt === 0) {
        // Игрок успешно восстановил ликвидность через распродажу и НЕ
        // объявлял банкротство: остаток денег у него сохраняется,
        // партия возвращается к штатному ходу через afterRentOrTax.
        // Кредитор ничего не получает — долг-то погашен.
        //
        // Деньги уходят кредитору ТОЛЬКО в объявленном банкротстве —
        // см. ниже bankruptcy.handle() (state.phase = BUILDING,
        // player.isBankrupt = true). Здесь же игрок остаётся в игре.
        //
        // В журнал НЕ пишем отдельное «Игрок покрыл долг» — по правилу
        // журнал фиксирует только конкретные ФАКТЫ (заложил, продал),
        // а промежуточный итог ликвидации (баланс снова ≥ 0) читается
        // из хода событий и текущего состояния.
        state.bankruptcy = undefined;
        this.afterRentOrTax(state, player);
        return {};
      }

      // Денег всё ещё не хватает — банкрот.
      // По правилу: всё имущество → БАНК, кредитор получает
      // компенсацию `(debt)` от Банка.
      const creditor = state.bankruptcy.creditorId
        ? (state.players.find((p) => p.id === state.bankruptcy!.creditorId) ?? null)
        : null;
      this.log.logBankruptcyDeclared(state, player, creditor?.displayName ?? "Банк");
      // `debt` — это ИСХОДНЫЙ долг (state.bankruptcy.debt до пересчёта
      // в remainingDebt) или используем remainingDebt, что то же самое.
      this.bankruptcy.handle(state, player, creditor, remainingDebt);
      state.bankruptcy = undefined;
      this.checkGameOver(state);
      this.advanceToNextPlayer(state);
      // ВАЖНО: после `advanceToNextPlayer` нужно СРАЗУ инициализировать
      // ход следующего живого игрока (а не оставлять фазу `BUILDING`,
      // как раньше). Без этого:
      //   - `canRollDice` на клиенте возвращает `false` (фаза ≠ ROLLING);
      //   - кнопка «Бросить кубики» неактивна, игрок застрял;
      //   - бот не делает ROLL_DICE по таймеру.
      // Используем СИНХРОННЫЙ хелпер `beginNextPlayerTurn` — он
      // идемпотентен, обнуляет флаги хода и сразу ставит фазу ROLLING
      // (или JAIL_DECISION), пишет «Начало хода» в журнал.
      const next = state.players[state.currentPlayerIndex];
      if (state.status === "active" && next && !next.isBankrupt) {
        this.beginNextPlayerTurn(state);
      } else {
        state.phase = "BUILDING";
      }
      return {};
    }

    throw new ForbiddenException(
      `Недопустимое действие ${action.type} в фазе BANKRUPTCY_LIQUIDATE`,
    );
  }

  private async handleBankruptcyTransfer(
    state: GameState,
    _player: Player,
    action: GameAction,
  ): Promise<{ card?: unknown; event?: GameEvent }> {
    if (action.type !== "END_TURN") {
      throw new ForbiddenException(
        `Недопустимое действие ${action.type} в фазе BANKRUPTCY_TRANSFER`,
      );
    }
    state.phase = "BUILDING";
    return {};
  }

  // Interrupt: Trading

  private async handleTradingNegotiate(
    state: GameState,
    player: Player,
    action: GameAction,
  ): Promise<{ card?: unknown; event?: GameEvent }> {
    if (!state.trade) {
      // Аварийный путь: state.trade уже сброшен (например, таймаут).
      // preTradePhase уже утерян (state.trade = undefined) — fallback в BUILDING.
      state.phase = this.resolvePhaseAfterTrade(state, player, undefined);
      return {};
    }

    if (player.id !== state.trade.currentPartyId) {
      throw new ForbiddenException("Сейчас не ваша очередь в торговле");
    }

    // ВАЖНО: захватываем preTradePhase В ЛОКАЛЬНУЮ ПЕРЕМЕННУЮ до сброса
    // state.trade, иначе resolvePhaseAfterTrade прочитает undefined.
    const preTradePhase = state.trade.preTradePhase;

    if (action.type === "TRADE_ACCEPT") {
      const initiator = state.players.find((p) => p.id === state.trade!.initiatorId);
      this.trade.executeTrade(state);
      state.trade = undefined;
      state.phase = this.resolvePhaseAfterTrade(state, player, preTradePhase);
      return {
        event: this.makeEvent("TRADE_COMPLETED", player, {
          message: `✅ ${player.displayName} и ${initiator?.displayName ?? "?"} завершили обмен`,
          type: "trade",
          payload: { otherPlayerId: initiator?.id },
        }),
      };
    }

    if (action.type === "TRADE_REJECT") {
      const initiator = state.players.find((p) => p.id === state.trade!.initiatorId);
      state.trade = undefined;
      // Сохраняем mustRollAgain, чтобы не терять право на ещё один бросок
      // после дубля, и возвращаемся в фазу, в которой были ДО сделки
      // (если торги начались в ROLLING — туда и возвращаемся).
      state.phase = this.resolvePhaseAfterTrade(state, player, preTradePhase);
      return {
        event: this.makeEvent("TRADE_REJECTED", player, {
          message: `❌ ${player.displayName} отклонил(а) обмен от ${initiator?.displayName ?? "?"}`,
          type: "trade",
          payload: { otherPlayerId: initiator?.id },
        }),
      };
    }

    if (action.type === "TRADE_COUNTER") {
      const max = state.settings.tradingMaxCounterOffers ?? 3;
      if (state.trade.counterCount >= max) {
        throw new ForbiddenException(`Достигнут лимит counter-offer'ов (${max})`);
      }
      this.trade.makeCounterOffer(state, action.offer);
      this.scheduleTradeTimer(state, this.findGameIdByState(state), state.trade!);
      const newCounterparty = state.players.find((p) => p.id === state.trade!.currentPartyId);
      return {
        event: this.makeEvent("TRADE_COUNTER", player, {
          message: `↩️ ${player.displayName} сделал(а) встречное предложение игроку ${newCounterparty?.displayName ?? "?"}`,
          type: "trade",
          payload: { otherPlayerId: newCounterparty?.id },
        }),
      };
    }

    if (action.type === "TRADE_CANCEL") {
      if (player.id !== state.trade.initiatorId) {
        throw new ForbiddenException("Отменить может только инициатор");
      }
      const recipient = state.players.find((p) => p.id === state.trade!.recipientId);
      state.trade = undefined;
      state.phase = this.resolvePhaseAfterTrade(state, player, preTradePhase);
      return {
        event: this.makeEvent("TRADE_CANCELLED", player, {
          message: `🚫 ${player.displayName} отменил(а) обмен с ${recipient?.displayName ?? "?"}`,
          type: "trade",
          payload: { otherPlayerId: recipient?.id },
        }),
      };
    }

    throw new ForbiddenException(`Недопустимое действие ${action.type} в фазе TRADING_NEGOTIATE`);
  }

  private async handleTradingConfirm(
    state: GameState,
    player: Player,
    action: GameAction,
  ): Promise<{ card?: unknown; event?: GameEvent }> {
    return this.handleTradingNegotiate(state, player, action);
  }

  /**
   * Множество фаз Turn FSM, в которых игрок имеет право торговать
   * (`canTrade === true`) и в которые мы можем вернуться после сделки.
   * Эти же фазы сервер устанавливает как `preTradePhase` при TRADE_OFFER.
   *
   * Если торги начались в одной из этих фаз, после accept/reject/cancel
   * партия должна вернуться ровно в неё (например, ROLLING → ROLLING,
   * чтобы игрок мог бросить кубики; BUY_DECISION → BUY_DECISION).
   */
  private static readonly RESTORABLE_PHASES_AFTER_TRADE: ReadonlySet<Phase> = new Set<Phase>([
    "START_TURN",
    "ROLLING",
    "DICE_ANIMATION",
    "RESOLVING_LANDING",
    "BUY_DECISION",
    "CARD_REVEAL",
    "CARD_EFFECT",
    "JAIL_DECISION",
    "PAY_RENT",
    "TAX_PAYMENT",
    "BUILDING",
    "END_TURN",
  ]);

  /**
   * Возвращает фазу, в которую партия должна вернуться после завершения торговли
   * (accept / reject / cancel / confirm).
   *
   * Логика:
   *  1. Если у игрока есть право на ещё один бросок (`mustRollAgain === true`) —
   *     всегда возвращаемся в ROLLING (право на бросок не должно сгорать из-за сделки).
   *  2. Иначе — если `preTradePhase` сохранён и это «своя» Turn-фаза (из
   *     RESTORABLE_PHASES_AFTER_TRADE), возвращаем её. Это покрывает кейс
   *     «игрок инициировал сделку в фазе ROLLING (ещё не ходил)» — после
   *     reject/cancel он снова окажется в ROLLING и сможет бросить кубики.
   *  3. Если `preTradePhase` не сохранён (старые снапшоты, аварийный путь,
   *     counter-offer без пробрасывания) — fallback в BUILDING.
   *
   * `preTradePhase` передаётся параметром (а не читается из `state.trade`),
   * потому что к моменту вызова `state.trade` уже сброшен в `undefined`.
   */
  private resolvePhaseAfterTrade(
    _state: GameState,
    player: Player,
    preTradePhase: Phase | undefined,
  ): Phase {
    if (player.mustRollAgain) {
      return "ROLLING";
    }
    if (preTradePhase && GamesService.RESTORABLE_PHASES_AFTER_TRADE.has(preTradePhase)) {
      return preTradePhase;
    }
    return "BUILDING";
  }

  // Вспомогательные методы

  private isInterruptPhase(phase: Phase): boolean {
    return (
      phase === "AUCTION_AWAITING_START" ||
      phase === "AUCTION_ACTIVE" ||
      phase === "AUCTION_FINISHED" ||
      phase === "BANKRUPTCY_LIQUIDATE" ||
      phase === "BANKRUPTCY_TRANSFER" ||
      phase === "TRADING_NEGOTIATE" ||
      phase === "TRADING_CONFIRM"
    );
  }

  private findGameIdByState(state: GameState): string {
    for (const [gameId, s] of this.activeGames.entries()) {
      if (s === state) return gameId;
    }
    return state.id;
  }

  private checkGameOver(state: GameState) {
    const alive = state.players.filter((p) => !p.isBankrupt);
    if (alive.length === 1 && state.status === "active") {
      state.status = "finished";
      state.phase = "FINISHED";
      state.winnerId = alive[0]!.id;
    } else if (alive.length === 0) {
      state.status = "finished";
      state.phase = "FINISHED";
    }
  }

  private assertCanAct(state: GameState, player: Player) {
    if (state.status !== "active" && state.phase !== "FINISHED") {
      throw new ForbiddenException("Партия не активна");
    }
    if (player.isBankrupt) {
      throw new ForbiddenException("Игрок обанкротился");
    }
  }

  /**
   * Хелпер: сконструировать GameEvent с дефолтными полями.
   * Делегирует работу в `LogService` (централизованный сервис журнала),
   * чтобы не дублировать генерацию uuid/at/playerId.
   *
   * Принимает `state` (опционально) — если передан, событие будет
   * добавлено в `state.events` (кольцевой буфер до MAX_EVENTS_IN_STATE).
   */
  private makeEvent(
    kind: GameEventKind,
    player: Player,
    fields: Pick<GameEvent, "message" | "type"> & { payload?: GameEvent["payload"] },
  ): GameEvent {
    return this.log.createWithoutState({
      kind,
      player,
      message: fields.message,
      type: fields.type,
      ...(fields.payload ? { payload: fields.payload } : {}),
    });
  }

  /**
   * Хелпер: создать GameEvent и положить его в `state.events`
   * (для восстановления истории при reconnect) + вернуть объект.
   * Удобен для обработчиков, которые хотят сразу записать событие
   * в журнал.
   */
  private logEvent(
    state: GameState,
    kind: GameEventKind,
    player: Player | null,
    fields: { message: string; type?: string; payload?: GameEvent["payload"] },
  ): GameEvent {
    return this.log.create(state, {
      kind,
      player,
      message: fields.message,
      ...(fields.type ? { type: fields.type } : {}),
      ...(fields.payload ? { payload: fields.payload } : {}),
    });
  }

  private advanceToNextPlayer(state: GameState) {
    const startIndex = state.currentPlayerIndex;
    let safety = state.players.length;
    do {
      state.currentPlayerIndex = (state.currentPlayerIndex + 1) % state.players.length;
      safety--;
      if (safety < 0) break;
    } while (
      state.players[state.currentPlayerIndex]?.isBankrupt &&
      state.currentPlayerIndex !== startIndex
    );

    const next = state.players[state.currentPlayerIndex];
    if (next) next.mustRollAgain = false;
    if (state.currentPlayerIndex === 0) state.round++;
    state.botThinking = undefined;
    state.lastDice = undefined;
    state.cardContext = undefined;
  }

  private rng(state: GameState & { rngCounter?: number }) {
    const counter = (state.rngCounter ?? 0) + 1;
    state.rngCounter = counter;
    return seedrandom(`${state.seed}:${counter}`);
  }

  private roll(state: GameState): [number, number] {
    const r = this.rng(state);
    const d1 = Math.floor(r() * 6) + 1;
    const d2 = Math.floor(r() * 6) + 1;
    return [d1, d2];
  }

  // Cleanup

  removeFromCache(gameId: string) {
    this.activeGames.delete(gameId);
    this.userToPlayer.delete(gameId);
    this.snapshotQueues.delete(gameId);
    for (const map of [
      this.botTimers,
      this.botThinkingTimers,
      this.botConfirmFallbackTimers,
      this.auctionTimers,
      this.tradeTimers,
      this.turnTimers,
    ]) {
      const t = map.get(gameId);
      if (t) clearTimeout(t);
      map.delete(gameId);
    }
    this.botConfirmFallbackContexts.delete(gameId);
  }

  /**
   * Поставить запись snapshot в очередь для данной игры. Все записи
   * для одного gameId идут строго последовательно — после завершения
   * предыдущей. Использует `tryUpdateSnapshot` (без throw'ов): если
   * по какой-то причине версия не совпала (например, между запросами
   * кто-то поменял state напрямую) — просто логируем warning.
   */
  private enqueueSnapshot(gameId: string, state: GameState): void {
    const previous = this.snapshotQueues.get(gameId) ?? Promise.resolve();
    const next = previous
      .then(async () => {
        try {
          // expectedVersion = state.version - 1: см. applyAction
          // (state.version++ уже инкрементнут на этом шаге).
          // Используем replaceSnapshot вместо updateSnapshot: он не
          // бросает исключение при конфликте версий, а просто возвращает
          // false. Это безопасно для фоновой записи: мы только логируем
          // расхождение, а игровой процесс в RAM продолжает работать.
          const ok = await this.repo.replaceSnapshot(gameId, state, state.version - 1);
          if (!ok) {
            this.logger.warn(
              `[snapshot] replaceSnapshot не применил version=${state.version} для game=${gameId}`,
            );
          }
        } catch (err) {
          this.logger.error(
            `updateSnapshot failed for game ${gameId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      })
      .catch(() => {
        // Ошибки обработаны выше, не даём цепочке «упасть» —
        // иначе последующие записи встанут навсегда.
      });
    this.snapshotQueues.set(gameId, next);
  }

  // Боты

  private scheduleBotIfNeeded(state: GameState, gameId: string) {
    const prev = this.botTimers.get(gameId);
    if (prev) {
      clearTimeout(prev);
      this.botTimers.delete(gameId);
    }
    if (state.status !== "active") return;

    // BANKRUPTCY_LIQUIDATE — это interrupt-фаза для торговли/аукциона
    // (там ждут решения живых людей), но ДЛЯ БОТА она не interrupt:
    // серверный обработчик (`handleBankruptcyLiquidate`) применяет
    // BANKRUPTCY_LIQUIDATE_HOUSES / BANKRUPTCY_MORTGAGE, и после
    // каждого такого действия мы должны вызвать бота снова, чтобы он
    // продолжил ликвидацию (продать ещё дома, заложить ещё клетки) или
    // подтвердил оплату. Без этого бот зависает после первого же шага
    // и партия «замерзает» в фазе BANKRUPTCY_LIQUIDATE.
    if (state.phase === "BANKRUPTCY_LIQUIDATE") {
      // См. ниже — бот-ликвидатор вызывается отдельной веткой.
    } else if (this.isInterruptPhase(state.phase)) {
      return;
    }

    const current = state.players[state.currentPlayerIndex];
    if (!current || current.kind !== "bot" || current.isBankrupt) return;
    if (state.botThinking && state.botThinking.playerId === current.id) return;

    // Не планируем, если фаза «ждущая» (визуальная анимация).
    const waitingPhases: ReadonlySet<Phase> = new Set([
      "DICE_ANIMATION",
      "MOVE_ANIMATION",
      "CARD_REVEAL",
      "CARD_EFFECT",
      "TAX_PAYMENT",
      "RESOLVING_LANDING",
      "END_TURN",
      "BOT_THINKING",
    ]);
    if (waitingPhases.has(state.phase)) return;

    // Специальная ветка: бот в фазе BANKRUPTCY_LIQUIDATE. Поскольку
    // `isInterruptPhase` включает эту фазу (и не даёт пройти дальше
    // через основную логику scheduler'а), мы обрабатываем её явно
    // здесь — вызываем `decide` (он вернёт `decideBankruptcy`) и
    // планируем бот-тик с задержкой.
    if (state.phase === "BANKRUPTCY_LIQUIDATE") {
      const proc = state.bankruptcy;
      if (proc && proc.playerId === current.id) {
        const decision = this.bot.decide(current, state);
        if (!decision) return;
        const delay = 600 + Math.random() * 400;
        const timer = setTimeout(() => {
          this.botTimers.delete(gameId);
          void this.runBotTurn(gameId, decision);
        }, delay);
        this.botTimers.set(gameId, timer);
        return;
      }
      // BANKRUPTCY_LIQUIDATE, но это не наш бот — не вмешиваемся.
      return;
    }

    const decision = this.bot.decide(current, state);

    // Защита от зависания: если бот в фазе BUILDING (или BUILDING_PHASE)
    // оказался с отрицательным балансом, `decide()` вернёт `null`. Не
    // ждём «END_TURN» и не открываем стройку — это только усугубит
    // ситуацию. Принудительно запускаем процедуру банкротства.
    if (!decision) {
      if (current.money < 0 && (state.phase === "BUILDING" || state.phase === "BUILDING_PHASE")) {
        const triggerTimer = setTimeout(
          () => {
            this.botTimers.delete(gameId);
            const live = this.activeGames.get(gameId);
            if (!live) return;
            if (live.status !== "active") return;
            const cur = live.players[live.currentPlayerIndex];
            if (!cur || cur.isBankrupt || cur.money >= 0) return;
            this.shouldStartBankruptcy(live, cur, null, -cur.money);
            this.enqueueSnapshot(gameId, live);
          },
          400 + Math.random() * 400,
        );
        this.botTimers.set(gameId, triggerTimer);
      }
      return;
    }

    const delay = 800 + Math.random() * 700;
    const timer = setTimeout(() => {
      this.botTimers.delete(gameId);
      void this.runBotTurn(gameId, decision);
    }, delay);
    this.botTimers.set(gameId, timer);
  }

  private async runBotTurn(gameId: string, decision: BotDecision) {
    try {
      const state = this.activeGames.get(gameId);
      if (!state) return;
      if (state.status !== "active") return;
      const current = state.players[state.currentPlayerIndex];
      if (!current || current.kind !== "bot" || current.isBankrupt) return;
      const action = this.botDecisionToAction(decision, state);
      if (!action) return;
      await this.applyAction(gameId, current.id, action);
    } catch (err) {
      this.logger.error(`Bot turn failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Ботские таймеры для визуальных фаз

  /**
   * Возвращает true, если фаза требует клиентского `CONFIRM_*` (или
   * авто-confirm по таймеру как fallback).
   *
   * Источник истины для понятия «визуальная фаза, ждущая подтверждения».
   * Используется в `applyAction` для принятия решения о планировании
   * fallback-таймера.
   */
  private isWaitingForClientConfirm(phase: Phase): boolean {
    return (
      phase === "DICE_ANIMATION" ||
      phase === "MOVE_ANIMATION" ||
      phase === "CARD_REVEAL" ||
      phase === "CARD_EFFECT" ||
      phase === "TAX_PAYMENT" ||
      phase === "PAY_RENT" ||
      phase === "RESOLVING_LANDING" ||
      phase === "END_TURN" ||
      phase === "AUCTION_FINISHED" ||
      phase === "BOT_THINKING"
    );
  }

  /**
   * Маппинг «фаза → ожидаемое CONFIRM_* действие» для fallback-таймера.
   * Если клиент не прислал нужный confirm, сервер через большой таймаут
   * (60с) сам отправит этот action от имени бота, чтобы партия не
   * «зависла» в визуальной фазе.
   */
  private confirmActionForPhase(phase: Phase): GameAction | null {
    switch (phase) {
      case "DICE_ANIMATION":
        return { type: "CONFIRM_DICE_ANIMATION" };
      case "MOVE_ANIMATION":
        return { type: "CONFIRM_MOVE_ANIMATION" };
      case "CARD_REVEAL":
      case "CARD_EFFECT":
        return { type: "CONFIRM_CARD" };
      case "TAX_PAYMENT":
        return { type: "CONFIRM_TAX" };
      case "PAY_RENT":
        return { type: "CONFIRM_RENT_PAYMENT" };
      case "RESOLVING_LANDING":
        return { type: "CONFIRM_LANDING" };
      case "END_TURN":
        return { type: "CONFIRM_END_TURN" };
      case "AUCTION_FINISHED":
        return { type: "CONFIRM_AUCTION" };
      default:
        return null;
    }
  }

  /**
   * Единый fallback-таймер подтверждения визуальной фазы для бота.
   *
   * Раньше здесь стояли 7 разных таймеров (`scheduleBotDiceAnimDone`,
   * `scheduleBotMoveAnimDone` и т.д.) на фиксированные интервалы
   * (2000мс, N×450+200мс, 2500мс, 400мс, 2000мс, 500мс). Эти таймеры
   * НЕ были синхронизированы с реальной скоростью анимации на клиенте
   * (которая зависит от `settings.animationSpeed`), и клиент НЕ слал
   * `CONFIRM_*` для бота (`isMyTurn === false`). В итоге:
   *   - на клиенте анимация «догоняла» уже идущую следующую фазу
   *     на сервере;
   *   - бот начинал ход, не дождавшись завершения предыдущего;
   *   - визуально несколько ботов двигались одновременно → рассинхрон.
   *
   * Теперь сервер НЕ шлёт `CONFIRM_*` автоматически — он ЖДЁТ клиентского
   * подтверждения. Клиент (даже если ходит бот) при завершении анимации
   * шлёт нужный confirm от любого подключённого игрока.
   *
   * Этот метод ставит ОДИН fallback-таймер на 60 секунд, который
   * сработает ТОЛЬКО в аварийной ситуации:
   *   - в комнате нет ни одного активного клиента (например, партия
   *     ботов без людей, или все клиенты отключились);
   *   - клиентский confirm потерялся.
   *
   * При нормальной игре таймер сбрасывается сразу после получения
   * `CONFIRM_*` в `applyAction` и никогда не срабатывает.
   */
  private scheduleBotConfirmFallback(state: GameState, gameId: string, current: Player) {
    const prevTimer = this.botConfirmFallbackTimers.get(gameId);
    if (prevTimer) {
      clearTimeout(prevTimer);
      this.botConfirmFallbackTimers.delete(gameId);
    }
    const action = this.confirmActionForPhase(state.phase);
    if (!action) {
      // Не визуальная фаза — никакого fallback не нужно.
      this.botConfirmFallbackContexts.delete(gameId);
      return;
    }
    this.botConfirmFallbackContexts.set(gameId, {
      phase: state.phase,
      playerId: current.id,
      setAt: Date.now(),
    });
    const FALLBACK_MS = 60_000; // 60с — щедро, чтобы не сработать при нормальной игре
    const timer = setTimeout(async () => {
      this.botConfirmFallbackTimers.delete(gameId);
      try {
        const s = this.activeGames.get(gameId);
        if (!s) return;
        // Проверяем: всё ещё та же фаза и тот же игрок?
        if (s.phase !== state.phase) return;
        if (s.players[s.currentPlayerIndex]?.id !== current.id) return;
        if (s.status !== "active") return;
        this.logger.warn(
          `[GamesService] Bot confirm FALLBACK fired for phase=${state.phase} game=${gameId} player=${current.id} (no client responded in ${FALLBACK_MS}ms)`,
        );
        await this.applyAction(gameId, current.id, action);
      } catch (err) {
        this.logger.error(
          `Bot confirm fallback failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }, FALLBACK_MS);
    this.botConfirmFallbackTimers.set(gameId, timer);
  }

  /**
   * Сбрасывает fallback-таймер подтверждения.
   * Вызывается из `applyAction` сразу после успешного dispatch'а
   * (когда клиент прислал нужный `CONFIRM_*` и фаза сменилась) — при
   * нормальной игре таймер снимается ДО срабатывания.
   */
  private clearBotConfirmFallback(gameId: string) {
    const t = this.botConfirmFallbackTimers.get(gameId);
    if (t) {
      clearTimeout(t);
      this.botConfirmFallbackTimers.delete(gameId);
    }
    this.botConfirmFallbackContexts.delete(gameId);
  }

  private botDecisionToAction(d: BotDecision, state: GameState): GameAction | null {
    if (typeof d === "string") {
      switch (d) {
        case "ROLL":
        case "TRY_DOUBLE":
          return { type: "ROLL_DICE" };
        case "BUY":
          return { type: "BUY_PROPERTY" };
        case "DECLINE_BUY":
          return { type: "DECLINE_BUY" };
        case "END_TURN":
          return { type: "END_TURN" };
        case "PAY_FINE":
          return { type: "PAY_JAIL_FINE" };
        case "USE_CARD":
          return { type: "USE_JAIL_CARD" };
        case "AUCTION_PASS":
          return { type: "AUCTION_PASS" };
        case "TRADE_ACCEPT":
          return { type: "TRADE_ACCEPT" };
        case "TRADE_REJECT":
          return { type: "TRADE_REJECT" };
        case "OPEN_BUILDING_PHASE":
          return { type: "OPEN_BUILDING_PHASE" };
        case "CONFIRM_BUILDING_PHASE":
          return { type: "CONFIRM_BUILDING_PHASE" };
        case "DECLARE_BANKRUPTCY":
          return { type: "BANKRUPTCY_DECLARE" };
        case "CONFIRM_BANKRUPTCY":
          return { type: "BANKRUPTCY_CONFIRM" };
        default:
          return null;
      }
    }
    switch (d.kind) {
      case "AUCTION_BID":
        // Бот прислал { kind: "AUCTION_BID", amount }. Превращаем
        // в AUCTION_MAKE_BID-action для dispatch.
        return { type: "AUCTION_MAKE_BID", amount: d.amount };
      case "BUILD_HOUSE":
        return { type: "BUILD_HOUSE", cellId: d.cellId };
      case "SELL_HOUSE":
        return { type: "SELL_HOUSE", cellId: d.cellId };
      case "MORTGAGE":
        return { type: "MORTGAGE_PROPERTY", cellId: d.cellId };
      case "UNMORTGAGE":
        return { type: "UNMORTGAGE_PROPERTY", cellId: d.cellId };
      case "LIQUIDATE_HOUSES":
        return { type: "BANKRUPTCY_LIQUIDATE_HOUSES", cellId: d.cellId };
      case "MORTGAGE_FOR_BANKRUPTCY":
        return { type: "BANKRUPTCY_MORTGAGE", cellId: d.cellId };
      case "SELL_PROPERTY_FOR_BANKRUPTCY":
        return { type: "BANKRUPTCY_SELL_PROPERTY", cellId: d.cellId };
      case "SELL_MORTGAGED_PROPERTY_FOR_BANKRUPTCY":
        return { type: "BANKRUPTCY_SELL_MORTGAGED_PROPERTY", cellId: d.cellId };
      case "TRADE_OFFER":
        return { type: "TRADE_OFFER", recipientId: d.recipientId, offer: d.offer };
      case "TRADE_COUNTER":
        return { type: "TRADE_COUNTER", offer: d.offer };
      default:
        return null;
    }
  }

  // Таймеры: аукцион, торговля, END_TURN (человек)

  /**
   * Планирует таймер для текущего участника аукциона:
   *   - бот: маленькая задержка auctionBotThinkMs (имитация «подумать»);
   *   - человек: полный turnDurationMs, потом авто-пас через движок (timeout).
   */
  private scheduleAuctionTimer(state: GameState): void {
    const gameId = this.findGameIdByState(state);
    this.clearAuctionTimer(gameId);
    if (state.phase !== "AUCTION_ACTIVE") return;
    if (!state.auction || state.auction.status !== "AUCTION_ACTIVE") return;
    if (!state.auction.currentBidderId) return;

    const currentBidderId = state.auction.currentBidderId;
    const currentBidder = state.players.find((p) => p.id === currentBidderId);
    if (!currentBidder) return;

    if (currentBidder.kind === "bot") {
      // Бот «думает» 1.5–3 секунды, потом делает ход.
      const thinkMs = (state.settings.auctionBotThinkMs ?? 1500) + Math.floor(Math.random() * 1500);
      const timer = setTimeout(() => {
        this.auctionTimers.delete(gameId);
        void this.runAuctionBotTurn(gameId, currentBidderId);
      }, thinkMs);
      this.auctionTimers.set(gameId, timer);
      return;
    }

    // Человек: ждём turnDurationMs, потом авто-пас через движок (timeout).
    const ms = Math.max(0, state.auction.turnDurationMs);
    const startedAt = state.auction.timerStartedAt;
    const timer = setTimeout(() => {
      this.auctionTimers.delete(gameId);
      try {
        const s = this.activeGames.get(gameId);
        if (!s || !s.auction) return;
        if (s.auction.status !== "AUCTION_ACTIVE") return;
        if (s.auction.currentBidderId !== currentBidderId) return;
        // Защита: timer мог быть перезапущен для нового участника.
        if (s.auction.timerStartedAt !== startedAt) return;
        // Применяем таймаут через AuctionService (эмитит событие).
        this.auction.applyCommand(gameId, s, {
          type: "timeout",
          playerId: currentBidderId,
        });
        this.afterAuctionTurn(s);
      } catch (err) {
        this.logger.error(
          `Auction timer failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }, ms);
    this.auctionTimers.set(gameId, timer);
  }

  /** Очистить таймер аукциона (если есть). */
  private clearAuctionTimer(gameId: string) {
    const prev = this.auctionTimers.get(gameId);
    if (prev) {
      clearTimeout(prev);
      this.auctionTimers.delete(gameId);
    }
  }

  /**
   * Ход бота в аукционе. Вызывается из scheduleAuctionTimer после
   * auctionBotThinkMs. Защитные проверки гарантируют идемпотентность:
   * если состояние изменилось — ничего не делаем.
   */
  private async runAuctionBotTurn(gameId: string, expectedBidderId: string) {
    try {
      const state = this.activeGames.get(gameId);
      if (!state) return;
      if (!state.auction) return;
      if (state.auction.status !== "AUCTION_ACTIVE") return;
      if (state.auction.currentBidderId !== expectedBidderId) return;
      const bot = state.players.find((p) => p.id === expectedBidderId);
      if (!bot || bot.kind !== "bot" || bot.isBankrupt) return;

      const decision = this.bot.decide(bot, state);
      // BotService возвращает либо строку, либо объект { kind, ... }.
      // Для AUCTION_BID объект содержит amount.
      const action = this.botDecisionToAction(decision ?? "AUCTION_PASS", state);
      if (!action) return;
      await this.applyAction(gameId, bot.id, action);
    } catch (err) {
      this.logger.error(
        `Auction bot turn failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private scheduleTradeTimer(
    state: GameState,
    gameId: string,
    _tradeContext: NonNullable<GameState["trade"]>,
  ) {
    const prev = this.tradeTimers.get(gameId);
    if (prev) {
      clearTimeout(prev);
      this.tradeTimers.delete(gameId);
    }
    if (state.phase !== "TRADING_NEGOTIATE" || !state.trade) return;

    const currentParty = state.players.find((p) => p.id === state.trade!.currentPartyId);
    if (!currentParty) return;

    // Для бота — отдельный короткий таймаут, чтобы UI не висел впустую.
    const isBot = currentParty.kind === "bot";
    const ms = isBot
      ? (state.settings.tradingBotResponseTimeoutMs ?? 3500)
      : (state.settings.tradingResponseTimeoutMs ?? 30000);
    const timer = setTimeout(async () => {
      this.tradeTimers.delete(gameId);
      try {
        if (state.phase !== "TRADING_NEGOTIATE" || !state.trade) return;
        const decision = this.bot.decide(currentParty, state);
        const action = this.botDecisionToAction(decision ?? "TRADE_REJECT", state);
        if (action) {
          await this.applyAction(gameId, currentParty.id, action);
        }
      } catch (err) {
        this.logger.error(
          `Trade timer failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }, ms);
    this.tradeTimers.set(gameId, timer);
  }

  private scheduleTurnTimeout(state: GameState, gameId: string) {
    const prev = this.turnTimers.get(gameId);
    if (prev) {
      clearTimeout(prev);
      this.turnTimers.delete(gameId);
    }
    if (state.status !== "active") return;
    const current = state.players[state.currentPlayerIndex];
    if (!current || current.kind !== "human" || current.isBankrupt) return;

    const timeout = state.settings.turnTimeoutMs;
    if (!timeout || timeout <= 0) return;

    const playerId = current.id;
    const timer = setTimeout(async () => {
      this.turnTimers.delete(gameId);
      try {
        const s = this.activeGames.get(gameId);
        if (!s) return;
        if (s.status !== "active") return;
        if (s.phase !== "ROLLING" && s.phase !== "BUY_DECISION") return;
        const now = s.players[s.currentPlayerIndex];
        if (!now || now.id !== playerId) return;
        await this.applyAction(gameId, playerId, { type: "END_TURN" });
      } catch (err) {
        this.logger.error(
          `Auto end-turn failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }, timeout);
    this.turnTimers.set(gameId, timer);
  }

  // Save / Load

  async loadSnapshot(gameId: string, state: GameState, expectedVersion: number): Promise<boolean> {
    const ok = await this.repo.replaceSnapshot(gameId, state, expectedVersion);
    if (ok) {
      if (!state.decks || !state.deckCards || state.decks.length === 0) {
        this.initializer.reShuffleDecks(state);
      }
      this.activeGames.set(gameId, state);
      this.scheduleBotIfNeeded(state, gameId);
      this.scheduleTurnTimeout(state, gameId);
    }
    return ok;
  }
}
