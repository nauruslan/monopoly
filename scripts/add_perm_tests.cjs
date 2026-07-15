/* eslint-disable */
// Добавляем тесты canBuyProperty/canTrade (блок в тюрьме) в turn-permissions.spec.ts
// + тест justEnteredJail в mustRollDiceNow.

const fs = require("node:fs");
const path = require("node:path");

const FILE = path.join(
  process.cwd(),
  "apps/server/src/games/__tests__/turn-permissions.spec.ts",
);
const buf = fs.readFileSync(FILE);
let text = buf.toString("utf8");
const isCrlf = text.includes("\r\n");
let src = isCrlf ? text.replace(/\r\n/g, "\n") : text;
const before = src;

// 1) Расширим импорт: добавим canBuyProperty, canTrade.
const oldImport =
  "import { canRollDice, canEndTurn, mustRollDiceNow, isCurrentPlayer } from \"../turn-permissions\";";
const newImport =
  "import {\n" +
  "  canRollDice,\n" +
  "  canEndTurn,\n" +
  "  mustRollDiceNow,\n" +
  "  isCurrentPlayer,\n" +
  "  canBuyProperty,\n" +
  "  canTrade,\n" +
  "} from \"../turn-permissions\";";
if (!src.includes(oldImport)) {
  console.error("import line not found");
  process.exit(1);
}
src = src.replace(oldImport, newImport);

// 2) В конце файла, перед `});` финального `describe`, добавим новый describe.
const closing = "});\n";
const lastClosing = src.lastIndexOf("});\n");
if (lastClosing < 0) {
  console.error("closing not found");
  process.exit(1);
}

const newDescribe =
  "\n" +
  "  // ─────────────────────── Тюрьма: блокировка покупки/торговли ───────────────────────\n" +
  "  describe(\"canBuyProperty (блок в тюрьме)\", () => {\n" +
  "    it(\"true в фазе BUY_DECISION, если игрок НЕ в тюрьме\", () => {\n" +
  "      const s = makeState({ phase: \"BUY_DECISION\" });\n" +
  "      expect(canBuyProperty(s, s.players[0]!)).toBe(true);\n" +
  "    });\n" +
  "\n" +
  "    it(\"false в фазе BUY_DECISION, если игрок В тюрьме (правила Монополии)\", () => {\n" +
  "      const s = makeState({ phase: \"BUY_DECISION\" });\n" +
  "      const p = { ...s.players[0]!, inJail: true };\n" +
  "      expect(canBuyProperty(s, p)).toBe(false);\n" +
  "    });\n" +
  "\n" +
  "    it(\"false в фазе BUILDING, если игрок в тюрьме (тоже нельзя)\", () => {\n" +
  "      const s = makeState({ phase: \"BUILDING\" });\n" +
  "      const p = { ...s.players[0]!, inJail: true };\n" +
  "      expect(canBuyProperty(s, p)).toBe(false);\n" +
  "    });\n" +
  "\n" +
  "    it(\"false в фазе ROLLING (покупка только в BUY_DECISION)\", () => {\n" +
  "      const s = makeState({ phase: \"ROLLING\" });\n" +
  "      expect(canBuyProperty(s, s.players[0]!)).toBe(false);\n" +
  "    });\n" +
  "  });\n" +
  "\n" +
  "  describe(\"canTrade (блок в тюрьме)\", () => {\n" +
  "    it(\"true в фазе BUILDING, если игрок НЕ в тюрьме\", () => {\n" +
  "      const s = makeState({ phase: \"BUILDING\" });\n" +
  "      expect(canTrade(s, s.players[0]!)).toBe(true);\n" +
  "    });\n" +
  "\n" +
  "    it(\"false в фазе BUILDING, если игрок В тюрьме (правила Монополии)\", () => {\n" +
  "      const s = makeState({ phase: \"BUILDING\" });\n" +
  "      const p = { ...s.players[0]!, inJail: true };\n" +
  "      expect(canTrade(s, p)).toBe(false);\n" +
  "    });\n" +
  "\n" +
  "    it(\"false в фазе ROLLING (торговля только в BUILDING)\", () => {\n" +
  "      const s = makeState({ phase: \"ROLLING\" });\n" +
  "      expect(canTrade(s, s.players[0]!)).toBe(false);\n" +
  "    });\n" +
  "  });\n" +
  "});\n";

src = src.slice(0, lastClosing) + newDescribe + src.slice(lastClosing + closing.length);

if (src === before) {
  console.error("File unchanged");
  process.exit(1);
}
const out = isCrlf ? src.replace(/\n/g, "\r\n") : src;
fs.writeFileSync(FILE, out, "utf8");
console.log("OK (CRLF=" + isCrlf + ")");
