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
</script>

<template>
  <div class="dice-area">
    <!-- Кубик #1 -->
    <div class="die die-1" :class="phase" :style="die1Style">
      <div class="face front face-1">
        <span class="dot"></span><span class="dot"></span><span class="dot"></span
        ><span class="dot"></span><span class="dot"></span><span class="dot"></span
        ><span class="dot"></span><span class="dot"></span><span class="dot"></span>
      </div>
      <div class="face back face-6">
        <span class="dot"></span><span class="dot"></span><span class="dot"></span
        ><span class="dot"></span><span class="dot"></span><span class="dot"></span
        ><span class="dot"></span><span class="dot"></span><span class="dot"></span>
      </div>
      <div class="face right face-2">
        <span class="dot"></span><span class="dot"></span><span class="dot"></span
        ><span class="dot"></span><span class="dot"></span><span class="dot"></span
        ><span class="dot"></span><span class="dot"></span><span class="dot"></span>
      </div>
      <div class="face left face-5">
        <span class="dot"></span><span class="dot"></span><span class="dot"></span
        ><span class="dot"></span><span class="dot"></span><span class="dot"></span
        ><span class="dot"></span><span class="dot"></span><span class="dot"></span>
      </div>
      <div class="face top face-3">
        <span class="dot"></span><span class="dot"></span><span class="dot"></span
        ><span class="dot"></span><span class="dot"></span><span class="dot"></span
        ><span class="dot"></span><span class="dot"></span><span class="dot"></span>
      </div>
      <div class="face bottom face-4">
        <span class="dot"></span><span class="dot"></span><span class="dot"></span
        ><span class="dot"></span><span class="dot"></span><span class="dot"></span
        ><span class="dot"></span><span class="dot"></span><span class="dot"></span>
      </div>
    </div>

    <!-- Кубик #2 -->
    <div class="die die-2" :class="phase" :style="die2Style">
      <div class="face front face-1">
        <span class="dot"></span><span class="dot"></span><span class="dot"></span
        ><span class="dot"></span><span class="dot"></span><span class="dot"></span
        ><span class="dot"></span><span class="dot"></span><span class="dot"></span>
      </div>
      <div class="face back face-6">
        <span class="dot"></span><span class="dot"></span><span class="dot"></span
        ><span class="dot"></span><span class="dot"></span><span class="dot"></span
        ><span class="dot"></span><span class="dot"></span><span class="dot"></span>
      </div>
      <div class="face right face-2">
        <span class="dot"></span><span class="dot"></span><span class="dot"></span
        ><span class="dot"></span><span class="dot"></span><span class="dot"></span
        ><span class="dot"></span><span class="dot"></span><span class="dot"></span>
      </div>
      <div class="face left face-5">
        <span class="dot"></span><span class="dot"></span><span class="dot"></span
        ><span class="dot"></span><span class="dot"></span><span class="dot"></span
        ><span class="dot"></span><span class="dot"></span><span class="dot"></span>
      </div>
      <div class="face top face-3">
        <span class="dot"></span><span class="dot"></span><span class="dot"></span
        ><span class="dot"></span><span class="dot"></span><span class="dot"></span
        ><span class="dot"></span><span class="dot"></span><span class="dot"></span>
      </div>
      <div class="face bottom face-4">
        <span class="dot"></span><span class="dot"></span><span class="dot"></span
        ><span class="dot"></span><span class="dot"></span><span class="dot"></span
        ><span class="dot"></span><span class="dot"></span><span class="dot"></span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dice-area {
  display: flex;
  gap: 26px;
  align-items: center;
  margin-top: 4px;
  perspective: 320px;
  perspective-origin: center center;
}

.die {
  width: 60px;
  height: 60px;
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

/* 2-секундная keyframe-анимация крутки 
   Применяется ТОЛЬКО когда класс .rolling на элементе.
*/
.die.rolling {
  animation: diceRotate 2s cubic-bezier(0.34, 1.56, 0.64, 1);
}

.die-2.rolling {
  animation-delay: 0.08s;
}

/* кубик показывает ровно серверные значения 
   Класс .final добавляется после завершения keyframes-анимации.
   animation: none гарантирует, что keyframes-кадры больше не применяются,
   и transform из inline style (CSS-переменных) — единственный источник.
   transition: transform плавно доводит кубик от последнего кадра
   keyframes-анимации (rotateX(720) rotateY(540) rotateZ(360)) к
   финальной грани из --face-transform. Короткий «доворот» 250мс
   заканчивается ровно на серверном значении. */
.die.final {
  animation: none;
  transition: transform 250ms cubic-bezier(0.4, 0, 0.2, 1);
}

/* плавный transition на смену грани.*/
.die.idle {
  animation: none;
  transition: transform 250ms cubic-bezier(0.4, 0, 0.2, 1);
}

/* 2 секунды крутки с 720° по X, 540° по Y, 360° по Z.
   Без forwards в .die.rolling — после 2 секунд transform снимается
   и к финальной грани нас ведёт CSS-transition на .die.final. */
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
  width: 60px;
  height: 60px;
  border-radius: 18px;
  background: linear-gradient(145deg, #ffffff, #f0f0f0);
  box-shadow:
    0 10px 30px rgba(0, 0, 0, 0.4),
    inset 0 2px 0 rgba(255, 255, 255, 0.8);
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  grid-template-rows: repeat(3, 1fr);
  padding: 9px;
  box-sizing: border-box;
  backface-visibility: hidden;
  -webkit-backface-visibility: hidden;
  overflow: hidden;
}

.face.front {
  transform: translateZ(30px);
}
.face.back {
  transform: translateZ(-30px) rotateY(180deg);
}
.face.right {
  transform: translateX(30px) rotateY(90deg);
}
.face.left {
  transform: translateX(-30px) rotateY(-90deg);
}
.face.top {
  transform: translateY(-30px) rotateX(90deg);
}
.face.bottom {
  transform: translateY(30px) rotateX(-90deg);
}

.dot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: radial-gradient(circle at 30% 30%, #2d2d3d, #0f0f1a);
  align-self: center;
  justify-self: center;
  display: none;
  box-shadow:
    inset 0 2px 4px rgba(0, 0, 0, 0.5),
    0 1px 0 rgba(255, 255, 255, 0.3);
}

.face-1 .dot:nth-child(5) {
  display: block;
}
.face-2 .dot:nth-child(1),
.face-2 .dot:nth-child(9) {
  display: block;
}
.face-3 .dot:nth-child(1),
.face-3 .dot:nth-child(5),
.face-3 .dot:nth-child(9) {
  display: block;
}
.face-4 .dot:nth-child(1),
.face-4 .dot:nth-child(3),
.face-4 .dot:nth-child(7),
.face-4 .dot:nth-child(9) {
  display: block;
}
.face-5 .dot:nth-child(1),
.face-5 .dot:nth-child(3),
.face-5 .dot:nth-child(5),
.face-5 .dot:nth-child(7),
.face-5 .dot:nth-child(9) {
  display: block;
}
.face-6 .dot:nth-child(1),
.face-6 .dot:nth-child(4),
.face-6 .dot:nth-child(7),
.face-6 .dot:nth-child(3),
.face-6 .dot:nth-child(6),
.face-6 .dot:nth-child(9) {
  display: block;
}
</style>
