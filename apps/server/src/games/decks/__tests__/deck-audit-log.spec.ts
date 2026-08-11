/**
 * Тесты DeckAuditLog.
 */
import type { GameState } from "@monopoly/shared";
import {
  appendDeckEvent,
  appendDeckEvents,
  getCardHistory,
  tailDeckEvents,
  countEventTypes,
  getEventsByType,
  clearDeckAuditLog,
} from "../deck-audit-log";
import { isCardEvent, type DeckEvent } from "../events";
import "../deck-audit-log"; // side-effect: declaration merging

function makeState(): GameState {
  return {
    id: "g1",
    version: 1,
    seed: "s",
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

function makeEvent(overrides: Partial<DeckEvent> = {}): DeckEvent {
  return {
    gameId: "g1",
    deckId: "d1",
    cardId: "card-1",
    type: "CARD_DRAWN",
    deckType: "CHANCE",
    playerId: "p1",
    fromIndex: 0,
    timestamp: "2025-01-01T00:00:00.000Z",
    ...overrides,
  } as DeckEvent;
}

describe("DeckAuditLog.appendDeckEvent", () => {
  it("создаёт deckAuditLog при первом вызове", () => {
    const state = makeState();
    expect(state.deckAuditLog).toBeUndefined();
    appendDeckEvent(state, makeEvent(), "p1");
    expect(state.deckAuditLog).toBeDefined();
    expect(state.deckAuditLog!.length).toBe(1);
  });

  it("назначает монотонный sequence number", () => {
    const state = makeState();
    const e1 = appendDeckEvent(state, makeEvent(), "p1");
    const e2 = appendDeckEvent(state, makeEvent(), "p1");
    const e3 = appendDeckEvent(state, makeEvent(), "p1");
    expect(e1.seq).toBe(1);
    expect(e2.seq).toBe(2);
    expect(e3.seq).toBe(3);
  });

  it("сохраняет actor если задан", () => {
    const state = makeState();
    const e = appendDeckEvent(state, makeEvent(), "p2");
    expect(e.actor).toBe("p2");
  });

  it("actor опционален", () => {
    const state = makeState();
    const e = appendDeckEvent(state, makeEvent());
    expect(e.actor).toBeUndefined();
  });
});

describe("DeckAuditLog.appendDeckEvents", () => {
  it("добавляет пачку событий с правильными sequence numbers", () => {
    const state = makeState();
    const entries = appendDeckEvents(state, [makeEvent(), makeEvent(), makeEvent()], "p1");
    expect(entries.length).toBe(3);
    expect(entries.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it("пустой массив не создаёт записей", () => {
    const state = makeState();
    appendDeckEvents(state, [], "p1");
    expect(state.deckAuditLog).toBeUndefined();
  });
});

describe("DeckAuditLog.getCardHistory", () => {
  it("возвращает только события по cardId", () => {
    const state = makeState();
    appendDeckEvent(state, makeEvent({ cardId: "card-A" } as Partial<DeckEvent>));
    appendDeckEvent(state, makeEvent({ cardId: "card-B" } as Partial<DeckEvent>));
    appendDeckEvent(state, makeEvent({ cardId: "card-A" } as Partial<DeckEvent>));
    const history = getCardHistory(state, "card-A");
    expect(history.length).toBe(2);
    expect(history.every((e) => isCardEvent(e.event) && e.event.cardId === "card-A")).toBe(true);
  });

  it("возвращает пустой массив, если ничего нет", () => {
    const state = makeState();
    expect(getCardHistory(state, "ghost")).toEqual([]);
  });
});

describe("DeckAuditLog.tailDeckEvents", () => {
  it("возвращает последние N событий", () => {
    const state = makeState();
    for (let i = 0; i < 5; i++) {
      appendDeckEvent(state, makeEvent());
    }
    const tail = tailDeckEvents(state, 2);
    expect(tail.length).toBe(2);
    expect(tail[0]!.seq).toBe(4);
    expect(tail[1]!.seq).toBe(5);
  });

  it("возвращает всё, если N > size", () => {
    const state = makeState();
    appendDeckEvent(state, makeEvent());
    appendDeckEvent(state, makeEvent());
    expect(tailDeckEvents(state, 10).length).toBe(2);
  });
});

describe("DeckAuditLog.getEventsByType", () => {
  it("фильтрует по типу", () => {
    const state = makeState();
    appendDeckEvent(state, makeEvent({ type: "CARD_DRAWN" } as Partial<DeckEvent>));
    appendDeckEvent(state, makeEvent({ type: "CARD_HELD" } as Partial<DeckEvent>));
    appendDeckEvent(state, makeEvent({ type: "CARD_DRAWN" } as Partial<DeckEvent>));
    const drawn = getEventsByType(state, "CARD_DRAWN");
    expect(drawn.length).toBe(2);
  });
});

describe("DeckAuditLog.countEventTypes", () => {
  it("считает каждый тип", () => {
    const state = makeState();
    appendDeckEvent(state, makeEvent({ type: "CARD_DRAWN" } as Partial<DeckEvent>));
    appendDeckEvent(state, makeEvent({ type: "CARD_DRAWN" } as Partial<DeckEvent>));
    appendDeckEvent(state, makeEvent({ type: "CARD_HELD" } as Partial<DeckEvent>));
    const counts = countEventTypes(state);
    expect(counts.CARD_DRAWN).toBe(2);
    expect(counts.CARD_HELD).toBe(1);
    expect(counts.CARD_USED).toBe(0);
  });
});

describe("DeckAuditLog.clearDeckAuditLog", () => {
  it("очищает лог", () => {
    const state = makeState();
    appendDeckEvent(state, makeEvent());
    appendDeckEvent(state, makeEvent());
    expect(state.deckAuditLog!.length).toBe(2);
    clearDeckAuditLog(state);
    expect(state.deckAuditLog).toEqual([]);
  });
});
