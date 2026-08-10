/**
 * Тесты EmptyDeckPolicy — runtime политика для legacy reshuffle.
 */
import type { GameState, Card } from "@monopoly/shared";
import { CHANCE_CARDS, TREASURY_CARDS } from "@monopoly/shared";
import {
  rebuildLegacyDeck,
  assertLegacyDeckNotEmpty,
  buildReturnedCardsEvents,
  getActivePolicy,
} from "../empty-deck.policy";

function makeState(seed: string = "test-seed"): GameState {
  return {
    id: "g1",
    version: 1,
    seed,
    status: "active",
    currentPlayerIndex: 0,
    phase: "IDLE",
    round: 1,
    players: [],
    board: [],
    settings: {} as GameState["settings"],
    createdAt: "",
    lastActivityAt: "",
    cardDecks: {
      chance: { cards: [], cursor: 0 },
      treasury: { cards: [], cursor: 0 },
      "luxury-tax": { cards: [], cursor: 0 },
    },
  };
}

describe("EmptyDeckPolicy.rebuildLegacyDeck", () => {
  it("возвращает перетасованную колоду с курсором 0", () => {
    const state = makeState("seed-A");
    const result = rebuildLegacyDeck(state, CHANCE_CARDS, "chance");
    expect(result.deck.cards.length).toBe(CHANCE_CARDS.length);
    expect(result.deck.cursor).toBe(0);
    expect(result.reshuffled).toBe(true);
  });

  it("детерминировано по seed: один и тот же seed → одинаковый порядок", () => {
    const stateA = makeState("seed-X");
    const stateB = makeState("seed-X");
    const a = rebuildLegacyDeck(stateA, CHANCE_CARDS, "chance");
    const b = rebuildLegacyDeck(stateB, CHANCE_CARDS, "chance");
    expect(a.deck.cards).toEqual(b.deck.cards);
  });

  it("разные seed → статистически разный порядок", () => {
    const a = rebuildLegacyDeck(makeState("seed-1"), CHANCE_CARDS, "chance");
    const b = rebuildLegacyDeck(makeState("seed-2"), CHANCE_CARDS, "chance");
    expect(a.deck.cards).not.toEqual(b.deck.cards);
  });

  it("работает для TREASURY", () => {
    const state = makeState();
    const result = rebuildLegacyDeck(state, TREASURY_CARDS, "treasury");
    expect(result.deck.cards.length).toBe(TREASURY_CARDS.length);
  });

  it("source может быть пустым (edge case)", () => {
    const state = makeState();
    const result = rebuildLegacyDeck(state, [] as Card[], "chance");
    expect(result.deck.cards).toEqual([]);
    expect(result.deck.cursor).toBe(0);
  });
});

describe("EmptyDeckPolicy.assertLegacyDeckNotEmpty", () => {
  it("не бросает, если колода не пуста", () => {
    expect(() => assertLegacyDeckNotEmpty({ cards: ["x"], cursor: 0 }, "chance")).not.toThrow();
  });

  it("бросает, если колода пуста", () => {
    expect(() => assertLegacyDeckNotEmpty({ cards: [], cursor: 0 }, "chance")).toThrow(/0 cards/);
  });
});

describe("EmptyDeckPolicy.buildReturnedCardsEvents", () => {
  it("строит события с возрастающим toIndex", () => {
    const events = buildReturnedCardsEvents(["c1", "c2", "c3"], "deck-1", 5);
    expect(events).toEqual([
      { cardId: "c1", toIndex: 5 },
      { cardId: "c2", toIndex: 6 },
      { cardId: "c3", toIndex: 7 },
    ]);
  });

  it("пустой массив → пустой результат", () => {
    expect(buildReturnedCardsEvents([], "deck-1", 0)).toEqual([]);
  });
});

describe("EmptyDeckPolicy.getActivePolicy", () => {
  it("после ensureDecksInitialized возвращает SKIP_DRAW", () => {
    const state = makeState();
    const policy = getActivePolicy(state);
    expect(policy).toBe("SKIP_DRAW");
  });
});
