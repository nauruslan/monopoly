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
  CardDeckState,
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
import { canRollDice, canEndTurn, isCurrentPlayer } from "./turn-permissions";
import type { GameEventKind } from "@monopoly/shared";
import { randomUUID } from "crypto";

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
  ) {
    if (!this.rentCalc) console.error("[GamesService] RentCalculator не заинжектирован!");
    if (!this.jail) console.error("[GamesService] JailHandlerService не заинжектирован!");
    if (!this.cards) console.error("[GamesService] CardHandlerService не заинжектирован!");
    if (!this.bankruptcy) console.error("[GamesService] BankruptcyService не заинжектирован!");
    if (!this.bot) console.error("[GamesService] BotService не заинжектирован!");
    if (!this.auction) console.error("[GamesService] AuctionService не заинжектирован!");
    if (!this.trade) console.error("[GamesService] TradeService не заинжектирован!");
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
    // Backfill: старые снапшоты могли не иметь cardDecks.
    if (!state.cardDecks) {
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

    // 2.3) Ранняя защита «торговли в тюрьме».
    // Правила Монополии запрещают торговлю в тюрьме. В текущем ходу
    // игрок может только завершить ход.
    if (action.type === "TRADE_OFFER" && player.inJail) {
      throw new ForbiddenException("Нельзя торговать, находясь в тюрьме");
    }

    // 2.4) Ранняя защита блокировки торговли: TRADE_OFFER получателю,
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
    // предсказуемыми. GDD §1.1 разрешает торговлю в любой момент хода
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
    //  - TRADE_OFFER / TRADE_TOGGLE_BLOCK — торговля (GDD §1.1);
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
        const _exhaustive: never = state.phase;
        throw new BadRequestException(`Unknown phase: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  // Обработчики фаз Turn FSM

  /**
   * START_TURN — инициализация контекста хода (мгновенная фаза).
   * Сразу переходит в ROLLING (или в JAIL_DECISION, если игрок в тюрьме).
   */
  private async handleStartTurn(
    state: GameState,
    player: Player,
    _action: GameAction,
  ): Promise<{ dice?: [number, number]; card?: unknown; event?: GameEvent }> {
    player.mustRollAgain = false;
    player.consecutiveDoubles = 0;
    // Сбрасываем флаги свежего попадания в специальные зоны
    // (в текущем ходу их действие уже учтено; в следующем ходу
    // игрок снова может бросать/действовать в обычном режиме).
    state.justEnteredJail = false;
    state.justArrivedAtParking = false;
    // Сбрасываем outcome последнего TRY_DOUBLE — если он каким-то
    // образом остался заполненным (например, на реконнекте), это
    // гарантирует, что в новом ходу мы не «провалимся» в ветку
    // DICE_ANIMATION как будто бы это была попытка выхода из тюрьмы.
    state.jailRollOutcome = undefined;
    // Новый ход — сбрасываем журнал попыток инициации торговли.
    state.tradeInitiationLog = [];
    if (player.inJail) {
      state.phase = "JAIL_DECISION";
    } else {
      state.phase = "ROLLING";
    }
    return {};
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
    if (action.type !== "ROLL_DICE") {
      throw new ForbiddenException(`Недопустимое действие ${action.type} в фазе ROLLING`);
    }

    // Бросаем кости.
    const diceResult = this.roll(state);
    const isDouble = diceResult[0] === diceResult[1];

    // Сохраняем контекст броска в state, чтобы клиент знал значения для анимации.
    state.lastDice = { dice: diceResult, isDouble };
    state.phase = "DICE_ANIMATION";

    return { dice: diceResult };
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

      if (outcome === "pay") {
        // 3-й промах: принудительная оплата 50₽. `Math.max(0, ...)` —
        // защита от отрицательного баланса; в реальной логике после
        // этого должен сработать `BankruptcyService`. Здесь НЕ бросаем
        // ForbiddenException при нехватке денег — по правилам Монополии
        // штраф всё равно применяется (долг может привести к банкротству
        // в handleResolvingLanding).
        player.money = Math.max(0, player.money - 50);
      }
      // Для "escape" (дубль) деньги НЕ списываются — игрок выходит
      // бесплатно, даже на 3-й попытке. Это правильный ход Монополии.
      player.inJail = false;
      player.jailTurns = 0;

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
   *  2) **Движение по карточке (move / move-relative / go-salary)**:
   *     `state.moveAnimation` уже заполнен картой, и `player.position`
   *     УЖЕ равен целевой клетке (был изменён в `applyCardEffectAndAdvance`).
   *     В этом случае мы НЕ сдвигаем позицию ещё раз, а только
   *     начисляем goSalary, если было прохождение через 0 (для forward)
   *     или нет (для backward — goSalary НЕ начисляется).
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

    // Отличаем карточное движение (move / move-relative / go-salary)
    // от обычного броска кубиков. Для карточного движения:
    //   - player.position УЖЕ изменён в applyCardEffectAndAdvance;
    //   - state.moveAnimation.direction задан явно ("forward" | "backward");
    //   - goSalary уже начислен (если был wrap через 0 для forward);
    //   - здесь мы только переходим в RESOLVING_LANDING.
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
    if (newPos < oldPos && newPos !== 0) {
      player.money += state.settings.goSalary;
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

    // GO — если игрок ОСТАНОВИЛСЯ ровно на клетке 0 (например, после тюрьмы
    // или из-за точной длины броска), начисляем goSalary.
    //
    // Правила Монополии:
    //  - Без дубля: обычная зарплата 200₽, фаза BUILDING.
    //  - После дубля: ДВОЙНАЯ зарплата (2× goSalary), и `mustRollAgain`
    //    СОХРАНЯЕТСЯ — игрок бросает ещё раз (фаза ROLLING).
    if (cell.type === "GO") {
      // раньше здесь проверялось `state.lastDice?.isDouble`,
      // что в общем случае совпадает с `player.mustRollAgain`, но
      // может рассинхронизироваться:
      //  - после `tryDouble` из тюрьмы `lastDice` обнуляется, и при
      //    дальнейшем движении `isDouble` теряется;
      //  - при ручном выставлении `mustRollAgain` (тесты, edge-cases).
      // Используем `player.mustRollAgain` — это ЕДИНСТВЕННЫЙ
      // каноничный флаг «игрок обязан бросить ещё раз» (см.
      // turn-permissions.ts:mustRollDiceNow).
      const isDouble = player.mustRollAgain === true;
      if (isDouble) {
        // Остановка на GO после дубля: двойная зарплата, и
        // право на повторный бросок сохраняется (правило дублей).
        player.money += state.settings.goSalary * 2;
        state.phase = "ROLLING";
      } else {
        player.money += state.settings.goSalary;
        state.phase = "BUILDING";
      }
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
        state.cardContext = {
          playerId: player.id,
          deck: "chance",
          card: jailCard,
          applied: false,
        };
        state.phase = "CARD_REVEAL";
        return { card: jailCard };
      }
      // fallback (если карточка не найдена в деке — теоретически невозможно)
      this.jail.sendToJail(player);
      state.justEnteredJail = true;
      state.phase = "JAIL_DECISION";
      return {};
    }
    // CHANCE / TREASURY — двухфазная обработка:
    //   1) CARD_REVEAL  — сервер вытягивает карту, кладёт её в state.cardContext,
    //                     НО НЕ применяет эффект. Клиент показывает модалку.
    //   2) CARD_EFFECT  — после CONFIRM_CARD эффект применяется.
    if (cell.type === "CHANCE" || cell.type === "TREASURY") {
      const deck = cell.type === "CHANCE" ? "chance" : "treasury";
      const card = this.cards.drawFromDeck(deck, state);
      state.cardContext = {
        playerId: player.id,
        deck,
        card,
        applied: false,
      };
      state.phase = "CARD_REVEAL";
      return { card };
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
        const card = this.cards.drawFromDeck("luxury-tax", state);
        state.cardContext = {
          playerId: player.id,
          deck: "luxury-tax",
          card,
          applied: false,
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
    // Флаг `state.justArrivedAtParking` НЕ ставится при обычном
    // попадании (через кубики) — он предназначен только для
    // «телепорта» по карточке «Отправляйтесь на парковку»
    // (см. applyCardEffectAndAdvance), где право на ещё один
    // бросок ТЕРЯЕТСЯ по правилам Монополии.
    if (cell.type === "PARKING") {
      if (player.mustRollAgain) {
        // Дубль: сохраняем право на повторный бросок.
        state.phase = "ROLLING";
      } else {
        // Без дубля: обычный отдых, можно завершить ход.
        state.phase = "BUILDING";
      }
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
        player.money = Math.max(0, player.money - rent);
        owner.money += rent;
        state.rentContext = undefined;
        if (player.money === 0) {
          this.startBankruptcyProcedure(state, player, owner, rent);
          return {};
        }
      } else {
        state.rentContext = undefined;
      }
      this.afterRentOrTax(state, player);
      return {};
    }

    // Legacy-fallback: TAX без taxVariant (старые данные).
    if (cell.type === "TAX" && cell.taxAmount) {
      player.money = Math.max(0, player.money - cell.taxAmount);
      state.rentContext = undefined;
      if (player.money === 0) {
        this.startBankruptcyProcedure(state, player, null, cell.taxAmount);
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
    player.money = Math.max(0, player.money - cell.taxAmount);
    if (player.money === 0) {
      this.startBankruptcyProcedure(state, player, null, cell.taxAmount);
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
      player.money -= cell.price;
      player.properties.push(cell.id);
      cell.ownerId = player.id;
      state.phase = player.mustRollAgain ? "ROLLING" : "BUILDING";
      return {};
    }

    if (action.type === "DECLINE_BUY") {
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
   *  - `go-salary`          → MOVE_ANIMATION (с начислением goSalary)
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
    //  - go-salary (target=0 через move) — игрок остаётся в основном
    //    цикле, `mustRollAgain` СОХРАНЯЕТСЯ (правило дублей действует).
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
      // Если телепорт через клетку 0 (GO) — начисляем goSalary.
      if (outcome.target === 0 && !outcome.passedGo) {
        player.money += state.settings.goSalary;
      }
      // Переставляем позицию игрока.
      const from = player.position;
      player.position = outcome.target;

      // ─── Особый случай: «Отправляйтесь на парковку» (id=20) ─────────
      // По правилам Монополии парковка — это «отдых»: цепочка
      // «бросок → движение → эффект» обрывается, право на ещё один
      // бросок (после дубля) ТЕРЯЕТСЯ, а карточка «Отправляйтесь на
      // парковку» действует КАК арест: в этом ходу игрок может только
      // завершить ход, бросать кубики ещё раз НЕЛЬЗЯ.
      //
      // Чтобы UI не предлагал лишних действий, ставим:
      //  - `justArrivedAtParking = true` — блокирует canRollDice
      //    (см. turn-permissions.ts);
      //  - фаза = BUILDING (а не MOVE_ANIMATION) — canEndTurn=true,
      //    кнопка «Завершить ход» активна;
      //  - moveAnimation НЕ заполняем — фишка телепортируется
      //    мгновенно (как для justEnteredJail в GOTO_JAIL cell).
      //
      // Флаг сбрасывается в `handleStartTurn` при начале СЛЕДУЮЩЕГО хода.
      const PARKING_ID = 20;
      if (outcome.target === PARKING_ID) {
        // «выводящая» карточка парковки обрывает
        // цепочку дубля. Сбрасываем `mustRollAgain`/`consecutiveDoubles`
        // явно ЗДЕСЬ, потому что общий безусловный сброс мы удалили
        // выше (он ломал move-relative). Спецлогика парковки в этом
        // ходу: игрок может только завершить ход.
        player.mustRollAgain = false;
        player.consecutiveDoubles = 0;
        state.justArrivedAtParking = true;
        state.moveAnimation = undefined;
        state.cardContext = undefined;
        state.phase = "BUILDING";
        state.lastDice = { dice: [0, 0], isDouble: false };
        return { card };
      }

      // Шаги для анимации (всегда положительные, по модулю 40).
      const steps = (outcome.target - from + 40) % 40;
      // Заполняем moveAnimation — клиент использует его для анимации фишки.
      // Направление для `move` (телепорт на конкретную клетку) — всегда
      // "forward": по правилам Монополии любой телепорт идёт по кратчайшему
      // пути через GO (если нужно) — это всегда по часовой стрелке.
      state.moveAnimation = {
        playerId: player.id,
        from,
        to: outcome.target,
        steps,
        isDouble: false,
        direction: outcome.direction ?? "forward",
      };
      // Очищаем cardContext — карта «съедена», эффект move применён.
      // Без этого клиент видел ту же карту в MOVE_ANIMATION и мог
      // повторно открыть модалку.
      state.cardContext = undefined;
      state.phase = "MOVE_ANIMATION";
      // lastDice с 0 шагами — handleMoveAnimation не сдвинет игрока повторно,
      // т.к. position уже корректная; moveAnimation уже инициализирован.
      state.lastDice = { dice: [0, 0], isDouble: false };
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
        // точного броска — этот случай уже обработан в ветке `go-salary`
        // или в handleResolvingLanding (клетка GO).
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
      // Карта «Идёшь в тюрьму». `CardHandlerService.applyEffect`
      // вернул `goto-jail` без мутаций — мы сами вызываем
      // `JailHandlerService.sendToJail`, чтобы централизованно
      // перенести фишку на 10, поставить inJail и сбросить флаги
      // ВАЖНО: `justEnteredJail=true` означает, что в ЭТОМ ходу
      // игрок может только «Завершить ход». Модалка тюрьмы с
      // тремя способами выхода появится в начале СЛЕДУЮЩЕГО хода
      // (тогда `handleStartTurn` сбросит `justEnteredJail`).
      this.jail.sendToJail(player);
      state.justEnteredJail = true;
      state.phase = "JAIL_DECISION";
      state.cardContext = undefined;
      return { card };
    }

    // stay: money / jail-free / luxury-tax-house
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
    // Если это move/move-relative/go-salary — фаза уже MOVE_ANIMATION.
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
   * BUILDING — игрок может строить/ипотечить/торговать.
   * Допустимые: BUILD_HOUSE, SELL_HOUSE, MORTGAGE_PROPERTY,
   * UNMORTGAGE_PROPERTY, TRADE_OFFER, END_TURN.
   */
  private async handleBuilding(
    state: GameState,
    player: Player,
    action: GameAction,
  ): Promise<{ card?: unknown; event?: GameEvent }> {
    switch (action.type) {
      case "BUILD_HOUSE": {
        const cell = state.board[action.cellId];
        if (!cell) throw new NotFoundException("Клетка не найдена");
        if (cell.ownerId !== player.id) throw new ForbiddenException("Это не ваша клетка");
        if (cell.type !== "PROPERTY")
          throw new BadRequestException("На этой клетке нельзя строить");
        if (!this.rentCalc.ownsMonopoly(cell, player, state)) {
          throw new ForbiddenException("Нет монополии");
        }
        if (cell.houses >= 5) throw new ForbiddenException("Уже отель");
        if (cell.housePrice === undefined) throw new BadRequestException("Нет цены дома");
        if (player.money < cell.housePrice) throw new ForbiddenException("Недостаточно денег");
        if (cell.group) {
          const groupCells = state.board.filter((c) => c.group === cell.group);
          const minHouses = Math.min(...groupCells.map((c) => c.houses));
          if (cell.houses > minHouses) {
            throw new ForbiddenException("Сначала постройте дома на других клетках группы");
          }
        }
        player.money -= cell.housePrice;
        cell.houses = (cell.houses + 1) as 0 | 1 | 2 | 3 | 4 | 5;
        return {};
      }

      case "SELL_HOUSE": {
        const cell = state.board[action.cellId];
        if (!cell) throw new NotFoundException("Клетка не найдена");
        if (cell.ownerId !== player.id) throw new ForbiddenException("Это не ваша клетка");
        if (cell.houses === 0) throw new ForbiddenException("Нет домов для продажи");
        if (cell.housePrice === undefined) throw new BadRequestException("Нет цены дома");
        if (cell.group) {
          const groupCells = state.board.filter((c) => c.group === cell.group);
          const maxHouses = Math.max(...groupCells.map((c) => c.houses));
          if (cell.houses < maxHouses) {
            throw new ForbiddenException("Сначала продайте дома на других клетках группы");
          }
        }
        player.money += cell.housePrice / 2;
        cell.houses = (cell.houses - 1) as 0 | 1 | 2 | 3 | 4 | 5;
        return {};
      }

      case "MORTGAGE_PROPERTY": {
        // Используем MortgageService, который:
        //  - проверяет правило "нет домов в цветовой группе" (canMortgage);
        //  - зачисляет mortgageValue игроку;
        //  - выставляет isMortgaged = true.
        const mortgageAmount = this.mortgageSvc.mortgage(state, player, action.cellId);
        return {
          event: this.makeEvent("PROPERTY_MORTGAGED", player, {
            message: `🏦 ${player.displayName} заложил(а) участок и получил(а) $${mortgageAmount}`,
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
        return {
          event: this.makeEvent("PROPERTY_UNMORTGAGED", player, {
            message: `💰 ${player.displayName} выкупил(а) участок за $${unmortgageAmount}`,
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

      case "END_TURN": {
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
        await this.handleStartTurn(state, next, action);
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
  private async handleJailDecision(
    state: GameState,
    player: Player,
    action: GameAction,
  ): Promise<{ dice?: [number, number]; card?: unknown; event?: GameEvent }> {
    if (!player.inJail) {
      // Уже вышли — передаём ход через мгновенный START_TURN.
      this.advanceToNextPlayer(state);
      const next = state.players[state.currentPlayerIndex];
      if (next) {
        state.phase = "ROLLING";
        await this.handleStartTurn(state, next, action);
      } else {
        state.phase = "ROLLING";
      }
      return {};
    }

    // Только что попал в тюрьму (в ЭТОМ ходу): по правилам Монополии
    // игрок НЕ принимает решение о выходе в том же ходу — только END_TURN.
    // Модальное окно с тремя способами выхода появится в начале
    // СЛЕДУЮЩЕГО хода, когда handleStartTurn сбросит justEnteredJail.
    if (state.justEnteredJail) {
      if (action.type === "END_TURN" || action.type === "CONFIRM_END_TURN") {
        this.advanceToNextPlayer(state);
        // Следующий ход: мгновенный START_TURN (handleStartTurn сбросит
        // justEnteredJail и переведёт нового игрока в ROLLING/JAIL_DECISION).
        const next = state.players[state.currentPlayerIndex];
        if (next) {
          state.phase = "ROLLING";
          await this.handleStartTurn(state, next, action);
        } else {
          state.phase = "ROLLING";
        }
        return {};
      }
      throw new ForbiddenException(
        `Только что попал в тюрьму — в этом ходу можно только завершить ход, а не ${action.type}`,
      );
    }

    if (!player.inJail) {
      // Уже вышли из тюрьмы (например, применили карту «выход из тюрьмы»
      // по предыдущему ходу, или `tryDoubleOrPay` только что сделал
      // `escape`/`pay` — но в этом случае `jailRollOutcome` уже задан
      // и ниже сработает ветка `TRY_DOUBLE`). Передаём ход через
      // мгновенный START_TURN.
      this.advanceToNextPlayer(state);
      const next = state.players[state.currentPlayerIndex];
      if (next) {
        state.phase = "ROLLING";
        await this.handleStartTurn(state, next, action);
      } else {
        state.phase = "ROLLING";
      }
      return {};
    }

    if (action.type === "PAY_JAIL_FINE") {
      if (player.money < 50) throw new ForbiddenException("Недостаточно денег");
      player.money -= 50;
      player.inJail = false;
      player.jailTurns = 0;
      state.phase = "ROLLING";
      return {};
    }

    if (action.type === "USE_JAIL_CARD") {
      if (player.jailCards === 0) throw new ForbiddenException("Нет карточек выхода");
      player.jailCards -= 1;
      player.inJail = false;
      player.jailTurns = 0;
      state.phase = "ROLLING";
      return {};
    }

    if (action.type === "TRY_DOUBLE") {
      const diceResult = this.roll(state);
      const isDouble = diceResult[0] === diceResult[1];
      state.lastDice = { dice: diceResult, isDouble };
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

  private startBankruptcyProcedure(
    state: GameState,
    player: Player,
    creditor: Player | null,
    debt: number,
  ) {
    state.bankruptcy = {
      playerId: player.id,
      creditorId: creditor?.id ?? null,
      debt,
      stage: 1,
    };
    state.phase = "BANKRUPTCY_LIQUIDATE";
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
      const cell = state.board[action.cellId];
      if (!cell) throw new NotFoundException("Клетка не найдена");
      if (cell.ownerId !== player.id) throw new ForbiddenException("Это не ваша клетка");
      if (cell.houses === 0) throw new ForbiddenException("Нет домов");
      if (cell.housePrice === undefined) throw new BadRequestException("Нет цены дома");
      player.money += cell.housePrice / 2;
      cell.houses = (cell.houses - 1) as 0 | 1 | 2 | 3 | 4 | 5;
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
      return {};
    }

    if (action.type === "BANKRUPTCY_CONFIRM" || action.type === "BANKRUPTCY_DECLARE") {
      if (player.money >= state.bankruptcy.debt) {
        const creditor = state.bankruptcy.creditorId
          ? (state.players.find((p) => p.id === state.bankruptcy!.creditorId) ?? null)
          : null;
        if (creditor) {
          player.money -= state.bankruptcy.debt;
          creditor.money += state.bankruptcy.debt;
        } else {
          player.money -= state.bankruptcy.debt;
        }
        state.bankruptcy = undefined;
        this.afterRentOrTax(state, player);
        return {};
      }
      const creditor = state.bankruptcy.creditorId
        ? (state.players.find((p) => p.id === state.bankruptcy!.creditorId) ?? null)
        : null;
      this.bankruptcy.handle(state, player, creditor);
      state.bankruptcy = undefined;
      this.checkGameOver(state);
      state.phase = "BUILDING";
      this.advanceToNextPlayer(state);
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
   * Используется обработчиками, чтобы не дублировать id/at/playerId.
   */
  private makeEvent(
    kind: GameEventKind,
    player: Player,
    fields: Pick<GameEvent, "message" | "type"> & { payload?: GameEvent["payload"] },
  ): GameEvent {
    return {
      id: randomUUID(),
      at: new Date().toISOString(),
      kind,
      playerId: player.id,
      message: fields.message,
      type: fields.type,
      ...(fields.payload ? { payload: fields.payload } : {}),
    };
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
    if (this.isInterruptPhase(state.phase)) return;

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

    const decision = this.bot.decide(current, state);
    if (!decision) return;

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
        case "DECLARE_BANKRUPTCY":
          return { type: "BANKRUPTCY_DECLARE" };
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
      if (!state.cardDecks) {
        this.initializer.reShuffleDecks(state);
      }
      this.activeGames.set(gameId, state);
      this.scheduleBotIfNeeded(state, gameId);
      this.scheduleTurnTimeout(state, gameId);
    }
    return ok;
  }
}
