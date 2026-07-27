<script setup lang="ts">
import { computed, ref } from "vue";
import CellComp from "./Cell.vue";
import Dice from "./Dice.vue";
import { getCellGridPos } from "@monopoly/shared";
import type { Cell as CellType } from "@monopoly/shared";

const props = defineProps<{
  cells: CellType[];
  players: {
    id: string;
    position: number;
    color: string;
    icon: string;
  }[];
  /**
   * Анимированные позиции игроков (`playerId → клетка`).
   * Если не переданы, используется `player.position` напрямую (без анимации).
   */
  displayPositions?: Record<string, number>;
  /**
   * Значения кубиков для центрального `<Dice>`. Приходят из `GameView`
   * (реальные с сервера через `game:dice`).
   */
  diceValues?: [number, number];
  diceRolling?: boolean;
}>();

/**
 * Ссылка на корневой DOM-элемент доски. Используется `GameView`
 * для расчёта координат всплывающих подсказок (`CellTooltip`) с
 * учётом реальных размеров и положения доски на экране — тултип
 * позиционируется ВНУТРИ игровой доски в зависимости от того, в
 * каком «секторе» (top/bottom/left/right) находится клетка.
 */
const boardEl = ref<HTMLDivElement | null>(null);
defineExpose({ boardEl });

const emit = defineEmits<{
  (e: "cell-click", payload: { cell: CellType; event: MouseEvent }): void;
  /**
   * Hover на клетку (наведение мышью). Используется для показа
   * расширенного тултипа в `GameView` (см. `CellTooltip.vue`).
   */
  (e: "cell-hover", payload: { cell: CellType; event: MouseEvent }): void;
  /**
   * Уход курсора с клетки. Используется для скрытия тултипа.
   */
  (e: "cell-leave", payload: { cell: CellType; event: MouseEvent }): void;
  /**
   * Прокидывается из `<Dice>` наверх, в GameView, чтобы тот
   * погасил `diceRolling` ровно по окончании 2-секундной анимации.
   */
  (e: "dice-roll-done"): void;
}>();

function onCellClick(cell: CellType, event: MouseEvent) {
  emit("cell-click", { cell, event });
}
function onCellHover(cell: CellType, event: MouseEvent) {
  emit("cell-hover", { cell, event });
}
function onCellLeave(cell: CellType, event: MouseEvent) {
  emit("cell-leave", { cell, event });
}

// Обёртки для шаблона: Cell.vue эмитит только MouseEvent (а не
// (cell, event) — Board.vue знает Cell из v-for). Чтобы не дублировать
// логику в анонимных стрелках и не путать ts-plugin, делаем явные
// функции-хендлеры.
function onCellClickHandler(cell: CellType, event: MouseEvent) {
  onCellClick(cell, event);
}
function onCellHoverHandler(cell: CellType, event: MouseEvent) {
  onCellHover(cell, event);
}
function onCellLeaveHandler(cell: CellType, event: MouseEvent) {
  onCellLeave(cell, event);
}

function onDiceRollDone() {
  emit("dice-roll-done");
}

// Резолвим позицию для UI: предпочитаем анимированную `displayPositions[id]`,
// иначе берём `player.position` из пропсов.
function displayPos(p: { id: string; position: number }): number {
  return props.displayPositions?.[p.id] ?? p.position;
}

// Группируем игроков по клеткам, на которых они стоят (с учётом анимации).
const playersOnCell = computed(() => {
  const map = new Map<number, typeof props.players>();
  for (const p of props.players) {
    const pos = displayPos(p);
    if (!map.has(pos)) map.set(pos, []);
    map.get(pos)!.push(p);
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
    <div ref="boardEl" class="board">
      <template v-for="(cell, i) in cells" :key="cell.id">
        <CellComp
          :cell="cell"
          :owner-color="ownerColor(cell)"
          :data-cell-id="cell.id"
          :style="{
            gridColumn: getCellGridPos(i).col,
            gridRow: getCellGridPos(i).row,
          }"
          @click="onCellClickHandler(cell, $event)"
          @hover="onCellHoverHandler(cell, $event)"
          @leave="onCellLeaveHandler(cell, $event)"
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
        <Dice
          :values="diceValues ?? [1, 1]"
          :rolling="diceRolling ?? false"
          @roll-done="onDiceRollDone"
        />
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
