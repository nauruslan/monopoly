/* eslint-disable */
// Patch games.service.ts: handleStartTurn + handleJailDecision.
// Используем line-anchored replace через split('\n') и индекс строк.

const fs = require("node:fs");
const path = require("node:path");

const FILE = path.join(
  process.cwd(),
  "apps/server/src/games/games.service.ts",
);
const raw = fs.readFileSync(FILE, "utf8");
const lines = raw.split("\n");

function findLine(needle, startAt = 0) {
  for (let i = startAt; i < lines.length; i++) {
    if (lines[i].includes(needle)) return i;
  }
  return -1;
}

// --- 1) handleStartTurn: найти блок `if (player.inJail) {...} else {...}`
// --- Вставить `state.justEnteredJail = false;` после `if (player.inJail) {`
const inJailLine = findLine("if (player.inJail) {");
if (inJailLine < 0) {
  console.error("if (player.inJail) not found");
  process.exit(1);
}
// Вставляем строку после открывающей скобки.
const indent = lines[inJailLine].match(/^(\s*)/)[1] + "  ";
lines.splice(
  inJailLine + 1,
  0,
  `${indent}state.justEnteredJail = false;`,
);

// --- 2) handleJailDecision: найти `if (action.type === "PAY_JAIL_FINE") {`
// --- и вставить перед ним блок проверки `state.justEnteredJail`.
const payJailLine = findLine('if (action.type === "PAY_JAIL_FINE") {');
if (payJailLine < 0) {
  console.error("PAY_JAIL_FINE block not found");
  process.exit(1);
}

const payIndent = lines[payJailLine].match(/^(\s*)/)[1];
const newBlock = [
  `${payIndent}// Svezhee popadanie v tyurmu (v ETOM khodu): po pravilam Monopolii`,
  `${payIndent}// igrok NE prinimaet reshenie o vykhode v tom zhe khodu — tolko END_TURN.`,
  `${payIndent}// Modalnaya okna s tremya sposobami vykhoda poyavitsya v nachale SLEDUYUSHEGO khoda.`,
  `${payIndent}if (state.justEnteredJail) {`,
  `${payIndent}  if (action.type === "END_TURN" || action.type === "CONFIRM_END_TURN") {`,
  `${payIndent}    this.advanceToNextPlayer(state);`,
  `${payIndent}    state.phase = "ROLLING";`,
  `${payIndent}    return {};`,
  `${payIndent}  }`,
  `${payIndent}  throw new ForbiddenException(`,
  `${payIndent}    \`Tolko chto popal v tyurmu — v etom khodu mozhno tolko zavershit hod, a ne \${action.type}\`,`,
  `${payIndent}  );`,
  `${payIndent}}`,
  ``,
];

lines.splice(payJailLine, 0, ...newBlock);

const out = lines.join("\n");
if (out === raw) {
  console.error("File unchanged");
  process.exit(1);
}
fs.writeFileSync(FILE, out, "utf8");
console.log("OK");
