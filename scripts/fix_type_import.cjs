/* eslint-disable */
// Fix: "import type {" -> "import {" чтобы CHANCE_CARDS импортировался как value.

const fs = require("node:fs");
const path = require("node:path");

const FILE = path.join(process.cwd(), "apps/server/src/games/games.service.ts");
const buf = fs.readFileSync(FILE);
let text = buf.toString("utf8");
const isCrlf = text.includes("\r\n");
let src = isCrlf ? text.replace(/\r\n/g, "\n") : text;
const before = src;

const old =
  'import type {\n  GameState,\n  GameAction,\n  Player,\n  GameEvent,\n  TradeOffer,\n  Phase,\n  Card,\n  CardDeckState,\n  Cell,\n  CHANCE_CARDS,\n} from "@monopoly/shared";';

const next =
  'import {\n  GameState,\n  GameAction,\n  Player,\n  GameEvent,\n  TradeOffer,\n  Phase,\n  Card,\n  CardDeckState,\n  Cell,\n  CHANCE_CARDS,\n} from "@monopoly/shared";';

if (!src.includes(old)) {
  console.error("type import not found");
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
