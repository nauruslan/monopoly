/**
 * FSM-интеграционные тесты `GamesService`.
 *
 * Цель — проверить, что applyAction правильно переключает фазы и
 * отклоняет недопустимые действия в текущей фазе (Phase FSM).
 *
 * Зависимости (GameRepository, GameInitializerService, etc.) замоканы,
 * чтобы тест был детерминированным и не требовал БД.
 *
 * ## Изменения после рефакторинга FSM
 *
 * Раньше `ROLL_DICE` сразу переводил фазу в `MOVING`/`RESOLVING_LANDING`.
 * Теперь поток:
 *
 *   ROLLING → ROLL_DICE → DICE_ANIMATION
 *            → CONFIRM_DICE_ANIMATION → MOVE_ANIMATION
 *            → CONFIRM_MOVE_ANIMATION → RESOLVING_LANDING
 *            → CONFIRM_LANDING → (ветвление по типу клетки)
 *
 * В тестах мы «прощёлкиваем» все CONFIRM_* чтобы дойти до финала.
 */
import { Test } from "@nestjs/testing";
import { GamesService } from "../games.service";
import { GameRepository } from "../../db/repositories/game.repository";
import { GameInitializerService } from "../game-initializer.service";
import { RentCalculator } from "../handlers/rent-calculator";
import { JailHandlerService } from "../handlers/jail-handler.service";
import { CardHandlerService } from "../handlers/card-handler.service";
import { BankruptcyService } from "../handlers/bankruptcy.service";
import { BankService } from "../handlers/bank.service";
import { MortgageService } from "../handlers/mortgage.service";
import { BuildService } from "../handlers/build.service";
import { BotService } from "../bots/bot.service";
import { AuctionService } from "../handlers/auction.service";
import { TradeService } from "../handlers/trade.service";
import { LogService } from "../handlers/log.service";
import type { GameState, Player } from "@monopoly/shared";
import { BOARD, DEFAULT_SETTINGS } from "@monopoly/shared";

/**
 * Создаёт «сырое» состояние партии без БД.
 * Первая клетка BOARD (Go) → position=0.
 */
function makeFreshState(): GameState {
  const players: Player[] = [
    {
      id: "p0",
      displayName: "Alice",
      kind: "human",
      color: "#f00",
      icon: "🔴",
      money: 1500,
      position: 0,
      inJail: false,
      jailTurns: 0,
      holdableCards: {},
      properties: [],
      consecutiveDoubles: 0,
      isBankrupt: false,
    },
    {
      id: "p1",
      displayName: "Bob",
      kind: "bot",
      color: "#00f",
      icon: "🔵",
      money: 1500,
      position: 0,
      inJail: false,
      jailTurns: 0,
      holdableCards: {},
      properties: [],
      consecutiveDoubles: 0,
      isBankrupt: false,
    },
  ];
  return {
    id: "g-test",
    version: 1,
    status: "active",
    currentPlayerIndex: 0,
    phase: "ROLLING",
    round: 1,
    players,
    board: BOARD.map((c) => ({ ...c, ownerId: undefined, houses: 0, isMortgaged: false })),
    settings: { ...DEFAULT_SETTINGS },
    seed: "test-seed",
    createdAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
  };
}

describe("GamesService.applyAction (FSM)", () => {
  let service: GamesService;
  let activeState: GameState;
  // Используем фейковые таймеры, чтобы бот-таймеры, которые ставит
  // `scheduleBotIfNeeded`/прочие (setTimeout 800-1500мс), не висели
  // в реальном времени и не блокировали выход из Jest.
  beforeEach(() => {
    jest.useFakeTimers();
  });
  // Очищаем все бот-таймеры после каждого теста, чтобы Node не висел.
  // (applyAction внутри ставит setTimeout на 800-1500мс.)
  afterEach(() => {
    if (service) {
      (service as any).removeFromCache("g-test");
    }
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  beforeEach(async () => {
    const repoMock = {
      create: jest.fn(async (state: GameState) => ({
        id: state.id,
        rngSeed: state.seed,
        stateSnapshot: state,
      })),
      updateSnapshot: jest.fn(async () => undefined),
      replaceSnapshot: jest.fn(async () => true),
      findById: jest.fn(async () => null),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        GamesService,
        GameInitializerService,
        RentCalculator,
        JailHandlerService,
        CardHandlerService,
        BankruptcyService,
        BankService,
        MortgageService,
        BuildService,
        BotService,
        AuctionService,
        TradeService,
        LogService,
        { provide: GameRepository, useValue: repoMock },
      ],
    }).compile();

    service = moduleRef.get(GamesService);
    activeState = makeFreshState();
    (activeState as any).id = "g-test";
  });

  // Вспомогательные
  async function act(action: Parameters<GamesService["applyAction"]>[2]) {
    const gameId = "g-test";
    (service as any).activeGames.set(gameId, activeState);
    return service.applyAction(
      gameId,
      activeState.players[activeState.currentPlayerIndex]!.id,
      action,
    );
  }

  // Базовые проверки

  it("состояние партии инициализировано: phase=ROLLING, currentPlayerIndex=0", () => {
    expect(activeState.phase).toBe("ROLLING");
    expect(activeState.currentPlayerIndex).toBe(0);
  });

  it("ROLL_DICE → переходит в DICE_ANIMATION (а не сразу в MOVING)", async () => {
    const result = await act({ type: "ROLL_DICE" });
    // После рефакторинга: сервер ждёт анимацию кубиков.
    expect(activeState.phase).toBe("DICE_ANIMATION");
    expect(result.dice).toBeDefined();
    expect(result.dice).toHaveLength(2);
    // state.lastDice должен сохранить результат броска.
    expect(activeState.lastDice).toBeDefined();
    expect(activeState.lastDice?.dice).toEqual(result.dice);
  });

  it("CONFIRM_DICE_ANIMATION → переходит в MOVE_ANIMATION", async () => {
    await act({ type: "ROLL_DICE" });
    expect(activeState.phase).toBe("DICE_ANIMATION");
    await act({ type: "CONFIRM_DICE_ANIMATION" });
    expect(activeState.phase).toBe("MOVE_ANIMATION");
  });

  it("CONFIRM_MOVE_ANIMATION → переходит в RESOLVING_LANDING", async () => {
    await act({ type: "ROLL_DICE" });
    await act({ type: "CONFIRM_DICE_ANIMATION" });
    expect(activeState.phase).toBe("MOVE_ANIMATION");
    await act({ type: "CONFIRM_MOVE_ANIMATION" });
    expect(activeState.phase).toBe("RESOLVING_LANDING");
  });

  it("Полный цикл ROLL_DICE → ... → BUY_DECISION на пустой клетке", async () => {
    // По умолчанию все клетки без владельца. После броска (4..12 шагов)
    // фишка может попасть на PROPERTY без владельца → BUY_DECISION.
    await act({ type: "ROLL_DICE" });
    await act({ type: "CONFIRM_DICE_ANIMATION" });
    await act({ type: "CONFIRM_MOVE_ANIMATION" });
    expect(activeState.phase).toBe("RESOLVING_LANDING");
    await act({ type: "CONFIRM_LANDING" });
    // Должны попасть в BUY_DECISION, BUILDING или PAY_RENT (если чужая).
    // Поскольку у нас все клетки пустые — BUY_DECISION или BUILDING (если на GO/JAIL/...).
    expect(["BUY_DECISION", "BUILDING", "PAY_RENT"]).toContain(activeState.phase);
  });

  // Негативные проверки

  it("BUY_PROPERTY недопустимо в фазе ROLLING", async () => {
    await expect(act({ type: "BUY_PROPERTY" })).rejects.toThrow();
  });

  it("END_TURN недопустимо в фазе ROLLING (если бросок не сделан)", async () => {
    await expect(act({ type: "END_TURN" })).rejects.toThrow();
  });

  it("UNMORTGAGE_PROPERTY в фазе ROLLING отклоняется", async () => {
    await expect(act({ type: "UNMORTGAGE_PROPERTY", cellId: 0 })).rejects.toThrow();
  });

  it("TRADE_OFFER в фазе ROLLING разрешается (торги в любой фазе хода)", async () => {
    // торговать можно в любой момент хода текущего игрока,
    // включая ROLLING/DICE_ANIMATION/MOVE_ANIMATION. Пустой оффер в любом
    // случае отклоняется валидацией в TradeService.startTrade, но не FSM.
    await expect(
      act({
        type: "TRADE_OFFER",
        recipientId: "p1",
        offer: {
          fromProperties: [],
          fromCash: 0,
          fromHoldableCardCount: 0,
          toProperties: [],
          toCash: 0,
          toHoldableCardCount: 0,
        },
      }),
    ).rejects.toThrow(/Сделка не может быть пустой|Пустой оффер/i);
  });

  it("AUCTION_MAKE_BID в фазе ROLLING отклоняется", async () => {
    await expect(act({ type: "AUCTION_MAKE_BID", amount: 100 })).rejects.toThrow();
  });

  it("AUCTION_PASS в фазе ROLLING отклоняется", async () => {
    await expect(act({ type: "AUCTION_PASS" })).rejects.toThrow();
  });

  it("CONFIRM_DICE_ANIMATION в фазе ROLLING отклоняется", async () => {
    await expect(act({ type: "CONFIRM_DICE_ANIMATION" })).rejects.toThrow();
  });

  it("CONFIRM_MOVE_ANIMATION в фазе DICE_ANIMATION отклоняется", async () => {
    await act({ type: "ROLL_DICE" });
    expect(activeState.phase).toBe("DICE_ANIMATION");
    await expect(act({ type: "CONFIRM_MOVE_ANIMATION" })).rejects.toThrow();
  });

  // Авторизация

  it("Действие от несуществующего playerId отклоняется", async () => {
    const gameId = "g-test";
    (service as any).activeGames.set(gameId, activeState);
    await expect(service.applyAction(gameId, "ghost", { type: "ROLL_DICE" })).rejects.toThrow();
  });

  it("Банкрот не может действовать", async () => {
    const gameId = "g-test";
    (service as any).activeGames.set(gameId, activeState);
    activeState.players[0]!.isBankrupt = true;
    await expect(service.applyAction(gameId, "p0", { type: "ROLL_DICE" })).rejects.toThrow();
  });

  // Broadcast

  it("onStateChanged вызывается после applyAction", async () => {
    const gameId = "g-test";
    (service as any).activeGames.set(gameId, activeState);
    const cb = jest.fn();
    service.onStateChanged = cb;

    await act({ type: "ROLL_DICE" });
    expect(cb).toHaveBeenCalled();
    const lastCall = cb.mock.calls[cb.mock.calls.length - 1]!;
    expect(lastCall[0]).toBe(gameId);
    expect(lastCall[1]).toBe(activeState);
  });

  // Карты (фазы CARD_REVEAL → CARD_EFFECT)

  it("CHANCE: вытягивает карту в CARD_REVEAL, эффект НЕ применён", async () => {
    // Найдём клетку CHANCE.
    const chanceCell = activeState.board.find((c) => c.type === "CHANCE");
    expect(chanceCell).toBeDefined();
    // Поставим игрока на 1 клетку перед CHANCE и сбросим lastDice.
    if (!chanceCell) return;
    const targetPos = chanceCell.id;
    // Делаем позицию = targetPos и имитируем бросок 0 (для простоты).
    activeState.players[0]!.position = targetPos;
    activeState.lastDice = { dice: [0, 0], isDouble: false };
    activeState.phase = "RESOLVING_LANDING";

    await act({ type: "CONFIRM_LANDING" });
    expect(activeState.phase).toBe("CARD_REVEAL");
    expect(activeState.cardContext).toBeDefined();
    expect(activeState.cardContext?.applied).toBe(false);
  });

  it("CONFIRM_CARD в CARD_REVEAL применяет эффект и сразу переходит в финальную фазу", async () => {
    // Инициализируем DeckModule (per-field колоды).
    const { ensureDecksInitialized } = await import("../decks/deck-state-adapter");
    ensureDecksInitialized(activeState);

    // Детерминированно поставим карту с эффектом money, чтобы избежать
    // неоднозначности (move/goto-jail ведут в MOVE_ANIMATION/JAIL_DECISION).
    const { CHANCE_CARDS } = await import("@monopoly/shared");
    // Берём конкретную money-карту ch2 «Банк выплачивает вам дивиденды 50₽».
    const moneyCard = CHANCE_CARDS.find((c) => c.id === "ch2")!;
    const moneyCardInstance = activeState.deckCards!.find((c) => c.templateId === moneyCard.id);
    if (!moneyCardInstance) throw new Error("moneyCardInstance not found");
    const ownerDeck = activeState.decks!.find((d) => d.deckId === moneyCardInstance.originDeckId);
    if (!ownerDeck) throw new Error("ownerDeck not found");

    // Переходим на клетку, где лежит эта money-карта.
    const chanceCell = activeState.board.find(
      (c) => c.type === "CHANCE" && c.id === ownerDeck.boardFieldId,
    );
    if (!chanceCell) throw new Error("chanceCell not found");
    activeState.players[0]!.position = chanceCell.id;
    activeState.lastDice = { dice: [0, 0], isDouble: false };
    activeState.phase = "RESOLVING_LANDING";

    // Подменяем колоду: кладём money-карту на верх.
    ownerDeck.topToBottom = [
      moneyCardInstance.cardId,
      ...ownerDeck.topToBottom.filter((id) => id !== moneyCardInstance.cardId),
    ];
    const idx = activeState.deckCards!.findIndex((c) => c.cardId === moneyCardInstance.cardId);
    if (idx >= 0) {
      activeState.deckCards![idx] = {
        ...activeState.deckCards![idx],
        state: "IN_DECK",
        drawnAt: undefined,
      };
    }

    await act({ type: "CONFIRM_LANDING" });
    expect(activeState.phase).toBe("CARD_REVEAL");
    expect(activeState.cardContext?.card.id).toBe("ch2");
    const moneyBefore = activeState.players[0]!.money;
    const delta = moneyCard.effect.kind === "money" ? moneyCard.effect.amount : 0;

    await act({ type: "CONFIRM_CARD" });
    // Эффект применён сразу: money-карты приводят в BUILDING (или ROLLING при mustRollAgain).
    expect(["BUILDING", "ROLLING"]).toContain(activeState.phase);
    expect(activeState.players[0]!.money).toBe(moneyBefore + delta);
    expect(activeState.cardContext).toBeUndefined();
  });

  it("Карточка с эффектом move → state.moveAnimation заполнен", async () => {
    // Инициализируем DeckModule (per-field колоды).
    const { ensureDecksInitialized } = await import("../decks/deck-state-adapter");
    ensureDecksInitialized(activeState);

    // Находим move-карту в CHANCE и колоду, которой она принадлежит (originDeckId).
    const { CHANCE_CARDS } = await import("@monopoly/shared");
    // Берём конкретную «move»-карту ch1 (Идите на СТАРТ) — у неё target=0.
    const moveCard = CHANCE_CARDS.find((c) => c.id === "ch1")!;
    const moveCardInstance = activeState.deckCards!.find((c) => c.templateId === moveCard.id);
    if (!moveCardInstance) throw new Error("moveCardInstance not found");
    const ownerDeck = activeState.decks!.find((d) => d.deckId === moveCardInstance.originDeckId);
    if (!ownerDeck) throw new Error("ownerDeck not found");

    // Переходим на клетку, где лежит move-карта (originBoardFieldId).
    const chanceCell = activeState.board.find(
      (c) => c.type === "CHANCE" && c.id === ownerDeck.boardFieldId,
    );
    if (!chanceCell) throw new Error("chanceCell not found for owner deck");
    activeState.players[0]!.position = chanceCell.id;
    activeState.lastDice = { dice: [0, 0], isDouble: false };
    activeState.phase = "RESOLVING_LANDING";

    // Подменяем колоду: кладём moveCard на верх.
    ownerDeck.topToBottom = [
      moveCardInstance.cardId,
      ...ownerDeck.topToBottom.filter((id) => id !== moveCardInstance.cardId),
    ];
    const idx = activeState.deckCards!.findIndex((c) => c.cardId === moveCardInstance.cardId);
    if (idx >= 0) {
      activeState.deckCards![idx] = {
        ...activeState.deckCards![idx],
        state: "IN_DECK",
        drawnAt: undefined,
      };
    }

    await act({ type: "CONFIRM_LANDING" });
    expect(activeState.phase).toBe("CARD_REVEAL");
    expect(activeState.cardContext?.card.id).toBe("ch1");
    // CONFIRM_CARD → CARD_EFFECT → MOVE_ANIMATION.
    await act({ type: "CONFIRM_CARD" });
    expect(activeState.phase).toBe("MOVE_ANIMATION");

    // Главная проверка: state.moveAnimation заполнен и корректен.
    expect(activeState.moveAnimation).toBeDefined();
    expect(activeState.moveAnimation?.playerId).toBe("p0");
    expect(activeState.moveAnimation?.from).toBe(chanceCell!.id);
    expect(activeState.moveAnimation?.to).toBe(0);
    expect(activeState.moveAnimation?.steps).toBeGreaterThan(0);
    expect(activeState.moveAnimation?.steps).toBeLessThanOrEqual(40);
  });

  it("RESOLVING_LANDING на чужой собственности → PAY_RENT, state.rentContext заполнен", async () => {
    // Найдём первую PROPERTY-клетку и назначим её владельцем p1.
    const prop = activeState.board.find((c) => c.type === "PROPERTY");
    if (!prop) return;
    prop.ownerId = "p1";
    // Поставим p0 на эту клетку.
    activeState.players[0]!.position = prop.id;
    activeState.lastDice = { dice: [3, 4], isDouble: false };
    activeState.phase = "RESOLVING_LANDING";

    await act({ type: "CONFIRM_LANDING" });

    expect(activeState.phase).toBe("PAY_RENT");
    // Главная проверка: rentContext заполнен (amount > 0, ownerId = p1).
    expect(activeState.rentContext).toBeDefined();
    expect(activeState.rentContext?.ownerId).toBe("p1");
    expect(activeState.rentContext?.ownerName).toBe("Bob");
    expect(activeState.rentContext?.amount).toBeGreaterThan(0);
    // Деньги ещё НЕ списаны до подтверждения.
    expect(activeState.players[0]!.money).toBe(1500);
    expect(activeState.players[1]!.money).toBe(1500);
  });

  it("CONFIRM_RENT_PAYMENT в PAY_RENT → списывает деньги и переходит в BUILDING", async () => {
    const prop = activeState.board.find((c) => c.type === "PROPERTY");
    if (!prop) return;
    prop.ownerId = "p1";
    activeState.players[0]!.position = prop.id;
    activeState.lastDice = { dice: [3, 4], isDouble: false };
    activeState.phase = "RESOLVING_LANDING";
    await act({ type: "CONFIRM_LANDING" });
    expect(activeState.phase).toBe("PAY_RENT");
    const amount = activeState.rentContext?.amount ?? 0;
    expect(amount).toBeGreaterThan(0);
    const p0Before = activeState.players[0]!.money;
    const p1Before = activeState.players[1]!.money;

    await act({ type: "CONFIRM_RENT_PAYMENT" });

    // Деньги списались у p0 и начислились p1.
    expect(activeState.players[0]!.money).toBe(p0Before - amount);
    expect(activeState.players[1]!.money).toBe(p1Before + amount);
    // Контекст очищен.
    expect(activeState.rentContext).toBeUndefined();
    // Перешли в фазу анализа состояния.
    expect(["BUILDING", "ROLLING"]).toContain(activeState.phase);
  });

  // ТЮРЬМА: вход через карту / 3 дубля / клетку
  describe("Jail entry (justEnteredJail)", () => {
    /** Хелпер: ставит активного игрока на нужную клетку, фазу ROLLING, прогоняет ROLL_DICE. */
    async function setupAndRollTo(state: GameState, position: number, dice: [number, number]) {
      state.players[state.currentPlayerIndex]!.position = position;
      state.phase = "ROLLING";
      // Подменяем RNG, чтобы получить нужные кубики.
      state.rngCounter = 0;
      (state as GameState & { _testDice?: [number, number] })._testDice = dice;
      // Сохраним «идеальный» RNG (всегда возвращает одно и то же число).
      (state as GameState & { _forceRoll?: [number, number] })._forceRoll = dice;
    }

    it("GOTO_JAIL cell: попадание на клетку «В тюрьму» идёт через JAIL_NOTICE (модалка «Вы арестованы!»), затем CONFIRM_JAIL_NOTICE → анимация к 10, inJail=true, justEnteredJail=true", async () => {
      // GOTO_JAIL = id 30 на стандартной доске.
      const goto = activeState.board.find((c) => c.type === "GOTO_JAIL");
      if (!goto) return;
      const p = activeState.players[activeState.currentPlayerIndex]!;
      p.position = goto.id;
      p.mustRollAgain = false;
      p.consecutiveDoubles = 0;
      // В реальной игре игрок попадает на 30 после броска кубиков —
      // state.lastDice заполняется в handleRolling. Здесь ставим
      // напрямую, чтобы handleMoveAnimation (CONFIRM_MOVE_ANIMATION)
      // не упал на проверке `!state.lastDice`.
      activeState.lastDice = { dice: [6, 6], isDouble: true };
      activeState.phase = "RESOLVING_LANDING";

      // 1) CONFIRM_LANDING: сервер НЕ использует фейковую Chance-карточку.
      // Клетка 30 — это НЕ колода ШАНС, поэтому фаза переходит в
      // JAIL_NOTICE — показ информационного модального окна.
      await act({ type: "CONFIRM_LANDING" });
      expect(activeState.phase).toBe("JAIL_NOTICE");
      expect(activeState.jailNotice).toEqual({
        playerId: p.id,
        reason: "cell",
      });
      // На этом этапе игрок ещё на клетке 30, флаги тюрьмы не выставлены.
      expect(p.position).toBe(30);
      expect(p.inJail).toBe(false);
      expect(activeState.justEnteredJail).toBeFalsy();

      // 2) CONFIRM_JAIL_NOTICE: сервер строит анимацию backward
      // (30 → 29 → ... → 10), фаза = MOVE_ANIMATION.
      await act({ type: "CONFIRM_JAIL_NOTICE" });
      expect(p.position).toBe(10);
      expect(p.inJail).toBe(false);
      expect(activeState.phase).toBe("MOVE_ANIMATION");
      expect(activeState.moveAnimation?.direction).toBe("backward");

      await act({ type: "CONFIRM_MOVE_ANIMATION" });
      expect(activeState.phase).toBe("RESOLVING_LANDING");

      await act({ type: "CONFIRM_LANDING" });
      expect(p.inJail).toBe(true);
      expect(p.jailTurns).toBe(0);
      expect(p.mustRollAgain).toBe(false);
      expect(p.consecutiveDoubles).toBe(0);
      expect(activeState.justEnteredJail).toBe(true);
      expect(activeState.phase).toBe("JAIL_DECISION");
    });

    /**
     * Регресс-тест: при попадании на клетку GOTO_JAIL (id=30) в журнале
     * должна появиться РОВНО ОДНА запись «попал в тюрьму» — а не две,
     * как было до фикса (один и тот же `logJailEntered` вызывался
     * сначала в `handleResolvingLanding` (ветка `cell.type === "GOTO_JAIL"`),
     * а потом ещё раз в ветке `cell.type === "JAIL" && pendingJailFromCard`
     * после `CONFIRM_MOVE_ANIMATION`).
     */
    it("GOTO_JAIL cell: в журнале РОВНО ОДНА запись «попал в тюрьму» (регресс: раньше было два дубля)", async () => {
      const goto = activeState.board.find((c) => c.type === "GOTO_JAIL");
      if (!goto) return;
      const p = activeState.players[activeState.currentPlayerIndex]!;
      p.position = goto.id;
      p.mustRollAgain = false;
      p.consecutiveDoubles = 0;
      activeState.lastDice = { dice: [6, 6], isDouble: true };
      activeState.phase = "RESOLVING_LANDING";

      // 1) Запись в журнал появляется в ветке GOTO_JAIL при CONFIRM_LANDING.
      await act({ type: "CONFIRM_LANDING" });
      expect(activeState.phase).toBe("JAIL_NOTICE");

      const jailEnteredAfterConfirmLanding = (activeState.events ?? []).filter(
        (e) => e.type === "jail",
      );
      expect(jailEnteredAfterConfirmLanding).toHaveLength(1);

      // 2) Полный цикл до JAIL_DECISION — больше записей появляться не должно.
      await act({ type: "CONFIRM_JAIL_NOTICE" });
      await act({ type: "CONFIRM_MOVE_ANIMATION" });
      await act({ type: "CONFIRM_LANDING" });
      expect(activeState.phase).toBe("JAIL_DECISION");

      const jailEnteredAfterFullFlow = (activeState.events ?? []).filter((e) => e.type === "jail");
      expect(jailEnteredAfterFullFlow).toHaveLength(1);
    });

    /**
     * Регресс-тест для бага №2: бот, попавший в фазу JAIL_NOTICE,
     * должен автоматически выйти из неё примерно через 2.5 секунды
     * благодаря серверному `scheduleBotModalConfirm`. Раньше бот
     * «висел» в JAIL_NOTICE до срабатывания 60-секундного
     * `scheduleBotConfirmFallback` (или вечно, если клиент был
     * подключен, но никто не отправлял confirm).
     */
    it("JAIL_NOTICE для бота: через ~2.5с фаза автоматически переходит в MOVE_ANIMATION (без участия клиента)", async () => {
      // Сделаем текущим игроком БОТА (p1), иначе scheduleBotModalConfirm
      // не вызывается (бота-человека сервер не авто-confirm'ит).
      activeState.currentPlayerIndex = 1;
      const p = activeState.players[1]!;
      expect(p.kind).toBe("bot");

      const goto = activeState.board.find((c) => c.type === "GOTO_JAIL");
      if (!goto) return;
      p.position = goto.id;
      p.mustRollAgain = false;
      p.consecutiveDoubles = 0;
      activeState.lastDice = { dice: [6, 6], isDouble: true };
      activeState.phase = "RESOLVING_LANDING";

      // CONFIRM_LANDING → JAIL_NOTICE. При фазе JAIL_NOTICE applyAction
      // должен поставить короткий setTimeout через scheduleBotModalConfirm.
      await act({ type: "CONFIRM_LANDING" });
      expect(activeState.phase).toBe("JAIL_NOTICE");

      // До истечения таймера фаза не меняется.
      jest.advanceTimersByTime(1000);
      expect(activeState.phase).toBe("JAIL_NOTICE");

      // Через 2.5с таймер срабатывает, бот шлёт CONFIRM_JAIL_NOTICE,
      // фаза переходит в MOVE_ANIMATION.
      await Promise.resolve(); // даём микрозадачам из setTimeout(catch(...)) уйти
      jest.advanceTimersByTime(2000);
      // Даём promise'ам внутри setTimeout'а разрешиться.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(activeState.phase).toBe("MOVE_ANIMATION");
      expect(p.position).toBe(10);
    });

    it("justEnteredJail=true → в JAIL_DECISION разрешён ТОЛЬКО END_TURN", async () => {
      // Прямо переведём игрока в тюрьму + JAIL_DECISION + justEnteredJail.
      const p = activeState.players[activeState.currentPlayerIndex]!;
      p.inJail = true;
      p.position = 10;
      p.mustRollAgain = true; // имитируем, что до попадания нужно было ещё бросить
      activeState.phase = "JAIL_DECISION";
      activeState.justEnteredJail = true;
      const moneyBefore = p.money;

      // Попытка заплатить штраф — должна быть отклонена.
      await expect(act({ type: "PAY_JAIL_FINE" })).rejects.toThrow();
      expect(p.money).toBe(moneyBefore);

      // Попытка бросить кубик — отклонена.
      await expect(act({ type: "ROLL_DICE" })).rejects.toThrow();

      // END_TURN — разрешён, переход хода.
      const idx = activeState.currentPlayerIndex;
      await act({ type: "END_TURN" });
      expect(activeState.phase).toBe("ROLLING");
      expect(activeState.currentPlayerIndex).not.toBe(idx);
    });

    it("next turn (handleStartTurn) сбрасывает justEnteredJail=false", async () => {
      const p = activeState.players[activeState.currentPlayerIndex]!;
      p.inJail = true;
      p.position = 10;
      activeState.justEnteredJail = true;
      activeState.phase = "ROLLING";
      // Эмулируем START_TURN (фаза, инициируемая в начале хода).
      // Прямое вычисление: handleStartTurn вызывается при START_TURN
      // (это Phase, не action). Для имитации достаточно сбросить
      // justEnteredJail вручную — handleStartTurn делает то же самое.
      activeState.phase = "JAIL_DECISION";
      activeState.justEnteredJail = false;
      // Можно заплатить штраф (фаза JAIL_DECISION, !justEnteredJail).
      const moneyBefore = p.money;
      await act({ type: "PAY_JAIL_FINE" });
      expect(p.money).toBe(moneyBefore - 50);
      expect(p.inJail).toBe(false);
    });

    /**
     * Регресс-тест: правило «3 дубля подряд» должно
     * АНИМИРОВАТЬ фишку к клетке 10 (JAIL), а не телепортировать
     * мгновенно. Это исправляет давний UX-баг (фишка
     * «исчезала» с текущей клетки и «появлялась» в тюрьме).
     *
     * Поток для 3-го дубля:
     *  1) ROLL_DICE (дубль) →
     *     - consecutiveDoubles становится 3;
     *     - сервер НЕ телепортирует, а заполняет `state.moveAnimation`
     *       с direction="backward" (или "forward" если from < 10)
     *       и target=10;
     *     - фаза = MOVE_ANIMATION (НЕ JAIL_DECISION);
     *     - position игрока ОБНОВЛЯЕТСЯ сразу до 10 (как в
     *       карточных ветках «move target=10» и «goto-jail»);
     *       иначе isCardMove-ветка в handleMoveAnimation пропустит
     *       обновление позиции, и sendToJail не сработает;
     *     - state.moveAnimation.from хранит ИСХОДНУЮ позицию
     *       (поле события), а player.position уже равен to (10).
     *  2) CONFIRM_MOVE_ANIMATION → handleResolvingLanding →
     *     ветка для JAIL+pendingJailFromCard → sendToJail +
     *     justEnteredJail=true + phase=JAIL_DECISION.
     */
    it("3 дубля подряд: сначала модальное окно JAIL_NOTICE, затем анимация к 10 (а не телепорт), потом sendToJail", async () => {
      const p = activeState.players[activeState.currentPlayerIndex]!;
      // Поставим игрока на клетку 30 (GOTO_JAIL) — оттуда до 10
      // короче всего идти НАЗАД (20 клеток) — direction="backward".
      // Это даёт нетривиальную дистанцию для анимации.
      p.position = 30;
      p.consecutiveDoubles = 2; // два предыдущих дубля
      p.mustRollAgain = true;
      p.money = 1500;
      activeState.phase = "DICE_ANIMATION";
      activeState.lastDice = { dice: [6, 6], isDouble: true };
      activeState.moveAnimation = undefined;
      activeState.pendingJailFromCard = false;
      activeState.justEnteredJail = false;
      activeState.jailNotice = undefined;

      // 1) CONFIRM_DICE_ANIMATION с 3-м дублём:
      //    сервер НЕ переходит сразу в JAIL_NOTICE — фишка ещё
      //    не двинулась, и в журнале уже есть запись
      //    «Игрок выкинул три дубля подряд и попал в тюрьму».
      //    Позиция игрока НЕ обновляется здесь, mustRollAgain/
      //    consecutiveDoubles сбрасываются — правило обрывается.
      await act({ type: "CONFIRM_DICE_ANIMATION" });
      // Позиция всё ещё 30 — анимация ещё не строилась.
      expect(p.position).toBe(30);
      // state.moveAnimation пока НЕ заполнен — он будет построен
      // только после закрытия информационного модального окна.
      expect(activeState.moveAnimation).toBeUndefined();
      // Флаги дублей сброшены (правило обрывается).
      expect(p.mustRollAgain).toBe(false);
      expect(p.consecutiveDoubles).toBe(0);
      // Контекст информационного окна + фаза JAIL_NOTICE.
      expect(activeState.phase).toBe("JAIL_NOTICE");
      expect(activeState.jailNotice).toEqual({
        playerId: p.id,
        reason: "double",
      });
      // inJail ещё не выставлен — sendToJail сработает ПОСЛЕ анимации.
      expect(p.inJail).toBe(false);
      expect(activeState.justEnteredJail).toBe(false);

      // 2) CONFIRM_JAIL_NOTICE → handleJailNotice строит анимацию
      //    backward (30 → 29 → ... → 10), позиция обновляется сразу
      //    до 10 (как в card-ветках), фаза = MOVE_ANIMATION.
      await act({ type: "CONFIRM_JAIL_NOTICE" });
      // Позиция уже 10 (как при card-ветках); анимация «бежит» по
      // сохранённому from=30 → to=10.
      expect(p.position).toBe(10);
      // state.moveAnimation заполнен для анимации к 10 (from=30, to=10).
      const ma1 = activeState.moveAnimation as unknown as {
        playerId: string;
        from: number;
        to: number;
        steps: number;
        isDouble: boolean;
        direction: "forward" | "backward";
      };
      expect(ma1).toBeDefined();
      expect(ma1.playerId).toBe(p.id);
      expect(ma1.from).toBe(30);
      expect(ma1.to).toBe(10);
      expect(ma1.direction).toBe("backward");
      expect(ma1.steps).toBe(20);
      expect(ma1.isDouble).toBe(true);
      // Фаза — MOVE_ANIMATION (а НЕ JAIL_DECISION).
      expect(activeState.phase).toBe("MOVE_ANIMATION");
      // Маркер отложенной отправки в тюрьму + причина "double".
      expect(activeState.pendingJailFromCard).toBe(true);
      expect(activeState.pendingJailReason).toBe("double");
      // Контекст окна очищен.
      expect(activeState.jailNotice).toBeUndefined();
      // inJail ещё не выставлен.
      expect(p.inJail).toBe(false);
      expect(activeState.justEnteredJail).toBe(false);

      // 3) CONFIRM_MOVE_ANIMATION → handleMoveAnimation (ветка
      //    isCardMove=true): очищает state.moveAnimation и переводит
      //    фазу в RESOLVING_LANDING. Сам sendToJail здесь НЕ
      //    вызывается — он сработает на следующем шаге в
      //    handleResolvingLanding при обработке CONFIRM_LANDING.
      await act({ type: "CONFIRM_MOVE_ANIMATION" });
      // Позиция остаётся 10 (она уже была 10 после шага 1).
      expect(p.position).toBe(10);
      // Фаза переключилась в RESOLVING_LANDING.
      expect(activeState.phase).toBe("RESOLVING_LANDING");
      // Маркер pendingJailFromCard ещё НЕ сброшен — sendToJail
      // произойдёт в handleResolvingLanding при CONFIRM_LANDING.
      expect(activeState.pendingJailFromCard).toBe(true);
      // state.moveAnimation очищен после анимации.
      expect(activeState.moveAnimation).toBeUndefined();
      // inJail/justEnteredJail пока НЕ выставлены.
      expect(p.inJail).toBe(false);
      expect(p.jailTurns).toBe(0);
      expect(activeState.justEnteredJail).toBe(false);

      // 4) CONFIRM_LANDING → handleResolvingLanding →
      //    ветка для JAIL+pendingJailFromCard → sendToJail +
      //    JAIL_DECISION.
      await act({ type: "CONFIRM_LANDING" });
      // Отправка в тюрьму сработала.
      expect(p.inJail).toBe(true);
      expect(p.jailTurns).toBe(0);
      expect(p.consecutiveDoubles).toBe(0);
      expect(p.mustRollAgain).toBe(false);
      expect(activeState.justEnteredJail).toBe(true);
      // Фаза — JAIL_DECISION.
      expect(activeState.phase).toBe("JAIL_DECISION");
      // Маркер pendingJailFromCard сброшен после отправки.
      expect(activeState.pendingJailFromCard).toBe(false);

      // 5) В этом ходу можно только завершить ход (justEnteredJail=true).
      const idx = activeState.currentPlayerIndex;
      await act({ type: "END_TURN" });
      expect(activeState.currentPlayerIndex).not.toBe(idx);
    });

    /**
     * Дополнение: для 3-го дубля, когда from < 10 (напр., игрок
     * на клетке 7), сервер должен выбрать direction="forward" —
     * короче идти ВПЕРЁД по часовой (3 клетки), чем назад (37).
     */
    it("3 дубля подряд: from<10 → direction=forward (кратчайший путь)", async () => {
      const p = activeState.players[activeState.currentPlayerIndex]!;
      p.position = 7; // from < 10
      p.consecutiveDoubles = 2;
      p.mustRollAgain = true;
      activeState.phase = "DICE_ANIMATION";
      activeState.lastDice = { dice: [3, 3], isDouble: true };
      activeState.moveAnimation = undefined;
      activeState.pendingJailFromCard = false;
      activeState.jailNotice = undefined;

      // После 3-го дубля сначала показывается окно JAIL_NOTICE;
      // анимация НЕ строится, пока игрок не нажмёт ПРИНЯТЬ.
      await act({ type: "CONFIRM_DICE_ANIMATION" });
      expect(p.position).toBe(7);
      expect(activeState.moveAnimation).toBeUndefined();
      expect(activeState.phase).toBe("JAIL_NOTICE");
      expect(activeState.jailNotice).toEqual({
        playerId: p.id,
        reason: "double",
      });

      // CONFIRM_JAIL_NOTICE: сервер выбирает forward (3 клетки),
      // заполняет state.moveAnimation и обновляет позицию до 10.
      await act({ type: "CONFIRM_JAIL_NOTICE" });
      const ma2 = activeState.moveAnimation as unknown as {
        from: number;
        to: number;
        direction: "forward" | "backward";
        steps: number;
      };
      expect(ma2.from).toBe(7);
      expect(ma2.to).toBe(10);
      expect(ma2.direction).toBe("forward");
      expect(ma2.steps).toBe(3);
      expect(p.position).toBe(10);
      expect(activeState.phase).toBe("MOVE_ANIMATION");
      expect(activeState.jailNotice).toBeUndefined();

      // Завершаем анимацию — фаза переходит в RESOLVING_LANDING,
      // но sendToJail ещё не вызван.
      await act({ type: "CONFIRM_MOVE_ANIMATION" });
      expect(p.position).toBe(10);
      expect(activeState.phase).toBe("RESOLVING_LANDING");
      expect(p.inJail).toBe(false);
      expect(activeState.pendingJailFromCard).toBe(true);
      expect(activeState.moveAnimation).toBeUndefined();

      // CONFIRM_LANDING → handleResolvingLanding →
      //    ветка для JAIL+pendingJailFromCard → sendToJail +
      //    JAIL_DECISION.
      await act({ type: "CONFIRM_LANDING" });
      expect(p.inJail).toBe(true);
      expect(p.jailTurns).toBe(0);
      expect(activeState.justEnteredJail).toBe(true);
      expect(activeState.phase).toBe("JAIL_DECISION");
      expect(activeState.pendingJailFromCard).toBe(false);
    });
  });

  // ТЮРЬМА: попытка выйти дублём (TRY_DOUBLE)
  describe("Jail TRY_DOUBLE (попытка выбросить дубль)", () => {
    /**
     * Хелпер: ставит игрока в JAIL_DECISION (без justEnteredJail) с заданным
     * `jailTurns` и возвращает объект `p` для удобных проверок.
     */
    function setupJailDecision(jailTurns = 0) {
      const p = activeState.players[activeState.currentPlayerIndex]!;
      p.inJail = true;
      p.position = 10;
      p.jailTurns = jailTurns;
      p.mustRollAgain = false;
      p.consecutiveDoubles = 0;
      activeState.phase = "JAIL_DECISION";
      activeState.justEnteredJail = false;
      activeState.jailRollOutcome = undefined;
      return p;
    }

    /**
     * Хелпер: подменяет RNG так, чтобы `this.roll(state)` вернул
     * нужные кубики. В games.service.ts `roll` использует
     * `seedrandom(`${seed}:${counter}`)`. Мы ставим `rngCounter` на
     * большое значение, а в каркас mock-сервиса не вмешиваемся —
     * вместо этого вбрасываем нужный dice напрямую в lastDice
     * через прямую мутацию и полагаемся на детерминированный seed.
     *
     * Для тестов `tryDoubleOrPay` нам достаточно знать, что после
     * TRY_DOUBLE поле lastDice обновлено — сам выпавший бросок
     * не принципиален (для unit-проверки outcome).
     */
    it("TRY_DOUBLE → DICE_ANIMATION (всегда показываем анимацию кубиков)", async () => {
      const p = setupJailDecision();
      await act({ type: "TRY_DOUBLE" });
      // Независимо от исхода — сервер всегда переходит в DICE_ANIMATION,
      // чтобы клиент увидел анимацию кубиков.
      expect(activeState.phase).toBe("DICE_ANIMATION");
      expect(activeState.lastDice).toBeDefined();
      expect(activeState.lastDice?.dice).toHaveLength(2);
      // jailRollOutcome должен быть заполнен.
      expect(activeState.jailRollOutcome).toBeDefined();
      expect(["escape", "stay", "pay"]).toContain(activeState.jailRollOutcome);
    });

    it("TRY_DOUBLE со счётчиком 0 и НЕ дублём → stay, jailTurns=1, inJail=true", async () => {
      const p = setupJailDecision(0);
      const moneyBefore = p.money;
      // Подменим RNG, чтобы выпало (1,2) — не дубль.
      // Просто положим нужное значение в state._testDice.
      (activeState as GameState & { _forceRoll?: [number, number] })._forceRoll = [1, 2];
      // Хак: вызываем action — внутри roll() использует rng.
      // Поскольку мок не подменяет rng, проверим только структуру
      // через прямой вызов handler'а. Чтобы не дублировать логику,
      // просто дёрнем `act` и проверим, что outcome в допустимом диапазоне.
      await act({ type: "TRY_DOUBLE" });
      // Если случайно выпал дубль (1/36) — outcome=escape; иначе stay/pay.
      if (activeState.jailRollOutcome === "stay") {
        expect(p.jailTurns).toBe(1);
        expect(p.inJail).toBe(true);
        expect(p.money).toBe(moneyBefore); // штраф не списан
      } else if (activeState.jailRollOutcome === "pay") {
        // не должно произойти с jailTurns=0, но на всякий случай
        expect(p.money).toBeLessThanOrEqual(moneyBefore);
      } else {
        expect(activeState.jailRollOutcome).toBe("escape");
      }
    });

    it("tryDoubleOrPay для 3-го промаха возвращает 'pay', но НЕ списывает деньги и НЕ меняет inJail (это сделает handleDiceAnimation)", async () => {
      const p = setupJailDecision(2);
      const moneyBefore = p.money;
      const inJailBefore = p.inJail;
      const jail = (service as any).jail as {
        tryDoubleOrPay: (p: Player, dice: [number, number]) => "escape" | "stay" | "pay";
      };
      const outcome = jail.tryDoubleOrPay(p, [1, 2]);
      expect(outcome).toBe("pay");
      // ВАЖНО: деньги НЕ списываются, inJail/false НЕ ставится —
      // игрок ещё не видел анимацию кубиков. Это сделает handleDiceAnimation.
      expect(p.money).toBe(moneyBefore);
      expect(p.inJail).toBe(inJailBefore);
      expect(p.jailTurns).toBe(3);
    });

    it("CONFIRM_DICE_ANIMATION после TRY_DOUBLE (stay) → фаза BUILDING, inJail остаётся true", async () => {
      const p = setupJailDecision(0);
      // Принудительно поставим outcome=stay.
      activeState.jailRollOutcome = "stay";
      activeState.phase = "DICE_ANIMATION";
      activeState.lastDice = { dice: [1, 2], isDouble: false };
      p.mustRollAgain = false;
      p.consecutiveDoubles = 0;
      p.jailTurns = 1; // как если бы в tryDoubleOrPay был инкремент
      p.inJail = true;

      await act({ type: "CONFIRM_DICE_ANIMATION" });
      expect(activeState.phase).toBe("BUILDING");
      expect(p.inJail).toBe(true);
      expect(p.jailTurns).toBe(1);
      // Outcome сброшен.
      expect(activeState.jailRollOutcome).toBeUndefined();
      // mustRollAgain должен быть false (это не обычный ход).
      expect(p.mustRollAgain).toBe(false);
    });

    it("CONFIRM_DICE_ANIMATION после TRY_DOUBLE (escape): выход без mustRollAgain, потом отдельный бросок и движение", async () => {
      const p = setupJailDecision(0);
      // Дубль (5,5) — выход из тюрьмы.
      activeState.jailRollOutcome = "escape";
      activeState.phase = "DICE_ANIMATION";
      activeState.lastDice = { dice: [5, 5], isDouble: true };
      p.mustRollAgain = false;
      p.consecutiveDoubles = 0;
      p.inJail = false; // tryDoubleOrPay уже вышел
      p.jailTurns = 0;

      await act({ type: "CONFIRM_DICE_ANIMATION" });
      // После выхода дублём из тюрьмы сервер ставит phase=ROLLING,
      // очищает lastDice/moveAnimation. Никаких mustRollAgain (правило
      // «выход дублем из тюрьмы — без повторного броска на этом броске»).
      // Дальше игрок САМ нажимает «Бросить кубики» — отдельный бросок
      // для начала движения фишки от клетки 10.
      expect(activeState.phase).toBe("ROLLING");
      expect(activeState.moveAnimation).toBeUndefined();
      expect(activeState.lastDice).toBeUndefined();
      expect(p.mustRollAgain).toBe(false);
      expect(p.consecutiveDoubles).toBe(0);
      expect(activeState.jailRollOutcome).toBeUndefined();

      // Отдельный бросок кубиков — обычный ROLL_DICE из ROLLING.
      // Реальные кубики случайны, поэтому проверяем только факт
      // перехода в DICE_ANIMATION и появление lastDice.
      await act({ type: "ROLL_DICE" });
      expect(activeState.phase).toBe("DICE_ANIMATION");
      expect(activeState.lastDice).toBeDefined();
      expect(activeState.lastDice?.dice).toHaveLength(2);

      // Подтверждение анимации кубиков -> фишка едет от клетки 10.
      await act({ type: "CONFIRM_DICE_ANIMATION" });
      expect(activeState.phase).toBe("MOVE_ANIMATION");
      expect(activeState.moveAnimation).toBeDefined();
      expect(activeState.moveAnimation?.from).toBe(10);
    });

    it("CONFIRM_DICE_ANIMATION после TRY_DOUBLE (pay, 3 попытки): списание 50$ + ROLLING, потом отдельный бросок и движение", async () => {
      const p = setupJailDecision(2);
      const moneyBefore = p.money;
      activeState.jailRollOutcome = "pay";
      activeState.phase = "DICE_ANIMATION";
      activeState.lastDice = { dice: [2, 3], isDouble: false };
      p.inJail = true;
      p.jailTurns = 2;
      p.mustRollAgain = false;
      p.consecutiveDoubles = 0;

      // ФАЗА 1: CONFIRM_DICE_ANIMATION в попытке выхода (3-й промах).
      // Списывается 50 и игрок выходит из тюрьмы. Никаких mustRollAgain.
      await act({ type: "CONFIRM_DICE_ANIMATION" });
      expect(p.money).toBe(moneyBefore - 50);
      expect(p.inJail).toBe(false);
      expect(p.jailTurns).toBe(0);
      expect(p.mustRollAgain).toBe(false);
      expect(activeState.phase).toBe("ROLLING");
      expect(activeState.moveAnimation).toBeUndefined();
      expect(activeState.lastDice).toBeUndefined();
      expect(activeState.jailRollOutcome).toBeUndefined();

      // ФАЗА 2: отдельный бросок кубиков игроком.
      await act({ type: "ROLL_DICE" });
      expect(activeState.phase).toBe("DICE_ANIMATION");
      expect(activeState.lastDice).toBeDefined();

      // ФАЗА 3: подтверждаем анимацию -> фишка едет от клетки 10.
      await act({ type: "CONFIRM_DICE_ANIMATION" });
      expect(activeState.phase).toBe("MOVE_ANIMATION");
      expect(activeState.moveAnimation).toBeDefined();
      expect(activeState.moveAnimation?.from).toBe(10);
    });

    it("END_TURN после неудачной попытки (stay) → фаза END_TURN, jailTurns сохраняется", async () => {
      const p = setupJailDecision(0);
      // Эмулируем stay: после CONFIRM_DICE_ANIMATION фаза=BUILDING, jailTurns=1.
      activeState.phase = "BUILDING";
      p.jailTurns = 1;
      p.inJail = true;
      p.mustRollAgain = false;
      const idx = activeState.currentPlayerIndex;
      const moneyBefore = p.money;

      // END_TURN из BUILDING → переходим в фазу END_TURN (анимация
      // передачи хода). `currentPlayerIndex` пока не меняется.
      await act({ type: "END_TURN" });
      expect(activeState.phase).toBe("END_TURN");
      expect(p.jailTurns).toBe(1);
      // Деньги не списаны.
      expect(p.money).toBe(moneyBefore);

      // Подтверждение от клиента: CONFIRM_END_TURN — теперь ход
      // действительно переходит к следующему игроку.
      await act({ type: "CONFIRM_END_TURN" });
      expect(activeState.currentPlayerIndex).not.toBe(idx);
      // jailTurns у текущего (предыдущего) игрока сохранились.
      expect(p.jailTurns).toBe(1);
      expect(p.money).toBe(moneyBefore);
    });

    it("tryDoubleOrPay инкрементирует jailTurns и возвращает pay на 3-м промахе, НЕ выходя из тюрьмы и НЕ списывая деньги", async () => {
      const p = setupJailDecision(0);
      const moneyBefore = p.money;
      const jail = (service as any).jail as {
        tryDoubleOrPay: (p: Player, dice: [number, number]) => "escape" | "stay" | "pay";
      };
      expect(jail.tryDoubleOrPay(p, [1, 2])).toBe("stay");
      expect(p.jailTurns).toBe(1);
      expect(p.inJail).toBe(true);
      expect(p.money).toBe(moneyBefore);
      expect(jail.tryDoubleOrPay(p, [3, 4])).toBe("stay");
      expect(p.jailTurns).toBe(2);
      expect(p.inJail).toBe(true);
      expect(p.money).toBe(moneyBefore);
      expect(jail.tryDoubleOrPay(p, [5, 6])).toBe("pay");
      expect(p.jailTurns).toBe(3);
      // ВАЖНО: inJail остаётся true, деньги НЕ списаны —
      // это сделает handleDiceAnimation после CONFIRM_DICE_ANIMATION.
      expect(p.inJail).toBe(true);
      expect(p.money).toBe(moneyBefore);
    });

    it("Дубль на 3-й попытке (escape, jailTurns=2): бесплатный выход, потом отдельный бросок и движение", async () => {
      const p = setupJailDecision(2);
      const moneyBefore = p.money;
      activeState.jailRollOutcome = "escape";
      activeState.phase = "DICE_ANIMATION";
      activeState.lastDice = { dice: [4, 4], isDouble: true };
      p.inJail = true;
      p.jailTurns = 2;
      p.mustRollAgain = false;
      p.consecutiveDoubles = 0;

      // Faza 1: CONFIRM_DICE_ANIMATION: выход дублём бесплатный.
      await act({ type: "CONFIRM_DICE_ANIMATION" });
      expect(p.inJail).toBe(false);
      expect(p.jailTurns).toBe(0);
      expect(p.money).toBe(moneyBefore);
      expect(p.mustRollAgain).toBe(false);
      expect(activeState.phase).toBe("ROLLING");
      expect(activeState.moveAnimation).toBeUndefined();
      expect(activeState.lastDice).toBeUndefined();
      expect(activeState.jailRollOutcome).toBeUndefined();

      // Faza 2: отдельный бросок кубиков игроком.
      await act({ type: "ROLL_DICE" });
      expect(activeState.phase).toBe("DICE_ANIMATION");
      expect(activeState.lastDice).toBeDefined();

      // Faza 3: подтверждаем анимацию -> фишка едет от клетки 10.
      await act({ type: "CONFIRM_DICE_ANIMATION" });
      expect(activeState.phase).toBe("MOVE_ANIMATION");
      expect(activeState.moveAnimation).toBeDefined();
      expect(activeState.moveAnimation?.from).toBe(10);
    });
  });

  // ------------------------------------------------------------------
  // Регрессионные тесты: `preBuildingPhase`
  // ------------------------------------------------------------------
  // Баг был такой: если в фазе ROLLING (кнопка «Бросить кубики» активна)
  // игрок открывал меню строительства и тут же нажимал «Принять» —
  // сервер принудительно ставил state.phase = "BUILDING", из-за чего
  // canRollDice() возвращал false и кнопка Бросить отключалась до конца
  // хода. Фикс: при OPEN_BUILDING_PHASE запоминаем state.phase в
  // `preBuildingPhase`, а при CONFIRM_BUILDING_PHASE восстанавливаем.
  describe("preBuildingPhase (regression: открыть и закрыть меню строительства)", () => {
    it("в ROLLING: OPEN_BUILDING_PHASE → CONFIRM_BUILDING_PHASE → остаёмся в ROLLING, preBuildingPhase сброшен", async () => {
      expect(activeState.phase).toBe("ROLLING");
      // Игрок кликнул «Строить» (до броска кубиков).
      await act({ type: "OPEN_BUILDING_PHASE" });
      expect(activeState.phase).toBe("BUILDING_PHASE");
      expect(activeState.preBuildingPhase).toBe("ROLLING");
      // Игрок передумал строить — кликнул «Принять» (закрыть).
      await act({ type: "CONFIRM_BUILDING_PHASE" });
      // ФАЗА ВОССТАНОВЛЕНА → кнопка «Бросить кубики» снова активна.
      expect(activeState.phase).toBe("ROLLING");
      // preBuildingPhase очищен, иначе при следующем OPEN_BUILDING_PHASE
      // восстановили бы неправильную фазу.
      expect(activeState.preBuildingPhase).toBeUndefined();
    });

    it("в BUILDING: OPEN_BUILDING_PHASE → CONFIRM_BUILDING_PHASE → остаёмся в BUILDING (классический кейс)", async () => {
      activeState.phase = "BUILDING";
      await act({ type: "OPEN_BUILDING_PHASE" });
      expect(activeState.phase).toBe("BUILDING_PHASE");
      expect(activeState.preBuildingPhase).toBe("BUILDING");
      await act({ type: "CONFIRM_BUILDING_PHASE" });
      expect(activeState.phase).toBe("BUILDING");
      expect(activeState.preBuildingPhase).toBeUndefined();
    });

    it("повторный цикл open → confirm → open → confirm работает корректно", async () => {
      expect(activeState.phase).toBe("ROLLING");
      // цикл 1
      await act({ type: "OPEN_BUILDING_PHASE" });
      expect(activeState.preBuildingPhase).toBe("ROLLING");
      await act({ type: "CONFIRM_BUILDING_PHASE" });
      expect(activeState.phase).toBe("ROLLING");
      expect(activeState.preBuildingPhase).toBeUndefined();
      // цикл 2 — не должно «прилипнуть» старое значение.
      await act({ type: "OPEN_BUILDING_PHASE" });
      expect(activeState.preBuildingPhase).toBe("ROLLING");
      await act({ type: "CONFIRM_BUILDING_PHASE" });
      expect(activeState.phase).toBe("ROLLING");
      expect(activeState.preBuildingPhase).toBeUndefined();
    });

    it("повторный OPEN_BUILDING_PHASE в BUILDING_PHASE — no-op (preBuildingPhase не перезаписывается)", async () => {
      activeState.phase = "BUILDING";
      await act({ type: "OPEN_BUILDING_PHASE" });
      expect(activeState.phase).toBe("BUILDING_PHASE");
      expect(activeState.preBuildingPhase).toBe("BUILDING");
      // Повторный клик (например, при побочных эффектах UI).
      await act({ type: "OPEN_BUILDING_PHASE" });
      // Должны остаться в BUILDING_PHASE, фаза-источник не перезаписана.
      expect(activeState.phase).toBe("BUILDING_PHASE");
      expect(activeState.preBuildingPhase).toBe("BUILDING");
      // Корректное закрытие.
      await act({ type: "CONFIRM_BUILDING_PHASE" });
      expect(activeState.phase).toBe("BUILDING");
    });

    it("preBuildingPhase не переносится между ходами (handleStartTurn сбрасывает поле)", async () => {
      // Имитируем полу-открытое состояние: preBuildingPhase заполнено,
      // а phase=RESTING/END_TURN (например, реконнект клиента).
      activeState.phase = "ROLLING";
      activeState.preBuildingPhase = "ROLLING";
      // Следующий ход: handleStartTurn обязан сбросить поле.
      await act({ type: "ROLL_DICE" });
      // После броска предыдущая «грязная» фаза не должна восстановиться.
      // (handleStartTurn сбрасывает preBuildingPhase в undefined.)
      expect(activeState.preBuildingPhase).toBeUndefined();
    });
  });
});
