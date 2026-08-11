/**
 * Тесты DeckStateAdapter (новый DeckModule, per-field колоды).
 */
import { CHANCE_CARDS, TREASURY_CARDS, LUXURY_TAX_CARDS, type GameState } from "@monopoly/shared";
import { ensureDecksInitialized, setupDecksForBoardPerField } from "../deck-state-adapter";

/**
 * Тестовая утилита: построить минимальный GameState без колод.
 * DeckModule инициализируется независимо.
 */
function makeState(): GameState {
  return {
    id: "g1",
    version: 1,
    seed: "test-seed-12345",
    status: "waiting",
    currentPlayerIndex: 0,
    phase: "IDLE",
    round: 1,
    players: [],
    board: [],
    settings: {} as GameState["settings"],
    createdAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
  };
}

describe("DeckStateAdapter.ensureDecksInitialized", () => {
  it("инициализирует state.decks и state.deckCards из shared-данных (per-field)", () => {
    const state = makeState();
    expect(state.decks).toBeUndefined();
    expect(state.deckCards).toBeUndefined();

    ensureDecksInitialized(state);

    expect(state.decks).toBeDefined();
    // DEFAULT_BOARD: 3 CHANCE + 3 TREASURY + 1 LUXURY_TAX = 7 колод.
    expect(state.decks!.length).toBe(7);
    // 11 CHANCE + 6 TREASURY + 4 LUXURY_TAX = 21 карта.
    expect(state.deckCards!.length).toBe(21);
    expect(state.deckSeed).toBe("test-seed-12345");
  });

  it("создаёт по ОДНОЙ DeckInstance на КАЖДУЮ клетку доски", () => {
    const state = makeState();
    ensureDecksInitialized(state);
    const chanceDecks = state.decks!.filter((d) => d.deckType === "CHANCE");
    const treasuryDecks = state.decks!.filter((d) => d.deckType === "COMMUNITY_CHEST");
    const luxuryDecks = state.decks!.filter((d) => d.deckType === "LUXURY_TAX");
    expect(chanceDecks.length).toBe(3);
    expect(treasuryDecks.length).toBe(3);
    expect(luxuryDecks.length).toBe(1);
    // boardFieldId указывает на клетку, НЕ на -1.
    for (const d of chanceDecks) {
      expect([7, 22, 36]).toContain(d.boardFieldId);
    }
    for (const d of treasuryDecks) {
      expect([2, 17, 33]).toContain(d.boardFieldId);
    }
    for (const d of luxuryDecks) {
      expect(d.boardFieldId).toBe(38);
    }
  });

  it("каждая карта принадлежит только своей колоде (нет «протекания»)", () => {
    const state = makeState();
    ensureDecksInitialized(state);
    const allTopToBottom = state.decks!.flatMap((d) => d.topToBottom);
    const uniqueCards = new Set(allTopToBottom);
    expect(uniqueCards.size).toBe(allTopToBottom.length);

    const allTemplateIds = state.deckCards!.map((c) => c.templateId);
    expect(allTemplateIds.filter((id) => id.startsWith("ch")).length).toBe(11);
    expect(allTemplateIds.filter((id) => id.startsWith("tr")).length).toBe(6);
    expect(allTemplateIds.filter((id) => id.startsWith("lt")).length).toBe(4);
  });

  it("ch10 «назад 5» попадает в CHANCE, а lt1 «налог» — в LUXURY_TAX", () => {
    const state = makeState();
    ensureDecksInitialized(state);
    const ch10 = state.deckCards!.find((c) => c.templateId === "ch10");
    const lt1 = state.deckCards!.find((c) => c.templateId === "lt1");
    expect(ch10).toBeDefined();
    expect(lt1).toBeDefined();
    const ch10Deck = state.decks!.find((d) => d.topToBottom.includes(ch10!.cardId));
    const lt1Deck = state.decks!.find((d) => d.topToBottom.includes(lt1!.cardId));
    expect(ch10Deck!.deckType).toBe("CHANCE");
    expect(lt1Deck!.deckType).toBe("LUXURY_TAX");
  });

  it("ИДЕНТИЧНЫЙ при повторном вызове (lazy+idempotent)", () => {
    const state = makeState();
    const r1 = ensureDecksInitialized(state);
    const r2 = ensureDecksInitialized(state);
    expect(r1.decks).toBe(r2.decks);
    expect(state.decks!.length).toBe(7);
  });
});

describe("DeckStateAdapter.setupDecksForBoardPerField", () => {
  it("строит per-field колоды (одна колода на клетку)", () => {
    const state = makeState();
    const result = setupDecksForBoardPerField(state);
    expect(result.decks.length).toBe(7);
    for (const d of result.decks) {
      expect(d.boardFieldId).toBeGreaterThanOrEqual(0);
    }
  });

  it("для 11 CHANCE-карт на 3 клетки: распределение [4, 4, 3]", () => {
    const state = makeState();
    // Подменяем seed-управляемый источник через смену state.seed нельзя
    // (используется seedrandom по нему), но мы хотим проверить, что
    // распределение работает — заменяем CHANCE_CARDS через прямой вызов
    // setupDecksForBoardPerField с шаблонами.
    const result = setupDecksForBoardPerField(state);
    const chanceDecks = result.decks.filter((d) => d.deckType === "CHANCE");
    expect(chanceDecks.length).toBe(3);
    const sizes = chanceDecks.map((d) => d.topToBottom.length).sort();
    expect(sizes).toEqual([3, 4, 4]);
  });

  it("для 6 TREASURY-карт на 3 клетки: каждая получает ровно 2", () => {
    const state = makeState();
    const result = setupDecksForBoardPerField(state);
    const treasuryDecks = result.decks.filter((d) => d.deckType === "COMMUNITY_CHEST");
    expect(treasuryDecks.length).toBe(3);
    for (const d of treasuryDecks) {
      expect(d.topToBottom.length).toBe(2);
    }
  });

  it("для 4 LUXURY_TAX-карт на 1 клетку: все 4 карты в одной колоде", () => {
    const state = makeState();
    const result = setupDecksForBoardPerField(state);
    const luxuryDecks = result.decks.filter((d) => d.deckType === "LUXURY_TAX");
    expect(luxuryDecks.length).toBe(1);
    expect(luxuryDecks[0]!.boardFieldId).toBe(38);
    expect(luxuryDecks[0]!.topToBottom.length).toBe(4);
  });

  it("детерминированный seed даёт одинаковый порядок", () => {
    const state1 = makeState();
    const state2 = makeState();
    const r1 = setupDecksForBoardPerField(state1);
    const r2 = setupDecksForBoardPerField(state2);
    expect(r1.decks[0]!.topToBottom).toEqual(r2.decks[0]!.topToBottom);
  });

  it("ch7 попадает ровно в ОДНУ CHANCE-колоду", () => {
    const state = makeState();
    const result = setupDecksForBoardPerField(state);
    const ch7Card = result.cards.find((c) => c.templateId === "ch7");
    expect(ch7Card).toBeDefined();
    const decksWithCh7 = result.decks.filter((d) => d.topToBottom.includes(ch7Card!.cardId));
    expect(decksWithCh7.length).toBe(1);
    expect([7, 22, 36]).toContain(decksWithCh7[0]!.boardFieldId);
  });

  it("загружает все три источника: CHANCE_CARDS, TREASURY_CARDS, LUXURY_TAX_CARDS", () => {
    // Sanity check: убеждаемся, что после init у нас ровно столько
    // карт, сколько в исходных справочниках.
    const expected = CHANCE_CARDS.length + TREASURY_CARDS.length + LUXURY_TAX_CARDS.length;
    const state = makeState();
    const result = setupDecksForBoardPerField(state);
    expect(result.cards.length).toBe(expected);
  });
});
