/**
 * Тесты setupDecks / createDecksContainer.
 */
import { createDecksContainer, setupDecks, type DecksContainer } from "../deck-setup.service";
import { NotEnoughCardTemplatesError } from "../errors";
import { FakeRng, createRng } from "../rng";
import type { CardTemplate, DeckSetupConfig } from "../types";

function makeTemplate(
  templateId: string,
  deckType: "CHANCE" | "COMMUNITY_CHEST" | "LUXURY_TAX" = "CHANCE",
  overrides: Partial<CardTemplate> = {},
): CardTemplate {
  return {
    templateId,
    deckType,
    title: `Title ${templateId}`,
    text: `Text ${templateId}`,
    holdInHand: false,
    transferable: false,
    effect: { kind: "money", amount: 50 },
    ...overrides,
  };
}

const CHANCE_5: CardTemplate[] = [
  makeTemplate("ch1", "CHANCE"),
  makeTemplate("ch2", "CHANCE"),
  makeTemplate("ch3", "CHANCE"),
  makeTemplate("ch4", "CHANCE"),
  makeTemplate("ch5", "CHANCE"),
];

const TREASURY_3: CardTemplate[] = [
  makeTemplate("tr1", "COMMUNITY_CHEST"),
  makeTemplate("tr2", "COMMUNITY_CHEST"),
  makeTemplate("tr3", "COMMUNITY_CHEST"),
];

const LUXURY_2: CardTemplate[] = [
  makeTemplate("lt1", "LUXURY_TAX"),
  makeTemplate("lt2", "LUXURY_TAX"),
];

const FULL_TEMPLATES: CardTemplate[] = [...CHANCE_5, ...TREASURY_3, ...LUXURY_2];

const FULL_CONFIG: DeckSetupConfig = {
  placements: [
    { deckType: "CHANCE", boardFieldId: 7, cardCount: 5 },
    { deckType: "CHANCE", boardFieldId: 22, cardCount: 5 },
    { deckType: "COMMUNITY_CHEST", boardFieldId: 2, cardCount: 3 },
    { deckType: "LUXURY_TAX", boardFieldId: 38, cardCount: 2 },
  ],
  templates: FULL_TEMPLATES,
};

/**
 * Извлекает последовательность `templateId` из колоды, проходя по
 * `topToBottom` и доставая соответствующий `card.templateId` из `cards`.
 *
 * Это позволяет сравнивать ПОРЯДОК детерминированно, не завися от
 * `cardId` (UUID не детерминированы).
 */
function deckTemplateOrder(
  deckTemplateIds: string[],
  cards: { cardId: string; templateId: string }[],
): string[] {
  const cardIdToTpl = new Map(cards.map((c) => [c.cardId, c.templateId] as const));
  return deckTemplateIds.map((cid) => cardIdToTpl.get(cid) ?? `<missing:${cid}>`);
}

describe("setupDecks", () => {
  it("создаёт все колоды из конфигурации", () => {
    const result = setupDecks("g1", FULL_CONFIG);
    expect(result.decks.length).toBe(4);
    // ВАЖНО: числовая сортировка (по умолчанию sort() — лексикографическая,
    // и тогда [7,22,2,38].sort() === [2,22,38,7], а не [2,7,22,38]).
    const sortedIds = [...result.decks.map((d) => d.boardFieldId)].sort((a, b) => a - b);
    expect(sortedIds).toEqual([2, 7, 22, 38]);
  });

  it("каждая колода привязана к boardFieldId", () => {
    const result = setupDecks("g1", FULL_CONFIG);
    for (const d of result.decks) {
      expect(d.boardFieldId).toBeDefined();
      expect(d.gameId).toBe("g1");
      expect(d.deckId.length).toBeGreaterThan(0);
    }
  });

  it("каждая карта имеет originDeckId и originBoardFieldId", () => {
    const result = setupDecks("g1", FULL_CONFIG);
    for (const card of result.cards) {
      const deck = result.decks.find((d) => d.deckId === card.originDeckId);
      expect(deck).toBeDefined();
      expect(card.originBoardFieldId).toBe(deck!.boardFieldId);
      expect(card.state).toBe("IN_DECK");
      expect(card.gameId).toBe("g1");
    }
  });

  it("все cardId уникальны (uuid)", () => {
    const result = setupDecks("g1", FULL_CONFIG);
    const ids = result.cards.map((c) => c.cardId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("количество карт в колоде соответствует конфигу", () => {
    const result = setupDecks("g1", FULL_CONFIG);
    const deckByField = new Map<number, number>();
    for (const d of result.decks) {
      deckByField.set(d.boardFieldId, d.topToBottom.length);
    }
    expect(deckByField.get(7)).toBe(5);
    expect(deckByField.get(22)).toBe(5);
    expect(deckByField.get(2)).toBe(3);
    expect(deckByField.get(38)).toBe(2);
  });

  it("Fisher-Yates не создаёт дубликатов в deck", () => {
    const result = setupDecks("g1", FULL_CONFIG);
    for (const d of result.decks) {
      expect(new Set(d.topToBottom).size).toBe(d.topToBottom.length);
    }
  });

  it("при одинаковом rng порядок templateId в колодах одинаковый", () => {
    // UUID не детерминированы, но порядок templateId в колоде — да.
    const a = setupDecks("g1", FULL_CONFIG, createRng("fixed"));
    const b = setupDecks("g1", FULL_CONFIG, createRng("fixed"));
    for (const deckA of a.decks) {
      const deckB = b.decks.find((d) => d.boardFieldId === deckA.boardFieldId);
      expect(deckB).toBeDefined();
      const orderA = deckTemplateOrder(deckA.topToBottom, a.cards);
      const orderB = deckTemplateOrder(deckB!.topToBottom, b.cards);
      expect(orderA).toEqual(orderB);
    }
  });

  it("при разных seed порядок templateId статистически отличается", () => {
    const a = setupDecks("g1", FULL_CONFIG, createRng("seed-A"));
    const b = setupDecks("g1", FULL_CONFIG, createRng("seed-B"));
    let anyDifferent = false;
    for (const deckA of a.decks) {
      const deckB = b.decks.find((d) => d.boardFieldId === deckA.boardFieldId);
      const orderA = deckTemplateOrder(deckA.topToBottom, a.cards);
      const orderB = deckTemplateOrder(deckB!.topToBottom, b.cards);
      if (JSON.stringify(orderA) !== JSON.stringify(orderB)) {
        anyDifferent = true;
        break;
      }
    }
    expect(anyDifferent).toBe(true);
  });

  it("если templates меньше, чем cardCount и allowDuplicates=false → NotEnoughCardTemplatesError", () => {
    const config: DeckSetupConfig = {
      placements: [{ deckType: "CHANCE", boardFieldId: 7, cardCount: 10 }],
      templates: CHANCE_5,
      allowDuplicates: false,
    };
    expect(() => setupDecks("g1", config)).toThrow(NotEnoughCardTemplatesError);
  });

  it("если templates меньше, чем cardCount и allowDuplicates=true → создаются дубли с уникальными cardId", () => {
    const config: DeckSetupConfig = {
      placements: [{ deckType: "CHANCE", boardFieldId: 7, cardCount: 10 }],
      templates: CHANCE_5,
      allowDuplicates: true,
    };
    const result = setupDecks("g1", config);
    const deck = result.decks[0]!;
    expect(deck.topToBottom.length).toBe(10);
    // cardId уникальны.
    expect(new Set(result.cards.map((c) => c.cardId)).size).toBe(10);
    // templateId могут повторяться.
    const templateIds = result.cards.map((c) => c.templateId);
    expect(new Set(templateIds).size).toBeLessThanOrEqual(5);
  });

  it("если templates больше, чем cardCount — берётся случайное подмножество", () => {
    const config: DeckSetupConfig = {
      placements: [{ deckType: "CHANCE", boardFieldId: 7, cardCount: 2 }],
      templates: CHANCE_5,
    };
    const result = setupDecks("g1", config);
    const deck = result.decks[0]!;
    expect(deck.topToBottom.length).toBe(2);
    const tplIds = result.cards.map((c) => c.templateId);
    for (const id of tplIds) {
      expect(CHANCE_5.some((t) => t.templateId === id)).toBe(true);
    }
  });

  it("если config.seed задан — используется он", () => {
    const configWithSeed: DeckSetupConfig = { ...FULL_CONFIG, seed: "explicit-seed" };
    const a = setupDecks("g1", configWithSeed);
    expect(a.seed).toBe("explicit-seed");
  });

  it("если config.seed НЕ задан — генерируется случайный", () => {
    const configNoSeed: DeckSetupConfig = { ...FULL_CONFIG };
    delete (configNoSeed as Partial<DeckSetupConfig>).seed;
    const a = setupDecks("g1", configNoSeed);
    const b = setupDecks("g1", configNoSeed);
    expect(a.seed).not.toBe(b.seed);
    expect(a.seed.length).toBeGreaterThan(0);
  });

  it("FakeRng детерминирует порядок templateId", () => {
    const config: DeckSetupConfig = {
      placements: [{ deckType: "CHANCE", boardFieldId: 7, cardCount: 5 }],
      templates: CHANCE_5,
    };
    const rng = new FakeRng([0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
    const r1 = setupDecks("g1", config, rng);
    const rng2 = new FakeRng([0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
    const r2 = setupDecks("g1", config, rng2);
    const order1 = deckTemplateOrder(r1.decks[0]!.topToBottom, r1.cards);
    const order2 = deckTemplateOrder(r2.decks[0]!.topToBottom, r2.cards);
    expect(order1).toEqual(order2);
  });

  it("если placement.cardCount = 0 — колода создаётся пустой", () => {
    const config: DeckSetupConfig = {
      placements: [{ deckType: "LUXURY_TAX", boardFieldId: 38, cardCount: 0 }],
      templates: LUXURY_2,
    };
    const result = setupDecks("g1", config);
    expect(result.decks[0]!.topToBottom).toEqual([]);
  });
});

describe("createDecksContainer", () => {
  it("группирует колоды по типу", () => {
    const container: DecksContainer = createDecksContainer("g1", FULL_CONFIG);
    expect(container.chance.length).toBe(2);
    expect(container.treasury.length).toBe(1);
    expect(container["luxury-tax"].length).toBe(1);
  });

  it("сохраняет пустые массивы для отсутствующих типов", () => {
    const config: DeckSetupConfig = {
      placements: [{ deckType: "CHANCE", boardFieldId: 7, cardCount: 3 }],
      templates: CHANCE_5,
    };
    const container = createDecksContainer("g1", config);
    expect(container.chance.length).toBe(1);
    expect(container.treasury.length).toBe(0);
    expect(container["luxury-tax"].length).toBe(0);
  });

  it("emptyDeckPolicy по умолчанию — SKIP_DRAW", () => {
    const container = createDecksContainer("g1", FULL_CONFIG);
    expect(container.emptyDeckPolicy).toBe("SKIP_DRAW");
  });

  it("emptyDeckPolicy переопределяется", () => {
    const container = createDecksContainer("g1", FULL_CONFIG, "ERROR");
    expect(container.emptyDeckPolicy).toBe("ERROR");
  });

  it("seed прокидывается в контейнер", () => {
    const container = createDecksContainer("g1", FULL_CONFIG);
    expect(container.seed.length).toBeGreaterThan(0);
  });
});
