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

  // ─────────────────── Регресс: «дубль + карточка Шанс на парковку» ───────────────────
  //
  // Сценарий бага:
  //  1) Игрок бросает дубль 2/2 → mustRollAgain=true, consecutiveDoubles=1.
  //  2) Попадает на ШАНС → вытягивает карту «Бесплатная парковка (move target=20)».
  //  3) После CONFIRM_CARD сервер перемещает фишку на 20, фаза идёт
  //     MOVE_ANIMATION → RESOLVING_LANDING (парковка) → BUILDING.
  //  4) mustRollAgain должен быть сброшен в false сервером (в
  //     applyCardEffectAndAdvance для move-исхода), иначе:
  //     - canEndTurn=false (т.к. mustRollAgain=true в BUILDING);
  //     - canRoll=false (т.к. фаза не ROLLING);
  //     - никаких активных кнопок → игра застопорена.
  //
  // Этот тест фиксирует, что turn-permissions ОЖИДАЕТ, что сервер уже
  // сбросил mustRollAgain к моменту прихода фазы BUILDING. Реальный
  // сброс тестируется в games.service.fsm.spec.ts.
  describe("regression: дубль + карточка Шанс на парковку", () => {
    it("после карточки move: BUILDING + mustRollAgain=false → canEndTurn=true", () => {
      // Имитируем состояние, которое должен вернуть сервер после
      // CONFIRM_CARD для карточки «Отправляйтесь на парковку»:
      //   - фаза BUILDING (парковка не требует действий);
      //   - mustRollAgain сброшен сервером (applyCardEffectAndAdvance).
      const s = makeState({
        phase: "BUILDING",
        players: [
          makePlayer({ id: "p0", mustRollAgain: false, consecutiveDoubles: 0 }),
          makePlayer({ id: "p1" }),
        ],
      });
      // Игрок стоит на парковке (id=20), деньги не изменились.
      s.players[0]!.position = 20;
      expect(canEndTurn(s, s.players[0]!)).toBe(true);
      expect(canRollDice(s, s.players[0]!)).toBe(false);
    });

    it("«Голый» BUILDING + mustRollAgain=true (анти-паттерн) → canEndTurn=false (страховка)", () => {
      // Если бы сервер НЕ сбросил mustRollAgain — обе кнопки заблокированы.
      // Этот тест документирует, что БЕЗ правки applyCardEffectAndAdvance
      // игра бы застряла. С правкой сервера — mustRollAgain=false, и этот
      // сценарий не возникает.
      const s = makeState({
        phase: "BUILDING",
        players: [makePlayer({ id: "p0", mustRollAgain: true }), makePlayer({ id: "p1" })],
      });
      expect(canEndTurn(s, s.players[0]!)).toBe(false);
      expect(canRollDice(s, s.players[0]!)).toBe(false);
    });
  });

  // ─────────────────── Регресс: «дубль + stay-карточка (money)» ───────────────────
  //
  // Контрастный сценарий: игрок бросил дубль и попал на money-карту
  // (например «Банк выплачивает вам дивиденды 50₽»). Это «stay»-эффект
  // (applyEffect возвращает kind: "stay"). По правилам Монополии здесь
  // НЕ должно быть сброса mustRollAgain — игрок остаётся на той же
  // клетке, и право на ещё один бросок сохраняется. afterRentOrTax в
  // GamesService выберет фазу ROLLING (а не BUILDING).
  //
  // Этот тест фиксирует, что если сервер по какой-то причине оставил
  // игрока в BUILDING с mustRollAgain=true (аномалия), UI заблокирует
  // обе кнопки — то есть корректное правило остаётся:
  //   «после дубля в BUILDING → игрок должен бросить ещё раз».
  describe("regression: дубль + money-карта (stay)", () => {
    it("ROLLING + mustRollAgain=true после money-карты → canRoll=true, canEndTurn=false", () => {
      // Нормальное состояние после money-карты с дублем: фаза ROLLING,
      // mustRollAgain сохранён, игрок бросает ещё раз.
      const s = makeState({
        phase: "ROLLING",
        players: [makePlayer({ id: "p0", mustRollAgain: true }), makePlayer({ id: "p1" })],
      });
      expect(canRollDice(s, s.players[0]!)).toBe(true);
      expect(mustRollDiceNow(s, s.players[0]!)).toBe(true);
      expect(canEndTurn(s, s.players[0]!)).toBe(false);
    });
  });

  describe("regression: justArrivedAtParking (карточка move target=20)", () => {
    it("justArrivedAtParking=true + phase=ROLLING → canRoll=false (бросок заблокирован)", () => {
      // После «Отправляйтесь на парковку» в текущем ходу право на
      // ещё один бросок (после дубля) ТЕРЯЕТСЯ. UI не должен показывать
      // активную кнопку «Бросить кубики» — даже если фаза=ROLLING
      // (защита от гонок с анимацией/реконнектом).
      const s = makeState({
        phase: "ROLLING",
        justArrivedAtParking: true,
        players: [makePlayer({ id: "p0" }), makePlayer({ id: "p1" })],
      });
      expect(canRollDice(s, s.players[0]!)).toBe(false);
      expect(mustRollDiceNow(s, s.players[0]!)).toBe(false);
    });

    it("justArrivedAtParking=true + phase=BUILDING → canEndTurn=true (завершить можно)", () => {
      // Нормальный случай сразу после карточки: фаза BUILDING, флаг
      // установлен. Игрок может только завершить ход.
      const s = makeState({
        phase: "BUILDING",
        justArrivedAtParking: true,
        players: [makePlayer({ id: "p0" }), makePlayer({ id: "p1" })],
      });
      expect(canEndTurn(s, s.players[0]!)).toBe(true);
    });

    it("justArrivedAtParking=false (или undefined) → canRoll=true в ROLLING", () => {
      // Защита от ложных срабатываний: если флаг не выставлен
      // (например, в начале хода handleStartTurn сбросил его),
      // бросок разрешён в обычном режиме.
      const s1 = makeState({
        phase: "ROLLING",
        players: [makePlayer({ id: "p0" }), makePlayer({ id: "p1" })],
      });
      expect(canRollDice(s1, s1.players[0]!)).toBe(true);

      const s2 = makeState({
        phase: "ROLLING",
        justArrivedAtParking: false,
        players: [makePlayer({ id: "p0" }), makePlayer({ id: "p1" })],
      });
      expect(canRollDice(s2, s2.players[0]!)).toBe(true);
    });
  });
});
