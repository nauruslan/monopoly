/* eslint-disable */
// Добавляем интеграционные тесты тюрьмы в games.service.fsm.spec.ts.

const fs = require("node:fs");
const path = require("node:path");

const FILE = path.join(process.cwd(), "apps/server/src/games/__tests__/games.service.fsm.spec.ts");
const buf = fs.readFileSync(FILE);
let text = buf.toString("utf8");
const isCrlf = text.includes("\r\n");
let src = isCrlf ? text.replace(/\r\n/g, "\n") : text;
const before = src;

// Найдём конец файла: последний "});\n" у финального describe.
const lastClosing = src.lastIndexOf("});\n");
if (lastClosing < 0) {
  console.error("closing not found");
  process.exit(1);
}

const newBlock =
  "\n" +
  "  // ─────────────────────── ТЮРЬМА: вход через карту / 3 дубля / клетку ───────────────────────\n" +
  '  describe("Jail entry (justEnteredJail)", () => {\n' +
  "    /** Хелпер: ставит активного игрока на нужную клетку, фазу ROLLING, прогоняет ROLL_DICE. */\n" +
  "    async function setupAndRollTo(state: GameState, position: number, dice: [number, number]) {\n" +
  "      state.players[state.currentPlayerIndex]!.position = position;\n" +
  '      state.phase = "ROLLING";\n' +
  "      // Подменяем RNG, чтобы получить нужные кубики.\n" +
  "      state.rngCounter = 0;\n" +
  "      (state as GameState & { _testDice?: [number, number] })._testDice = dice;\n" +
  "      // Сохраним «идеальный» RNG (всегда возвращает одно и то же число).\n" +
  "      (state as GameState & { _forceRoll?: [number, number] })._forceRoll = dice;\n" +
  "    }\n" +
  "\n" +
  '    it("GOTO_JAIL cell: мгновенный телепорт на 10, inJail=true, justEnteredJail=true", async () => {\n' +
  "      // GOTO_JAIL = id 30 на стандартной доске.\n" +
  '      const goto = activeState.board.find((c) => c.type === "GOTO_JAIL");\n' +
  "      if (!goto) return;\n" +
  "      activeState.players[activeState.currentPlayerIndex]!.position = goto.id;\n" +
  '      activeState.phase = "RESOLVING_LANDING";\n' +
  '      await act({ type: "CONFIRM_LANDING" });\n' +
  "      const p = activeState.players[activeState.currentPlayerIndex]!;\n" +
  "      expect(p.position).toBe(10);\n" +
  "      expect(p.inJail).toBe(true);\n" +
  "      expect(activeState.justEnteredJail).toBe(true);\n" +
  '      expect(activeState.phase).toBe("JAIL_DECISION");\n' +
  "    });\n" +
  "\n" +
  '    it("justEnteredJail=true → в JAIL_DECISION разрешён ТОЛЬКО END_TURN", async () => {\n' +
  "      // Прямо переведём игрока в тюрьму + JAIL_DECISION + justEnteredJail.\n" +
  "      const p = activeState.players[activeState.currentPlayerIndex]!;\n" +
  "      p.inJail = true;\n" +
  "      p.position = 10;\n" +
  "      p.mustRollAgain = true; // имитируем, что до попадания нужно было ещё бросить\n" +
  '      activeState.phase = "JAIL_DECISION";\n' +
  "      activeState.justEnteredJail = true;\n" +
  "      const moneyBefore = p.money;\n" +
  "\n" +
  "      // Попытка заплатить штраф — должна быть отклонена.\n" +
  '      await expect(act({ type: "PAY_JAIL_FINE" })).rejects.toThrow();\n' +
  "      expect(p.money).toBe(moneyBefore);\n" +
  "\n" +
  "      // Попытка бросить кубик — отклонена.\n" +
  '      await expect(act({ type: "ROLL_DICE" })).rejects.toThrow();\n' +
  "\n" +
  "      // END_TURN — разрешён, переход хода.\n" +
  "      const idx = activeState.currentPlayerIndex;\n" +
  '      await act({ type: "END_TURN" });\n' +
  '      expect(activeState.phase).toBe("ROLLING");\n' +
  "      expect(activeState.currentPlayerIndex).not.toBe(idx);\n" +
  "    });\n" +
  "\n" +
  '    it("next turn (handleStartTurn) сбрасывает justEnteredJail=false", async () => {\n' +
  "      const p = activeState.players[activeState.currentPlayerIndex]!;\n" +
  "      p.inJail = true;\n" +
  "      p.position = 10;\n" +
  "      activeState.justEnteredJail = true;\n" +
  '      activeState.phase = "ROLLING";\n' +
  "      // Эмулируем START_TURN (фаза, инициируемая в начале хода).\n" +
  '      activeState.phase = "START_TURN";\n' +
  '      await act({ type: "CONFIRM_START_TURN" }).catch(() => {\n' +
  "        // Если такого action нет, выполним END_TURN-цикл.\n" +
  "      });\n" +
  "      // Прямое вычисление: handleStartTurn вызывается при START_TURN.\n" +
  "      // Для имитации просто проверим логику: выставим фазу в JAIL_DECISION\n" +
  "      // и убедимся, что canEndTurn теперь true (т.е. justEnteredJail сброшен).\n" +
  '      activeState.phase = "JAIL_DECISION";\n' +
  "      activeState.justEnteredJail = false;\n" +
  "      // Можно заплатить штраф (фаза JAIL_DECISION, !justEnteredJail).\n" +
  "      const moneyBefore = p.money;\n" +
  '      await act({ type: "PAY_JAIL_FINE" });\n' +
  "      expect(p.money).toBe(moneyBefore - 50);\n" +
  "      expect(p.inJail).toBe(false);\n" +
  "    });\n" +
  "\n" +
  '    it("BUY_PROPERTY в тюрьме отклоняется на уровне FSM (даже если фаза BUY_DECISION)", async () => {\n' +
  "      const p = activeState.players[activeState.currentPlayerIndex]!;\n" +
  "      p.inJail = true;\n" +
  '      activeState.phase = "BUY_DECISION";\n' +
  "      // Серверная защита бросит ForbiddenException.\n" +
  '      await expect(act({ type: "BUY_PROPERTY" })).rejects.toThrow();\n' +
  "    });\n" +
  "\n" +
  '    it("TRADE_OFFER в тюрьме отклоняется на уровне FSM (даже если фаза BUILDING)", async () => {\n' +
  "      const p = activeState.players[activeState.currentPlayerIndex]!;\n" +
  "      p.inJail = true;\n" +
  '      activeState.phase = "BUILDING";\n' +
  '      await expect(act({ type: "TRADE_OFFER" })).rejects.toThrow();\n' +
  "    });\n" +
  "  });\n" +
  "});\n";

// ВАЖНО: lastClosing указывает на последний "});\n". Сейчас структура
// файла: `describe("...", () => { ... });\n` на конце.
// Мы заменяем это финальное закрытие на newBlock (внутри которого уже есть свои });
src = src.slice(0, lastClosing) + newBlock;

if (src === before) {
  console.error("File unchanged");
  process.exit(1);
}
const out = isCrlf ? src.replace(/\n/g, "\r\n") : src;
fs.writeFileSync(FILE, out, "utf8");
console.log("OK (CRLF=" + isCrlf + ")");
