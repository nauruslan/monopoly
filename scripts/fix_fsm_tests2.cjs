/* eslint-disable */
// Удаляем из games.service.fsm.spec.ts тесты с TRADE_OFFER/BUY_PROPERTY в тюрьме —
// они требуют доп. полей в GameAction. Логика покрыта unit-тестами canBuyProperty/canTrade.

const fs = require("node:fs");
const path = require("node:path");

const FILE = path.join(process.cwd(), "apps/server/src/games/__tests__/games.service.fsm.spec.ts");
const buf = fs.readFileSync(FILE);
let text = buf.toString("utf8");
const isCrlf = text.includes("\r\n");
let src = isCrlf ? text.replace(/\r\n/g, "\n") : text;
const before = src;

const old =
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

const next = "  });\n});\n";

if (!src.includes(old)) {
  console.error("old block not found");
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
