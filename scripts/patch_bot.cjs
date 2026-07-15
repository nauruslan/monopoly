/* eslint-disable */
// Patch bot.service.ts: JAIL_DECISION учитывает justEnteredJail + ROLLING страховка.
// Файл в CRLF, поэтому нормализуем при чтении и запишем в CRLF обратно.

const fs = require("node:fs");
const path = require("node:path");

const FILE = path.join(process.cwd(), "apps/server/src/games/bots/bot.service.ts");
const rawBuf = fs.readFileSync(FILE);
let text = rawBuf.toString("utf8");
const isCrlf = text.includes("\r\n");
let src = isCrlf ? text.replace(/\r\n/g, "\n") : text;
const EOL = isCrlf ? "\r\n" : "\n";
const before = src;

function findLine(needle, startAt = 0) {
  const lines = src.split("\n");
  for (let i = startAt; i < lines.length; i++) {
    if (lines[i].includes(needle)) return { lines, idx: i };
  }
  return null;
}

const found = findLine('case "JAIL_DECISION":');
if (!found) {
  console.error("JAIL_DECISION line not found");
  process.exit(1);
}
const { lines, idx } = found;

// Найдём первую строку ЗА блоком, где начинается "case" следующий, или
// строка с "case \"AUCTION_BIDDING\":" — это начало следующего case.
let endIdx = idx;
while (endIdx < lines.length) {
  const ln = lines[endIdx];
  if (endIdx > idx && ln.trimStart().startsWith("case ")) break;
  if (ln.includes("Прерывания: аукцион")) break;
  endIdx++;
}
// Отрезаем блок [idx, endIdx)
const newBlock = [
  '      case "JAIL_DECISION":',
  "        // Svezhee popadanie v tyurmu (v ETOM khodu) — po pravilam Monopolii",
  "        // igrok ne prinimaet reshenie o vykhode v tom zhe khodu: tolko END_TURN.",
  "        // Modalnaya okna s tremya sposobami vykhoda poyavitsya v SLEDUYUSHEM khodu.",
  '        if (state.justEnteredJail) return "END_TURN";',
  '        if (player.jailCards > 0) return "USE_CARD";',
  '        if (player.money >= 50) return "PAY_FINE";',
  '        return "TRY_DOUBLE";',
];
lines.splice(idx, endIdx - idx, ...newBlock);

src = lines.join("\n");

// Страховка для ROLLING: убираем старую ветвь "if (player.inJail) { ... }"
// в кейсе "ROLLING", заменяем на просто "if (player.inJail) return null;".
const oldRoll =
  '      case "ROLLING":\n' +
  "        // Если игрок в тюрьме — сначала надо выйти (использовать карточку\n" +
  "        // или попробовать дубль), а не бросать кубики. Решение об оплате\n" +
  "        // штрафа и логика tryDouble vs payFine — в JAIL_DECISION, куда\n" +
  "        // GamesService переведёт фазу после нашего действия.\n" +
  "        if (player.inJail) {\n" +
  '          if (player.jailCards > 0) return "USE_CARD";\n' +
  '          return "TRY_DOUBLE";\n' +
  "        }\n" +
  "        // В ROLLING бот кидает кубики (потом сервер сам переходит в\n" +
  "        // DICE_ANIMATION и по таймеру двигает дальше).\n" +
  '        return "ROLL";';

const newRoll =
  '      case "ROLLING":\n' +
  "        // В ROLLING бот кидает кубики (потом сервер сам переходит в\n" +
  "        // DICE_ANIMATION и по таймеру двигает дальше). Если же почему-то\n" +
  "        // игрок в тюрьме (теоретически) — ждём JAIL_DECISION, не действуем.\n" +
  "        if (player.inJail) return null;\n" +
  '        return "ROLL";';

if (src.includes(oldRoll)) {
  src = src.replace(oldRoll, newRoll);
}

if (src === before) {
  console.error("File unchanged");
  process.exit(1);
}
const out = isCrlf ? src.replace(/\n/g, "\r\n") : src;
fs.writeFileSync(FILE, out, "utf8");
console.log("OK (CRLF=" + isCrlf + ")");
