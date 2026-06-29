<script setup lang="ts">
defineProps<{
  values: [number, number];
  rolling: boolean;
}>();

// Углы поворота для каждой грани кубика
const rotations: Record<number, { x: number; y: number }> = {
  1: { x: 0, y: 0 },
  2: { x: 0, y: -90 },
  3: { x: 0, y: 180 },
  4: { x: 0, y: 90 },
  5: { x: -90, y: 0 },
  6: { x: 90, y: 0 },
};

function getTransform(value: number, isFirst: boolean): string {
  const rot = rotations[value];
  if (!rot) return "";
  const baseAngle = isFirst ? 8 : -8;
  const spins = 360;
  return `rotateY(${baseAngle}deg) rotateX(${rot.x + spins}deg) rotateY(${rot.y + spins}deg) rotateZ(${spins}deg)`;
}
</script>

<template>
  <div class="dice-area">
    <div class="die" :class="{ rolling }" :style="{ transform: getTransform(values[0], true) }">
      <div class="face front face-1">
        <span class="dot"></span><span class="dot"></span><span class="dot"></span>
        <span class="dot"></span><span class="dot"></span><span class="dot"></span>
        <span class="dot"></span><span class="dot"></span><span class="dot"></span>
      </div>
      <div class="face back face-6">
        <span class="dot"></span><span class="dot"></span><span class="dot"></span>
        <span class="dot"></span><span class="dot"></span><span class="dot"></span>
        <span class="dot"></span><span class="dot"></span><span class="dot"></span>
      </div>
      <div class="face right face-2">
        <span class="dot"></span><span class="dot"></span><span class="dot"></span>
        <span class="dot"></span><span class="dot"></span><span class="dot"></span>
        <span class="dot"></span><span class="dot"></span><span class="dot"></span>
      </div>
      <div class="face left face-5">
        <span class="dot"></span><span class="dot"></span><span class="dot"></span>
        <span class="dot"></span><span class="dot"></span><span class="dot"></span>
        <span class="dot"></span><span class="dot"></span><span class="dot"></span>
      </div>
      <div class="face top face-3">
        <span class="dot"></span><span class="dot"></span><span class="dot"></span>
        <span class="dot"></span><span class="dot"></span><span class="dot"></span>
        <span class="dot"></span><span class="dot"></span><span class="dot"></span>
      </div>
      <div class="face bottom face-4">
        <span class="dot"></span><span class="dot"></span><span class="dot"></span>
        <span class="dot"></span><span class="dot"></span><span class="dot"></span>
        <span class="dot"></span><span class="dot"></span><span class="dot"></span>
      </div>
    </div>

    <div class="die" :class="{ rolling }" :style="{ transform: getTransform(values[1], false) }">
      <div class="face front face-1">
        <span class="dot"></span><span class="dot"></span><span class="dot"></span>
        <span class="dot"></span><span class="dot"></span><span class="dot"></span>
        <span class="dot"></span><span class="dot"></span><span class="dot"></span>
      </div>
      <div class="face back face-6">
        <span class="dot"></span><span class="dot"></span><span class="dot"></span>
        <span class="dot"></span><span class="dot"></span><span class="dot"></span>
        <span class="dot"></span><span class="dot"></span><span class="dot"></span>
      </div>
      <div class="face right face-2">
        <span class="dot"></span><span class="dot"></span><span class="dot"></span>
        <span class="dot"></span><span class="dot"></span><span class="dot"></span>
        <span class="dot"></span><span class="dot"></span><span class="dot"></span>
      </div>
      <div class="face left face-5">
        <span class="dot"></span><span class="dot"></span><span class="dot"></span>
        <span class="dot"></span><span class="dot"></span><span class="dot"></span>
        <span class="dot"></span><span class="dot"></span><span class="dot"></span>
      </div>
      <div class="face top face-3">
        <span class="dot"></span><span class="dot"></span><span class="dot"></span>
        <span class="dot"></span><span class="dot"></span><span class="dot"></span>
        <span class="dot"></span><span class="dot"></span><span class="dot"></span>
      </div>
      <div class="face bottom face-4">
        <span class="dot"></span><span class="dot"></span><span class="dot"></span>
        <span class="dot"></span><span class="dot"></span><span class="dot"></span>
        <span class="dot"></span><span class="dot"></span><span class="dot"></span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dice-area {
  display: flex;
  gap: 26px;
  align-items: center;
  margin-top: 12px;
  perspective: 320px;
  perspective-origin: center center;
}

.die {
  width: 60px;
  height: 60px;
  position: relative;
  transform-style: preserve-3d;
  transition: transform 0.8s var(--ease-spring);
  transform: rotateY(var(--die-angle, 0deg));
}

.die.rolling {
  animation: diceRotate 0.8s ease-in-out forwards;
}

@keyframes diceRotate {
  100% {
    transform: rotateX(360deg) rotateY(calc(var(--die-angle, 0deg) - 360deg)) rotateZ(360deg);
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
.face-6 .dot:nth-child(3),
.face-6 .dot:nth-child(4),
.face-6 .dot:nth-child(6),
.face-6 .dot:nth-child(7),
.face-6 .dot:nth-child(9) {
  display: block;
}
</style>
