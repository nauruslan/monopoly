/**
 * Тесты EmptyDeckPolicy — runtime политика для DeckModule.
 */
import type { GameState } from "@monopoly/shared";
import { buildReturnedCardsEvents, getActivePolicy } from "../empty-deck.policy";

function makeState(): GameState {
  return {
    id: "g1",
    version: 1,
    seed: "test-seed",
    status: "active",
    currentPlayerIndex: 0,
    phase: "IDLE",
    round: 1,
    players: [],
    board: [],
    settings: {} as GameState["settings"],
    createdAt: "",
    lastActivityAt: "",
  };
}

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
