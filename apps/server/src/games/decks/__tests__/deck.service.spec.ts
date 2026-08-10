/**
 * Тесты DeckService (draw/return/hold/use/transfer/reshuffle).
 */
import {
  drawCard,
  returnCardToDeck,
  holdCardInHand,
  useCardFromHand,
  transferCard,
  reshuffleDeck,
  peekTopCard,
  cardsInHand,
  type DeckContext,
} from "../deck.service";
import {
  CardCannotBeHeldError,
  CardCannotBeTransferredError,
  CardNotFoundError,
  CardNotInHandError,
  DeckEmptyError,
  DeckNotFoundError,
  InvalidCardStateError,
} from "../errors";
import { FakeRng } from "../rng";
import type { CardInstance, CardTemplate, DeckInstance } from "../types";
import { createDecksContainer, setupDecks } from "../deck-setup.service";

// ===================================================================
// Test fixtures
// ===================================================================

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

const HOLDABLE_TEMPLATE: CardTemplate = makeTemplate("ch7", "CHANCE", {
  holdInHand: true,
  transferable: true,
  effect: { kind: "jail-free" } as never,
});

const TRANSFERABLE_TEMPLATE: CardTemplate = makeTemplate("tr1", "COMMUNITY_CHEST", {
  holdInHand: true,
  transferable: true,
});

const PLAIN_TEMPLATE = makeTemplate("ch1", "CHANCE");

/**
 * Строит простой контекст с одной колодой и N картами на поле 7.
 */
function buildContext(opts: {
  cards?: Partial<CardInstance>[];
  deckSize?: number;
  templates?: CardTemplate[];
  rngSeed?: string;
  emptyDeckPolicy?: "SKIP_DRAW" | "WAIT" | "RETURN_HELD_CARDS" | "ERROR";
}): DeckContext {
  const deckId = "deck-1";
  const templates = opts.templates ?? [PLAIN_TEMPLATE, HOLDABLE_TEMPLATE, TRANSFERABLE_TEMPLATE];
  // Если передан массив overrides — его длина фиксирует количество карт;
  // иначе используем `deckSize` (по умолчанию 3).
  const cardCount = opts.cards !== undefined ? opts.cards.length : (opts.deckSize ?? 3);

  const cards: CardInstance[] = [];
  for (let i = 0; i < cardCount; i++) {
    const overrides = opts.cards?.[i] ?? {};
    const tpl = templates[i % templates.length]!;
    cards.push({
      cardId: `card-${i}`,
      gameId: "g1",
      templateId: tpl.templateId,
      originDeckId: deckId,
      originBoardFieldId: 7,
      state: "IN_DECK",
      ...overrides,
    });
  }

  const deck: DeckInstance = {
    deckId,
    gameId: "g1",
    deckType: "CHANCE",
    boardFieldId: 7,
    topToBottom: cards.map((c) => c.cardId),
  };

  const templatesById = new Map(templates.map((t) => [t.templateId, t]));

  const ctx: DeckContext = {
    gameId: "g1",
    decks: [deck],
    cards,
    templatesById,
    emptyDeckPolicy: opts.emptyDeckPolicy ?? "SKIP_DRAW",
    ...(opts.rngSeed ? { rng: new FakeRng([0.1, 0.2, 0.3, 0.4, 0.5], opts.rngSeed) } : {}),
  };
  return ctx;
}

// ===================================================================
// Tests
// ===================================================================

describe("DeckService.drawCard", () => {
  it("снимает верхнюю карту и переводит её в DRAWN", () => {
    const ctx = buildContext({});
    const topBefore = ctx.decks[0]!.topToBottom[0]!;

    const r = drawCard(ctx, { boardFieldId: 7, playerId: "p1" });

    expect(r.decks[0]!.topToBottom).not.toContain(topBefore);
    const drawnCard = r.cards.find((c) => c.cardId === topBefore)!;
    expect(drawnCard.state).toBe("DRAWN");
    expect(drawnCard.drawnAt).toBeDefined();
  });

  it("эмиттит CARD_DRAWN событие", () => {
    const ctx = buildContext({});
    const r = drawCard(ctx, { boardFieldId: 7, playerId: "p1" });
    expect(r.events.length).toBe(1);
    const ev = r.events[0]!;
    expect(ev.type).toBe("CARD_DRAWN");
    if (ev.type === "CARD_DRAWN") {
      expect(ev.playerId).toBe("p1");
      expect(ev.fromIndex).toBe(0);
    }
  });

  it("бросает DeckNotFoundError, если boardFieldId не существует", () => {
    const ctx = buildContext({});
    expect(() => drawCard(ctx, { boardFieldId: 999, playerId: "p1" })).toThrow(DeckNotFoundError);
  });

  it("бросает DeckEmptyError при пустой колоде + SKIP_DRAW", () => {
    const ctx = buildContext({ cards: [], deckSize: 0 });
    expect(() => drawCard(ctx, { boardFieldId: 7, playerId: "p1" })).toThrow(DeckEmptyError);
  });

  it("при пустой колоде + ERROR тоже бросает DeckEmptyError", () => {
    const ctx = buildContext({ cards: [], deckSize: 0, emptyDeckPolicy: "ERROR" });
    expect(() => drawCard(ctx, { boardFieldId: 7, playerId: "p1" })).toThrow(DeckEmptyError);
  });

  it("при RETURN_HELD_CARDS и пустой колоде — возвращает IN_HAND и сразу тянет ту же карту", () => {
    const ctx = buildContext({
      deckSize: 0,
      emptyDeckPolicy: "RETURN_HELD_CARDS",
    });
    // Положим одну карту в IN_HAND той же колоды.
    const heldCard: CardInstance = {
      cardId: "held-1",
      gameId: "g1",
      templateId: HOLDABLE_TEMPLATE.templateId,
      originDeckId: "deck-1",
      originBoardFieldId: 7,
      state: "IN_HAND",
      holderPlayerId: "p1",
    };
    const ctxWithHeld: DeckContext = {
      ...ctx,
      cards: [heldCard],
    };
    // До draw: карта в IN_HAND.
    expect(ctxWithHeld.cards.find((c) => c.cardId === "held-1")!.state).toBe("IN_HAND");
    const r = drawCard(ctxWithHeld, { boardFieldId: 7, playerId: "p1" });
    // После draw: карта вернулась в низ, но сразу же вытянута сверху.
    expect(r.cards.find((c) => c.cardId === "held-1")!.state).toBe("DRAWN");
    expect(r.decks[0]!.topToBottom).not.toContain("held-1"); // уже снята
    // Была последовательно переведена: IN_HAND → IN_DECK → DRAWN.
    // Проверяем, что были эмитнуты 2 события: RETURNED + DRAWN.
    expect(r.events.find((e) => e.type === "CARD_RETURNED")).toBeDefined();
    expect(r.events.find((e) => e.type === "CARD_DRAWN")).toBeDefined();
  });

  it("НЕ мутирует входной ctx.cards", () => {
    const ctx = buildContext({});
    const cardIdsBefore = ctx.cards.map((c) => c.cardId);
    const stateBefore = ctx.cards.map((c) => c.state);

    drawCard(ctx, { boardFieldId: 7, playerId: "p1" });

    expect(ctx.cards.map((c) => c.cardId)).toEqual(cardIdsBefore);
    expect(ctx.cards.map((c) => c.state)).toEqual(stateBefore);
  });

  it("бросает InvalidCardStateError, если верхняя карта уже не IN_DECK", () => {
    const ctx = buildContext({
      cards: [{ cardId: "card-0", state: "IN_HAND", holderPlayerId: "p1" }],
    });
    expect(() => drawCard(ctx, { boardFieldId: 7, playerId: "p1" })).toThrow(InvalidCardStateError);
  });
});

describe("DeckService.returnCardToDeck", () => {
  it("возвращает DRAWN карту в низ колоды", () => {
    const ctx = buildContext({
      cards: [{ state: "DRAWN", drawnAt: "2025-01-01T00:00:00.000Z" }],
    });
    const r = returnCardToDeck(ctx, { cardId: "card-0", reason: "RESOLVED" });
    const returnedCard = r.cards.find((c) => c.cardId === "card-0")!;
    expect(returnedCard.state).toBe("IN_DECK");
    expect(returnedCard.holderPlayerId).toBeUndefined();
    expect(returnedCard.drawnAt).toBeUndefined();
    expect(r.decks[0]!.topToBottom[r.decks[0]!.topToBottom.length - 1]).toBe("card-0");
  });

  it("эмиттит CARD_RETURNED с правильным reason", () => {
    const ctx = buildContext({ cards: [{ state: "RESOLVING" }] });
    const r = returnCardToDeck(ctx, { cardId: "card-0", reason: "DROPPED" });
    const ev = r.events.find((e) => e.type === "CARD_RETURNED");
    expect(ev).toBeDefined();
    if (ev && ev.type === "CARD_RETURNED") {
      expect(ev.reason).toBe("DROPPED");
    }
  });

  it("бросает InvalidCardStateError, если карта IN_DECK", () => {
    const ctx = buildContext({});
    expect(() => returnCardToDeck(ctx, { cardId: "card-0", reason: "RESOLVED" })).toThrow(
      InvalidCardStateError,
    );
  });

  it("бросает InvalidCardStateError, если карта USED", () => {
    const ctx = buildContext({ cards: [{ state: "USED" }] });
    expect(() => returnCardToDeck(ctx, { cardId: "card-0", reason: "RESOLVED" })).toThrow(
      InvalidCardStateError,
    );
  });

  it("бросает CardNotFoundError, если карты нет", () => {
    const ctx = buildContext({});
    expect(() => returnCardToDeck(ctx, { cardId: "ghost", reason: "RESOLVED" })).toThrow(
      CardNotFoundError,
    );
  });
});

describe("DeckService.holdCardInHand", () => {
  it("переводит DRAWN карту с holdInHand=true в IN_HAND", () => {
    const ctx = buildContext({
      cards: [{ state: "DRAWN" }],
      templates: [HOLDABLE_TEMPLATE],
    });
    const r = holdCardInHand(ctx, { cardId: "card-0", playerId: "p1" });
    const card = r.cards.find((c) => c.cardId === "card-0")!;
    expect(card.state).toBe("IN_HAND");
    expect(card.holderPlayerId).toBe("p1");
  });

  it("бросает CardCannotBeHeldError, если holdInHand=false", () => {
    const ctx = buildContext({
      cards: [{ state: "DRAWN" }],
      templates: [PLAIN_TEMPLATE],
    });
    expect(() => holdCardInHand(ctx, { cardId: "card-0", playerId: "p1" })).toThrow(
      CardCannotBeHeldError,
    );
  });

  it("бросает InvalidCardStateError, если карта в IN_DECK", () => {
    const ctx = buildContext({
      templates: [HOLDABLE_TEMPLATE],
    });
    expect(() => holdCardInHand(ctx, { cardId: "card-0", playerId: "p1" })).toThrow(
      InvalidCardStateError,
    );
  });
});

describe("DeckService.useCardFromHand", () => {
  it("переводит IN_HAND в USED", () => {
    const ctx = buildContext({
      cards: [{ state: "IN_HAND", holderPlayerId: "p1" }],
      templates: [HOLDABLE_TEMPLATE],
    });
    const r = useCardFromHand(ctx, { cardId: "card-0", playerId: "p1" });
    const card = r.card;
    expect(card.state).toBe("USED");
    expect(card.usedAt).toBeDefined();
  });

  it("бросает CardNotInHandError, если карта не в IN_HAND", () => {
    const ctx = buildContext({
      cards: [{ state: "DRAWN" }],
      templates: [HOLDABLE_TEMPLATE],
    });
    expect(() => useCardFromHand(ctx, { cardId: "card-0", playerId: "p1" })).toThrow(
      CardNotInHandError,
    );
  });
});

describe("DeckService.transferCard", () => {
  it("передаёт карту с transferable=true другому игроку", () => {
    const ctx = buildContext({
      cards: [{ state: "IN_HAND", holderPlayerId: "p1" }],
      templates: [TRANSFERABLE_TEMPLATE],
    });
    const r = transferCard(ctx, {
      cardId: "card-0",
      fromPlayerId: "p1",
      toPlayerId: "p2",
    });
    const card = r.cards.find((c) => c.cardId === "card-0")!;
    expect(card.state).toBe("IN_HAND"); // не меняется
    expect(card.holderPlayerId).toBe("p2");
    const ev = r.events[0]!;
    expect(ev.type).toBe("CARD_TRANSFERRED");
  });

  it("бросает CardCannotBeTransferredError, если transferable=false", () => {
    const ctx = buildContext({
      cards: [{ state: "IN_HAND", holderPlayerId: "p1" }],
      templates: [PLAIN_TEMPLATE], // holdInHand=true, transferable=false
    });
    // Здесь проблема: PLAIN не holdInHand. Используем кастом.
    const ctx2 = buildContext({
      cards: [{ state: "IN_HAND", holderPlayerId: "p1" }],
      templates: [makeTemplate("x", "CHANCE", { holdInHand: true, transferable: false })],
    });
    expect(() =>
      transferCard(ctx2, { cardId: "card-0", fromPlayerId: "p1", toPlayerId: "p2" }),
    ).toThrow(CardCannotBeTransferredError);
  });

  it("бросает CardNotInHandError, если карта не в IN_HAND", () => {
    const ctx = buildContext({
      cards: [{ state: "DRAWN" }],
      templates: [TRANSFERABLE_TEMPLATE],
    });
    expect(() =>
      transferCard(ctx, { cardId: "card-0", fromPlayerId: "p1", toPlayerId: "p2" }),
    ).toThrow(CardNotInHandError);
  });
});

describe("DeckService.reshuffleDeck", () => {
  it("перемешивает topToBottom через fisherYates", () => {
    // `deckSize` без `cards` генерирует 4 карты.
    const ctx = buildContext({ deckSize: 4, rngSeed: "test" });
    const before = [...ctx.decks[0]!.topToBottom];

    const r = reshuffleDeck(ctx, { deckId: "deck-1" });

    expect(r.decks[0]!.topToBottom.length).toBe(before.length);
    // Тот же мультисет.
    expect([...r.decks[0]!.topToBottom].sort()).toEqual([...before].sort());
  });

  it("эмиттит DECK_RESHUFFLED событие", () => {
    const ctx = buildContext({ deckSize: 3, rngSeed: "test" });
    const r = reshuffleDeck(ctx, { deckId: "deck-1" });
    const ev = r.events.find((e) => e.type === "DECK_RESHUFFLED");
    expect(ev).toBeDefined();
    if (ev && ev.type === "DECK_RESHUFFLED") {
      expect(ev.deckId).toBe("deck-1");
      expect(ev.seed).toBe("test");
      expect(ev.cardCount).toBe(3);
    }
  });

  it("бросает ошибку, если deckId не существует", () => {
    const ctx = buildContext({ rngSeed: "test" });
    expect(() => reshuffleDeck(ctx, { deckId: "ghost" })).toThrow(DeckNotFoundError);
  });

  it("бросает InvalidCardStateError, если RNG не задан", () => {
    const ctx = buildContext({}); // без rng
    expect(() => reshuffleDeck(ctx, { deckId: "deck-1" })).toThrow(InvalidCardStateError);
  });
});

describe("DeckService.peekTopCard", () => {
  it("возвращает верхнюю карту БЕЗ удаления", () => {
    const ctx = buildContext({});
    const peeked = peekTopCard(ctx, 7);
    expect(peeked).not.toBeNull();
    expect(peeked!.cardId).toBe(ctx.decks[0]!.topToBottom[0]);
    expect(ctx.decks[0]!.topToBottom.length).toBe(3); // не изменился
    expect(ctx.cards.find((c) => c.cardId === peeked!.cardId)!.state).toBe("IN_DECK");
  });

  it("возвращает null для пустой колоды", () => {
    const ctx = buildContext({ cards: [], deckSize: 0 });
    expect(peekTopCard(ctx, 7)).toBeNull();
  });

  it("возвращает null для несуществующего boardFieldId", () => {
    const ctx = buildContext({});
    expect(peekTopCard(ctx, 999)).toBeNull();
  });
});

describe("DeckService.cardsInHand", () => {
  it("возвращает все карты в состоянии IN_HAND", () => {
    const ctx = buildContext({
      cards: [
        { state: "IN_HAND", holderPlayerId: "p1" },
        { state: "IN_HAND", holderPlayerId: "p2" },
        { state: "DRAWN" },
        { state: "IN_DECK" },
      ],
    });
    const inHand = cardsInHand(ctx);
    expect(inHand.length).toBe(2);
  });

  it("возвращает пустой массив, если карт в IN_HAND нет", () => {
    const ctx = buildContext({});
    expect(cardsInHand(ctx)).toEqual([]);
  });
});

// ===================================================================
// End-to-end: полный сценарий draw → hold → transfer → use.
// ===================================================================

describe("End-to-end: draw → hold → transfer → use", () => {
  it("полный жизненный цикл карты ch7 (Выход из тюрьмы)", () => {
    // Используем ЕДИНСТВЕННЫЙ holdable-шаблон, чтобы drawn карта всегда была holdable.
    const templates: CardTemplate[] = [HOLDABLE_TEMPLATE];
    const setup = setupDecks("g1", {
      placements: [{ deckType: "CHANCE", boardFieldId: 7, cardCount: 3 }],
      templates,
      seed: "lifecycle-test",
    });

    // Найти колоду на boardFieldId=7.
    const deck = setup.decks[0]!;
    const ctx: DeckContext = {
      gameId: "g1",
      decks: [deck],
      cards: setup.cards,
      templatesById: new Map(templates.map((t) => [t.templateId, t])),
      emptyDeckPolicy: "SKIP_DRAW",
    };

    // Шаг 1: draw.
    const drawn = drawCard(ctx, { boardFieldId: 7, playerId: "p1" });
    expect(drawn.cards.find((c) => c.cardId === drawn.drawnCard.cardId)!.state).toBe("DRAWN");

    // Шаг 2: hold.
    const held = holdCardInHand(
      { ...ctx, decks: drawn.decks, cards: drawn.cards },
      { cardId: drawn.drawnCard.cardId, playerId: "p1" },
    );
    expect(held.cards.find((c) => c.cardId === drawn.drawnCard.cardId)!.state).toBe("IN_HAND");

    // Шаг 3: transfer.
    const transferred = transferCard(
      { ...ctx, decks: held.decks, cards: held.cards },
      { cardId: drawn.drawnCard.cardId, fromPlayerId: "p1", toPlayerId: "p2" },
    );
    expect(transferred.cards.find((c) => c.cardId === drawn.drawnCard.cardId)!.holderPlayerId).toBe(
      "p2",
    );

    // Шаг 4: use.
    const used = useCardFromHand(
      { ...ctx, decks: transferred.decks, cards: transferred.cards },
      { cardId: drawn.drawnCard.cardId, playerId: "p2" },
    );
    expect(used.card.state).toBe("USED");
    expect(used.card.usedAt).toBeDefined();
  });

  it("правило Монополии «discard to bottom»: не-holdable карта возвращается в низ после применения эффекта", () => {
    // Правило: каждая вытянутая не-holdable карта (money / move / move-relative
    // / goto-jail / luxury-tax-house / go-salary) возвращается в НИЗ своей
    // колоды после применения эффекта. Это циклический сдвиг колоды.
    //
    // В тесте: колода [A, B, C, D, E].
    //  - draw → A снимается сверху, колода = [B, C, D, E].
    //  - return → A добавляется в конец, колода = [B, C, D, E, A].
    //  - draw → B снимается, колода = [C, D, E, A].
    //  - return → B добавляется в конец, колода = [C, D, E, A, B].
    //  - draw → C → [D, E, A, B, C].
    //  - return → C → [D, E, A, B, C, ...]
    // На 6-й итерации порядок вернётся к [A, B, C, D, E].
    const ctx0 = buildContext({
      deckSize: 5,
      templates: [
        makeTemplate("ch1"),
        makeTemplate("ch2"),
        makeTemplate("ch3"),
        makeTemplate("ch4"),
        makeTemplate("ch5"),
      ],
    });
    expect(ctx0.cards.length).toBe(5);
    expect(ctx0.decks[0]!.topToBottom).toEqual(["card-0", "card-1", "card-2", "card-3", "card-4"]);

    // ─── Итерация 1: draw A ─────────────────────────────────────────
    const d1 = drawCard(ctx0, { boardFieldId: 7, playerId: "p1" });
    expect(d1.decks[0]!.topToBottom).toEqual(["card-1", "card-2", "card-3", "card-4"]);
    expect(d1.drawnCard.cardId).toBe("card-0");
    // return A в низ.
    const r1 = returnCardToDeck(
      { ...ctx0, decks: d1.decks, cards: d1.cards },
      { cardId: "card-0", reason: "RESOLVED" },
    );
    expect(r1.decks[0]!.topToBottom).toEqual(["card-1", "card-2", "card-3", "card-4", "card-0"]);

    // ─── Итерация 2: draw B → return B в низ ────────────────────────
    const d2 = drawCard(
      { ...ctx0, decks: r1.decks, cards: r1.cards },
      { boardFieldId: 7, playerId: "p1" },
    );
    expect(d2.drawnCard.cardId).toBe("card-1");
    expect(d2.decks[0]!.topToBottom).toEqual(["card-2", "card-3", "card-4", "card-0"]);
    const r2 = returnCardToDeck(
      { ...ctx0, decks: d2.decks, cards: d2.cards },
      { cardId: "card-1", reason: "RESOLVED" },
    );
    expect(r2.decks[0]!.topToBottom).toEqual(["card-2", "card-3", "card-4", "card-0", "card-1"]);

    // ─── Итерация 3: draw C → return C в низ ────────────────────────
    const d3 = drawCard(
      { ...ctx0, decks: r2.decks, cards: r2.cards },
      { boardFieldId: 7, playerId: "p1" },
    );
    expect(d3.drawnCard.cardId).toBe("card-2");
    const r3 = returnCardToDeck(
      { ...ctx0, decks: d3.decks, cards: d3.cards },
      { cardId: "card-2", reason: "RESOLVED" },
    );
    expect(r3.decks[0]!.topToBottom).toEqual(["card-3", "card-4", "card-0", "card-1", "card-2"]);

    // ─── Итерация 4: draw D → return D в низ ────────────────────────
    const d4 = drawCard(
      { ...ctx0, decks: r3.decks, cards: r3.cards },
      { boardFieldId: 7, playerId: "p1" },
    );
    expect(d4.drawnCard.cardId).toBe("card-3");
    const r4 = returnCardToDeck(
      { ...ctx0, decks: d4.decks, cards: d4.cards },
      { cardId: "card-3", reason: "RESOLVED" },
    );
    expect(r4.decks[0]!.topToBottom).toEqual(["card-4", "card-0", "card-1", "card-2", "card-3"]);

    // ─── Итерация 5: draw E → return E в низ (полный круг) ──────────
    const d5 = drawCard(
      { ...ctx0, decks: r4.decks, cards: r4.cards },
      { boardFieldId: 7, playerId: "p1" },
    );
    expect(d5.drawnCard.cardId).toBe("card-4");
    const r5 = returnCardToDeck(
      { ...ctx0, decks: d5.decks, cards: d5.cards },
      { cardId: "card-4", reason: "RESOLVED" },
    );
    // После полного цикла порядок восстановился!
    expect(r5.decks[0]!.topToBottom).toEqual(["card-0", "card-1", "card-2", "card-3", "card-4"]);
  });

  it("discard to bottom для колоды из ОДНОЙ карты: карта всегда на индексе 0 (РОСКОШНЫЙ НАЛОГ)", () => {
    // Спецслучай: сейчас в LUXURY_TAX только 1 карта. По правилу
    // «discard to bottom» draw снимает её, return кладёт обратно.
    // Карта всегда на индексе 0 — порядок не меняется.
    const ctx0 = buildContext({
      deckSize: 1,
      templates: [makeTemplate("lt1")],
    });
    expect(ctx0.decks[0]!.topToBottom).toEqual(["card-0"]);
    expect(ctx0.cards.length).toBe(1);

    // draw → карты нет в top, но drawn.cardId = "card-0".
    const d1 = drawCard(ctx0, { boardFieldId: 7, playerId: "p1" });
    expect(d1.drawnCard.cardId).toBe("card-0");
    expect(d1.decks[0]!.topToBottom).toEqual([]);

    // return → карта снова на индексе 0.
    const r1 = returnCardToDeck(
      { ...ctx0, decks: d1.decks, cards: d1.cards },
      { cardId: "card-0", reason: "RESOLVED" },
    );
    expect(r1.decks[0]!.topToBottom).toEqual(["card-0"]);

    // Повторный draw → снова "card-0" (та же карта).
    const d2 = drawCard(
      { ...ctx0, decks: r1.decks, cards: r1.cards },
      { boardFieldId: 7, playerId: "p1" },
    );
    expect(d2.drawnCard.cardId).toBe("card-0");
  });
});

describe("createDecksContainer integration", () => {
  it("создаёт валидный контекст для DeckService", () => {
    const templates: CardTemplate[] = [HOLDABLE_TEMPLATE, makeTemplate("ch1"), makeTemplate("ch2")];
    const container = createDecksContainer("g1", {
      placements: [{ deckType: "CHANCE", boardFieldId: 7, cardCount: 3 }],
      templates,
      seed: "integration",
    });
    const ctx: DeckContext = {
      gameId: "g1",
      decks: [...container.chance, ...container.treasury, ...container["luxury-tax"]],
      cards: container.cards,
      templatesById: new Map(templates.map((t) => [t.templateId, t])),
      emptyDeckPolicy: container.emptyDeckPolicy,
    };
    expect(ctx.decks.length).toBeGreaterThan(0);
    expect(ctx.cards.length).toBe(3);

    // Через DeckService должна быть возможность нарисовать верхнюю.
    const peeked = peekTopCard(ctx, 7);
    expect(peeked).not.toBeNull();
  });
});
