<script setup lang="ts">
import type { Cell } from "../types/cell";
import type { Player } from "../types/player";

defineProps<{
  cell: Cell | null;
  owner: Player | undefined;
  x: number;
  y: number;
}>();
</script>

<template>
  <div v-if="cell" class="cell-tooltip visible" :style="{ left: x + 'px', top: y + 'px' }">
    <div v-if="cell.color" class="tooltip-color-bar" :style="{ background: cell.color }"></div>
    <div class="tooltip-name">{{ cell.icon }} {{ cell.name }}</div>
    <div v-if="cell.price" class="tooltip-price">₽{{ cell.price }}</div>
    <div v-if="cell.rent" class="tooltip-rent">Аренда: ₽{{ cell.rent }}</div>
    <div v-if="cell.taxAmount" class="tooltip-rent">Налог: ₽{{ cell.taxAmount }}</div>
    <div v-if="owner" class="tooltip-rent" :style="{ color: owner.color }">
      👤 {{ owner.displayName }}
    </div>
  </div>
</template>

<style scoped>
.cell-tooltip {
  position: fixed;
  background: rgba(23, 9, 45, 0.98);
  backdrop-filter: blur(24px);
  border-radius: 12px;
  padding: 14px 16px;
  box-shadow:
    0 12px 40px rgba(0, 0, 0, 0.6),
    0 0 0 1px rgba(149, 114, 218, 0.2);
  z-index: 500;
  pointer-events: none;
  max-width: 240px;
}

.tooltip-color-bar {
  height: 4px;
  border-radius: 2px;
  margin-bottom: 8px;
  box-shadow: 0 2px 8px currentColor;
}

.tooltip-name {
  font-size: 14px;
  font-weight: 700;
  margin-bottom: 4px;
}

.tooltip-price {
  font-size: 12px;
  color: var(--gold);
  font-weight: 700;
}

.tooltip-rent {
  font-size: 10px;
  color: var(--text2);
  margin-top: 2px;
}
</style>
