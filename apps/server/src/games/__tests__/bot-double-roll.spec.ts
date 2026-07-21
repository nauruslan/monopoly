/**
 * Регрессионные тесты: «бот + дубль + карточка Шанс/Казна → другая клетка».
 *
 * Сценарий бага (описан пользователем):
 *  1) Бот бросает дубль → mustRollAgain=true.
 *  2) Попадает на ШАНС/КАЗНУ → вытягивает карту с эффектом
 *     `move-relative` (назад на 3) или `move` (на другую клетку).
 *  3) После CONFIRM_CARD + CONFIRM_MOVE_ANIMATION + CONFIRM_LANDING
 *     фишка приземляется на пустой клетке PROPERTY (BUY_DECISION) или
 *     TAX.
 *  4) ДО ИСПРАВЛЕНИЯ: бот в BUY_DECISION возвращал решение "END_TURN"
 *     через `decideBuy`, что недопустимо в фазе BUY_DECISION
 *     (принимает только BUY_PROPERTY/DECLINE_BUY) → сервер бросал
 *     ForbiddenException, фаза не менялась, бот «зависал» и терял
 *     право на ещё один бросок.
 *  5) ДОПОЛНИТЕЛЬНЫЕ БАГИ: afterAuctionFinished (раньше
 *     `handleAuctionResolve`) и handleTradingNegotiate сбрасывали
 *     mustRollAgain=true при возврате в BUILDING после аукциона/торгов.
 *
 * ИСПРАВЛЕНИЕ:
 *  - `BotService.decideBuy` возвращает "DECLINE_BUY" вместо "END_TURN".
 *  - `afterAuctionFinished` сохраняет `player.mustRollAgain` и
 *    переходит в ROLLING при его наличии.
 *  - `handleTradingNegotiate` сохраняет `player.mustRollAgain` при
 *    TRADE_REJECT / TRADE_CANCEL / TRADE_ACCEPT.
 */
import { Test } from "@nestjs/testing";
import { GamesService } from "../games.service";
import { GameRepository } from "../../db/repositories/game.repository";
import { GameInitializerService } from "../game-initializer.service";
import { RentCalculator } from "../handlers/rent-calculator";
import { JailHandlerService } from "../handlers/jail-handler.service";
import { CardHandlerService } from "../handlers/card-handler.service";
import { BankruptcyService } from "../handlers/bankruptcy.service";
import { BotService } from "../bots/bot.service";
import { AuctionService } from "../handlers/auction.service";
import { TradeService } from "../handlers/trade.service";
import type { GameState, Player } from "@monopoly/shared";
import { BOARD, DEFAULT_SETTINGS, CHANCE_CARDS } from "@monopoly/shared";
import { canEndTurn, canRollDice } from "../turn-permissions";

function makeBotState(): GameState {
  // Создаём партию из ДВУХ ботов: имитирует реальный сценарий,
  // когда все игроки — боты.
  const players: Player[] = [
    {
      id: "p0",
      displayName: "Bot0",
      kind: "bot",
      color: "#f00",
      icon: "🔴",
      money: 1500,
      position: 0,
      inJail: false,
      jailTurns: 0,
      jailCards: 0,
      properties: [],
      consecutiveDoubles: 0,
      isBankrupt: false,
    },
    {
      id: "p1",
      displayName: "Bot1",
      kind: "bot",
      color: "#00f",
      icon: "🔵",
      money: 1500,
      position: 0,
      inJail: false,
      jailTurns: 0,
      jailCards: 0,
      properties: [],
      consecutiveDoubles: 0,
      isBankrupt: false,
    },
  ];
  return {
    id: "g-bot-test",
    version: 1,
    status: "active",
    currentPlayerIndex: 0,
    phase: "ROLLING",
    round: 1,
    players,
    board: BOARD.map((c) => ({ ...c, ownerId: undefined, houses: 0, isMortgaged: false })),
    settings: { ...DEFAULT_SETTINGS, auctionEnabled: true },
    seed: "bot-test-seed",
    createdAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
  };
}

describe("GamesService.applyAction: regression дубль + карточка → БОТ сохраняет право на ещё один бросок", () => {
  let service: GamesService;
  let activeState: GameState;
  let botService: BotService;

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    if (service) {
      (service as any).removeFromCache("g-bot-test");
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
        BotService,
        AuctionService,
        TradeService,
        { provide: GameRepository, useValue: repoMock },
      ],
    }).compile();

    service = moduleRef.get(GamesService);
    botService = moduleRef.get(BotService);
    activeState = makeBotState();
    (activeState as any).id = "g-bot-test";
  });

  async function act(action: Parameters<GamesService["applyAction"]>[2]) {
    const gameId = "g-bot-test";
    (service as any).activeGames.set(gameId, activeState);
    return service.applyAction(
      gameId,
      activeState.players[activeState.currentPlayerIndex]!.id,
      action,
    );
  }

  it("Бот в BUY_DECISION после move-relative карты на дубле: decideBuy → DECLINE_BUY, фаза → ROLLING (право на ещё один бросок сохранено)", async () => {
    // Сценарий:
    //  - бот стоит на клетке 11, бросает дубль, идёт на CHANCE (например, 15),
    //    тянет «вернитесь на 3 назад» → попадает на 12 (PROPERTY, Railway или
    //    другую клетку без владельца).
    //  - В BUY_DECISION у бота не хватает денег с запасом → должно вернуться
    //    "DECLINE_BUY", НЕ "END_TURN" (иначе ForbiddenException).
    //  - Без аукциона (settings.auctionEnabled=false) → сразу ROLLING.
    const backCard = CHANCE_CARDS.find(
      (c) => c.effect.kind === "move-relative" && "steps" in c.effect && c.effect.steps === -3,
    );
    expect(backCard).toBeDefined();
    if (!backCard) return;

    // Отключаем аукцион, чтобы сразу уйти в ROLLING/BUILDING.
    activeState.settings.auctionEnabled = false;

    const START_POSITION = 11; // 11 - 3 = 8 (PROPERTY, lightblue)
    const p = activeState.players[activeState.currentPlayerIndex]!;
    p.position = START_POSITION;
    p.mustRollAgain = true;
    p.consecutiveDoubles = 1;
    p.money = 50; // Чтобы бот точно не купил клетку за 200₽.
    activeState.lastDice = { dice: [1, 1], isDouble: true };
    activeState.phase = "CARD_REVEAL";
    activeState.cardContext = {
      playerId: p.id,
      deck: backCard.deck,
      card: backCard,
      applied: false,
    };
    activeState.cardDecks = {
      chance: { cards: [backCard.id], cursor: 0 },
      treasury: { cards: [], cursor: 0 },
      "luxury-tax": { cards: [], cursor: 0 },
    };

    // 1) CONFIRM_CARD — move-relative не сбрасывает mustRollAgain,
    //    фаза MOVE_ANIMATION.
    await act({ type: "CONFIRM_CARD" });
    expect(p.mustRollAgain).toBe(true);
    expect(p.consecutiveDoubles).toBe(1);
    expect(activeState.phase).toBe("MOVE_ANIMATION");

    // 2) CONFIRM_MOVE_ANIMATION → RESOLVING_LANDING.
    await act({ type: "CONFIRM_MOVE_ANIMATION" });
    expect(activeState.phase).toBe("RESOLVING_LANDING");

    // 3) CONFIRM_LANDING → клетка 8 (PROPERTY) пуста → BUY_DECISION.
    await act({ type: "CONFIRM_LANDING" });
    expect(p.position).toBe(8);
    expect(activeState.phase).toBe("BUY_DECISION");

    // 4) Проверяем: бот в BUY_DECISION возвращает "DECLINE_BUY" (НЕ "END_TURN"),
    //    потому что у него не хватает денег с запасом 200₽.
    const decision = botService.decide(p, activeState);
    expect(decision).toBe("DECLINE_BUY");

    // 5) Действие DECLINE_BUY не должно приводить к ForbiddenException.
    //    Без аукциона фаза сразу переходит в ROLLING, mustRollAgain
    //    сохраняется.
    await act({ type: "DECLINE_BUY" });
    expect(p.mustRollAgain).toBe(true);
    expect(p.consecutiveDoubles).toBe(1);
    expect(activeState.phase).toBe("ROLLING");
    // UI: «Бросить» активна, «Завершить» — нет.
    expect(canRollDice(activeState, p)).toBe(true);
    expect(canEndTurn(activeState, p)).toBe(false);
  });

  it("Бот в BUY_DECISION с деньгами: decideBuy → BUY, после покупки mustRollAgain=true → ROLLING", async () => {
    // Тот же сценарий, но у бота достаточно денег, и он покупает клетку.
    // После покупки фаза должна быть ROLLING (а не BUILDING),
    // т.к. mustRollAgain=true.
    const backCard = CHANCE_CARDS.find(
      (c) => c.effect.kind === "move-relative" && "steps" in c.effect && c.effect.steps === -3,
    );
    expect(backCard).toBeDefined();
    if (!backCard) return;

    const START_POSITION = 11;
    const p = activeState.players[activeState.currentPlayerIndex]!;
    p.position = START_POSITION;
    p.mustRollAgain = true;
    p.consecutiveDoubles = 1;
    p.money = 1500; // Достаточно денег.
    activeState.lastDice = { dice: [1, 1], isDouble: true };
    activeState.phase = "CARD_REVEAL";
    activeState.cardContext = {
      playerId: p.id,
      deck: backCard.deck,
      card: backCard,
      applied: false,
    };
    activeState.cardDecks = {
      chance: { cards: [backCard.id], cursor: 0 },
      treasury: { cards: [], cursor: 0 },
      "luxury-tax": { cards: [], cursor: 0 },
    };

    // CONFIRM_CARD → MOVE_ANIMATION → RESOLVING_LANDING → CONFIRM_LANDING.
    await act({ type: "CONFIRM_CARD" });
    expect(activeState.phase).toBe("MOVE_ANIMATION");
    await act({ type: "CONFIRM_MOVE_ANIMATION" });
    expect(activeState.phase).toBe("RESOLVING_LANDING");
    await act({ type: "CONFIRM_LANDING" });
    expect(p.position).toBe(8);
    expect(activeState.phase).toBe("BUY_DECISION");

    // Бот решает купить.
    const decision = botService.decide(p, activeState);
    expect(decision).toBe("BUY");

    // После покупки — mustRollAgain=true → фаза ROLLING.
    await act({ type: "BUY_PROPERTY" });
    expect(p.mustRollAgain).toBe(true);
    expect(p.consecutiveDoubles).toBe(1);
    expect(activeState.phase).toBe("ROLLING");
    expect(p.properties).toContain(8);
    expect(activeState.board[8]!.ownerId).toBe(p.id);
  });

  it("afterAuctionFinished: при mustRollAgain=true фаза → ROLLING (сохраняет право на ещё один бросок)", async () => {
    // Юнит-тест исправления `afterAuctionFinished`:
    // при наличии `mustRollAgain` после аукциона фаза должна быть ROLLING,
    // а не BUILDING. Это нужно, чтобы не терять право на ещё один бросок
    // после дубля, если аукцион был начат после карточки move-relative.
    const p = activeState.players[activeState.currentPlayerIndex]!;
    p.mustRollAgain = true;
    p.consecutiveDoubles = 1;
    // Имитируем «только что пришёл AUCTION_FINISHED»: state.auction
    // уже отдан финализатору, фаза ещё AUCTION_FINISHED.
    activeState.phase = "AUCTION_FINISHED";
    activeState.auction = undefined;

    // Дёргаем напрямую (это приватный метод, но тест регрессионный).
    (service as any).afterAuctionFinished(activeState);

    expect(activeState.auction).toBeUndefined();
    expect(p.mustRollAgain).toBe(true);
    expect(p.consecutiveDoubles).toBe(1);
    expect(activeState.phase).toBe("ROLLING");
  });

  it("afterAuctionFinished: при mustRollAgain=false фаза → BUILDING (как раньше)", async () => {
    const p = activeState.players[activeState.currentPlayerIndex]!;
    p.mustRollAgain = false;
    p.consecutiveDoubles = 0;
    activeState.phase = "AUCTION_FINISHED";
    activeState.auction = undefined;

    (service as any).afterAuctionFinished(activeState);

    expect(activeState.phase).toBe("BUILDING");
  });

  it("handleTradingNegotiate TRADE_REJECT: при mustRollAgain=true фаза → ROLLING", async () => {
    // Юнит-тест исправления `handleTradingNegotiate`:
    // при наличии `mustRollAgain` после TRADE_REJECT фаза должна быть
    // ROLLING, а не BUILDING. Это нужно, чтобы не терять право на ещё
    // один бросок после дубля, если торги инициированы после карточки.
    const p = activeState.players[activeState.currentPlayerIndex]!;
    p.mustRollAgain = true;
    p.consecutiveDoubles = 1;
    activeState.phase = "TRADING_NEGOTIATE";
    activeState.trade = {
      initiatorId: "p1",
      recipientId: p.id,
      currentPartyId: p.id,
      offer: { fromProperties: [], fromCash: 50, toProperties: [], toCash: 0 },
      counterCount: 0,
    };

    await (service as any).handleTradingNegotiate(activeState, p, { type: "TRADE_REJECT" });

    expect(activeState.trade).toBeUndefined();
    expect(p.mustRollAgain).toBe(true);
    expect(p.consecutiveDoubles).toBe(1);
    expect(activeState.phase).toBe("ROLLING");
  });

  it("Бот в TRADING_NEGOTIATE отклоняет trade после карточки на дубле: mustRollAgain сохраняется", async () => {
    // Сценарий: игрок бросает дубль, попадает на ШАНС, тянет
    // go-salary (или stay-карту), переходит в BUILDING. Во время
    // своего хода другой игрок предлагает обмен — текущий игрок
    // (который должен бросить ещё раз из-за дубля) отклоняет trade.
    // После TRADE_REJECT mustRollAgain должен сохраниться, и фаза
    // должна быть ROLLING.
    const goCard = CHANCE_CARDS.find((c) => c.effect.kind === "go-salary");
    expect(goCard).toBeDefined();
    if (!goCard) return;

    const p = activeState.players[activeState.currentPlayerIndex]!;
    const p1 = activeState.players[1]!;
    p.position = 24; // около CHANCE
    p.mustRollAgain = true;
    p.consecutiveDoubles = 1;
    p.money = 1500;
    p1.money = 1500;
    p1.properties = [1];
    activeState.board[1]!.ownerId = p1.id;
    activeState.lastDice = { dice: [1, 1], isDouble: true };
    activeState.phase = "CARD_REVEAL";
    activeState.cardContext = {
      playerId: p.id,
      deck: goCard.deck,
      card: goCard,
      applied: false,
    };
    activeState.cardDecks = {
      chance: { cards: [goCard.id], cursor: 0 },
      treasury: { cards: [], cursor: 0 },
      "luxury-tax": { cards: [], cursor: 0 },
    };

    // go-salary → MOVE_ANIMATION → RESOLVING_LANDING → ROLLING.
    await act({ type: "CONFIRM_CARD" });
    expect(p.mustRollAgain).toBe(true);
    await act({ type: "CONFIRM_MOVE_ANIMATION" });
    expect(activeState.phase).toBe("RESOLVING_LANDING");
    await act({ type: "CONFIRM_LANDING" });
    // На GO: goSalary начислился, фаза ROLLING (т.к. mustRollAgain=true).
    expect(p.mustRollAgain).toBe(true);
    expect(activeState.phase).toBe("ROLLING");

    // Теперь p1 (другой игрок) инициирует trade в фазе BUILDING... но мы
    // в ROLLING. Торги разрешены только в BUILDING. Чтобы протестировать
    // именно TRADING_NEGOTIATE, мы вручную переведём state в TRADING_NEGOTIATE
    // (имитация того, что торги были инициированы в прошлом ходу).
    activeState.phase = "TRADING_NEGOTIATE";
    activeState.trade = {
      initiatorId: p1.id,
      recipientId: p.id,
      currentPartyId: p.id,
      offer: { fromProperties: [], fromCash: 50, toProperties: [], toCash: 0 },
      counterCount: 0,
    };

    // Бот (p) отклоняет trade — mustRollAgain должен сохраниться.
    await act({ type: "TRADE_REJECT" });
    expect(p.mustRollAgain).toBe(true);
    expect(p.consecutiveDoubles).toBe(1);
    expect(activeState.phase).toBe("ROLLING");
    expect(activeState.trade).toBeUndefined();
  });

  it("Бот решает DECLINE_BUY в BUY_DECISION — действие DECLINE_BUY не выбрасывает ForbiddenException", async () => {
    // Проверяем только уровень сервиса: явный DECLINE_BUY при дубле
    // приводит к фазе ROLLING, mustRollAgain сохраняется.
    const cell = activeState.board[8]!;
    cell.ownerId = undefined; // пустая клетка
    const p = activeState.players[activeState.currentPlayerIndex]!;
    p.position = 8;
    p.mustRollAgain = true;
    p.consecutiveDoubles = 1;
    p.money = 0; // гарантированно не хватает на покупку
    activeState.settings.auctionEnabled = false; // без аукциона
    activeState.phase = "BUY_DECISION";

    // Должно сработать без исключений.
    await act({ type: "DECLINE_BUY" });
    expect(activeState.phase).toBe("ROLLING");
    expect(p.mustRollAgain).toBe(true);
    expect(p.consecutiveDoubles).toBe(1);
  });
});
