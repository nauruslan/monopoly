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
import type {
  GameState,
  GameAction,
  Player,
  GameEvent,
  TradeOffer,
  Phase,
  Card,
  CardDeckState,
  Cell,
} from "@monopoly/shared";
import { GameRepository } from "../db/repositories/game.repository";
import { GameInitializerService } from "./game-initializer.service";
import { RentCalculator } from "./handlers/rent-calculator";
import { JailHandlerService } from "./handlers/jail-handler.service";
import { CardHandlerService } from "./handlers/card-handler.service";
import { BankruptcyService } from "./handlers/bankruptcy.service";
import { BotService, type BotDecision } from "./bots/bot.service";
import { AuctionService } from "./handlers/auction.service";
import { TradeService } from "./handlers/trade.service";

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
  /** Таймеры авто-CONFIRM_DICE_ANIMATION для ботов (фаза DICE_ANIMATION). */
  private botDiceAnimTimers = new Map<string, NodeJS.Timeout>();
  /** Таймеры авто-CONFIRM_MOVE_ANIMATION для ботов (фаза MOVE_ANIMATION). */
  private botMoveAnimTimers = new Map<string, NodeJS.Timeout>();
  /** Таймеры авто-CONFIRM_CARD для ботов (фаза CARD_REVEAL). */
  private botCardTimers = new Map<string, NodeJS.Timeout>();
  /** Таймеры авто-CONFIRM_TAX для ботов (фаза TAX_PAYMENT). */
  private botTaxTimers = new Map<string, NodeJS.Timeout>();
  /** Таймеры авто-CONFIRM_RENT_PAYMENT для ботов (фаза PAY_RENT). */
  private botRentTimers = new Map<string, NodeJS.Timeout>();
  /** Таймеры авто-CONFIRM_LANDING для ботов (фаза RESOLVING_LANDING). */
  private botLandingTimers = new Map<string, NodeJS.Timeout>();
  /** Таймеры авто-CONFIRM_END_TURN для ботов (фаза END_TURN). */
  private botEndTurnTimers = new Map<string, NodeJS.Timeout>();
  /** Таймеры аукционных ставок. */
  private auctionTimers = new Map<string, NodeJS.Timeout>();
  /** Таймеры ответа в торговле. */
  private tradeTimers = new Map<string, NodeJS.Timeout>();
  /** Таймеры авто-END_TURN для человека. */
  private turnTimers = new Map<string, NodeJS.Timeout>();

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
    const player = state.players.find((p) => p.id === playerId);
    if (!player) throw new NotFoundException("Игрок не найден в партии");
    this.assertCanAct(state, player);

    // 3) Проверить, что ход именно этого игрока (для не-interrupt фаз).
    if (!this.isInterruptPhase(state.phase)) {
      const currentPlayer = state.players[state.currentPlayerIndex];
      if (currentPlayer.id !== player.id) {
        throw new ForbiddenException("Сейчас не ваш ход");
      }
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

    // Планирование ботских таймеров ПОСЛЕ завершения диспатча
    // 1) Если сейчас DICE_ANIMATION и ход бота — ставим таймер CONFIRM_DICE_ANIMATION.
    if (player.kind === "bot" && state.phase === "DICE_ANIMATION") {
      this.scheduleBotDiceAnimDone(state, gameId, player);
    }

    // 2) Если сейчас MOVE_ANIMATION и ход бота — таймер CONFIRM_MOVE_ANIMATION.
    if (player.kind === "bot" && state.phase === "MOVE_ANIMATION" && state.lastDice) {
      this.scheduleBotMoveAnimDone(state, gameId, player, state.lastDice.dice);
    }

    // 3) Если сейчас CARD_REVEAL и ход бота — таймер CONFIRM_CARD.
    if (player.kind === "bot" && state.phase === "CARD_REVEAL") {
      this.scheduleBotCardDone(state, gameId, player);
    }

    // 4) Если сейчас TAX_PAYMENT и ход бота — таймер CONFIRM_TAX.
    if (player.kind === "bot" && state.phase === "TAX_PAYMENT") {
      this.scheduleBotTaxDone(state, gameId, player);
    }

    // 4.1) Если сейчас PAY_RENT и ход бота — таймер CONFIRM_RENT_PAYMENT.
    if (player.kind === "bot" && state.phase === "PAY_RENT") {
      this.scheduleBotRentDone(state, gameId, player);
    }

    // 5) Если сейчас RESOLVING_LANDING и ход бота — таймер CONFIRM_LANDING.
    if (player.kind === "bot" && state.phase === "RESOLVING_LANDING") {
      this.scheduleBotLandingDone(state, gameId, player);
    }

    // 6) Если сейчас END_TURN и ход бота — таймер CONFIRM_END_TURN.
    if (player.kind === "bot" && state.phase === "END_TURN") {
      this.scheduleBotEndTurnDone(state, gameId, player);
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
      "BOT_THINKING",
    ]);
    if (!waitingForClientConfirm.has(state.phase)) {
      this.scheduleBotIfNeeded(state, gameId);
    }
    this.scheduleTurnTimeout(state, gameId);

    // Сохранение в БД (в фоне)
    void this.repo.updateSnapshot(gameId, state, state.version - 1).catch((err) => {
      this.logger.error(
        `updateSnapshot failed for game ${gameId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });

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
      case "AUCTION_BIDDING":
        return this.handleAuctionBidding(state, player, action);
      case "AUCTION_RESOLVE":
        return this.handleAuctionResolve(state, player, action);

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

    // Логика дублей — перенесена сюда из старого processMovement.
    if (isDouble) {
      player.consecutiveDoubles += 1;
      if (player.consecutiveDoubles >= 3) {
        this.jail.sendToJail(player);
        player.consecutiveDoubles = 0;
        player.mustRollAgain = false;
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
    const dice = state.lastDice.dice;
    const steps = dice[0] + dice[1];
    const oldPos = player.position;
    const newPos = (oldPos + steps) % 40;
    player.position = newPos;

    // Прохождение GO через wrap → зарплата.
    if (newPos < oldPos || oldPos + steps >= 40) {
      player.money += state.settings.goSalary;
    }

    // Переходим в RESOLVING_LANDING — мгновенная фаза-диспетчер по типу клетки.
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
    if (cell.type === "GO") {
      player.money += state.settings.goSalary;
      state.phase = "BUILDING";
      return {};
    }

    // GOTO_JAIL — мгновенное действие, шлём в тюрьму.
    if (cell.type === "GOTO_JAIL") {
      this.jail.sendToJail(player);
      player.mustRollAgain = false;
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
        state.rentContext = undefined;
        state.phase = "BUILDING";
      } else {
        // Чужая — рассчитываем ренту заранее и кладём в state.rentContext,
        // затем переходим в PAY_RENT. Деньги НЕ списываем — клиент должен
        // сначала показать модалку и отправить CONFIRM_RENT_PAYMENT.
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

    // JAIL (visit), PARKING — ничего не делаем, переходим в BUILDING.
    state.phase = "BUILDING";
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
        // Запускаем аукцион.
        this.auction.startAuction(state, cell, player);
        state.phase = "AUCTION_BIDDING";
        this.scheduleAuctionTimer(state, this.findGameIdByState(state), state.auction!.bidDeadline);
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
   * ВАЖНО (bugfix «двойной модалки»): после применения эффекта `cardContext`
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

    if (outcome.kind === "move") {
      // Если телепорт через клетку 0 (GO) — начисляем goSalary.
      if (outcome.target === 0 && !outcome.passedGo) {
        player.money += state.settings.goSalary;
      }
      // Переставляем позицию игрока.
      const from = player.position;
      player.position = outcome.target;
      // Шаги для анимации (всегда положительные, по модулю 40).
      const steps = (outcome.target - from + 40) % 40;
      // Заполняем moveAnimation — клиент использует его для анимации фишки.
      state.moveAnimation = {
        playerId: player.id,
        from,
        to: outcome.target,
        steps,
        isDouble: false,
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
      // Вычислим целевую позицию с учётом прохождения GO.
      const oldPos = player.position;
      const newPos = (oldPos + outcome.steps + 40) % 40;
      const passedGo = outcome.steps > 0 && oldPos + outcome.steps >= 40;
      if (passedGo) {
        player.money += state.settings.goSalary;
      }
      const steps = Math.abs(outcome.steps);
      player.position = newPos;
      // Заполняем moveAnimation — клиент анимирует фишку.
      state.moveAnimation = {
        playerId: player.id,
        from: oldPos,
        to: newPos,
        steps,
        isDouble: false,
      };
      // Очищаем cardContext (см. комментарий в ветке `move`).
      state.cardContext = undefined;
      state.phase = "MOVE_ANIMATION";
      // lastDice для moveStepMs (хотя moveAnimation уже даёт steps).
      state.lastDice = {
        dice: outcome.steps >= 0 ? [0, steps] : [steps, 0],
        isDouble: false,
      };
      return { card };
    }

    if (outcome.kind === "goto-jail") {
      // applyEffect уже отправил в тюрьму.
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
        const cell = state.board[action.cellId];
        if (!cell) throw new NotFoundException("Клетка не найдена");
        if (cell.ownerId !== player.id) throw new ForbiddenException("Это не ваша клетка");
        if (cell.isMortgaged) throw new ForbiddenException("Уже заложена");
        if (cell.houses > 0) throw new ForbiddenException("Сначала продайте дома");
        if (cell.mortgageValue === undefined) throw new BadRequestException("Нельзя заложить");
        player.money += cell.mortgageValue;
        cell.isMortgaged = true;
        return {};
      }

      case "UNMORTGAGE_PROPERTY": {
        const cell = state.board[action.cellId];
        if (!cell) throw new NotFoundException("Клетка не найдена");
        if (cell.ownerId !== player.id) throw new ForbiddenException("Это не ваша клетка");
        if (!cell.isMortgaged) throw new ForbiddenException("Не заложена");
        if (cell.mortgageValue === undefined) throw new BadRequestException("Нельзя выкупить");
        const cost = Math.ceil(cell.mortgageValue * 1.1);
        if (player.money < cost) throw new ForbiddenException("Недостаточно денег");
        player.money -= cost;
        cell.isMortgaged = false;
        return {};
      }

      case "TRADE_OFFER": {
        this.trade.startTrade(state, player, action.recipientId, action.offer);
        state.phase = "TRADING_NEGOTIATE";
        const gameId = this.findGameIdByState(state);
        this.scheduleTradeTimer(state, gameId, state.trade!);
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
      state.phase = "ROLLING";
    } else {
      this.advanceToNextPlayer(state);
      state.phase = "ROLLING";
    }
    // Очищаем контекст броска.
    state.lastDice = undefined;
    state.cardContext = undefined;
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
      // Уже вышли — передаём ход.
      this.advanceToNextPlayer(state);
      state.phase = "ROLLING";
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
      const outcome = this.jail.tryDoubleOrPay(player, diceResult);
      if (outcome === "escape" || outcome === "pay") {
        player.inJail = false;
        // Переход в DICE_ANIMATION (анимация кубиков в тюрьме).
        state.phase = "DICE_ANIMATION";
        return { dice: diceResult };
      }
      // "stay" — остаёмся, передаём ход.
      this.advanceToNextPlayer(state);
      state.phase = "ROLLING";
      return { dice: diceResult };
    }

    throw new ForbiddenException(`Недопустимое действие ${action.type} в фазе JAIL_DECISION`);
  }

  // Interrupt: Auction

  /**
   * AUCTION_BIDDING — текущий участник делает ставку или пасует.
   * Допустимые: AUCTION_BID, AUCTION_PASS.
   */
  private async handleAuctionBidding(
    state: GameState,
    player: Player,
    action: GameAction,
  ): Promise<{ card?: unknown; event?: GameEvent }> {
    if (!state.auction) {
      state.phase = "BUILDING";
      return {};
    }

    const currentBidder = state.players[state.auction.currentBidderIndex];
    if (!currentBidder || currentBidder.id !== player.id) {
      throw new ForbiddenException("Сейчас не ваша очередь ставить");
    }

    if (action.type === "AUCTION_PASS") {
      state.auction.activeBidders = state.auction.activeBidders.filter((id) => id !== player.id);
      return this.advanceAuction(state);
    }

    if (action.type === "AUCTION_BID") {
      const minBid = state.auction.currentBid + 1;
      if (action.amount < minBid) {
        throw new ForbiddenException(`Минимальная ставка: ${minBid}`);
      }
      if (player.money < action.amount) {
        throw new ForbiddenException("Недостаточно денег");
      }
      state.auction.currentBid = action.amount;
      state.auction.highestBidderId = player.id;
      return this.advanceAuction(state);
    }

    throw new ForbiddenException(`Недопустимое действие ${action.type} в фазе AUCTION_BIDDING`);
  }

  /**
   * AUCTION_RESOLVE — аукцион завершён, передаём клетку победителю.
   * Допустимые: AUCTION_AUTO_PASS, END_TURN.
   */
  private async handleAuctionResolve(
    state: GameState,
    _player: Player,
    action: GameAction,
  ): Promise<{ card?: unknown; event?: GameEvent }> {
    if (action.type !== "END_TURN" && action.type !== "AUCTION_AUTO_PASS") {
      throw new ForbiddenException(`Недопустимое действие ${action.type} в фазе AUCTION_RESOLVE`);
    }

    if (state.auction) {
      this.auction.resolveAuction(state);
    }
    state.auction = undefined;
    state.phase = "BUILDING";
    return {};
  }

  /**
   * Продвигает аукцион: переходит к следующему участнику или в AUCTION_RESOLVE.
   */
  private advanceAuction(state: GameState): { card?: unknown; event?: GameEvent } {
    if (!state.auction) {
      state.phase = "AUCTION_RESOLVE";
      return {};
    }

    if (state.auction.activeBidders.length <= 1) {
      state.phase = "AUCTION_RESOLVE";
      return {};
    }

    let nextIndex = state.auction.currentBidderIndex + 1;
    let attempts = 0;
    while (attempts < state.players.length) {
      const candidateId = state.auction.bidderOrder[nextIndex % state.auction.bidderOrder.length];
      if (candidateId && state.auction.activeBidders.includes(candidateId)) {
        state.auction.currentBidderIndex = state.auction.bidderOrder.findIndex(
          (id) => id === candidateId,
        );
        const gameId = this.findGameIdByState(state);
        this.scheduleAuctionTimer(state, gameId, state.auction.bidDeadline);
        return {};
      }
      nextIndex++;
      attempts++;
    }

    state.phase = "AUCTION_RESOLVE";
    return {};
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
      state.phase = "BUILDING";
      return {};
    }

    if (player.id !== state.trade.currentPartyId) {
      throw new ForbiddenException("Сейчас не ваша очередь в торговле");
    }

    if (action.type === "TRADE_ACCEPT") {
      this.trade.executeTrade(state);
      state.trade = undefined;
      state.phase = "BUILDING";
      return {};
    }

    if (action.type === "TRADE_REJECT") {
      state.trade = undefined;
      state.phase = "BUILDING";
      return {};
    }

    if (action.type === "TRADE_COUNTER") {
      const max = state.settings.tradingMaxCounterOffers ?? 3;
      if (state.trade.counterCount >= max) {
        throw new ForbiddenException(`Достигнут лимит counter-offer'ов (${max})`);
      }
      this.trade.makeCounterOffer(state, action.offer);
      this.scheduleTradeTimer(state, this.findGameIdByState(state), state.trade!);
      return {};
    }

    if (action.type === "TRADE_CANCEL") {
      if (player.id !== state.trade.initiatorId) {
        throw new ForbiddenException("Отменить может только инициатор");
      }
      state.trade = undefined;
      state.phase = "BUILDING";
      return {};
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

  // Вспомогательные методы

  private isInterruptPhase(phase: Phase): boolean {
    return (
      phase === "AUCTION_BIDDING" ||
      phase === "AUCTION_RESOLVE" ||
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
    for (const map of [
      this.botTimers,
      this.botThinkingTimers,
      this.botDiceAnimTimers,
      this.botMoveAnimTimers,
      this.botCardTimers,
      this.botTaxTimers,
      this.botRentTimers,
      this.botLandingTimers,
      this.botEndTurnTimers,
      this.auctionTimers,
      this.tradeTimers,
      this.turnTimers,
    ]) {
      const t = map.get(gameId);
      if (t) clearTimeout(t);
      map.delete(gameId);
    }
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
   * Бот автоматически подтверждает анимацию кубиков через diceAnimationMs.
   */
  private scheduleBotDiceAnimDone(state: GameState, gameId: string, current: Player) {
    const prev = this.botDiceAnimTimers.get(gameId);
    if (prev) {
      clearTimeout(prev);
      this.botDiceAnimTimers.delete(gameId);
    }
    const ms = state.settings.diceAnimationMs ?? 2000;
    const timer = setTimeout(async () => {
      this.botDiceAnimTimers.delete(gameId);
      try {
        const s = this.activeGames.get(gameId);
        if (!s) return;
        if (s.phase !== "DICE_ANIMATION") return;
        if (s.players[s.currentPlayerIndex]?.id !== current.id) return;
        await this.applyAction(gameId, current.id, { type: "CONFIRM_DICE_ANIMATION" });
      } catch (err) {
        this.logger.error(
          `Bot CONFIRM_DICE_ANIMATION failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }, ms);
    this.botDiceAnimTimers.set(gameId, timer);
  }

  /**
   * Бот автоматически подтверждает анимацию движения фишки через
   * moveStepMs × N + buffer.
   */
  private scheduleBotMoveAnimDone(
    state: GameState,
    gameId: string,
    current: Player,
    dice: [number, number],
  ) {
    const prev = this.botMoveAnimTimers.get(gameId);
    if (prev) {
      clearTimeout(prev);
      this.botMoveAnimTimers.delete(gameId);
    }
    const stepMs = state.settings.moveStepMs ?? 450;
    const total = dice[0] + dice[1];
    const ms = total * stepMs + 200;
    const timer = setTimeout(async () => {
      this.botMoveAnimTimers.delete(gameId);
      try {
        const s = this.activeGames.get(gameId);
        if (!s) return;
        if (s.phase !== "MOVE_ANIMATION") return;
        if (s.players[s.currentPlayerIndex]?.id !== current.id) return;
        await this.applyAction(gameId, current.id, { type: "CONFIRM_MOVE_ANIMATION" });
      } catch (err) {
        this.logger.error(
          `Bot CONFIRM_MOVE_ANIMATION failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }, ms);
    this.botMoveAnimTimers.set(gameId, timer);
  }

  /**
   * Бот автоматически подтверждает показ карточки через 2.5с.
   */
  private scheduleBotCardDone(state: GameState, gameId: string, current: Player) {
    const prev = this.botCardTimers.get(gameId);
    if (prev) {
      clearTimeout(prev);
      this.botCardTimers.delete(gameId);
    }
    const ms = 2500; // время «прочитать» карточку
    const timer = setTimeout(async () => {
      this.botCardTimers.delete(gameId);
      try {
        const s = this.activeGames.get(gameId);
        if (!s) return;
        if (s.phase !== "CARD_REVEAL") return;
        if (s.players[s.currentPlayerIndex]?.id !== current.id) return;
        await this.applyAction(gameId, current.id, { type: "CONFIRM_CARD" });
      } catch (err) {
        this.logger.error(
          `Bot CONFIRM_CARD failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }, ms);
    this.botCardTimers.set(gameId, timer);
  }

  /**
   * Бот автоматически подтверждает оплату фиксированного налога (TAX_PAYMENT)
   * через 2 секунды.
   */
  private scheduleBotTaxDone(state: GameState, gameId: string, current: Player) {
    const prev = this.botTaxTimers.get(gameId);
    if (prev) {
      clearTimeout(prev);
      this.botTaxTimers.delete(gameId);
    }
    const ms = 2000;
    const timer = setTimeout(async () => {
      this.botTaxTimers.delete(gameId);
      try {
        const s = this.activeGames.get(gameId);
        if (!s) return;
        if (s.phase !== "TAX_PAYMENT") return;
        if (s.players[s.currentPlayerIndex]?.id !== current.id) return;
        await this.applyAction(gameId, current.id, { type: "CONFIRM_TAX" });
      } catch (err) {
        this.logger.error(
          `Bot CONFIRM_TAX failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }, ms);
    this.botTaxTimers.set(gameId, timer);
  }

  /**
   * Бот автоматически подтверждает оплату ренты (фаза PAY_RENT) через 2 секунды.
   */
  private scheduleBotRentDone(state: GameState, gameId: string, current: Player) {
    const prev = this.botRentTimers.get(gameId);
    if (prev) {
      clearTimeout(prev);
      this.botRentTimers.delete(gameId);
    }
    const ms = 2000;
    const timer = setTimeout(async () => {
      this.botRentTimers.delete(gameId);
      try {
        const s = this.activeGames.get(gameId);
        if (!s) return;
        if (s.phase !== "PAY_RENT") return;
        if (s.players[s.currentPlayerIndex]?.id !== current.id) return;
        await this.applyAction(gameId, current.id, { type: "CONFIRM_RENT_PAYMENT" });
      } catch (err) {
        this.logger.error(
          `Bot CONFIRM_RENT_PAYMENT failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }, ms);
    this.botRentTimers.set(gameId, timer);
  }

  /**
   * Бот автоматически подтверждает приземление через 400мс.
   */
  private scheduleBotLandingDone(state: GameState, gameId: string, current: Player) {
    const prev = this.botLandingTimers.get(gameId);
    if (prev) {
      clearTimeout(prev);
      this.botLandingTimers.delete(gameId);
    }
    const ms = 400;
    const timer = setTimeout(async () => {
      this.botLandingTimers.delete(gameId);
      try {
        const s = this.activeGames.get(gameId);
        if (!s) return;
        if (s.phase !== "RESOLVING_LANDING") return;
        if (s.players[s.currentPlayerIndex]?.id !== current.id) return;
        await this.applyAction(gameId, current.id, { type: "CONFIRM_LANDING" });
      } catch (err) {
        this.logger.error(
          `Bot CONFIRM_LANDING failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }, ms);
    this.botLandingTimers.set(gameId, timer);
  }

  /**
   * Бот автоматически подтверждает передачу хода через 500мс.
   */
  private scheduleBotEndTurnDone(state: GameState, gameId: string, current: Player) {
    const prev = this.botEndTurnTimers.get(gameId);
    if (prev) {
      clearTimeout(prev);
      this.botEndTurnTimers.delete(gameId);
    }
    const ms = 500;
    const timer = setTimeout(async () => {
      this.botEndTurnTimers.delete(gameId);
      try {
        const s = this.activeGames.get(gameId);
        if (!s) return;
        if (s.phase !== "END_TURN") return;
        if (s.players[s.currentPlayerIndex]?.id !== current.id) return;
        await this.applyAction(gameId, current.id, { type: "CONFIRM_END_TURN" });
      } catch (err) {
        this.logger.error(
          `Bot CONFIRM_END_TURN failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }, ms);
    this.botEndTurnTimers.set(gameId, timer);
  }

  private botDecisionToAction(d: BotDecision, state: GameState): GameAction | null {
    if (typeof d === "string") {
      switch (d) {
        case "ROLL":
        case "TRY_DOUBLE":
          return { type: "ROLL_DICE" };
        case "BUY":
          return { type: "BUY_PROPERTY" };
        case "END_TURN":
          return { type: "END_TURN" };
        case "PAY_FINE":
          return { type: "PAY_JAIL_FINE" };
        case "USE_CARD":
          return { type: "USE_JAIL_CARD" };
        case "AUCTION_BID": {
          const auction = state.auction;
          const cell = auction ? state.board[auction.cellId] : null;
          const minInc = cell?.price ? Math.max(10, Math.floor(cell.price * 0.05)) : 10;
          const nextBid = (auction?.currentBid ?? 0) + minInc;
          return { type: "AUCTION_BID", amount: nextBid };
        }
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
      default:
        return null;
    }
  }

  // Таймеры: аукцион, торговля, END_TURN (человек)

  private scheduleAuctionTimer(state: GameState, gameId: string, _deadline: string) {
    const prev = this.auctionTimers.get(gameId);
    if (prev) {
      clearTimeout(prev);
      this.auctionTimers.delete(gameId);
    }
    if (state.phase !== "AUCTION_BIDDING") return;
    if (!state.auction) return;

    const currentBidder = state.players[state.auction.currentBidderIndex];
    if (!currentBidder) return;

    const ms = state.settings.auctionBidTimeoutMs ?? 15000;
    const timer = setTimeout(async () => {
      this.auctionTimers.delete(gameId);
      try {
        if (state.phase !== "AUCTION_BIDDING" || !state.auction) return;
        const decision = this.bot.decide(currentBidder, state);
        const action = this.botDecisionToAction(decision ?? "AUCTION_PASS", state);
        if (action) {
          await this.applyAction(gameId, currentBidder.id, action);
        }
      } catch (err) {
        this.logger.error(
          `Auction timer failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }, ms);
    this.auctionTimers.set(gameId, timer);
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

    const ms = state.settings.tradingResponseTimeoutMs ?? 30000;
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
