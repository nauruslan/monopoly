import { Test } from "@nestjs/testing";
import { TradeService } from "../handlers/trade.service";
import {
  makeCell,
  makeMonopolyBoard,
  makePlayer,
  makeState,
  makeTradeOffer,
  resetCounters,
} from "./factories";
import type { GameState, Player } from "@monopoly/shared";

describe("TradeService", () => {
  let svc: TradeService;

  beforeEach(async () => {
    resetCounters();
    const moduleRef = await Test.createTestingModule({
      providers: [TradeService],
    }).compile();
    svc = moduleRef.get(TradeService);
  });

  describe("startTrade", () => {
    it("создаёт state.trade с валидным оффером", () => {
      const me = makePlayer({ id: "p0", money: 500, properties: [0] });
      const other = makePlayer({ id: "p1", properties: [1] });
      const board = makeMonopolyBoard(3);
      board[0]!.ownerId = "p0";
      board[1]!.ownerId = "p1";
      const state = makeState({ players: [me, other], board });

      svc.startTrade(state, me, "p1", makeTradeOffer({ fromProperties: [0], toProperties: [1] }));

      expect(state.trade).toBeDefined();
      expect(state.trade!.initiatorId).toBe("p0");
      expect(state.trade!.recipientId).toBe("p1");
      expect(state.trade!.currentPartyId).toBe("p1");
      expect(state.trade!.counterCount).toBe(0);
    });

    it("бросает ошибку, если recipient не существует", () => {
      const me = makePlayer({ id: "p0" });
      const state = makeState({ players: [me] });
      expect(() => svc.startTrade(state, me, "ghost", makeTradeOffer())).toThrow();
    });

    it("бросает ошибку, если recipient — сам initiator", () => {
      const me = makePlayer({ id: "p0" });
      const state = makeState({ players: [me] });
      expect(() => svc.startTrade(state, me, "p0", makeTradeOffer())).toThrow(/самим собой/);
    });

    it("бросает ошибку, если recipient обанкротился", () => {
      const me = makePlayer({ id: "p0" });
      const other = makePlayer({ id: "p1", isBankrupt: true });
      const state = makeState({ players: [me, other] });
      expect(() => svc.startTrade(state, me, "p1", makeTradeOffer())).toThrow(/обанкротившимся/);
    });

    it("бросает ошибку, если инициатор не владеет fromProperties", () => {
      const me = makePlayer({ id: "p0", properties: [0] });
      const other = makePlayer({ id: "p1", properties: [1] });
      const board = makeMonopolyBoard(3);
      board[0]!.ownerId = "p0";
      board[1]!.ownerId = "p1";
      const state = makeState({ players: [me, other], board });

      // 2 не принадлежит инициатору
      expect(() =>
        svc.startTrade(state, me, "p1", makeTradeOffer({ fromProperties: [2] })),
      ).toThrow(/не принадлежит инициатору/);
    });

    it("бросает ошибку, если у инициатора не хватает денег", () => {
      const me = makePlayer({ id: "p0", money: 100 });
      const other = makePlayer({ id: "p1" });
      const state = makeState({ players: [me, other] });
      expect(() => svc.startTrade(state, me, "p1", makeTradeOffer({ fromCash: 500 }))).toThrow(
        /Недостаточно денег/,
      );
    });
  });

  describe("makeCounterOffer", () => {
    function makeTradeState(): { state: GameState; p0: Player; p1: Player } {
      const p0 = makePlayer({ id: "p0", money: 500, properties: [0] });
      const p1 = makePlayer({ id: "p1", money: 500, properties: [1] });
      const board = makeMonopolyBoard(3);
      board[0]!.ownerId = "p0";
      board[1]!.ownerId = "p1";
      const state = makeState({ players: [p0, p1], board });
      svc.startTrade(state, p0, "p1", makeTradeOffer({ fromProperties: [0], toProperties: [1] }));
      return { state, p0, p1 };
    }

    it("меняет стороны: текущий получатель становится инициатором", () => {
      const { state } = makeTradeState();
      // Сейчас currentPartyId = p1 (получатель).
      // Делаем counter — инициатором становится p1.
      svc.makeCounterOffer(state, makeTradeOffer({ fromProperties: [1], toProperties: [0] }));
      expect(state.trade!.initiatorId).toBe("p1");
      expect(state.trade!.recipientId).toBe("p0");
      expect(state.trade!.currentPartyId).toBe("p0");
    });

    it("инкрементирует counterCount", () => {
      const { state } = makeTradeState();
      svc.makeCounterOffer(state, makeTradeOffer({ fromProperties: [1], toProperties: [0] }));
      expect(state.trade!.counterCount).toBe(1);
    });
  });

  describe("executeTrade", () => {
    it("передаёт клетки и деньги между сторонами", () => {
      const p0 = makePlayer({ id: "p0", money: 500, properties: [0] });
      const p1 = makePlayer({ id: "p1", money: 500, properties: [1] });
      const board = makeMonopolyBoard(3);
      board[0]!.ownerId = "p0";
      board[1]!.ownerId = "p1";
      const state = makeState({ players: [p0, p1], board });
      svc.startTrade(
        state,
        p0,
        "p1",
        makeTradeOffer({
          fromProperties: [0],
          fromCash: 100,
          toProperties: [1],
          toCash: 50,
        }),
      );

      svc.executeTrade(state);

      // p0 отдал cell 0 и 100₽, получил cell 1 и 50₽
      expect(state.players[0]!.properties).toEqual([1]);
      expect(state.players[0]!.money).toBe(450); // 500 - 100 + 50
      // p1 отдал cell 1 и 50₽, получил cell 0 и 100₽
      expect(state.players[1]!.properties).toEqual([0]);
      expect(state.players[1]!.money).toBe(550); // 500 - 50 + 100
      expect(state.board[0]!.ownerId).toBe("p1");
      expect(state.board[1]!.ownerId).toBe("p0");
    });

    it("no-op, если state.trade отсутствует", () => {
      const p0 = makePlayer({ id: "p0", money: 500 });
      const state = makeState({ players: [p0] });
      // Не должен бросать.
      expect(() => svc.executeTrade(state)).not.toThrow();
    });
  });

  describe("addCashToPlayer (auto debt)", () => {
    it("автоматически погашает долг при поступлении денег", () => {
      const p = makePlayer({ money: 100, currentDebt: 300, creditorId: "bank" });
      const { debtCovered } = TradeService.addCashToPlayer(p, 500);
      expect(debtCovered).toBe(300);
      expect(p.money).toBe(300); // 100 + 500 - 300
      expect(p.currentDebt).toBe(0);
      expect(p.creditorId).toBeNull();
    });

    it("частично погашает долг, если денег меньше долга", () => {
      const p = makePlayer({ money: 50, currentDebt: 200, creditorId: "bank" });
      const { debtCovered } = TradeService.addCashToPlayer(p, 100);
      expect(debtCovered).toBe(100);
      expect(p.money).toBe(50); // 50 + 100 - 100
      expect(p.currentDebt).toBe(100);
      expect(p.creditorId).toBe("bank");
    });

    it("не трагается на долг, если его нет", () => {
      const p = makePlayer({ money: 100 });
      const { debtCovered } = TradeService.addCashToPlayer(p, 50);
      expect(debtCovered).toBe(0);
      expect(p.money).toBe(150);
    });
  });

  describe("toggleBlock", () => {
    it("добавляет и удаляет игрока в блоклист", () => {
      const me = makePlayer({ id: "me" });
      const other = makePlayer({ id: "other" });
      const state = makeState({ players: [me, other] });
      expect(svc.toggleBlock(state, me, "other")).toBe(true);
      expect(me.blockedPlayers).toContain("other");
      expect(svc.toggleBlock(state, me, "other")).toBe(false);
      expect(me.blockedPlayers).not.toContain("other");
    });

    it("бросает ошибку для самого себя", () => {
      const me = makePlayer({ id: "me" });
      const state = makeState({ players: [me] });
      expect(() => svc.toggleBlock(state, me, "me")).toThrow();
    });
  });

  describe("getTradableProperties", () => {
    it("возвращает только клетки без зданий", () => {
      const board = makeMonopolyBoard(3);
      const me = makePlayer({ id: "me", properties: [0, 1, 2] });
      board[0]!.ownerId = "me";
      board[1]!.ownerId = "me";
      board[2]!.ownerId = "me";
      board[1]!.houses = 2; // с домом — не торгуется
      const state = makeState({ players: [me], board });
      const tradable = svc.getTradableProperties(me, state);
      expect(tradable).toContain(0);
      expect(tradable).toContain(2);
      expect(tradable).not.toContain(1);
    });
  });

  describe("executeTrade (debt auto-cover)", () => {
    it("при получении денег долг автоматически погашается", () => {
      const p0 = makePlayer({ id: "p0", money: 0, properties: [0], currentDebt: 100, creditorId: "bank" });
      const p1 = makePlayer({ id: "p1", money: 500, properties: [1] });
      const board = makeMonopolyBoard(3);
      board[0]!.ownerId = "p0";
      board[1]!.ownerId = "p1";
      const state = makeState({ players: [p0, p1], board });
      svc.startTrade(
        state,
        p0,
        "p1",
        makeTradeOffer({
          fromProperties: [0],
          fromCash: 0,
          toProperties: [1],
          toCash: 200,
        }),
      );
      svc.executeTrade(state);
      // p0 получил 200, но 100 идёт на погашение долга
      expect(p0.money).toBe(100);
      expect(p0.currentDebt).toBe(0);
      expect(p0.creditorId).toBeNull();
      expect(p0.properties).toEqual([1]);
    });
  });
});
