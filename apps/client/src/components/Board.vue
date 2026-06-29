<script setup lang="ts">
import { computed, ref } from "vue";
import CellComp from "./Cell.vue";
import Dice from "./Dice.vue";
import type { Cell as CellType } from "@monopoly/shared";

const props = defineProps<{
  cells: CellType[];
  players: {
    id: string;
    position: number;
    color: string;
    icon: string;
  }[];
}>();

const emit = defineEmits<{
  (e: "cell-click", payload: { cell: CellType; event: MouseEvent }): void;
}>();

function onCellClick(cell: CellType, event: MouseEvent) {
  emit("cell-click", { cell, event });
}

// Mock-значения кубиков (пока статичные)
const diceValues = ref<[number, number]>([3, 5]);
const diceRolling = ref(false);

/**
 * Определяет позицию клетки на сетке 11x11
 *
 * Расположение клеток в Монополии:
 * - id 0-10:  нижняя строка, справа налево (id 0 в правом нижнем углу)
 * - id 11-19: левая колонка, снизу вверх
 * - id 21-30: верхняя строка, слева направо
 * - id 31-39: правая колонка, сверху вниз
 * - id 20:    не входит в «рамку» — это «Бесплатная стоянка» в углу
 */
function getGridPos(i: number) {
  if (i <= 10) return { row: 11, col: 11 - i };
  if (i <= 19) return { row: 11 - (i - 10), col: 1 };
  if (i <= 30) return { row: 1, col: i - 19 };
  return { row: i - 29, col: 11 };
}

// Группируем игроков по клеткам, на которых они стоят
const playersOnCell = computed(() => {
  const map = new Map<number, typeof props.players>();
  for (const p of props.players) {
    if (!map.has(p.position)) map.set(p.position, []);
    map.get(p.position)!.push(p);
  }
  return map;
});

// HEX-цвет владельца клетки (для подсветки)
function ownerColor(cell: CellType): string | undefined {
  if (!cell.ownerId) return undefined;
  return props.players.find((p) => p.id === cell.ownerId)?.color;
}
</script>

<template>
  <div class="board-wrapper">
    <div class="board">
      <template v-for="(cell, i) in cells" :key="cell.id">
        <CellComp
          :cell="cell"
          :owner-color="ownerColor(cell)"
          :style="{
            gridColumn: getGridPos(i).col,
            gridRow: getGridPos(i).row,
          }"
          @click="onCellClick(cell, $event)"
        >
          <div
            v-for="p in playersOnCell.get(cell.id) || []"
            :key="p.id"
            class="player-token"
            :style="{ background: p.color, '--token-glow': p.color }"
          >
            {{ p.icon }}
          </div>
        </CellComp>
      </template>

      <!-- Центральная панель -->
      <div class="board-center">
        <slot name="center">
          <div class="logo">Монополия</div>
          <div class="logo-sub">neon edition</div>
        </slot>
        <Dice :values="diceValues" :rolling="diceRolling" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.board-wrapper {
  display: flex;
  justify-content: center;
  align-items: center;
}

.board {
  display: grid;
  grid-template-columns: repeat(11, 1fr);
  grid-template-rows: repeat(11, 1fr);
  width: min(90vw, 800px);
  aspect-ratio: 1 / 1;
  gap: 4px;
  padding: 8px;
  background: linear-gradient(135deg, #0a0a1a 0%, #1a1a2e 100%);
  border: 2px solid var(--neon-cyan, #4d9eff);
  border-radius: 12px;
  box-shadow:
    0 0 24px rgba(77, 158, 255, 0.4),
    inset 0 0 24px rgba(77, 158, 255, 0.1);
}

.board-center {
  grid-column: 2 / span 9;
  grid-row: 2 / span 9;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  background: rgba(10, 10, 26, 0.6);
  border: 1px dashed rgba(77, 158, 255, 0.4);
  border-radius: 8px;
  padding: 20px;
}

.logo {
  font-size: clamp(24px, 4vw, 48px);
  font-weight: 800;
  letter-spacing: 4px;
  color: var(--neon-cyan, #4d9eff);
  text-shadow:
    0 0 10px rgba(77, 158, 255, 0.8),
    0 0 20px rgba(77, 158, 255, 0.5);
}

.logo-sub {
  margin-top: 8px;
  font-size: clamp(10px, 1.5vw, 14px);
  letter-spacing: 6px;
  text-transform: uppercase;
  color: rgba(255, 255, 255, 0.5);
}

.player-token {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  box-shadow:
    0 0 8px var(--token-glow),
    0 0 12px var(--token-glow);
  border: 1px solid rgba(255, 255, 255, 0.4);
}
</style>
