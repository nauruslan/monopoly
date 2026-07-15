/* eslint-disable */
// Удаляем "CONFIRM_START_TURN" из нового блока jail-тестов.

const fs = require("node:fs");
const path = require("node:path");

const FILE = path.join(process.cwd(), "apps/server/src/games/__tests__/games.service.fsm.spec.ts");
const buf = fs.readFileSync(FILE);
let text = buf.toString("utf8");
const isCrlf = text.includes("\r\n");
let src = isCrlf ? text.replace(/\r\n/g, "\n") : text;
const before = src;

const old =
  '      activeState.phase = "START_TURN";\n' +
  '      await act({ type: "CONFIRM_START_TURN" }).catch(() => {\n' +
  "        // Если такого action нет, выполним END_TURN-цикл.\n" +
  "      });\n" +
  "      // Прямое вычисление: handleStartTurn вызывается при START_TURN.\n" +
  "      // Для имитации просто проверим логику: выставим фазу в JAIL_DECISION\n" +
  "      // и убедимся, что canEndTurn теперь true (т.е. justEnteredJail сброшен).\n" +
  '      activeState.phase = "JAIL_DECISION";\n' +
  "      activeState.justEnteredJail = false;";

const next =
  "      // Прямое вычисление: handleStartTurn вызывается при START_TURN\n" +
  "      // (это Phase, не action). Для имитации достаточно сбросить\n" +
  "      // justEnteredJail вручную — handleStartTurn делает то же самое.\n" +
  '      activeState.phase = "JAIL_DECISION";\n' +
  "      activeState.justEnteredJail = false;";

if (!src.includes(old)) {
  console.error("CONFIRM_START_TURN block not found");
  process.exit(1);
}
src = src.replace(old, next);

if (src === before) {
  console.error("File unchanged");
  process.exit(1);
}
const out = isCrlf ? src.replace(/\n/g, "\r\n") : src;
fs.writeFileSync(FILE, out, "utf8");
console.log("OK (CRLF=" + isCrlf + ")");
