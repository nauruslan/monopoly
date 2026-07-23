<script setup lang="ts">
import type { Cell } from "@monopoly/shared";

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
      mortgaged: cell.isMortgaged,
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

    <!--
      Бейдж «заложено» — просто иконка 🚫 (перечёркнутый круг),
      БЕЗ фона, БЕЗ рамки, без свечения. Размещается в верхней
      части карточки, но ВНУТРИ (не торчит наружу), и лежит
      ПОД верхней цветной полоской .color-bar (z-index ниже).
      Никаких filter/opacity/scale на саму клетку — фишки игроков
      остаются яркими, layout стабильный.
    -->
    <div
      v-if="cell.isMortgaged"
      class="mortgaged-seal"
      title="Участок заложен"
      aria-label="Участок заложен"
    >
      <span class="mortgaged-icon">🚫</span>
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

.cell.mortgaged {
  position: relative;
}

.cell .color-bar {
  z-index: 2;
}

.mortgaged-seal {
  position: absolute;
  top: 8px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  box-shadow: none;
  line-height: 1;
  pointer-events: none;
  padding: 0;
}

.mortgaged-icon {
  font-size: 14px;
  line-height: 1;
  background: transparent;
}
</style>
