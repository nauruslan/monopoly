import { Test } from "@nestjs/testing";
import { AuctionService, type AuctionEvent } from "../handlers/auction.service";
import { makeCell, makeMonopolyBoard, makePlayer, makeState, resetCounters } from "./factories";
import { canCurrentBidderAffordMinBid } from "../handlers/auction.engine";
import type { GameState } from "@monopoly/shared";

/** Помощник: дефолтный `state.auction` для тестов (status: AUCTION_ACTIVE). */
function makeAuctionContext(overrides: Partial<NonNullable<GameState["auction"]>> = {}) {
  const now = 1_000_000;
  const base = {
    id: "auc-test",
    cellId: 0,
    initiatorId: "p0",
    status: "AUCTION_ACTIVE" as const,
    currentBid: 0,
    highestBidderId: null,
    bidderOrder: [] as string[],
    activeBidders: [] as string[],
    currentBidderIndex: -1,
    currentBidderId: null,
    timerStartedAt: now,
    turnDurationMs: 10_000,
    actionLog: [],
    winnerId: null,
    finalBid: 0,
    finishReason: null,
    startedAt: now,
    closedAt: null,
  };
  return { ...base, ...overrides } as NonNullable<GameState["auction"]>;
}

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
    it("включает инициатора в участники, банкротов исключает; первый ход — у инициатора", () => {
      const me = makePlayer({ id: "p0" });
      const p1 = makePlayer({ id: "p1" });
      const p2 = makePlayer({ id: "p2", isBankrupt: true });
      const cell = makeCell();
      const state = makeState({ players: [me, p1, p2] });

      const ok = svc.startAuction("game1", state, cell, me, 1_000_000);
      expect(ok).toBe(true);
      expect(state.auction).toBeDefined();
      expect(state.auction!.cellId).toBe(cell.id);
      expect(state.auction!.currentBid).toBe(0);
      expect(state.auction!.highestBidderId).toBeNull();
      // Активные участники: инициатор p0 + p1 (p2 — банкрот).
      // Порядок ротирован от инициатора.
      expect(state.auction!.bidderOrder).toEqual(["p0", "p1"]);
      expect(state.auction!.activeBidders).toEqual(["p0", "p1"]);
      expect(state.auction!.currentBidderId).toBe("p0");
      // Сервис сразу активирует (AWAITING_START → AUCTION_ACTIVE).
      expect(state.auction!.status).toBe("AUCTION_ACTIVE");
    });

    it("создаёт state.auction, даже если участник только сам инициатор", () => {
      const me = makePlayer({ id: "p0" });
      const p1 = makePlayer({ id: "p1", isBankrupt: true });
      const cell = makeCell();
      const state = makeState({ players: [me, p1] });

      const ok = svc.startAuction("game1", state, cell, me);
      expect(ok).toBe(true);
      expect(state.auction).toBeDefined();
      expect(state.auction!.bidderOrder).toEqual(["p0"]);
      expect(state.auction!.currentBidderId).toBe("p0");
    });

    it("не создаёт state.auction, если все игроки — банкроты", () => {
      const me = makePlayer({ id: "p0", isBankrupt: true });
      const p1 = makePlayer({ id: "p1", isBankrupt: true });
      const cell = makeCell();
      const state = makeState({ players: [me, p1] });

      const ok = svc.startAuction("game1", state, cell, me);
      expect(ok).toBe(false);
      expect(state.auction).toBeUndefined();
    });

    it("рассылает AUCTION_START + AUCTION_TURN_UPDATE через onAuctionEvent", () => {
      const me = makePlayer({ id: "p0" });
      const p1 = makePlayer({ id: "p1" });
      const cell = makeCell();
      const state = makeState({ players: [me, p1] });

      const events: AuctionEvent[] = [];
      svc.onAuctionEvent = (_gid, ev) => events.push(ev);

      svc.startAuction("gameX", state, cell, me, 1_700_000_000_000);

      const types = events.map((e) => e.type);
      expect(types).toContain("AUCTION_START");
      expect(types).toContain("AUCTION_TURN_UPDATE");

      const start = events.find((e) => e.type === "AUCTION_START")!;
      if (start.type === "AUCTION_START") {
        expect(start.firstBidderId).toBe("p0");
        expect(start.participants).toEqual(["p0", "p1"]);
      }
    });
  });

  describe("applyCommand (sell path)", () => {
    it("передаёт клетку победителю и списывает деньги через движок", () => {
      const me = makePlayer({ id: "p0", money: 1000 });
      const winner = makePlayer({ id: "p1", money: 1000 });
      const cell = makeCell({ id: 5, price: 200 });
      const state: GameState = makeState({
        players: [me, winner],
        board: makeMonopolyBoard(10).map((c, i) => (i === 5 ? cell : c)),
      });
      // p1 — на часах, лидер пока никто. После placeBid аукцион
      // должен сразу закрыться (sold), т.к. других активных нет.
      state.auction = makeAuctionContext({
        cellId: 5,
        bidderOrder: ["p1"],
        currentBidderId: "p1",
        activeBidders: ["p1"],
        currentBidderIndex: 0,
        status: "AUCTION_ACTIVE",
        currentBid: 0,
        highestBidderId: null,
      });

      const r = svc.applyCommand("game1", state, {
        type: "placeBid",
        playerId: "p1",
        amount: 150,
      });
      expect(r.ok).toBe(true);

      // Движок сам перевёл в FINISHED, передал клетку и списал деньги.
      expect(state.auction!.status).toBe("FINISHED");
      expect(state.auction!.finishReason).toBe("SOLD");
      expect(state.auction!.winnerId).toBe("p1");
      expect(state.auction!.finalBid).toBe(150);
      expect(state.players[1]!.money).toBe(850); // 1000 - 150
      expect(state.players[1]!.properties).toContain(5);
      expect(state.board[5]!.ownerId).toBe("p1");
    });

    it("закрывает аукцион как unsold, если все спасовали", () => {
      const me = makePlayer({ id: "p0" });
      const p1 = makePlayer({ id: "p1" });
      const state = makeState({ players: [me, p1] });
      state.auction = makeAuctionContext({
        cellId: 5,
        bidderOrder: ["p0", "p1"],
        currentBidderId: "p0",
        activeBidders: ["p0", "p1"],
        currentBidderIndex: 0,
      });

      // p0 пасует → остаётся только p1 (currentBid=0) → ход переходит p1.
      const r1 = svc.applyCommand("game1", state, { type: "pass", playerId: "p0" });
      expect(r1.ok).toBe(true);

      // p1 пасует → никого не осталось → UNSOLD.
      const r2 = svc.applyCommand("game1", state, { type: "pass", playerId: "p1" });
      expect(r2.ok).toBe(true);
      expect(state.auction!.status).toBe("FINISHED");
      expect(state.auction!.finishReason).toBe("UNSOLD");
    });
  });

  describe("canCurrentBidderAffordMinBid (free helper)", () => {
    it("true, если у текущего участника хватает денег на минимальную ставку", () => {
      const me = makePlayer({ id: "p0", money: 100 });
      const state = makeState({ players: [me] });
      state.auction = makeAuctionContext({
        cellId: 0,
        currentBid: 50,
        highestBidderId: null,
        bidderOrder: ["p0"],
        currentBidderId: "p0",
        activeBidders: ["p0"],
        currentBidderIndex: 0,
      });
      expect(canCurrentBidderAffordMinBid(state)).toBe(true);
    });

    it("false, если у текущего участника не хватает денег", () => {
      const me = makePlayer({ id: "p0", money: 10 });
      const state = makeState({ players: [me] });
      state.auction = makeAuctionContext({
        cellId: 0,
        currentBid: 50,
        highestBidderId: null,
        bidderOrder: ["p0"],
        currentBidderId: "p0",
        activeBidders: ["p0"],
        currentBidderIndex: 0,
      });
      expect(canCurrentBidderAffordMinBid(state)).toBe(false);
    });

    it("false, если state.auction отсутствует", () => {
      const me = makePlayer({ id: "p0", money: 1000 });
      const state = makeState({ players: [me] });
      expect(canCurrentBidderAffordMinBid(state)).toBe(false);
    });
  });
});
