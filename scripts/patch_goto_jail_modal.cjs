/* eslint-disable */
// Patch games.service.ts: GOTO_JAIL cell показывает модалку (CardModal)
// перед телепортацией. После CONFIRM_CARD идёт applyCardEffectAndAdvance
// (goto-jail outcome) -> sendToJail().

const fs = require("node:fs");
const path = require("node:path");

const FILE = path.join(process.cwd(), "apps/server/src/games/games.service.ts");
const buf = fs.readFileSync(FILE);
let text = buf.toString("utf8");
const isCrlf = text.includes("\r\n");
let src = isCrlf ? text.replace(/\r\n/g, "\n") : text;
const before = src;

// 1) Импорт CHANCE_CARDS из shared.
const importStart = "import {";
const importIdx = src.indexOf(importStart);
if (importIdx < 0) {
  console.error("import { not found");
  process.exit(1);
}
// Найдём конец первой группы импорта из "@monopoly/shared".
const sharedStart = src.indexOf('from "@monopoly/shared";', importIdx);
if (sharedStart < 0) {
  console.error('import from "@monopoly/shared" not found');
  process.exit(1);
}
// Перед "from "@monopoly/shared";" — вставка ", CHANCE_CARDS".
const insertAt = sharedStart;
const addImport = ", CHANCE_CARDS";
if (!src.includes(addImport, importIdx)) {
  src = src.slice(0, insertAt) + addImport + src.slice(insertAt);
}

// 2) Заменяем логику GOTO_JAIL: вместо sendToJail() напрямую —
//    показываем cardContext с goto-jail карточкой и phase = CARD_REVEAL.
const old =
  '    if (cell.type === "GOTO_JAIL") {\n' +
  "      this.jail.sendToJail(player);\n" +
  "      state.justEnteredJail = true;\n" +
  '      state.phase = "JAIL_DECISION";\n' +
  "      return {};\n" +
  "    }";

const next =
  '    if (cell.type === "GOTO_JAIL") {\n' +
  "      // Попадание на клетку «В тюрьму» (id=30) — по правилам Монополии\n" +
  "      // фишка ДОЛЖНА мгновенно (без анимации) переместиться на 10.\n" +
  "      // UX-flow: показываем карточку-объявление через стандартный\n" +
  "      // `CARD_REVEAL` -> `CardModal` (как для Chance). При подтверждении\n" +
  "      // CONFIRM_CARD идёт `handleCardEffect` -> `applyCardEffectAndAdvance`\n" +
  '      // (outcome.kind === "goto-jail") -> `sendToJail()` + JAIL_DECISION.\n' +
  "      // Сама фишка НЕ двигается по клеткам (нет MOVE_ANIMATION) —\n" +
  "      // клиент при `justEnteredJail=true` ставит её на `player.position`\n" +
  "      // мгновенно через watcher в GameView.vue.\n" +
  '      const jailCard = CHANCE_CARDS.find((c) => c.effect.kind === "goto-jail");\n' +
  "      if (jailCard) {\n" +
  "        state.cardContext = {\n" +
  "          playerId: player.id,\n" +
  '          deck: "chance",\n' +
  "          card: jailCard,\n" +
  "          applied: false,\n" +
  "        };\n" +
  '        state.phase = "CARD_REVEAL";\n' +
  "        return { card: jailCard };\n" +
  "      }\n" +
  "      // fallback (если карточка не найдена в деке — теоретически невозможно)\n" +
  "      this.jail.sendToJail(player);\n" +
  "      state.justEnteredJail = true;\n" +
  '      state.phase = "JAIL_DECISION";\n' +
  "      return {};\n" +
  "    }";

if (!src.includes(old)) {
  console.error("GOTO_JAIL block not found");
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
