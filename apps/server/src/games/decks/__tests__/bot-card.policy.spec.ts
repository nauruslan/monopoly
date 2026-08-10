/**
 * Тесты BotCardPolicy.
 */
import type { Player, GameState } from "@monopoly/shared";
import {
  decideJailEscape,
  findJailFreeCardInHand,
  shouldUseHoldableCard,
  shouldTransferHoldableCard,
  evaluateHoldableCardsValue,
  hasAnyHoldableCard,
  canUseCardNow,
} from "../bot-card.policy";

function makePlayer(overrides: Partial<Player> = {}): Player {
  return {
    id: "p1",
    displayName: "P1",
    kind: "bot",
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

function makeState(phase: GameState["phase"] = "IDLE"): GameState {
  return {
    id: "g1",
    version: 1,
    seed: "s",
    status: "active",
    currentPlayerIndex: 0,
    phase,
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
  } as GameState;
}

describe("BotCardPolicy.decideJailEscape", () => {
  it("USE_CARD, если есть holdable jail-free", () => {
    const player = makePlayer({
      inJail: true,
      holdableCards: {
        "card-x": { templateId: "ch7", drawnAt: "", originDeckId: "" },
      },
    });
    const result = decideJailEscape({ player, state: makeState() });
    expect(result.kind).toBe("USE_CARD");
    if (result.kind === "USE_CARD") {
      expect(result.cardId).toBe("card-x");
    }
  });

  it("PAY, если есть деньги, но нет карт", () => {
    const player = makePlayer({ inJail: true, money: 200 });
    const result = decideJailEscape({ player, state: makeState() });
    expect(result.kind).toBe("PAY");
  });

  it("USE_CARD имеет приоритет над PAY", () => {
    const player = makePlayer({
      inJail: true,
      money: 200,
      holdableCards: {
        ch7: { templateId: "ch7", drawnAt: "", originDeckId: "" },
      },
    });
    const result = decideJailEscape({ player, state: makeState() });
    expect(result.kind).toBe("USE_CARD");
  });

  it("TRY_DOUBLE, если нет ни карт, ни денег", () => {
    const player = makePlayer({ inJail: true, money: 10 });
    const result = decideJailEscape({ player, state: makeState() });
    expect(result.kind).toBe("TRY_DOUBLE");
  });

  it("учитывает jailFine из настроек", () => {
    const player = makePlayer({ inJail: true, money: 100 });
    const result = decideJailEscape({
      player,
      state: makeState(),
      jailFine: 200,
    });
    expect(result.kind).toBe("TRY_DOUBLE");
  });
});

describe("BotCardPolicy.findJailFreeCardInHand", () => {
  it("находит ch7 cardId", () => {
    const player = makePlayer({
      holdableCards: {
        "card-other": { templateId: "tr1", drawnAt: "", originDeckId: "" },
        "card-jail": { templateId: "ch7", drawnAt: "", originDeckId: "" },
      },
    });
    expect(findJailFreeCardInHand(player)).toBe("card-jail");
  });

  it("возвращает любую holdable, если ch7 нет", () => {
    const player = makePlayer({
      holdableCards: {
        "card-x": { templateId: "tr1", drawnAt: "", originDeckId: "" },
      },
    });
    expect(findJailFreeCardInHand(player)).toBe("card-x");
  });

  it("null, если holdableCards нет", () => {
    const player = makePlayer();
    expect(findJailFreeCardInHand(player)).toBeNull();
  });

  it("null, если holdableCards пуст", () => {
    const player = makePlayer({ holdableCards: {} });
    expect(findJailFreeCardInHand(player)).toBeNull();
  });
});

describe("BotCardPolicy.shouldUseHoldableCard", () => {
  it("true для ch7 в фазе JAIL_DECISION когда игрок в тюрьме", () => {
    const player = makePlayer({
      inJail: true,
      holdableCards: {
        "card-x": { templateId: "ch7", drawnAt: "", originDeckId: "" },
      },
    });
    expect(shouldUseHoldableCard({ player, state: makeState("JAIL_DECISION") }, "card-x")).toBe(
      true,
    );
  });

  it("false, если игрок НЕ в тюрьме", () => {
    const player = makePlayer({
      inJail: false,
      holdableCards: {
        "card-x": { templateId: "ch7", drawnAt: "", originDeckId: "" },
      },
    });
    expect(shouldUseHoldableCard({ player, state: makeState("JAIL_DECISION") }, "card-x")).toBe(
      false,
    );
  });

  it("false для не-ch7 карт", () => {
    const player = makePlayer({
      inJail: true,
      holdableCards: {
        "card-x": { templateId: "tr1", drawnAt: "", originDeckId: "" },
      },
    });
    expect(shouldUseHoldableCard({ player, state: makeState("JAIL_DECISION") }, "card-x")).toBe(
      false,
    );
  });

  it("false, если карты нет в hand", () => {
    const player = makePlayer({ inJail: true });
    expect(shouldUseHoldableCard({ player, state: makeState("JAIL_DECISION") }, "ghost")).toBe(
      false,
    );
  });
});

describe("BotCardPolicy.shouldTransferHoldableCard", () => {
  it("всегда false (MVP — только trade)", () => {
    const player = makePlayer({
      holdableCards: {
        "card-x": { templateId: "ch7", drawnAt: "", originDeckId: "" },
      },
    });
    expect(shouldTransferHoldableCard({ player, state: makeState() }, "p2", "card-x")).toBe(false);
  });
});

describe("BotCardPolicy.evaluateHoldableCardsValue", () => {
  it("1 карта = perCardValue", () => {
    const player = makePlayer({
      holdableCards: {
        ch7: { templateId: "ch7", drawnAt: "", originDeckId: "" },
      },
    });
    expect(evaluateHoldableCardsValue(player, 50)).toBe(50);
  });

  it("несколько карт = count * perCardValue", () => {
    const player = makePlayer({
      holdableCards: {
        "card-1": { templateId: "ch7", drawnAt: "", originDeckId: "" },
        "card-2": { templateId: "ch7", drawnAt: "", originDeckId: "" },
        "card-3": { templateId: "ch7", drawnAt: "", originDeckId: "" },
      },
    });
    expect(evaluateHoldableCardsValue(player, 75)).toBe(225);
  });

  it("0 для игрока без карт", () => {
    expect(evaluateHoldableCardsValue(makePlayer())).toBe(0);
  });
});

describe("BotCardPolicy.hasAnyHoldableCard", () => {
  it("true для holdableCards с данными", () => {
    expect(
      hasAnyHoldableCard(
        makePlayer({
          holdableCards: {
            ch7: { templateId: "ch7", drawnAt: "", originDeckId: "" },
          },
        }),
      ),
    ).toBe(true);
  });

  it("true для holdableCards", () => {
    const player = makePlayer({
      holdableCards: {
        "card-x": { templateId: "ch7", drawnAt: "", originDeckId: "" },
      },
    });
    expect(hasAnyHoldableCard(player)).toBe(true);
  });

  it("false для пустого", () => {
    expect(hasAnyHoldableCard(makePlayer())).toBe(false);
  });
});

describe("BotCardPolicy.canUseCardNow", () => {
  it("true для jail-free в JAIL_DECISION", () => {
    const player = makePlayer({
      inJail: true,
      holdableCards: {
        "card-x": { templateId: "ch7", drawnAt: "", originDeckId: "" },
      },
    });
    expect(canUseCardNow({ player, state: makeState("JAIL_DECISION") }, "card-x")).toBe(true);
  });

  it("false в других фазах", () => {
    const player = makePlayer({
      holdableCards: {
        "card-x": { templateId: "ch7", drawnAt: "", originDeckId: "" },
      },
    });
    expect(canUseCardNow({ player, state: makeState("ROLLING") }, "card-x")).toBe(false);
  });

  it("false, если карты нет", () => {
    const player = makePlayer();
    expect(canUseCardNow({ player, state: makeState("JAIL_DECISION") }, "ghost")).toBe(false);
  });
});
