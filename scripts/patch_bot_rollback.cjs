/* eslint-disable */
// Восстанавливаем в bot.service.ts ветку ROLLING для inJail (страховка).
const fs = require("node:fs");
const path = require("node:path");

const FILE = path.join(process.cwd(), "apps/server/src/games/bots/bot.service.ts");
const buf = fs.readFileSync(FILE);
let text = buf.toString("utf8");
const isCrlf = text.includes("\r\n");
let src = isCrlf ? text.replace(/\r\n/g, "\n") : text;
const before = src;

const old =
  "      case \"ROLLING\":\n" +
  "        // В ROLLING бот кидает кубики (потом сервер сам переходит в\n" +
  "        // DICE_ANIMATION и по таймеру двигает дальше). Если же почему-то\n" +
  "        // игрок в тюрьме (теоретически) — ждём JAIL_DECISION, не действуем.\n" +
  "        if (player.inJail) return null;\n" +
  "        return \"ROLL\";";

const next =
  "      case \"ROLLING\":\n" +
  "        // Если игрок в тюрьме — сначала надо выйти (использовать карточку\n" +
  "        // или попробовать дубль), а не бросать кубики. Решение об оплате\n" +
  "        // штрафа и логика tryDouble vs payFine — в JAIL_DECISION, куда\n" +
  "        // GamesService переведёт фазу после нашего действия.\n" +
  "        if (player.inJail) {\n" +
  "          if (player.jailCards > 0) return \"USE_CARD\";\n" +
  "          return \"TRY_DOUBLE\";\n" +
  "        }\n" +
  "        // В ROLLING бот кидает кубики (потом сервер сам переходит в\n" +
  "        // DICE_ANIMATION и по таймеру двигает дальше).\n" +
  "        return \"ROLL\";";

if (!src.includes(old)) {
  console.error("ROLLING block not found");
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
