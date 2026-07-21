import { Test } from "@nestjs/testing";
import { BotService, type BotDecision } from "../bots/bot.service";
import { makeCell, makeMonopolyBoard, makePlayer, makeState, resetCounters } from "./factories";
import type { GameState, Player } from "@monopoly/shared";

describe("BotService.decide", () => {
  let bot: BotService;

  beforeEach(async () => {
    resetCounters();
    const moduleRef = await Test.createTestingModule({
      providers: [BotService],
    }).compile();
    bot = moduleRef.get(BotService);
  });

  // ─────────────────────── ROLLING ───────────────────────
  describe("ROLLING phase", () => {
    it("ROLL, если игрок не в тюрьме и не имеет карточек", () => {
      const player = makePlayer({ inJail: false, jailCards: 0 });
      const state = makeState({ phase: "ROLLING", players: [player] });
      expect(bot.decide(player, state)).toBe("ROLL");
    });

    it("USE_CARD, если в тюрьме и есть карточка", () => {
      const player = makePlayer({ inJail: true, jailCards: 1 });
      const state = makeState({ phase: "ROLLING", players: [player] });
      expect(bot.decide(player, state)).toBe("USE_CARD");
    });

    it("TRY_DOUBLE, если в тюрьме без карточки", () => {
      const player = makePlayer({ inJail: true, jailCards: 0 });
      const state = makeState({ phase: "ROLLING", players: [player] });
      expect(bot.decide(player, state)).toBe("TRY_DOUBLE");
    });
  });

  // ─────────────────────── BUY_DECISION ───────────────────────
  describe("BUY_DECISION phase", () => {
    it("BUY, если хватает денег с запасом 200₽", () => {
      const cell = makeCell({ price: 200 });
      const player = makePlayer({ position: 0, money: 1500 });
      player.properties = [];
      const board = makeMonopolyBoard(3);
      board[0] = cell;
      const state = makeState({
        phase: "BUY_DECISION",
        players: [player],
        board,
      });
      expect(bot.decide(player, state)).toBe("BUY");
    });

    it("DECLINE_BUY (отказ), если денег впритык", () => {
      const cell = makeCell({ price: 200 });
      const player = makePlayer({ position: 0, money: 200 }); // ровно впритык
      const board = makeMonopolyBoard(3);
      board[0] = cell;
      const state = makeState({
        phase: "BUY_DECISION",
        players: [player],
        board,
      });
      // Раньше возвращался "END_TURN", что приводило к ForbiddenException
      // (END_TURN недопустим в BUY_DECISION) и зависанию бота после дубля +
      // карточки move-relative (бот терял право на ещё один бросок).
      // Корректно: фаза BUY_DECISION принимает только BUY_PROPERTY/DECLINE_BUY.
      expect(bot.decide(player, state)).toBe("DECLINE_BUY");
    });

    it("DECLINE_BUY, если у клетки уже есть владелец", () => {
      const cell = makeCell({ price: 200, ownerId: "another" });
      const player = makePlayer({ position: 0, money: 1500 });
      const board = makeMonopolyBoard(3);
      board[0] = cell;
      const state = makeState({
        phase: "BUY_DECISION",
        players: [player],
        board,
      });
      expect(bot.decide(player, state)).toBe("DECLINE_BUY");
    });
  });

  // ─────────────────────── JAIL_DECISION ───────────────────────
  describe("JAIL_DECISION phase", () => {
    it("USE_CARD имеет приоритет над штрафом", () => {
      const player = makePlayer({ jailCards: 1, money: 1500 });
      const state = makeState({ phase: "JAIL_DECISION", players: [player] });
      expect(bot.decide(player, state)).toBe("USE_CARD");
    });

    it("PAY_FINE, если денег достаточно и нет карточки", () => {
      const player = makePlayer({ jailCards: 0, money: 100 });
      const state = makeState({ phase: "JAIL_DECISION", players: [player] });
      expect(bot.decide(player, state)).toBe("PAY_FINE");
    });

    it("TRY_DOUBLE, если нечем платить и нет карточки", () => {
      const player = makePlayer({ jailCards: 0, money: 10 });
      const state = makeState({ phase: "JAIL_DECISION", players: [player] });
      expect(bot.decide(player, state)).toBe("TRY_DOUBLE");
    });
  });

  // ─────────────────────── BUILDING ───────────────────────
  describe("BUILDING phase", () => {
    it("строит дом, если есть монополия и деньги", () => {
      const board = makeMonopolyBoard(3);
      const player = makePlayer({ money: 1500, properties: [0, 1, 2] });
      board[0].ownerId = player.id;
      board[1].ownerId = player.id;
      board[2].ownerId = player.id;
      const state = makeState({
        phase: "BUILDING",
        players: [player],
        board,
      });
      const decision = bot.decide(player, state);
      expect(decision).toMatchObject({ kind: "BUILD_HOUSE", cellId: expect.any(Number) });
    });

    it("UNMORTGAGE, если монополия есть, но дома все по 5, и есть заложенное", () => {
      const board = makeMonopolyBoard(3);
      const player = makePlayer({ money: 1500, properties: [0, 1, 2] });
      board[0].ownerId = player.id;
      board[1].ownerId = player.id;
      board[2].ownerId = player.id;
      board[0].houses = 5;
      board[1].houses = 5;
      board[2].houses = 5;
      // Сделаем одну клетку заложенной, чтобы был кандидат на unmortgage.
      board[1].isMortgaged = true;
      const state = makeState({
        phase: "BUILDING",
        players: [player],
        board,
      });
      const decision = bot.decide(player, state);
      expect(decision).toMatchObject({ kind: "UNMORTGAGE", cellId: expect.any(Number) });
    });

    it("END_TURN, если строить нечего", () => {
      const board = makeMonopolyBoard(3);
      const player = makePlayer({ money: 1500, properties: [] });
      const state = makeState({
        phase: "BUILDING",
        players: [player],
        board,
      });
      expect(bot.decide(player, state)).toBe("END_TURN");
    });
  });

  // ─────────────────────── AUCTION ───────────────────────
  describe("AUCTION_ACTIVE phase", () => {
    /**
     * Фабрика состояния «активный аукцион» v2.
     * По умолчанию:
     *  - 2 игрока: me (id="me"), other (id="other");
     *  - cellId=0 (моно-доска makeMonopolyBoard(3), базовая цена 200₽);
     *  - me — текущий «на часах» (currentBidderId="me");
     *  - currentBid=0, highestBidderId=null;
     *  - оба участника активны.
     */
    function makeAuctionState(
      overrides: Partial<{
        currentBid: number;
        highestBidderId: string | null;
        activeBidders: string[];
        currentBidderId: string | null;
        meMoney: number;
      }> = {},
    ): GameState {
      const me = makePlayer({ id: "me", money: overrides.meMoney ?? 1500 });
      const other = makePlayer({ id: "other", money: 1500 });
      const board = makeMonopolyBoard(3);
      const activeBidders = overrides.activeBidders ?? [me.id, other.id];
      const currentBidderId = overrides.currentBidderId ?? me.id;
      const currentBidderIndex = Math.max(0, activeBidders.indexOf(currentBidderId));
      return makeState({
        phase: "AUCTION_ACTIVE",
        currentPlayerIndex: 0,
        players: [me, other],
        board,
        auction: {
          id: "auc1",
          cellId: 0,
          initiatorId: "other",
          status: "AUCTION_ACTIVE",
          currentBid: overrides.currentBid ?? 0,
          highestBidderId: overrides.highestBidderId ?? null,
          bidderOrder: [me.id, other.id],
          activeBidders,
          currentBidderIndex,
          currentBidderId,
          timerStartedAt: Date.now(),
          turnDurationMs: 30000,
          actionLog: [],
          winnerId: null,
          finalBid: 0,
          finishReason: null,
          startedAt: Date.now(),
          closedAt: null,
        },
      });
    }

    it("PASS, если бот уже лидирует (не перебивает сам себя)", () => {
      const state = makeAuctionState({ currentBid: 50, highestBidderId: "me" });
      const me = state.players[0]!;
      expect(bot.decide(me, state)).toBe("AUCTION_PASS");
    });

    it("BID c amount=10, если цена ниже 80% от базовой (на пустой клетке)", () => {
      // cellId=0, price=200, 80% = 160. currentBid=0, nextBid = 10.
      // 10 <= 160, и auctionWorthBidding (без группы → 10 <= 100) →
      // возвращаем объект с amount=10.
      const state = makeAuctionState({ currentBid: 0, highestBidderId: null });
      const me = state.players[0]!;
      const decision = bot.decide(me, state) as Extract<BotDecision, { kind: "AUCTION_BID" }>;
      expect(decision).toEqual({ kind: "AUCTION_BID", amount: 10 });
    });

    it("PASS, если минимальная ставка выше 80% от базовой", () => {
      // currentBid=170, инкремент = max(10, 200*0.05) = 10 → nextBid=180.
      // 180 > 160 (80% от 200) → PASS.
      const state = makeAuctionState({ currentBid: 170, highestBidderId: "other" });
      const me = state.players[0]!;
      expect(bot.decide(me, state)).toBe("AUCTION_PASS");
    });

    it("PASS, если денег впритык (нет запаса 100₽)", () => {
      // currentBid=0 → nextBid=10. Запас в боте = +100, нужно >= 110.
      const state = makeAuctionState({
        currentBid: 0,
        highestBidderId: null,
        meMoney: 100,
      });
      const me = state.players[0]!;
      expect(bot.decide(me, state)).toBe("AUCTION_PASS");
    });
  });
  // ─────────────────────── TRADE ───────────────────────
  describe("TRADING_NEGOTIATE / TRADING_CONFIRM phase", () => {
    it("REJECT, если нет state.trade", () => {
      const me = makePlayer();
      const state = makeState({ phase: "TRADING_NEGOTIATE", players: [me] });
      expect(bot.decide(me, state)).toBe("TRADE_REJECT");
    });

    it("REJECT, если value < 90% от cost", () => {
      const board = makeMonopolyBoard(3);
      // С точки зрения other (recipient, currentPartyId):
      // он отдаёт toProperties=[] (0₽) + toCash=50,
      // получает fromProperties=[0] (200₽) + fromCash=0.
      // value=200, cost=50, 200/50 = 4.0 ≥ 0.9 → ACCEPT. Тест наоборот!
      // Сделаем наоборот: other отдаёт дорогое, получает мало.
      const me = makePlayer({ id: "me", properties: [0] });
      const other = makePlayer({ id: "other", properties: [1] });
      board[0].ownerId = "me";
      board[1].ownerId = "other";
      // me (initiator) отдаёт 200 (cell 0), просит 50₽.
      // other отдаёт 50₽, получает cell 0 (200₽). value=50, cost=200.
      // 50/200 = 0.25 < 0.9 → REJECT.
      const state = makeState({
        phase: "TRADING_NEGOTIATE",
        players: [me, other],
        board,
        trade: {
          initiatorId: "me",
          recipientId: "other",
          currentPartyId: "other",
          offer: { fromProperties: [0], fromCash: 0, toProperties: [], toCash: 50 },
          counterCount: 0,
        },
      });
      // Чтобы other получал МАЛО и отдавал МНОГО — перевернём стороны:
      // Сейчас other получает cell 0 (200₽) и отдаёт 50₽ → ACCEPT.
      // Для REJECT нужна обратная картина: other отдаёт дорогое.
      // other отдаёт cell 1 (200₽) + 0₽, получает 50₽. value=50, cost=200.
      state.trade!.offer = {
        fromProperties: [], // me отдаёт 0
        fromCash: 50, // me даёт 50₽
        toProperties: [1], // me просит cell 1 (200₽)
        toCash: 0,
      };
      // Пересчёт: other (recipient) получает fromProperties=[] (0) + fromCash=50 = 50.
      // other отдаёт toProperties=[1] (200) + toCash=0 = 200. 50/200 = 0.25 < 0.9 → REJECT.
      expect(bot.decide(other, state)).toBe("TRADE_REJECT");
    });

    it("ACCEPT, если value >= 90% от cost", () => {
      const board = makeMonopolyBoard(3);
      // Я получаю клетку 0 (price=200) + 100₽ = 300.
      // Отдаю клетку 1 (price=200) = 200. value/cost = 300/200 = 1.5 → ACCEPT.
      const me = makePlayer({ id: "me", properties: [1] });
      const other = makePlayer({ id: "other", properties: [0] });
      board[0].ownerId = "other";
      board[1].ownerId = "me";
      const state = makeState({
        phase: "TRADING_NEGOTIATE",
        players: [me, other],
        board,
        trade: {
          initiatorId: "other",
          recipientId: "me",
          currentPartyId: "me",
          offer: { fromProperties: [0], fromCash: 100, toProperties: [1], toCash: 0 },
          counterCount: 0,
        },
      });
      expect(bot.decide(me, state)).toBe("TRADE_ACCEPT");
    });

    it("ACCEPT в TRADING_CONFIRM, если инициатор подтверждает", () => {
      const me = makePlayer({ id: "me" });
      const other = makePlayer({ id: "other" });
      const state = makeState({
        phase: "TRADING_CONFIRM",
        players: [me, other],
        trade: {
          initiatorId: "me",
          recipientId: "other",
          currentPartyId: "me",
          offer: { fromProperties: [], fromCash: 0, toProperties: [], toCash: 0 },
          counterCount: 1,
        },
      });
      expect(bot.decide(me, state)).toBe("TRADE_ACCEPT");
    });
  });

  // ─────────────────────── BANKRUPTCY ───────────────────────
  describe("BANKRUPTCY_LIQUIDATE phase", () => {
    function makeBkState(overrides: {
      debt: number;
      money: number;
      propsWithHouses?: number[];
      propsToMortgage?: number[];
    }): {
      state: GameState;
      player: Player;
    } {
      const me = makePlayer({
        id: "me",
        money: overrides.money,
        properties: [...(overrides.propsWithHouses ?? []), ...(overrides.propsToMortgage ?? [])],
      });
      const board = makeMonopolyBoard(4);
      for (const id of overrides.propsWithHouses ?? []) {
        board[id].ownerId = "me";
        board[id].houses = 2;
        board[id].housePrice = 100;
      }
      for (const id of overrides.propsToMortgage ?? []) {
        board[id].ownerId = "me";
        board[id].isMortgaged = false;
        board[id].mortgageValue = 150;
      }
      return {
        player: me,
        state: makeState({
          phase: "BANKRUPTCY_LIQUIDATE",
          players: [me],
          board,
          bankruptcy: { playerId: "me", creditorId: null, debt: overrides.debt, stage: 2 },
        }),
      };
    }

    it("LIQUIDATE_HOUSES, если денег < долга и есть дома", () => {
      const { state, player } = makeBkState({ debt: 1000, money: 100, propsWithHouses: [0] });
      const d = bot.decide(player, state);
      expect(d).toMatchObject({ kind: "LIQUIDATE_HOUSES", cellId: 0 });
    });

    it("MORTGAGE_FOR_BANKRUPTCY, если домов нет, но есть закладываемая собственность", () => {
      const { state, player } = makeBkState({ debt: 1000, money: 100, propsToMortgage: [1] });
      const d = bot.decide(player, state);
      expect(d).toMatchObject({ kind: "MORTGAGE_FOR_BANKRUPTCY", cellId: 1 });
    });

    it("DECLARE_BANKRUPTCY, если нечего продавать/закладывать", () => {
      const { state, player } = makeBkState({ debt: 1000, money: 0 });
      expect(bot.decide(player, state)).toBe("DECLARE_BANKRUPTCY");
    });
  });

  // ─────────────────────── UNKNOWN PHASE ───────────────────────
  it("null для незнакомой фазы", () => {
    const me = makePlayer();
    const state = makeState({ phase: "IDLE", players: [me] });
    expect(bot.decide(me, state)).toBeNull();
  });
});
