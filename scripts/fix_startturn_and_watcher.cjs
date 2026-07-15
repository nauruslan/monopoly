#!/usr/bin/env node
/* eslint-disable */
// Исправления:
// 1) games.service.ts: handleEndTurn и handleJailDecision (после advanceToNextPlayer)
//    должны ставить phase = "START_TURN", чтобы при следующем ходе сработал
//    handleStartTurn (сброс justEnteredJail, переход в ROLLING/JAIL_DECISION).
// 2) GameView.vue: удалить вложенный watcher на justEnteredJail из тела phase watcher
//    и добавить нормальный watcher верхнего уровня.

const fs = require("fs");
const path = require("path");

const REPO = path.resolve(__dirname, "..");

function readText(rel) {
  const buf = fs.readFileSync(path.join(REPO, rel));
  const isCrlf = buf.includes(Buffer.from("\r\n"));
  return { text: buf.toString("utf8"), isCrlf };
}

function writeText(rel, text, isCrlf) {
  if (isCrlf) {
    text = text.replace(/\r\n/g, "\n");
    text = text.replace(/\n/g, "\r\n");
  }
  fs.writeFileSync(path.join(REPO, rel), text, "utf8");
}

function replaceExact(text, oldSubstr, newSubstr) {
  const idx = text.indexOf(oldSubstr);
  if (idx < 0) {
    throw new Error("Not found: " + JSON.stringify(oldSubstr.slice(0, 80)));
  }
  return text.slice(0, idx) + newSubstr + text.slice(idx + oldSubstr.length);
}

// =============================================================
// PART 1: games.service.ts
// =============================================================
const SERVER = "apps/server/src/games/games.service.ts";
{
  const { text, isCrlf } = readText(SERVER);
  let t = text;

  // 1.1 handleEndTurn: после advanceToNextPlayer → phase = "START_TURN"
  const old1 = `    if (player.mustRollAgain) {
      player.mustRollAgain = false;
      player.consecutiveDoubles = 0;
      state.phase = "ROLLING";
    } else {
      this.advanceToNextPlayer(state);
      state.phase = "ROLLING";
    }`;
  const new1 = `    if (player.mustRollAgain) {
      player.mustRollAgain = false;
      player.consecutiveDoubles = 0;
      state.phase = "START_TURN";
    } else {
      this.advanceToNextPlayer(state);
      // Передаём ход через промежуточную фазу START_TURN — там
      // handleStartTurn проверит, в тюрьме ли новый игрок, и либо
      // переведёт его в JAIL_DECISION (сбросив justEnteredJail),
      // либо сразу в ROLLING.
      state.phase = "START_TURN";
    }`;
  t = replaceExact(t, old1, new1);

  // 1.2 handleJailDecision: !inJail → START_TURN
  const old2 = `    if (!player.inJail) {
      // Уже вышли — передаём ход.
      this.advanceToNextPlayer(state);
      state.phase = "ROLLING";
      return {};
    }`;
  const new2 = `    if (!player.inJail) {
      // Уже вышли — передаём ход через START_TURN, чтобы новый игрок
      // прошёл handleStartTurn (сброс justEnteredJail и т.п.).
      this.advanceToNextPlayer(state);
      state.phase = "START_TURN";
      return {};
    }`;
  t = replaceExact(t, old2, new2);

  // 1.3 handleJailDecision: ветка justEnteredJail — END_TURN
  const old3 = `    if (state.justEnteredJail) {
      if (action.type === "END_TURN" || action.type === "CONFIRM_END_TURN") {
        this.advanceToNextPlayer(state);
        state.phase = "ROLLING";
        return {};
      }
      throw new ForbiddenException(
        \`Tolko chto popal v tyurmu — v etom khodu mozhno tolko zavershit hod, a ne \${action.type}\`,
      );
    }`;
  const new3 = `    if (state.justEnteredJail) {
      if (action.type === "END_TURN" || action.type === "CONFIRM_END_TURN") {
        this.advanceToNextPlayer(state);
        // Следующий ход должен пройти через START_TURN, чтобы
        // handleStartTurn сбросил justEnteredJail.
        state.phase = "START_TURN";
        return {};
      }
      throw new ForbiddenException(
        \`Только что попал в тюрьму — в этом ходу можно только завершить ход, а не \${action.type}\`,
      );
    }`;
  t = replaceExact(t, old3, new3);

  // 1.4 handleJailDecision: TRY_DOUBLE — stay
  const old5 = `      // "stay" — остаёмся, передаём ход.
      this.advanceToNextPlayer(state);
      state.phase = "ROLLING";
      return { dice: diceResult };`;
  const new5 = `      // "stay" — остаёмся, передаём ход через START_TURN.
      this.advanceToNextPlayer(state);
      state.phase = "START_TURN";
      return { dice: diceResult };`;
  t = replaceExact(t, old5, new5);

  // 1.5 Починим испорченные комментарии (если предыдущий patch оставил
  // транслитерированный русский). Ищем по фрагменту «Svezhee popadanie»
  // и заменяем нормальным русским комментарием.
  t = t.replace(
    /\/\/ Svezhee popadanie v tyurmu[\s\S]*?Modalnaya okna[\s\S]*?SLEDUYUSHEGO khoda\.[ \t]*/,
    "// Только что попал в тюрьму (в ЭТОМ ходу): по правилам Монополии\n    // игрок НЕ принимает решение о выходе в том же ходу — только END_TURN.\n    // Модальное окно с тремя способами выхода появится в начале СЛЕДУЮЩЕГО хода.\n    ",
  );

  writeText(SERVER, t, isCrlf);
  console.log("[OK] games.service.ts patched");
}

// =============================================================
// PART 2: GameView.vue
// =============================================================
const CLIENT = "apps/client/src/views/GameView.vue";
{
  const { text, isCrlf } = readText(CLIENT);
  let t = text;

  // 2.1 Удалим вложенный watcher на justEnteredJail из тела phase watcher.
  // Старый блок выглядит так (он лежит в СЕРЕДИНЕ callback'а phase watcher'а,
  // из-за чего не является самостоятельным watcher'ом, а выполняется
  // синхронно каждый раз при смене фазы).
  const oldWatcher = `// Мгновенный телепорт в тюрьму: когда сервер только что отправил игрока
// в тюрьму (картой/3 дублями/клеткой), \`state.justEnteredJail=true\`,
// фаза JAIL_DECISION, но \`MOVE_ANIMATION\` не запускается. Синхронизируем
// \`displayPositions\` с реальной \`player.position\` (тюрьма = 10), чтобы
// фишка «прыгнула» без анимации.
watch(
  () => state.value.justEnteredJail,
  (justEntered) => {
    if (!justEntered) return;
    const p = currentPlayer.value;
    if (!p) return;
    // Очистим активный таймер анимации, если он был.
    if (animTimers[p.id]) {
      clearInterval(animTimers[p.id]);
      delete animTimers[p.id];
    }
    displayPositions.value = {
      ...displayPositions.value,
      [p.id]: p.position,
    };
  },
);`;

  if (t.indexOf(oldWatcher) < 0) {
    // Фрагмент-поиск по началу блока + закрывающему }.
    const fragStart = `// Мгновенный телепорт в тюрьму:`;
    const fragEnd = `  },\n);`;
    const s = t.indexOf(fragStart);
    if (s < 0) {
      console.warn("[WARN] justEnteredJail watcher block not found — skipping removal");
    } else {
      const close = t.indexOf(fragEnd, s);
      if (close < 0) {
        console.warn("[WARN] End of justEnteredJail watcher not found — skipping");
      } else {
        const endIdx = close + fragEnd.length;
        t = t.slice(0, s) + t.slice(endIdx);
        // Подчистим возможный висячий отступ
        t = t.replace(/\n[ \t]*\n[ \t]*\}\n[ \t]*\}\n[ \t]*\}/g, "\n      }\n    }\n  }");
      }
    }
  } else {
    t = replaceExact(t, oldWatcher, "");
  }

  // 2.2 Вставим нормальный watcher верхнего уровня сразу после объявления
  // displayPositions. Найдём якорь и добавим watcher'ы перед animatePlayerTo.
  const anchor = `// Анимация хода фишки (фаза MOVE_ANIMATION)
// ВАЖНО: на промежуточных клетках НИЧЕГО не срабатывает.
// Анимация идёт по stepDelay × N шагов.
// По завершении — отправляем CONFIRM_MOVE_ANIMATION → сервер
// финально перемещает игрока в handleMoveAnimation, и мы получаем
// обновлённый state с новой позицией.
const displayPositions = ref<Record<string, number>>({});`;

  if (t.indexOf(anchor) < 0) {
    throw new Error("GameView.vue: displayPositions anchor not found");
  }

  const newBlock = `// Мгновенный телепорт в тюрьму: когда сервер только что отправил игрока
// в тюрьму (картой/3 дублями/клеткой), state.justEnteredJail=true,
// фаза JAIL_DECISION, но MOVE_ANIMATION не запускается. Синхронизируем
// displayPositions с реальной player.position (тюрьма = 10), чтобы
// фишка «прыгнула» без анимации.
//
// ВАЖНО: watcher регистрируется ВНУТРИ setup как самостоятельный
// top-level watch — иначе он не будет реактивным.
watch(
  () => state.value.justEnteredJail,
  (justEntered) => {
    if (!justEntered) return;
    const p = currentPlayer.value;
    if (!p) return;
    // Очистим активный таймер анимации, если он был.
    if (animTimers[p.id]) {
      clearInterval(animTimers[p.id]);
      delete animTimers[p.id];
    }
    displayPositions.value = {
      ...displayPositions.value,
      [p.id]: p.position,
    };
  },
);

// Подстраховка: если сервер прислал state с уже justEnteredJail=true
// (например, при reconnect/mount), watcher на phase мог не сработать.
// Следим за изменением currentPlayer.position пока justEnteredJail=true
// — если позиция поменялась (телепорт на 10), мгновенно синхронизируем.
watch(
  () => [currentPlayer.value?.id, currentPlayer.value?.position] as const,
  ([, pos], [, oldPos]) => {
    if (pos === undefined || oldPos === undefined) return;
    if (pos === oldPos) return;
    if (!state.value.justEnteredJail) return;
    const p = currentPlayer.value;
    if (!p) return;
    if (animTimers[p.id]) {
      clearInterval(animTimers[p.id]);
      delete animTimers[p.id];
    }
    displayPositions.value = {
      ...displayPositions.value,
      [p.id]: pos,
    };
  },
);
`;

  t = replaceExact(t, anchor, newBlock + anchor);

  writeText(CLIENT, t, isCrlf);
  console.log("[OK] GameView.vue patched");
}

console.log("Done.");
