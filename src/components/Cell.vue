<script setup lang="ts">
import type { Cell } from "../types/cell";

const props = defineProps<{
  cell: Cell;
  // Опциональный prop — HEX-цвет владельца (для подсветки)
  ownerColor?: string;
}>();

const emit = defineEmits<{
  (e: "click", cell: Cell, event: MouseEvent): void;
}>();

function onClick(e: MouseEvent) {
  emit("click", props.cell, e);
}
</script>

<template>
  <div
    class="cell"
    :class="{
      'go-cell': cell.type === 'GO',
      'chance-cell': cell.type === 'CHANCE',
      'treasury-cell': cell.type === 'TREASURY',
      'tax-cell': cell.type === 'TAX',
      'jail-cell': cell.type === 'JAIL',
      'parking-cell': cell.type === 'PARKING',
      'gotojail-cell': cell.type === 'GOTO_JAIL',
      special: ['PROPERTY', 'RAILROAD', 'UTILITY'].includes(cell.type),
      owned: !!cell.ownerId,
    }"
    :style="{
      // CSS-переменная для цвета владельца
      '--owner-color': ownerColor || 'transparent',
    }"
    @click="onClick"
  >
    <!-- Цветная полоска сверху (для клеток с группой) -->
    <div v-if="cell.color" class="color-bar" :style="{ background: cell.color }"></div>

    <!-- Иконка -->
    <div v-if="cell.icon" class="cell-icon">{{ cell.icon }}</div>

    <!-- Название клетки -->
    <div class="cell-name">{{ cell.name }}</div>

    <!-- Цена (только если она есть и больше 0) -->
    <div v-if="cell.price && cell.price > 0" class="cell-price">₽{{ cell.price }}</div>

    <!-- Дома (от 1 до 4 штук) -->
    <div v-if="cell.houses > 0 && cell.houses < 5" class="cell-houses">
      {{ "🏠".repeat(cell.houses) }}
    </div>

    <!-- Отель (houses === 5) -->
    <div v-if="cell.houses === 5" class="cell-hotel">🏨</div>

    <!-- Слот для фишек игроков -->
    <div class="players-on-cell">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.cell-houses {
  font-size: 8px;
  margin-top: 2px;
  letter-spacing: -2px;
}

.cell-hotel {
  font-size: 14px;
  margin-top: 2px;
}
</style>
