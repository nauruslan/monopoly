/**
 * Unit-тесты для `turn-permissions.ts` — чистые функции проверки прав игрока
 * на игровые действия (`canRollDice`, `canEndTurn`, `mustRollDiceNow`).
 *
 * Покрываемые сценарии — это именно баг-репро и граничные случаи:
 *
 *   - «после дубля бросок обязателен» (mustRollAgain=true → canRoll=true, canEndTurn=false);
 *   - «после дубля в тюрьме» (mustRollAgain=true + inJail=true → canRoll=false);
 *   - «начало хода» (фаза ROLLING, mustRollAgain=false → canRoll=true, canEndTurn=false);
 *   - «после покупки» (фаза BUILDING, mustRollAgain=false → canEndTurn=true);
 *   - «банкрот / не моя очередь / партия не активна» → обе кнопки false.
 *
 * Эти тесты фиксируют правила бизнес-логики, на которую опирается UI
 *  и FSM-валидация в
 * `GamesService.applyAction`.
 */
import {
  canRollDice,
  canEndTurn,
  mustRollDiceNow,
  isCurrentPlayer,
  canBuyProperty,
  canTrade,
} from "../turn-permissions";
import type { GameState, Player } from "@monopoly/shared";
import { BOARD, DEFAULT_SETTINGS } from "@monopoly/shared";

function makePlayer(over: Partial<Player> = {}): Player {
  return {
    id: "p0",
    displayName: "Alice",
    kind: "human",
    color: "#f00",
    icon: "🔴",
    money: 1500,
    position: 0,
    inJail: false,
    jailTurns: 0,
    jailCards: 0,
    properties: [],
    consecutiveDoubles: 0,
    isBankrupt: false,
    mustRollAgain: false,
    ...over,
  };
}

function makeState(over: Partial<GameState> = {}): GameState {
  const p0 = makePlayer({ id: "p0" });
  const p1 = makePlayer({ id: "p1", displayName: "Bob", kind: "bot" });
  return {
    id: "g-test",
    version: 1,
    status: "active",
    currentPlayerIndex: 0,
    phase: "ROLLING",
    round: 1,
    players: [p0, p1],
    board: BOARD.map((c) => ({ ...c, ownerId: undefined, houses: 0, isMortgaged: false })),
    settings: { ...DEFAULT_SETTINGS },
    seed: "test-seed",
    createdAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    ...over,
  };
}

describe("turn-permissions", () => {
  describe("isCurrentPlayer", () => {
    it("true для игрока, чей currentPlayerIndex", () => {
      const s = makeState({ currentPlayerIndex: 1 });
      expect(isCurrentPlayer(s, s.players[1]!)).toBe(true);
    });
    it("false для остальных игроков", () => {
      const s = makeState({ currentPlayerIndex: 0 });
      expect(isCurrentPlayer(s, s.players[1]!)).toBe(false);
    });
  });

  describe("canRollDice", () => {
    it("true в начале хода: phase=ROLLING, не в тюрьме, не банкрот", () => {
      const s = makeState({ phase: "ROLLING" });
      const p = s.players[0]!;
      expect(canRollDice(s, p)).toBe(true);
    });

    it("true ПОСЛЕ ДУБЛЯ: mustRollAgain=true, phase=ROLLING (главный bugfix)", () => {
      // Это и был сценарий бага: после дубля игрок ОБЯЗАН бросить ещё раз.
      // UI должен показывать «Бросить кубики» активной, а «Завершить» нет.
      const s = makeState({
        phase: "ROLLING",
        players: [makePlayer({ id: "p0", mustRollAgain: true }), makePlayer({ id: "p1" })],
      });
      const p = s.players[0]!;
      expect(canRollDice(s, p)).toBe(true);
      // canEndTurn при этом должно быть false (см. ниже).
      expect(canEndTurn(s, p)).toBe(false);
    });

    it("false в фазе BUILDING", () => {
      const s = makeState({ phase: "BUILDING" });
      expect(canRollDice(s, s.players[0]!)).toBe(false);
    });

    it("false в тюрьме (фаза ROLLING, inJail=true)", () => {
      const s = makeState({ phase: "ROLLING" });
      const p = { ...s.players[0]!, inJail: true };
      expect(canRollDice(s, p)).toBe(false);
    });

    it("false для банкрота", () => {
      const s = makeState({ phase: "ROLLING" });
      const p = { ...s.players[0]!, isBankrupt: true };
      expect(canRollDice(s, p)).toBe(false);
    });

    it("false если ход не этого игрока", () => {
      const s = makeState({ phase: "ROLLING", currentPlayerIndex: 1 });
      expect(canRollDice(s, s.players[0]!)).toBe(false);
    });

    it("false если партия не активна", () => {
      const s = makeState({ phase: "ROLLING", status: "finished" });
      expect(canRollDice(s, s.players[0]!)).toBe(false);
    });
  });

  describe("canEndTurn", () => {
    it("true после покупки: phase=BUILDING, mustRollAgain=false", () => {
      const s = makeState({ phase: "BUILDING" });
      expect(canEndTurn(s, s.players[0]!)).toBe(true);
    });

    it("false в начале хода: phase=ROLLING (бросок обязателен)", () => {
      // Главный bugfix: кнопка «Завершить» НЕ должна быть активна в начале хода.
      const s = makeState({ phase: "ROLLING" });
      expect(canEndTurn(s, s.players[0]!)).toBe(false);
    });

    it("false после дубля: phase=BUILDING, mustRollAgain=true", () => {
      // После дубля в BUILDING сервер форсит повторный бросок —
      // UI не должен показывать «Завершить» активной.
      const s = makeState({
        phase: "BUILDING",
        players: [makePlayer({ id: "p0", mustRollAgain: true }), makePlayer({ id: "p1" })],
      });
      expect(canEndTurn(s, s.players[0]!)).toBe(false);
    });

    it("false в DICE_ANIMATION", () => {
      const s = makeState({ phase: "DICE_ANIMATION" });
      expect(canEndTurn(s, s.players[0]!)).toBe(false);
    });

    it("false в MOVE_ANIMATION", () => {
      const s = makeState({ phase: "MOVE_ANIMATION" });
      expect(canEndTurn(s, s.players[0]!)).toBe(false);
    });

    it("false для банкрота", () => {
      const s = makeState({ phase: "BUILDING" });
      const p = { ...s.players[0]!, isBankrupt: true };
      expect(canEndTurn(s, p)).toBe(false);
    });

    it("false если ход не этого игрока", () => {
      const s = makeState({ phase: "BUILDING", currentPlayerIndex: 1 });
      expect(canEndTurn(s, s.players[0]!)).toBe(false);
    });
  });

  describe("mustRollDiceNow", () => {
    it("true только при phase=ROLLING и mustRollAgain=true", () => {
      const p = makePlayer({ mustRollAgain: true });
      const s1 = makeState({ phase: "ROLLING", players: [p, makePlayer({ id: "p1" })] });
      expect(mustRollDiceNow(s1, s1.players[0]!)).toBe(true);
    });

    it("false если mustRollAgain=false (обычный бросок в начале хода)", () => {
      const s = makeState({ phase: "ROLLING" });
      expect(mustRollDiceNow(s, s.players[0]!)).toBe(false);
    });

    it("false в фазе BUILDING (после дубля сервер ещё не вернулся в ROLLING — это нормально)", () => {
      const p = makePlayer({ mustRollAgain: true });
      const s = makeState({ phase: "BUILDING", players: [p, makePlayer({ id: "p1" })] });
      expect(mustRollDiceNow(s, s.players[0]!)).toBe(false);
    });

    it("false в тюрьме", () => {
      const p = makePlayer({ mustRollAgain: true, inJail: true });
      const s = makeState({ phase: "ROLLING", players: [p, makePlayer({ id: "p1" })] });
      expect(mustRollDiceNow(s, s.players[0]!)).toBe(false);
    });
  });

  // ─────────────────────── Тюрьма: блокировка покупки/торговли ───────────────────────
  describe("canBuyProperty (блок в тюрьме)", () => {
    it("true в фазе BUY_DECISION, если игрок НЕ в тюрьме", () => {
      const s = makeState({ phase: "BUY_DECISION" });
      expect(canBuyProperty(s, s.players[0]!)).toBe(true);
    });

    it("false в фазе BUY_DECISION, если игрок В тюрьме (правила Монополии)", () => {
      const s = makeState({ phase: "BUY_DECISION" });
      const p = { ...s.players[0]!, inJail: true };
      expect(canBuyProperty(s, p)).toBe(false);
    });

    it("false в фазе BUILDING, если игрок в тюрьме (тоже нельзя)", () => {
      const s = makeState({ phase: "BUILDING" });
      const p = { ...s.players[0]!, inJail: true };
      expect(canBuyProperty(s, p)).toBe(false);
    });

    it("false в фазе ROLLING (покупка только в BUY_DECISION)", () => {
      const s = makeState({ phase: "ROLLING" });
      expect(canBuyProperty(s, s.players[0]!)).toBe(false);
    });
  });

  describe("canTrade (блок в тюрьме)", () => {
    it("true в фазе BUILDING, если игрок НЕ в тюрьме", () => {
      const s = makeState({ phase: "BUILDING" });
      expect(canTrade(s, s.players[0]!)).toBe(true);
    });

    it("false в фазе BUILDING, если игрок В тюрьме (правила Монополии)", () => {
      const s = makeState({ phase: "BUILDING" });
      const p = { ...s.players[0]!, inJail: true };
      expect(canTrade(s, p)).toBe(false);
    });

    it("false в фазе ROLLING (торговля только в BUILDING)", () => {
      const s = makeState({ phase: "ROLLING" });
      expect(canTrade(s, s.players[0]!)).toBe(false);
    });
  });
});
