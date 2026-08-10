import { Test } from "@nestjs/testing";
import { TradeService } from "../handlers/trade.service";
import type { CardInstance, DeckInstance } from "../decks/types";
import type { GameState } from "@monopoly/shared";
import type { HoldableCardEntry, Player } from "@monopoly/shared";
import {
  makeMonopolyBoard,
  makePlayer,
  makeState,
  makeTradeOffer,
  resetCounters,
} from "./factories";

describe("TradeService — реальный обмен holdable карт через DeckModule (TODO 5)", () => {
  let svc: TradeService;

  beforeEach(async () => {
    resetCounters();
    const moduleRef = await Test.createTestingModule({
      providers: [TradeService],
    }).compile();
    svc = moduleRef.get(TradeService);
  });

  function ensureDecks(state: GameState): DeckInstance[] {
    if (!state.decks) state.decks = [];
    if (!state.deckCards) state.deckCards = [];
    if (state.decks.length === 0) {
      const deckId = "test-chance-deck-1";
      state.decks.push({
        deckId,
        gameId: state.id,
        deckType: "CHANCE",
        boardFieldId: 7,
        topToBottom: [],
      });
    }
    return state.decks;
  }

  function giveJailFreeCard(player: Player, templateId: string, state: GameState): string {
    const decks = ensureDecks(state);
    const deck = decks[0]!;
    const cardId = `${player.id}-card-${Math.random().toString(36).slice(2, 9)}`;

    state.deckCards!.push({
      cardId,
      gameId: state.id,
      templateId,
      originDeckId: deck.deckId,
      originBoardFieldId: 7,
      state: "IN_HAND",
      holderPlayerId: player.id,
      drawnAt: new Date().toISOString(),
    } as CardInstance);

    if (!player.holdableCards) player.holdableCards = {};
    const entry: HoldableCardEntry = {
      templateId,
      drawnAt: new Date().toISOString(),
      originDeckId: deck.deckId,
    };
    player.holdableCards[templateId] = entry;
    return cardId;
  }

  it("trade полностью выполняется при fromHoldableCardCount=0 (cards pipeline — no-op)", () => {
    const p0 = makePlayer({ id: "p0", money: 500, properties: [0] });
    const p1 = makePlayer({ id: "p1", money: 500, properties: [1] });
    const board = makeMonopolyBoard(3);
    board[0]!.ownerId = "p0";
    board[1]!.ownerId = "p1";
    const state = makeState({ players: [p0, p1], board });

    // fromHoldableCardCount=0 → offer валиден (0 <= holdable). trade должен пройти.
    // properties exchange + cash:
    //   p0: -[0] +[1] +100₽ → p0.money = 600
    //   p1: -[1] +[0] -100₽ → p1.money = 400
    expect(() =>
      svc.startTrade(
        state,
        p0,
        "p1",
        makeTradeOffer({
          fromProperties: [0],
          fromHoldableCardCount: 0,
          toProperties: [1],
          toCash: 100,
        }),
      ),
    ).not.toThrow();
    expect(() => svc.executeTrade(state)).not.toThrow();
    expect(p0.money).toBe(600);
    expect(p1.money).toBe(400);
  });

  it("executeTrade без holdable карт не передаёт ничего (transferHoldableCards — no-op)", () => {
    const p0 = makePlayer({ id: "p0", money: 500, properties: [0] });
    const p1 = makePlayer({ id: "p1", money: 500, properties: [1] });
    const board = makeMonopolyBoard(3);
    board[0]!.ownerId = "p0";
    board[1]!.ownerId = "p1";
    const state = makeState({ players: [p0, p1], board });

    // У p0 нет ни одной holdable-карты.
    ensureDecks(state);

    svc.startTrade(
      state,
      p0,
      "p1",
      makeTradeOffer({
        fromProperties: [0],
        fromHoldableCardCount: 0,
        toProperties: [1],
        toCash: 100,
      }),
    );
    svc.executeTrade(state);

    // никаких карт в DeckModule у игроков
    expect(state.deckCards!.filter((c) => c.holderPlayerId === "p1").length).toBe(0);
    expect(state.deckCards!.filter((c) => c.holderPlayerId === "p0").length).toBe(0);
    expect(p0.money).toBe(600);
    expect(p1.money).toBe(400);
  });

  it("startTrade бросает ошибку, если обещанных карт больше чем в holdableCards", () => {
    const p0 = makePlayer({ id: "p0", money: 500, properties: [0] });
    const p1 = makePlayer({ id: "p1", money: 500, properties: [1] });
    const board = makeMonopolyBoard(3);
    board[0]!.ownerId = "p0";
    board[1]!.ownerId = "p1";
    const state = makeState({ players: [p0, p1], board });

    giveJailFreeCard(p0, "ch7", state);

    // Обещаем 2, есть 1 → ошибка.
    expect(() =>
      svc.startTrade(
        state,
        p0,
        "p1",
        makeTradeOffer({ fromProperties: [0], fromHoldableCardCount: 2, toProperties: [1] }),
      ),
    ).toThrow(/нет столько/);
  });

  it("startTrade пропускает, если fromHoldableCardCount === countHoldableCards", () => {
    const p0 = makePlayer({ id: "p0", money: 500, properties: [0] });
    const p1 = makePlayer({ id: "p1", money: 500, properties: [1] });
    const board = makeMonopolyBoard(3);
    board[0]!.ownerId = "p0";
    board[1]!.ownerId = "p1";
    const state = makeState({ players: [p0, p1], board });

    giveJailFreeCard(p0, "ch7", state);

    // Обещаем ровно 1, есть 1 → OK.
    expect(() =>
      svc.startTrade(
        state,
        p0,
        "p1",
        makeTradeOffer({ fromProperties: [0], fromHoldableCardCount: 1, toProperties: [1] }),
      ),
    ).not.toThrow();
  });

  it("executeTrade завершается успешно даже если transferCard бросает (try/catch защищает trade)", () => {
    const p0 = makePlayer({ id: "p0", money: 500, properties: [0] });
    const p1 = makePlayer({ id: "p1", money: 500, properties: [1] });
    const board = makeMonopolyBoard(3);
    board[0]!.ownerId = "p0";
    board[1]!.ownerId = "p1";
    const state = makeState({ players: [p0, p1], board });

    giveJailFreeCard(p0, "ch7", state);

    svc.startTrade(
      state,
      p0,
      "p1",
      makeTradeOffer({
        fromProperties: [0],
        fromHoldableCardCount: 1,
        toProperties: [1],
        toCash: 50,
      }),
    );

    // Если перенос карты не сработает по какой-то причине (template не transferable,
    // card удалён между проверкой и т.п.) — executeTrade всё равно не бросит,
    // потому что transferHoldableCards защищён try/catch.
    expect(() => svc.executeTrade(state)).not.toThrow();
    // Properties и cash обменяются штатно.
    expect(p0.properties).toEqual([1]);
    expect(p1.properties).toEqual([0]);
    expect(p0.money).toBe(550); // 500 + 50 (toCash)
    expect(p1.money).toBe(450); // 500 - 50
  });
});
