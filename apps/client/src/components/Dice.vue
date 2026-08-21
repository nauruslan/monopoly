<script setup lang="ts">
/**
 * Dice.vue — 3D-кубики с анимацией броска.
 *
 * Архитектура:
 *
 *  1. **Источник правды — `props.values` (приходят с сервера).** Кубики
 *     показывают ровно то, что прислал сервер:
 *     - watcher на `props.values` обновляет CSS-переменную `--face-transform`
 *       синхронно при каждом изменении;
 *     - watcher `immediate: true` гарантирует корректное состояние
 *       на первом рендере.
 *
 *  2. **CSS-keyframes `diceRotate` отвечает за визуальную крутку.**
 *     Без `forwards` — после 2-секундной анимации transform снимается,
 *     и к финальной грани нас ведёт CSS-transition в .die.final / .die.idle.
 *     Так последний кадр keyframes (rotateX(720) rotateY(540) rotateZ(360))
 *     не «прилипает» к transform и не блокирует серверное значение грани.
 *
 *  3. **Состояния**: 'idle' (нет анимации, виден финальный transform),
 *     'rolling' (2-сек keyframes крутки), 'final' (после анимации,
 *     плавный transition к серверной грани).
 *
 *  4. **Финальный transform задаётся через CSS-переменную `--face-transform`**
 *     по `props.values` через inline style. Базовая наклонная поза
 *     кубика в покое — через CSS-переменную `--die-angle`.
 *
 *  5. **Точки на гранях**. Каждая точка получает явный класс `pos-N`
 *     (N = 1..9), привязанный к фиксированной ячейке CSS-grid 3x3
 *     через `grid-area`. Это гарантирует:
 *       - все точки выровнены по одним и тем же осям (3 столбца / 3 строки);
 *       - одинаковые отступы со всех сторон (через `padding` грани и
 *         `justify-self: center; align-self: center` у точки в ячейке);
 *       - точки центрированы относительно своих ячеек, а не привязаны
 *         к порядку элементов в DOM (в отличие от старого nth-child);
 *       - раскладка не зависит от того, в каком порядке Vue генерирует
 *         классы, что устраняет риски со scoped-CSS Vue.
 */
import { ref, watch, onBeforeUnmount, computed } from "vue";

const props = defineProps<{
  values: [number, number];
  rolling: boolean;
}>();

const emit = defineEmits<{ (e: "roll-done"): void }>();

/** Длительность анимации броска (по требованию — 2 секунды). */
const ROLL_MS = 2000;

/**
 * Базовые углы наклона в покое (1:1 из прототипа):
 *  die1 — 8°, die2 — -8°.
 *  Задаются через CSS-переменную --die-angle.
 */
const DICE_BASE: [number, number] = [8, -8];

/**
 * Углы для каждого значения грани — соответствуют фактическому
 * расположению CSS-классов граней в шаблоне (см. разметку ниже).
 *
 *   Карта "значение -> грань в DOM" (где физически наклеен класс face-N):
 *     1 -> .face.front   (translateZ(30px))
 *     2 -> .face.right   (translateX(30px) rotateY(90deg))
 *     3 -> .face.top     (translateY(-30px) rotateX(90deg))
 *     4 -> .face.bottom  (translateY(30px) rotateX(-90deg))
 *     5 -> .face.left    (translateX(-30px) rotateY(-90deg))
 *     6 -> .face.back    (translateZ(-30px) rotateY(180deg))
 *
 *   Чтобы нужная грань оказалась смотрящей на зрителя, transform самого
 *   кубика должен быть обратным к собственному внутреннему rotate этой грани.
 *   Отсюда значения в DICE_ROT — «компенсация»:
 *     1: rotateX(0)   rotateY(0)    — грань и так во фронте
 *     2: rotateX(0)   rotateY(-90)  — грань 2 смещена вправо с +90°,
 *                                     кубик крутим влево на -90°
 *     3: rotateX(-90) rotateY(0)    — грань 3 наверху с +90°,
 *                                     кубик наклоняем вниз на -90°
 *     4: rotateX(90)  rotateY(0)    — грань 4 внизу с -90°,
 *                                     кубик наклоняем вверх на +90°
 *     5: rotateX(0)   rotateY(90)   — грань 5 слева с -90°,
 *                                     кубик крутим вправо на +90°
 *     6: rotateX(0)   rotateY(180)  — грань 6 сзади с +180°,
 *                                     кубик крутим на 180°
 */
const DICE_ROT: Record<number, { x: number; y: number }> = {
  1: { x: 0, y: 0 },
  2: { x: 0, y: -90 },
  3: { x: -90, y: 0 },
  4: { x: 90, y: 0 },
  5: { x: 0, y: 90 },
  6: { x: 0, y: 180 },
};

/**
 * Карта "значение грани -> массив позиций точек (1..9)" для шаблона.
 *  Позиции соответствуют ячейкам grid 3x3 в `.face`:
 *    1 2 3
 *    4 5 6
 *    7 8 9
 *
 *  Стандартная раскладка игральной кости:
 *    1: {5}                — центр
 *    2: {1, 9}             — диагональ противоположная
 *    3: {1, 5, 9}          — главная диагональ
 *    4: {1, 3, 7, 9}       — четыре угла
 *    5: {1, 3, 5, 7, 9}    — четыре угла + центр
 *    6: {1, 2, 3, 7, 8, 9} — две крайние колонки полностью
 */
const DICE_DOTS: Record<number, number[]> = {
  1: [5],
  2: [1, 9],
  3: [1, 5, 9],
  4: [1, 3, 7, 9],
  5: [1, 3, 5, 7, 9],
  6: [1, 2, 3, 7, 8, 9],
};

/**
 * Локальное состояние броска. Нужно, чтобы корректно отрабатывать случаи,
 * когда `props.rolling` стал `false` (например, в `onDiceRollDone`),
 * но в этот момент таймер ещё не дошёл. Тогда мы хотим принудительно
 * перейти в `final` и заэмитить `roll-done`.
 */
type Phase = "idle" | "rolling" | "final";
const phase = ref<Phase>("idle");

/**
 * CSS-transform для финального положения кубика `dieIndex` со значением `value`.
 * Возвращаем строку БЕЗ var(--die-angle) — базовый угол применяется отдельным
 * rotateY в CSS: `transform: rotateY(var(--die-angle)) var(--face-transform)`.
 */
function buildFaceTransform(dieIndex: number, value: number): string {
  const rot = DICE_ROT[value] ?? { x: 0, y: 0 };
  return `rotateX(${rot.x}deg) rotateY(${rot.y}deg)`;
}

/**
 * Реактивные CSS-переменные для каждого кубика. Эти переменные
 * обновляются по `props.values` и применяются в `<style>` через
 * `transform: rotateY(var(--die-angle)) var(--face-transform)`.
 *
 * Vue watcher'ы обновляют `faceTransforms.value` синхронно при изменении
 * `props.values`, и CSS реагирует в тот же тик рендера.
 */
const faceTransforms = ref<[string, string]>([
  buildFaceTransform(0, props.values[0]),
  buildFaceTransform(1, props.values[1]),
]);

let stopTimer: number | null = null;

function clearTimer() {
  if (stopTimer !== null) {
    clearTimeout(stopTimer);
    stopTimer = null;
  }
}

function applyFaceTransforms() {
  const v1 = Number(props.values[0]);
  const v2 = Number(props.values[1]);

  // Clamp values to valid dice range 1-6
  const clampedV1 = Math.max(1, Math.min(6, v1));
  const clampedV2 = Math.max(1, Math.min(6, v2));

  faceTransforms.value = [buildFaceTransform(0, clampedV1), buildFaceTransform(1, clampedV2)];
}

function startRoll() {
  clearTimer();
  // Перед стартом анимации зафиксировать финальный transform — чтобы
  // когда animation завершится, inline style сразу показывал
  // именно серверные значения (а не случайный keyframe-кадр).
  applyFaceTransforms();
  phase.value = "rolling";
  stopTimer = window.setTimeout(() => {
    stopTimer = null;
    phase.value = "final";
    // Дополнительная гарантия: ещё раз обновить transform (props.values
    // мог измениться в ходе анимации — мы не хотим показывать старое).
    applyFaceTransforms();
    emit("roll-done");
  }, ROLL_MS);
}

function stopRoll() {
  clearTimer();
  applyFaceTransforms();
  phase.value = "final";
}

// Следим за `props.values` — это ГЛАВНЫЙ watcher, обеспечивающий
// что кубики показывают именно серверные значения. Обновляем transform
// немедленно, независимо от `phase`.
watch(
  () => props.values,
  () => {
    applyFaceTransforms();
  },
  { immediate: true, deep: true },
);

// Следим за `props.rolling` — управляет фазой анимации.
watch(
  () => props.rolling,
  (rolling) => {
    if (rolling) {
      startRoll();
    } else {
      stopRoll();
    }
  },
);

onBeforeUnmount(() => clearTimer());

// Computed-стили для inline style. Связывают реактивные CSS-переменные
// с каждым кубиком через --face-transform.
const die1Style = computed(() => ({
  "--face-transform": faceTransforms.value[0],
}));
const die2Style = computed(() => ({
  "--face-transform": faceTransforms.value[1],
}));

/**
 * Возвращает массив позиций точек (1..9) для грани со значением `value`.
 * Используется в шаблоне для рендера `<span class="dot pos-N">` строго
 * в тех ячейках grid, где должна быть точка. Это исключает зависимость
 * от порядка элементов в DOM и обеспечивает выравнивание по одним
 * и тем же осям.
 */
function dotsFor(value: number): number[] {
  const v = Math.max(1, Math.min(6, Math.floor(value)));
  // `noUncheckedIndexedAccess` в строгом TS делает индексирование
  // `Record<number, ...>` типом `T | undefined`. Поскольку ключи 1..6
  // захардкожены и `v` clamp'ится в этот диапазон — безопасно вернуть
  // дефолт через явное приведение к не-undefined.
  const dots = DICE_DOTS[v];
  return dots ?? (DICE_DOTS[1] as number[]);
}
</script>

<template>
  <div class="dice-area">
    <!-- Кубик #1 -->
    <div class="die die-1" :class="phase" :style="die1Style">
      <div class="face front" data-value="1">
        <span v-for="pos in dotsFor(1)" :key="`f1-${pos}`" class="dot" :class="`pos-${pos}`"></span>
      </div>
      <div class="face back" data-value="6">
        <span v-for="pos in dotsFor(6)" :key="`f6-${pos}`" class="dot" :class="`pos-${pos}`"></span>
      </div>
      <div class="face right" data-value="2">
        <span v-for="pos in dotsFor(2)" :key="`f2-${pos}`" class="dot" :class="`pos-${pos}`"></span>
      </div>
      <div class="face left" data-value="5">
        <span v-for="pos in dotsFor(5)" :key="`f5-${pos}`" class="dot" :class="`pos-${pos}`"></span>
      </div>
      <div class="face top" data-value="3">
        <span v-for="pos in dotsFor(3)" :key="`f3-${pos}`" class="dot" :class="`pos-${pos}`"></span>
      </div>
      <div class="face bottom" data-value="4">
        <span v-for="pos in dotsFor(4)" :key="`f4-${pos}`" class="dot" :class="`pos-${pos}`"></span>
      </div>
    </div>

    <!-- Кубик #2 -->
    <div class="die die-2" :class="phase" :style="die2Style">
      <div class="face front" data-value="1">
        <span v-for="pos in dotsFor(1)" :key="`s1-${pos}`" class="dot" :class="`pos-${pos}`"></span>
      </div>
      <div class="face back" data-value="6">
        <span v-for="pos in dotsFor(6)" :key="`s6-${pos}`" class="dot" :class="`pos-${pos}`"></span>
      </div>
      <div class="face right" data-value="2">
        <span v-for="pos in dotsFor(2)" :key="`s2-${pos}`" class="dot" :class="`pos-${pos}`"></span>
      </div>
      <div class="face left" data-value="5">
        <span v-for="pos in dotsFor(5)" :key="`s5-${pos}`" class="dot" :class="`pos-${pos}`"></span>
      </div>
      <div class="face top" data-value="3">
        <span v-for="pos in dotsFor(3)" :key="`s3-${pos}`" class="dot" :class="`pos-${pos}`"></span>
      </div>
      <div class="face bottom" data-value="4">
        <span v-for="pos in dotsFor(4)" :key="`s4-${pos}`" class="dot" :class="`pos-${pos}`"></span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dice-area {
  display: flex;
  gap: 18px;
  align-items: center;
  margin-top: 0;
  perspective: 280px;
  perspective-origin: center center;
}

.die {
  width: 50px;
  height: 50px;
  position: relative;
  transform-style: preserve-3d;
  transform: rotateY(var(--die-angle, 0deg)) var(--face-transform, rotateX(0deg) rotateY(0deg));
}

.die-1 {
  --die-angle: 8deg;
}
.die-2 {
  --die-angle: -8deg;
}

.die.rolling {
  animation: diceRotate 2s cubic-bezier(0.34, 1.56, 0.64, 1);
}

.die-2.rolling {
  animation-delay: 0.08s;
}

.die.final {
  animation: none;
  transition: transform 250ms cubic-bezier(0.4, 0, 0.2, 1);
}

.die.idle {
  animation: none;
  transition: transform 250ms cubic-bezier(0.4, 0, 0.2, 1);
}

@keyframes diceRotate {
  from {
    transform: rotateX(0deg) rotateY(0deg) rotateZ(0deg);
  }
  to {
    transform: rotateX(720deg) rotateY(540deg) rotateZ(360deg);
  }
}

.face {
  position: absolute;
  width: 50px;
  height: 50px;
  border-radius: 14px;
  background: linear-gradient(145deg, #ffffff, #f0f0f0);
  box-shadow:
    0 8px 24px rgba(0, 0, 0, 0.4),
    inset 0 2px 0 rgba(255, 255, 255, 0.8);
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  grid-template-rows: repeat(3, 1fr);
  padding: 7px;
  box-sizing: border-box;
  backface-visibility: hidden;
  -webkit-backface-visibility: hidden;
  overflow: hidden;
}

.face.front {
  transform: translateZ(25px);
}
.face.back {
  transform: translateZ(-25px) rotateY(180deg);
}
.face.right {
  transform: translateX(25px) rotateY(90deg);
}
.face.left {
  transform: translateX(-25px) rotateY(-90deg);
}
.face.top {
  transform: translateY(-25px) rotateX(90deg);
}
.face.bottom {
  transform: translateY(25px) rotateX(-90deg);
}

.dot {
  width: 70%;
  height: 70%;
  max-width: 14px;
  max-height: 14px;
  aspect-ratio: 1 / 1;
  justify-self: center;
  align-self: center;
  border-radius: 50%;
  background: radial-gradient(circle at 30% 30%, #2d2d3d, #0f0f1a);
  display: none;
  box-shadow:
    inset 0 2px 4px rgba(0, 0, 0, 0.5),
    0 1px 0 rgba(255, 255, 255, 0.3);
}

.dot.pos-1 {
  grid-area: 1 / 1;
}
.dot.pos-2 {
  grid-area: 1 / 2;
}
.dot.pos-3 {
  grid-area: 1 / 3;
}
.dot.pos-4 {
  grid-area: 2 / 1;
}
.dot.pos-5 {
  grid-area: 2 / 2;
}
.dot.pos-6 {
  grid-area: 2 / 3;
}
.dot.pos-7 {
  grid-area: 3 / 1;
}
.dot.pos-8 {
  grid-area: 3 / 2;
}
.dot.pos-9 {
  grid-area: 3 / 3;
}

.face[data-value="1"] .dot.pos-5 {
  display: block;
}

.face[data-value="2"] .dot.pos-1,
.face[data-value="2"] .dot.pos-9 {
  display: block;
}

.face[data-value="3"] .dot.pos-1,
.face[data-value="3"] .dot.pos-5,
.face[data-value="3"] .dot.pos-9 {
  display: block;
}

.face[data-value="4"] .dot.pos-1,
.face[data-value="4"] .dot.pos-3,
.face[data-value="4"] .dot.pos-7,
.face[data-value="4"] .dot.pos-9 {
  display: block;
}

.face[data-value="5"] .dot.pos-1,
.face[data-value="5"] .dot.pos-3,
.face[data-value="5"] .dot.pos-5,
.face[data-value="5"] .dot.pos-7,
.face[data-value="5"] .dot.pos-9 {
  display: block;
}

.face[data-value="6"] .dot.pos-1,
.face[data-value="6"] .dot.pos-2,
.face[data-value="6"] .dot.pos-3,
.face[data-value="6"] .dot.pos-7,
.face[data-value="6"] .dot.pos-8,
.face[data-value="6"] .dot.pos-9 {
  display: block;
}
</style>
