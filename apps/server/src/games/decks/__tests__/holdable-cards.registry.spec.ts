/**
 * Тесты HoldableCardsRegistry.
 */
import type { Player, GameState } from "@monopoly/shared";
import { CHANCE_CARDS, TREASURY_CARDS, LUXURY_TAX_CARDS } from "@monopoly/shared";
import { ensureDecksInitialized } from "../deck-state-adapter";
import {
  countHoldableCards,
  syncHoldableCards,
  backfillHoldableCards,
  hasHoldableCard,
  listHoldableCardIds,
  getFirstHoldableLegacyCard,
} from "../holdable-cards.registry";
import "../holdable-cards.registry"; // side-effect: register declarations

function makePlayer(overrides: Partial<Player> = {}): Player {
  return {
    id: "p1",
    displayName: "Player 1",
    kind: "human",
    color: "#fff",
    icon: "🔴",
    money: 1500,
    position: 0,
    inJail: false,
    jailTurns: 0,
    properties: [],
    consecutiveDoubles: 0,
    isBankrupt: false,
    ...overrides,
  } as Player;
}

function makeState(): GameState {
  return {
    id: "g1",
    version: 1,
    seed: "test-seed",
    status: "waiting",
    currentPlayerIndex: 0,
    phase: "IDLE",
    round: 1,
    players: [],
    board: [],
    settings: {} as GameState["settings"],
    createdAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    cardDecks: {
      chance: { cards: CHANCE_CARDS.map((c) => c.id), cursor: 0 },
      treasury: { cards: TREASURY_CARDS.map((c) => c.id), cursor: 0 },
      "luxury-tax": { cards: LUXURY_TAX_CARDS.map((c) => c.id), cursor: 0 },
    },
  } as GameState;
}

function ch7Holdable(): Record<
  string,
  { templateId: string; drawnAt: string; originDeckId: string }
> {
  return {
    ch7: { templateId: "ch7", drawnAt: "2025-01-01", originDeckId: "d1" },
  };
}

describe("HoldableCardsRegistry.countHoldableCards", () => {
  it("возвращает 0 для игрока без карт", () => {
    const player = makePlayer();
    expect(countHoldableCards(player)).toBe(0);
  });

  it("возвращает 1, если holdableCards содержит одну запись", () => {
    const player = makePlayer({ holdableCards: ch7Holdable() });
    expect(countHoldableCards(player)).toBe(1);
  });

  it("возвращает размер holdableCards, если он инициализирован", () => {
    const player = makePlayer({
      holdableCards: {
        "card-1": { templateId: "ch7", drawnAt: "2025-01-01", originDeckId: "" },
        "card-2": { templateId: "ch7", drawnAt: "2025-01-01", originDeckId: "" },
        "card-3": { templateId: "ch7", drawnAt: "2025-01-01", originDeckId: "" },
      },
    });
    expect(countHoldableCards(player)).toBe(3);
  });

  it("возвращает 0 для пустого holdableCards", () => {
    const player = makePlayer({ holdableCards: {} });
    expect(countHoldableCards(player)).toBe(0);
  });
});

describe("HoldableCardsRegistry.syncHoldableCards", () => {
  it("delta=+1 с templateId+cardId: создаёт новую запись", () => {
    const state = makeState();
    ensureDecksInitialized(state);
    const player = makePlayer();
    syncHoldableCards(player, state, {
      delta: 1,
      templateId: "ch7",
      cardId: "card-1",
    });
    expect(Object.keys(player.holdableCards ?? {}).length).toBe(1);
    expect(player.holdableCards!["card-1"]).toBeDefined();
  });

  it("delta=-1: удаляет запись по cardId", () => {
    const state = makeState();
    const player = makePlayer({ holdableCards: ch7Holdable() });
    syncHoldableCards(player, state, { delta: -1, cardId: "ch7" });
    expect(Object.keys(player.holdableCards ?? {}).length).toBe(0);
  });

  it("delta=-1 без cardId — no-op", () => {
    const state = makeState();
    const player = makePlayer();
    syncHoldableCards(player, state, { delta: -1 });
    expect(Object.keys(player.holdableCards ?? {}).length).toBe(0);
  });

  it("delta=+1 с templateId+cardId: инициализирует holdableCards и holdableCardsByPlayer", () => {
    const state = makeState();
    ensureDecksInitialized(state);
    const player = makePlayer();
    syncHoldableCards(player, state, {
      delta: 1,
      templateId: "ch7",
      cardId: "test-card-1",
    });
    expect(Object.keys(player.holdableCards ?? {}).length).toBe(1);
    expect(player.holdableCards).toBeDefined();
    expect(player.holdableCards!["test-card-1"]).toBeDefined();
    expect(player.holdableCards!["test-card-1"]!.templateId).toBe("ch7");
    expect(state.holdableCardsByPlayer).toBeDefined();
    expect(state.holdableCardsByPlayer![player.id]).toContain("test-card-1");
  });

  it("delta=-1 с templateId+cardId: убирает карту из обоих слоёв", () => {
    const state = makeState();
    ensureDecksInitialized(state);
    const player = makePlayer({
      holdableCards: {
        "test-card-1": { templateId: "ch7", drawnAt: "2025-01-01", originDeckId: "" },
      },
    });
    state.holdableCardsByPlayer = { [player.id]: ["test-card-1"] };

    syncHoldableCards(player, state, {
      delta: -1,
      templateId: "ch7",
      cardId: "test-card-1",
    });

    expect(Object.keys(player.holdableCards ?? {}).length).toBe(0);
    expect(player.holdableCards!["test-card-1"]).toBeUndefined();
    expect(state.holdableCardsByPlayer![player.id]).not.toContain("test-card-1");
  });
});

describe("HoldableCardsRegistry.backfillHoldableCards", () => {
  it("создаёт placeholder-записи для игроков с holdableCards", () => {
    const state = makeState();
    state.players = [
      makePlayer({ id: "p1", holdableCards: ch7Holdable() }),
      makePlayer({ id: "p2" }),
    ];
    ensureDecksInitialized(state);
    backfillHoldableCards(state);
    expect(state.players[0]!.holdableCards).toBeDefined();
    expect(Object.keys(state.players[0]!.holdableCards!).length).toBe(1);
  });

  it("создаёт пустой holdableCards, если его нет", () => {
    const state = makeState();
    state.players = [makePlayer({ id: "p1" })];
    ensureDecksInitialized(state);
    backfillHoldableCards(state);
    expect(state.players[0]!.holdableCards).toBeDefined();
    expect(Object.keys(state.players[0]!.holdableCards!).length).toBe(0);
  });

  it("не трогает существующий holdableCards (с ch7)", () => {
    const state = makeState();
    state.players = [makePlayer({ id: "p1", holdableCards: ch7Holdable() })];
    ensureDecksInitialized(state);
    backfillHoldableCards(state);
    expect(state.players[0]!.holdableCards!["ch7"]).toBeDefined();
  });

  it("no-op если DeckModule не инициализирован (нет deckCards)", () => {
    const state = makeState();
    state.players = [makePlayer({ id: "p1" })];
    // Не вызываем ensureDecksInitialized.
    backfillHoldableCards(state);
    expect(state.players[0]!.holdableCards).toBeUndefined();
  });
});

describe("HoldableCardsRegistry.hasHoldableCard", () => {
  it("возвращает true, если cardId есть в holdableCards", () => {
    const player = makePlayer({
      holdableCards: {
        "card-x": { templateId: "ch7", drawnAt: "", originDeckId: "" },
      },
    });
    expect(hasHoldableCard(player, "card-x")).toBe(true);
  });

  it("возвращает false, если cardId нет", () => {
    const player = makePlayer({
      holdableCards: {
        "card-x": { templateId: "ch7", drawnAt: "", originDeckId: "" },
      },
    });
    expect(hasHoldableCard(player, "card-y")).toBe(false);
  });

  it("false, если holdableCards пуст", () => {
    const player = makePlayer({ holdableCards: {} });
    expect(hasHoldableCard(player, "any")).toBe(false);
  });
});

describe("HoldableCardsRegistry.listHoldableCardIds", () => {
  it("возвращает ключи holdableCards", () => {
    const player = makePlayer({
      holdableCards: {
        "card-1": { templateId: "ch7", drawnAt: "", originDeckId: "" },
        "card-2": { templateId: "ch7", drawnAt: "", originDeckId: "" },
      },
    });
    expect(listHoldableCardIds(player).sort()).toEqual(["card-1", "card-2"]);
  });

  it("возвращает пустой массив, если holdableCards пуст", () => {
    const player = makePlayer({ holdableCards: {} });
    expect(listHoldableCardIds(player)).toEqual([]);
  });

  it("возвращает пустой массив, если holdableCards undefined", () => {
    const player = makePlayer();
    expect(listHoldableCardIds(player)).toEqual([]);
  });
});

describe("HoldableCardsRegistry.getFirstHoldableLegacyCard", () => {
  it("возвращает первую карту и её legacy Card", () => {
    const player = makePlayer({
      holdableCards: {
        "card-1": { templateId: "ch7", drawnAt: "", originDeckId: "" },
      },
    });
    const result = getFirstHoldableLegacyCard(player);
    expect(result).not.toBeNull();
    expect(result!.cardId).toBe("card-1");
    expect(result!.card).not.toBeNull();
    expect(result!.card!.id).toBe("ch7");
  });

  it("возвращает null, если нет карт", () => {
    const player = makePlayer();
    expect(getFirstHoldableLegacyCard(player)).toBeNull();
  });
});
