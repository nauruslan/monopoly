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
});
