/* eslint-disable */
// Patch GameView.vue: canBuy/canEndTurn/showJailModal + instant teleport.

const fs = require("node:fs");
const path = require("node:path");

const FILE = path.join(process.cwd(), "apps/client/src/views/GameView.vue");
const buf = fs.readFileSync(FILE);
let text = buf.toString("utf8");
const isCrlf = text.includes("\r\n");
let src = isCrlf ? text.replace(/\r\n/g, "\n") : text;
const EOL = isCrlf ? "\r\n" : "\n";
const before = src;
const lines = src.split("\n");

function findLine(needle, startAt = 0) {
  for (let i = startAt; i < lines.length; i++) {
    if (lines[i].includes(needle)) return i;
  }
  return -1;
}

// --- 1) canBuy: добавить проверку inJail ---
const canBuyIdx = findLine("const canBuy = computed");
if (canBuyIdx < 0) {
  console.error("canBuy line not found");
  process.exit(1);
}
const canBuyLine = lines[canBuyIdx];
const newCanBuy =
  'const canBuy = computed(() => isMyTurn.value && state.value.phase === "BUY_DECISION" && !currentPlayer.value?.inJail);';
lines[canBuyIdx] = newCanBuy;

// --- 2) canEndTurn: разрешить END_TURN в фазе JAIL_DECISION ---
const canEndIdx = findLine("const canEndTurn = computed");
if (canEndIdx < 0) {
  console.error("canEndTurn line not found");
  process.exit(1);
}
// Меняем начало: после `if (!isMyTurn.value) return false;` добавим
// короткое замыкание для JAIL_DECISION.
const oldEnd = ["const canEndTurn = computed(() => {", "  if (!isMyTurn.value) return false;"];
const newEnd = [
  "const canEndTurn = computed(() => {",
  "  if (!isMyTurn.value) return false;",
  "  // В тюрьме (JAIL_DECISION) единственный способ продолжить — END_TURN.",
  '  if (state.value.phase === "JAIL_DECISION") return true;',
];
const startSlice = lines.slice(canEndIdx, canEndIdx + oldEnd.length).join("\n");
const expected = oldEnd.join("\n");
if (startSlice !== expected) {
  console.error("canEndTurn start pattern mismatch");
  process.exit(1);
}
lines.splice(canEndIdx, oldEnd.length, ...newEnd);

src = lines.join("\n");

// --- 3) showJailModal: не показывать, если только что попал в тюрьму ---
const oldShow = '    showJailModal.value = newPhase === "JAIL_DECISION";';
const newShow =
  "    // Только что попал в тюрьму (в этом ходу) — модалку с тремя способами\n" +
  "    // выхода НЕ показываем: игроку остаётся только END_TURN. Модалка\n" +
  "    // появится в начале СЛЕДУЮЩЕГО хода, когда `state.justEnteredJail`\n" +
  "    // будет сброшен в `handleStartTurn`.\n" +
  "    showJailModal.value =\n" +
  '      newPhase === "JAIL_DECISION" && !state.value.justEnteredJail;';
if (!src.includes(oldShow)) {
  console.error("showJailModal line not found");
  process.exit(1);
}
src = src.replace(oldShow, newShow);

// --- 4) Instant teleport на `justEnteredJail` ---
// Вставляем watcher ПОСЛЕ существующего watcher'а `phase`.
const phaseWatchIdx = src.indexOf("watch(\n  () => state.value.phase,");
if (phaseWatchIdx < 0) {
  // попробуем альтернативный паттерн (с CR-LF после скобок)
  const phaseWatchIdx2 = src.indexOf("watch(\n  () => state.value.phase,");
  if (phaseWatchIdx2 < 0) {
    console.error("phase watcher not found");
    process.exit(1);
  }
}

// Найдём конец блока watcher'а phase (ближайший "});" после phaseWatchIdx).
const afterPhase = src.indexOf("});", phaseWatchIdx);
if (afterPhase < 0) {
  console.error("phase watcher end not found");
  process.exit(1);
}
const insertAt = afterPhase + "});".length;

const teleportBlock =
  "\n\n" +
  "// Мгновенный телепорт в тюрьму: когда сервер только что отправил игрока\n" +
  "// в тюрьму (картой/3 дублями/клеткой), `state.justEnteredJail=true`,\n" +
  "// фаза JAIL_DECISION, но `MOVE_ANIMATION` не запускается. Синхронизируем\n" +
  "// `displayPositions` с реальной `player.position` (тюрьма = 10), чтобы\n" +
  "// фишка «прыгнула» без анимации.\n" +
  "watch(\n" +
  "  () => state.value.justEnteredJail,\n" +
  "  (justEntered) => {\n" +
  "    if (!justEntered) return;\n" +
  "    const p = currentPlayer.value;\n" +
  "    if (!p) return;\n" +
  "    // Очистим активный таймер анимации, если он был.\n" +
  "    if (animTimers[p.id]) {\n" +
  "      clearInterval(animTimers[p.id]);\n" +
  "      delete animTimers[p.id];\n" +
  "    }\n" +
  "    displayPositions.value = {\n" +
  "      ...displayPositions.value,\n" +
  "      [p.id]: p.position,\n" +
  "    };\n" +
  "  },\n" +
  ");";

src = src.slice(0, insertAt) + teleportBlock + src.slice(insertAt);

if (src === before) {
  console.error("File unchanged");
  process.exit(1);
}
const out = isCrlf ? src.replace(/\n/g, "\r\n") : src;
fs.writeFileSync(FILE, out, "utf8");
console.log("OK (CRLF=" + isCrlf + ")");
