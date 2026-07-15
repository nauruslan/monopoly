import { Test } from "@nestjs/testing";
import { AuctionService } from "../handlers/auction.service";
import { makeCell, makeMonopolyBoard, makePlayer, makeState, resetCounters } from "./factories";
import type { GameState, Player } from "@monopoly/shared";

describe("AuctionService", () => {
  let svc: AuctionService;

  beforeEach(async () => {
    resetCounters();
    const moduleRef = await Test.createTestingModule({
      providers: [AuctionService],
    }).compile();
    svc = moduleRef.get(AuctionService);
  });

  describe("startAuction", () => {
    it("создаёт state.auction, исключая инициатора и банкротов", () => {
      const me = makePlayer({ id: "p0" });
      const p1 = makePlayer({ id: "p1" });
      const p2 = makePlayer({ id: "p2", isBankrupt: true });
      const cell = makeCell();
      const state = makeState({ players: [me, p1, p2] });

      svc.startAuction(state, cell, me);

      expect(state.auction).toBeDefined();
      expect(state.auction!.cellId).toBe(cell.id);
      expect(state.auction!.currentBid).toBe(0);
      expect(state.auction!.highestBidderId).toBeNull();
      // Активные участники: только p1 (без me и без банкрота p2)
      expect(state.auction!.activeBidders).toEqual(["p1"]);
      expect(state.auction!.bidderOrder).toEqual(["p1"]);
    });

    it("не создаёт state.auction, если нет активных участников", () => {
      const me = makePlayer({ id: "p0" });
      const p1 = makePlayer({ id: "p1", isBankrupt: true });
      const cell = makeCell();
      const state = makeState({ players: [me, p1] });

      svc.startAuction(state, cell, me);

      expect(state.auction).toBeUndefined();
    });
  });

  describe("resolveAuction", () => {
    it("передаёт клетку победителю и списывает деньги", () => {
      const me = makePlayer({ id: "p0", money: 1000 });
      const winner = makePlayer({ id: "p1", money: 1000 });
      const cell = makeCell({ id: 5, price: 200 });
      const state = makeState({
        players: [me, winner],
        board: makeMonopolyBoard(10).map((c, i) => (i === 5 ? cell : c)),
      });
      state.auction = {
        cellId: 5,
        currentBid: 150,
        highestBidderId: "p1",
        bidderOrder: ["p1"],
        currentBidderIndex: 0,
        activeBidders: ["p1"],
        bidDeadline: new Date(Date.now() + 1000).toISOString(),
      };

      svc.resolveAuction(state);

      // resolveAuction НЕ очищает state.auction — это делает вызывающий код
      // (games.service.ts) при переходе AUCTION_RESOLVE → END_TURN.
      // Мы проверяем только side-effects: деньги списаны, клетка передана.
      expect(state.players[1]!.money).toBe(850); // 1000 - 150
      expect(state.players[1]!.properties).toContain(5);
      expect(state.board[5]!.ownerId).toBe("p1");
    });

    it("оставляет клетку у Банка, если нет победителя", () => {
      const me = makePlayer({ id: "p0" });
      const cell = makeCell({ id: 5 });
      const state = makeState({
        players: [me],
        board: makeMonopolyBoard(10).map((c, i) => (i === 5 ? cell : c)),
      });
      state.auction = {
        cellId: 5,
        currentBid: 0,
        highestBidderId: null,
        bidderOrder: [],
        currentBidderIndex: 0,
        activeBidders: [],
        bidDeadline: new Date(Date.now() + 1000).toISOString(),
      };

      svc.resolveAuction(state);

      // Клетка не передана никому, владелец остаётся undefined
      expect(state.board[5]!.ownerId).toBeUndefined();
    });
  });

  describe("isCurrentBidderAffordable", () => {
    it("true, если у текущего участника хватает денег на минимальную ставку", () => {
      // currentBidderIndex указывает на позицию в массиве players (НЕ в activeBidders!)
      // state.auction.currentBidderIndex=0 → players[0]
      const me = makePlayer({ id: "p0", money: 100 });
      const state = makeState({ players: [me] });
      state.auction = {
        cellId: 0,
        currentBid: 50,
        highestBidderId: null,
        bidderOrder: ["p0"],
        currentBidderIndex: 0,
        activeBidders: ["p0"],
        bidDeadline: new Date(Date.now() + 1000).toISOString(),
      };
      expect(svc.isCurrentBidderAffordable(state)).toBe(true);
    });

    it("false, если у текущего участника не хватает денег", () => {
      const me = makePlayer({ id: "p0", money: 10 });
      const state = makeState({ players: [me] });
      state.auction = {
        cellId: 0,
        currentBid: 50,
        highestBidderId: null,
        bidderOrder: ["p0"],
        currentBidderIndex: 0,
        activeBidders: ["p0"],
        bidDeadline: new Date(Date.now() + 1000).toISOString(),
      };
      expect(svc.isCurrentBidderAffordable(state)).toBe(false);
    });

    it("false, если state.auction отсутствует", () => {
      const me = makePlayer({ id: "p0", money: 1000 });
      const state = makeState({ players: [me] });
      expect(svc.isCurrentBidderAffordable(state)).toBe(false);
    });
  });
});
