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
import { canEndTurn, canRollDice } from "../turn-permissions";

// Хелперы для создания state и применения действий (унифицированы с
// special-cells-double.spec.ts).

function makePlayer(overrides: Partial<Player> = {}): Player {
  return {
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
    ...overrides,
  };
}

function makeStateWithPlayers(players: Player[]): GameState {
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

function makeFreshState(): GameState {
  return makeStateWithPlayers([
    makePlayer({ id: "p0", displayName: "Alice" }),
    makePlayer({ id: "p1", displayName: "Bob", kind: "bot" }),
  ]);
}

async function buildService(): Promise<GamesService> {
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

  return moduleRef.get(GamesService);
}

describe("BUGFIX #1: RentCalculator — заложенные ж/д и утилиты не учитываются в счётчике", () => {
  let state: GameState;

  beforeEach(async () => {
    jest.useFakeTimers();
    await buildService();
    state = makeFreshState();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  /**
   * Сценарий: владелец имеет 3 ж/д, одна из них заложена.
   * Ожидаемая рента = 50₽ (как за 2 станции), а НЕ 100₽ (как за 3).
   * Также проверяем, что приземление на ЗАЛОЖЕННУЮ станцию даёт 0 ренты.
   */
  it("RAILROAD: 3 станции, 1 заложена → рента считается как за 2 станции (50₽)", () => {
    const rentCalc = new RentCalculator();
    const owner = state.players[0]!;
    owner.properties = [5, 15, 25]; // 3 RAILROAD-клетки
    // Закладываем одну из станций (id=15 — Pennsylvania Railroad).
    state.board[15]!.isMortgaged = true;
    state.board[5]!.ownerId = owner.id;
    state.board[15]!.ownerId = owner.id;
    state.board[25]!.ownerId = owner.id;

    // Приземляемся на незаложенную станцию — ожидаем 50₽ (×2, как за 2 станции).
    const rent = rentCalc.calculate(state.board[5]!, state, [3, 4]);
    expect(rent).toBe(50);
  });

  it("RAILROAD: приземление на заложенную станцию даёт 0 ренты", () => {
    const rentCalc = new RentCalculator();
    const owner = state.players[0]!;
    owner.properties = [5, 15, 25];
    state.board[15]!.isMortgaged = true;
    state.board[5]!.ownerId = owner.id;
    state.board[15]!.ownerId = owner.id;
    state.board[25]!.ownerId = owner.id;

    const rent = rentCalc.calculate(state.board[15]!, state, [3, 4]);
    expect(rent).toBe(0);
  });

  it("UTILITY: 2 утилиты, 1 заложена → множитель = 4 (как за 1), а не 10 (как за 2)", () => {
    const rentCalc = new RentCalculator();
    const owner = state.players[0]!;
    // В стандартной Монополии 2 утилиты: id=12 (Электростанция), id=28 (Водопровод).
    owner.properties = [12, 28];
    state.board[12]!.ownerId = owner.id;
    state.board[28]!.ownerId = owner.id;
    state.board[28]!.isMortgaged = true; // закладываем одну

    // Бросок [3,4] = 7. Ожидаемо: 4 × 7 = 28₽ (как за 1 утилиту).
    const rent = rentCalc.calculate(state.board[12]!, state, [3, 4]);
    expect(rent).toBe(28);
  });

  it("UTILITY: приземление на заложенную утилиту даёт 0 ренты", () => {
    const rentCalc = new RentCalculator();
    const owner = state.players[0]!;
    owner.properties = [12, 28];
    state.board[12]!.ownerId = owner.id;
    state.board[28]!.ownerId = owner.id;
    state.board[28]!.isMortgaged = true;

    const rent = rentCalc.calculate(state.board[28]!, state, [3, 4]);
    expect(rent).toBe(0);
  });

  it("RAILROAD: 4 станции, 2 заложены → рента = 25₽ (как за 1 станцию, не 200₽ за 4)", () => {
    const rentCalc = new RentCalculator();
    const owner = state.players[0]!;
    owner.properties = [5, 15, 25, 35]; // все 4 RAILROAD
    for (const id of [5, 15, 25, 35]) {
      state.board[id]!.ownerId = owner.id;
    }
    // Закладываем 2 станции.
    state.board[15]!.isMortgaged = true;
    state.board[35]!.isMortgaged = true;

    // Приземляемся на незаложенную (id=5).
    const rent = rentCalc.calculate(state.board[5]!, state, [2, 3]);
    expect(rent).toBe(50); // 2 незаложенных = 50₽
  });
});

describe("BUGFIX #2: PAY_JAIL_FINE без денег → фаза распродажи / банкротство", () => {
  let service: GamesService;
  let state: GameState;

  beforeEach(async () => {
    jest.useFakeTimers();
    service = await buildService();
    state = makeStateWithPlayers([
      // Бот с деньгами < 50 и одним домом, который можно продать.
      makePlayer({
        id: "bot1",
        displayName: "PoorBot",
        kind: "bot",
        money: 30,
        inJail: true,
        jailTurns: 1,
        properties: [1], // PROPERTY с домами
      }),
      makePlayer({ id: "p1", displayName: "Bob", kind: "human", money: 1500 }),
    ]);
    // Даём боту собственность с домами, чтобы покрыть дефицит.
    const ownedCell = state.board[1]!;
    ownedCell.ownerId = "bot1";
    ownedCell.houses = 2;
    ownedCell.housePrice = 50; // за 2 дома можно выручить 100₽
    state.board[1] = ownedCell;
    state.currentPlayerIndex = 0;
    state.phase = "JAIL_DECISION";
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  async function act(action: Parameters<GamesService["applyAction"]>[2]) {
    const gameId = "g-test";
    (service as any).activeGames.set(gameId, state);
    return service.applyAction(gameId, state.players[state.currentPlayerIndex]!.id, action);
  }

  /**
   * Сценарий: бот в тюрьме, денег 30₽ (< 50), но у него есть дома,
   * которые можно продать. По правилам Монополии он должен попасть
   * в фазу распродажи (BANKRUPTCY_LIQUIDATE), а не «остановить игру».
   */
  it("бот в тюрьме с 30₽ (не хватает 20₽) и домами → BANKRUPTCY_LIQUIDATE", async () => {
    await act({ type: "PAY_JAIL_FINE" });

    // Фаза должна стать BANKRUPTCY_LIQUIDATE (распродажа), а не
    // бросать ForbiddenException.
    expect(state.phase).toBe("BANKRUPTCY_LIQUIDATE");
    expect(state.bankruptcy).toBeDefined();
    expect(state.bankruptcy?.playerId).toBe("bot1");
    // Дефицит = 50 - 30 = 20₽.
    expect(state.bankruptcy?.debt).toBe(20);
    // Игрок остался в тюрьме (распродажа происходит ДО оплаты штрафа).
    expect(state.players[0]!.inJail).toBe(true);
  });

  /**
   * Сценарий: бот в тюрьме, денег < 0, и покрыть долг нечем —
   * должно сработать банкротство.
   */
  it("бот в тюрьме с отрицательным балансом и без имущества → банкротство", async () => {
    const botId = "bot1";
    const bot = state.players.find((p) => p.id === botId)!;
    bot.money = -10;
    bot.properties = [];
    // ВАЖНО: сбрасываем ownerId клетки, иначе `computeMaxLiquidity` в
    // `bankruptcy.canCoverDebt` найдёт ликвидность на доске и вернёт
    // `true` — мы попадём в ветку распродажи, а не банкротства.
    state.board[1]!.ownerId = undefined;
    state.bankruptcy = undefined;

    await act({ type: "PAY_JAIL_FINE" });

    // Банкротство должно сработать — игрок помечен как банкрот.
    // Проверяем по id, чтобы исключить перестановки currentPlayerIndex.
    const botAfter = state.players.find((p) => p.id === botId)!;
    expect(botAfter.isBankrupt).toBe(true);
  });

  /**
   * Сценарий: бот в тюрьме, денег РОВНО 50₽ — обычная оплата без банкротства.
   */
  it("бот в тюрьме с ровно 50₽ → оплата штрафа, ROLLING (без банкротства)", async () => {
    const bot = state.players[0]!;
    bot.money = 50;
    bot.properties = [];

    await act({ type: "PAY_JAIL_FINE" });

    expect(bot.money).toBe(0);
    expect(bot.inJail).toBe(false);
    expect(state.phase).toBe("ROLLING");
    expect(state.bankruptcy).toBeUndefined();
  });
});

describe("BUGFIX #3: PARKING — спецполе, принудительная остановка после дублей", () => {
  let service: GamesService;
  let state: GameState;

  beforeEach(async () => {
    jest.useFakeTimers();
    service = await buildService();
    state = makeFreshState();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  async function act(action: Parameters<GamesService["applyAction"]>[2]) {
    const gameId = "g-test";
    (service as any).activeGames.set(gameId, state);
    return service.applyAction(gameId, state.players[state.currentPlayerIndex]!.id, action);
  }

  it("PARKING через кубики с дублём: mustRollAgain СБРОШЕН, фаза BUILDING", async () => {
    const p = state.players[state.currentPlayerIndex]!;
    p.position = 18;
    p.mustRollAgain = true;
    p.consecutiveDoubles = 1;
    state.lastDice = { dice: [1, 1], isDouble: true };
    state.phase = "MOVE_ANIMATION";

    await act({ type: "CONFIRM_MOVE_ANIMATION" });
    expect(p.position).toBe(20);
    expect(state.phase).toBe("RESOLVING_LANDING");
    await act({ type: "CONFIRM_LANDING" });

    // Главное утверждение: даже с дублём — цепочка дублей ОБРЫВАЕТСЯ.
    expect(p.mustRollAgain).toBe(false);
    expect(p.consecutiveDoubles).toBe(0);
    expect(state.phase).toBe("BUILDING");
    // justArrivedAtParking теперь ставится ВСЕГДА (раньше только по карточке).
    expect(state.justArrivedAtParking).toBe(true);
    expect(canRollDice(state, p)).toBe(false);
    expect(canEndTurn(state, p)).toBe(true);
  });

  it("PARKING через кубики без дубля: mustRollAgain=false, BUILDING, justArrivedAtParking=true", async () => {
    const p = state.players[state.currentPlayerIndex]!;
    p.position = 18;
    p.mustRollAgain = false;
    p.consecutiveDoubles = 0;
    state.lastDice = { dice: [1, 1], isDouble: false };
    state.phase = "MOVE_ANIMATION";

    await act({ type: "CONFIRM_MOVE_ANIMATION" });
    await act({ type: "CONFIRM_LANDING" });

    expect(p.mustRollAgain).toBe(false);
    expect(p.consecutiveDoubles).toBe(0);
    expect(state.justArrivedAtParking).toBe(true);
    expect(state.phase).toBe("BUILDING");
    expect(canRollDice(state, p)).toBe(false);
  });

  it("PARKING после 2-го дубля подряд: счётчик consecutiveDoubles СБРОШЕН (не уходит в арест)", async () => {
    // Защита от регрессии: парковка не должна дать игроку третий
    // дубль → арест. После приземления на парковку consecutiveDoubles=0.
    const p = state.players[state.currentPlayerIndex]!;
    p.position = 18;
    p.consecutiveDoubles = 2; // ещё один дубль = арест
    p.mustRollAgain = true;
    state.lastDice = { dice: [1, 1], isDouble: true };
    state.phase = "MOVE_ANIMATION";

    await act({ type: "CONFIRM_MOVE_ANIMATION" });
    await act({ type: "CONFIRM_LANDING" });

    expect(p.consecutiveDoubles).toBe(0);
    expect(p.inJail).toBe(false);
    expect(state.phase).toBe("BUILDING");
  });
});
