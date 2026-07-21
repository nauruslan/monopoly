/**
 * Unit-тесты для чистого `AuctionEngine` (v2).
 *
 * Новая логика: один проход по `activeBidders` (без понятия «круг»).
 *  - инициализация: инициатор ВКЛЮЧЁН в участники, банкроты исключены;
 *  - placeBid (валидация, обновление currentBid/highestBidderId, сдвиг хода);
 *  - pass (включая timeout, помеченный reason=TIMEOUT в логе);
 *  - НЕТ правила «лидер не может пасовать» (пасует → удаляется из activeBidders);
 *  - закрытие: `activeBidders.length === 1` → SOLD, `=== 0` → UNSOLD;
 *  - обработка ошибок (NOT_ACTIVE / NOT_ON_CLOCK / BID_TOO_LOW / INSUFFICIENT_FUNDS / BANKRUPT / ALREADY_CLOSED);
 *  - иммутабельность: `applyAuctionCommand` не мутирует входной state.auction.
 */
import {
  applyAuctionCommand,
  canCurrentBidderAffordMinBid,
  getOnClock,
  initAuction,
  isParticipant,
  minNextBid,
  type AuctionEngineError,
} from "../handlers/auction.engine";
import type { GameState, Player } from "@monopoly/shared";
import { makeMonopolyBoard, makePlayer, makeState, resetCounters } from "./factories";

describe("AuctionEngine", () => {
  beforeEach(() => {
    resetCounters();
  });

  // ---------------- helpers ----------------
  function makePlayers(): Player[] {
    return [
      makePlayer({ id: "p0", money: 1000 }),
      makePlayer({ id: "p1", money: 1000 }),
      makePlayer({ id: "p2", money: 1000 }),
    ];
  }

  /** Создаёт state с активным аукционом (status: "AUCTION_ACTIVE"). */
  function makeActiveAuction(opts: {
    bidderOrder: string[];
    currentBidderId: string;
    currentBid?: number;
    highestBidderId?: string | null;
    activeBidders?: string[];
  }): GameState {
    const players = makePlayers();
    const state = makeState({ players, board: makeMonopolyBoard(10) });
    const now = 1_000_000;
    state.auction = {
      id: "auc-test",
      cellId: 1,
      initiatorId: opts.bidderOrder[0]!,
      status: "AUCTION_ACTIVE",
      currentBid: opts.currentBid ?? 0,
      highestBidderId: opts.highestBidderId ?? null,
      bidderOrder: opts.bidderOrder,
      activeBidders: opts.activeBidders ?? [...opts.bidderOrder],
      currentBidderIndex: opts.bidderOrder.indexOf(opts.currentBidderId),
      currentBidderId: opts.currentBidderId,
      timerStartedAt: now,
      turnDurationMs: 10_000,
      actionLog: [],
      winnerId: null,
      finalBid: 0,
      finishReason: null,
      startedAt: now,
      closedAt: null,
    };
    return state;
  }

  // ---------------- initAuction ----------------
  describe("initAuction", () => {
    it("включает инициатора в участники, банкротов исключает; первый ход — у инициатора", () => {
      const me = makePlayer({ id: "p0" });
      const p1 = makePlayer({ id: "p1" });
      const p2 = makePlayer({ id: "p2", isBankrupt: true });
      const state: GameState = {
        ...makeState({ players: [me, p1, p2], board: makeMonopolyBoard(10) }),
      };
      const next = initAuction(state, { id: 1 }, me, { turnDurationMs: 10_000 }, 1_000_000);
      expect(next).not.toBeNull();
      // Инициатор ВКЛЮЧЁН, банкрот p2 — нет. Порядок: инициатор → p1.
      expect(next!.auction!.bidderOrder).toEqual(["p0", "p1"]);
      expect(next!.auction!.currentBidderId).toBe("p0");
      // Активные = bidderOrder (init phase: оба живы).
      expect(next!.auction!.activeBidders).toEqual(["p0", "p1"]);
      expect(next!.auction!.status).toBe("AWAITING_START");
    });

    it("начинает с инициатора даже если он не первый в общем списке игроков", () => {
      const p0 = makePlayer({ id: "p0" });
      const me = makePlayer({ id: "p1" }); // инициатор — p1
      const p2 = makePlayer({ id: "p2" });
      const state: GameState = {
        ...makeState({ players: [p0, me, p2], board: makeMonopolyBoard(10) }),
      };
      const next = initAuction(state, { id: 1 }, me, { turnDurationMs: 10_000 }, 1_000_000);
      expect(next).not.toBeNull();
      // Порядок ротирован от инициатора: p1 → p2 → p0
      expect(next!.auction!.bidderOrder).toEqual(["p1", "p2", "p0"]);
      expect(next!.auction!.currentBidderId).toBe("p1");
    });

    it("создаёт аукцион, даже если участник только сам инициатор", () => {
      const me = makePlayer({ id: "p0" });
      const p1 = makePlayer({ id: "p1", isBankrupt: true });
      const state = makeState({ players: [me, p1] });
      const next = initAuction(state, { id: 1 }, me, { turnDurationMs: 10_000 });
      expect(next).not.toBeNull();
      expect(next!.auction!.bidderOrder).toEqual(["p0"]);
      expect(next!.auction!.currentBidderId).toBe("p0");
    });

    it("возвращает null, если все игроки — банкроты", () => {
      const me = makePlayer({ id: "p0", isBankrupt: true });
      const p1 = makePlayer({ id: "p1", isBankrupt: true });
      const state = makeState({ players: [me, p1] });
      const next = initAuction(state, { id: 1 }, me, { turnDurationMs: 10_000 });
      expect(next).toBeNull();
    });
  });

  // ---------------- placeBid ----------------
  describe("placeBid", () => {
    it("обновляет ставку, лидера и передаёт ход", () => {
      const state = makeActiveAuction({
        bidderOrder: ["p0", "p1", "p2"],
        currentBidderId: "p0",
      });
      const result = applyAuctionCommand(state, {
        type: "placeBid",
        playerId: "p0",
        amount: 50,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const a = result.state.auction!;
      expect(a.currentBid).toBe(50);
      expect(a.highestBidderId).toBe("p0");
      expect(a.actionLog).toHaveLength(1);
      expect(a.actionLog[0]!.amount).toBe(50);
      expect(a.actionLog[0]!.action).toBe("BID");
      // Следующий "на часах" — p1
      expect(a.currentBidderId).toBe("p1");
    });

    it("NOT_ON_CLOCK, если игрок не на часах", () => {
      const state = makeActiveAuction({
        bidderOrder: ["p0", "p1"],
        currentBidderId: "p0",
      });
      const r = applyAuctionCommand(state, {
        type: "placeBid",
        playerId: "p1",
        amount: 50,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe<AuctionEngineError>("NOT_ON_CLOCK");
    });

    it("BID_TOO_LOW, если ставка равна текущей (строгое правило)", () => {
      const state = makeActiveAuction({
        bidderOrder: ["p0", "p1"],
        currentBidderId: "p1",
        currentBid: 100,
        highestBidderId: "p0",
      });
      const r = applyAuctionCommand(state, {
        type: "placeBid",
        playerId: "p1",
        amount: 100,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe<AuctionEngineError>("BID_TOO_LOW");
    });

    it("INSUFFICIENT_FUNDS, если у игрока не хватает денег", () => {
      const players = makePlayers();
      players[0] = { ...players[0]!, money: 5 };
      const state = makeActiveAuction({
        bidderOrder: ["p0", "p1"],
        currentBidderId: "p0",
      });
      // Подменяем players в state (так как makeActiveAuction создаёт свой)
      state.players = players;
      const r = applyAuctionCommand(state, {
        type: "placeBid",
        playerId: "p0",
        amount: 50,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe<AuctionEngineError>("INSUFFICIENT_FUNDS");
    });

    it("передаёт ход следующему, перебивая лидера", () => {
      const state = makeActiveAuction({
        bidderOrder: ["p0", "p1", "p2"],
        currentBidderId: "p1",
        currentBid: 50,
        highestBidderId: "p0",
      });
      const r = applyAuctionCommand(state, {
        type: "placeBid",
        playerId: "p1",
        amount: 100,
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const a = r.state.auction!;
      // После перебивки все остаются в activeBidders (ставка не выбивает).
      expect(a.activeBidders).toEqual(["p0", "p1", "p2"]);
      expect(a.currentBid).toBe(100);
      expect(a.highestBidderId).toBe("p1");
      // Следующий — p2.
      expect(a.currentBidderId).toBe("p2");
    });
  });

  // ---------------- pass / timeout ----------------
  describe("pass", () => {
    it("пас удаляет игрока из activeBidders и передаёт ход следующему", () => {
      const state = makeActiveAuction({
        bidderOrder: ["p0", "p1", "p2"],
        currentBidderId: "p0",
      });
      const r = applyAuctionCommand(state, { type: "pass", playerId: "p0" });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const a = r.state.auction!;
      expect(a.activeBidders).toEqual(["p1", "p2"]);
      // В логе — запись с action="PASS".
      expect(a.actionLog[0]!.action).toBe("PASS");
      expect(a.actionLog[0]!.playerId).toBe("p0");
      expect(a.currentBidderId).toBe("p1");
    });

    it("лидер тоже может пасовать (больше нет правила LEADER_CANNOT_PASS)", () => {
      const state = makeActiveAuction({
        bidderOrder: ["p0", "p1"],
        currentBidderId: "p0",
        currentBid: 50,
        highestBidderId: "p0",
      });
      const r = applyAuctionCommand(state, { type: "pass", playerId: "p0" });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const a = r.state.auction!;
      // Остался только p1 → SOLD.
      expect(a.status).toBe("FINISHED");
      expect(a.finishReason).toBe("SOLD");
      expect(a.winnerId).toBe("p0");
    });

    it("timeout помечает лог с action=TIMEOUT", () => {
      const state = makeActiveAuction({
        bidderOrder: ["p0", "p1"],
        currentBidderId: "p0",
      });
      const r = applyAuctionCommand(state, { type: "timeout", playerId: "p0" });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const a = r.state.auction!;
      expect(a.actionLog[0]!.action).toBe("TIMEOUT");
      expect(a.activeBidders).toEqual(["p1"]);
    });
  });

  // ---------------- закрытие ----------------
  describe("закрытие", () => {
    it("SOLD, когда остался один активный (после пасов)", () => {
      const state = makeActiveAuction({
        bidderOrder: ["p0", "p1"],
        currentBidderId: "p0",
        currentBid: 50,
        highestBidderId: "p1",
      });
      // p0 пасует → остался только p1 (лидер) → SOLD.
      const r = applyAuctionCommand(state, { type: "pass", playerId: "p0" });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const a = r.state.auction!;
      expect(a.status).toBe("FINISHED");
      expect(a.finishReason).toBe("SOLD");
      expect(a.winnerId).toBe("p1");
      expect(a.finalBid).toBe(50);
      // Деньги списаны, клетка передана
      const winner = r.state.players.find((p) => p.id === "p1")!;
      expect(winner.money).toBe(950);
      expect(winner.properties).toContain(1);
      expect(r.state.board[1]!.ownerId).toBe("p1");
    });

    it("SOLD при первой же ставке, если был только один участник", () => {
      const state = makeActiveAuction({
        bidderOrder: ["p0"],
        currentBidderId: "p0",
      });
      const r = applyAuctionCommand(state, {
        type: "placeBid",
        playerId: "p0",
        amount: 50,
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const a = r.state.auction!;
      expect(a.status).toBe("FINISHED");
      expect(a.finishReason).toBe("SOLD");
      expect(a.winnerId).toBe("p0");
      expect(a.finalBid).toBe(50);
    });

    it("UNSOLD, когда все спасовали без ставок", () => {
      const state = makeActiveAuction({
        bidderOrder: ["p0", "p1"],
        currentBidderId: "p0",
      });
      const r1 = applyAuctionCommand(state, { type: "pass", playerId: "p0" });
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;
      const r2 = applyAuctionCommand(r1.state, { type: "pass", playerId: "p1" });
      expect(r2.ok).toBe(true);
      if (!r2.ok) return;
      expect(r2.state.auction!.status).toBe("FINISHED");
      expect(r2.state.auction!.finishReason).toBe("UNSOLD");
      expect(r2.state.auction!.winnerId).toBeNull();
      expect(r2.state.board[1]!.ownerId).toBeUndefined();
    });

    it("ALREADY_CLOSED, если приходит команда после sold/unsold", () => {
      const state = makeActiveAuction({
        bidderOrder: ["p0", "p1"],
        currentBidderId: "p0",
        currentBid: 50,
        highestBidderId: "p1",
      });
      const r1 = applyAuctionCommand(state, { type: "pass", playerId: "p0" });
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;
      const r2 = applyAuctionCommand(r1.state, {
        type: "placeBid",
        playerId: "p1",
        amount: 100,
      });
      expect(r2.ok).toBe(false);
      if (!r2.ok) expect(r2.error).toBe<AuctionEngineError>("ALREADY_CLOSED");
    });
  });

  // ---------------- геттеры ----------------
  describe("getters", () => {
    it("minNextBid = currentBid + 1 (новое правило v2: инкремент = 1)", () => {
      const state = makeActiveAuction({
        bidderOrder: ["p0", "p1"],
        currentBidderId: "p0",
        currentBid: 50,
        highestBidderId: "p1",
      });
      expect(minNextBid(state)).toBe(51);
    });

    it("getOnClock = currentBidderId", () => {
      const state = makeActiveAuction({
        bidderOrder: ["p0", "p1"],
        currentBidderId: "p1",
      });
      expect(getOnClock(state)).toBe("p1");
    });

    it("isParticipant проверяет наличие в bidderOrder", () => {
      const state = makeActiveAuction({
        bidderOrder: ["p0", "p1"],
        currentBidderId: "p0",
      });
      expect(isParticipant(state, "p0")).toBe(true);
      expect(isParticipant(state, "p2")).toBe(false);
    });

    it("canCurrentBidderAffordMinBid учитывает текущего и деньги", () => {
      const state = makeActiveAuction({
        bidderOrder: ["p0", "p1"],
        currentBidderId: "p0",
        currentBid: 50,
      });
      // У p0 — 1000₽ (см. makePlayers), хватает на 51.
      expect(canCurrentBidderAffordMinBid(state)).toBe(true);

      // Обнуляем деньги текущего.
      state.players = state.players.map((p) => (p.id === "p0" ? { ...p, money: 50 } : p));
      expect(canCurrentBidderAffordMinBid(state)).toBe(false);
    });
  });

  // ---------------- иммутабельность ----------------
  describe("иммутабельность", () => {
    it("applyAuctionCommand не мутирует входной state.auction", () => {
      const state = makeActiveAuction({
        bidderOrder: ["p0", "p1"],
        currentBidderId: "p0",
      });
      const before = JSON.parse(JSON.stringify(state));
      applyAuctionCommand(state, {
        type: "placeBid",
        playerId: "p0",
        amount: 50,
      });
      expect(state).toEqual(before);
    });
  });
});
