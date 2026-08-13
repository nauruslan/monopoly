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
    /**
     * `true`, если игрок сейчас в тюрьме (по правилам Монополии — на
     * клетке 10, "JAIL"). Используется для визуальной индикации:
     * фишка такого игрока "мигает" своим цветом (ярче ↔ приглушённее),
     * чтобы все клиенты видели, кто из игроков арестован. Источник
     * истины — `Player.inJail` из `packages/shared/src/types/player.ts`,
     * сервер присылает его в `GameState.players` через WS-событие
     * `game:state`. 
     */
    inJail?: boolean;
  }[];
  /**
   * ID игроков, которых сервер ТОЛЬКО ЧТО отправил в тюрьму
   * (фаза JAIL_NOTICE: карточка «Иди в тюрьму», попадание на клетку 30,
   * три дубля подряд), но флаг `inJail=true` ещё не пришёл с сервера
   * (это произойдёт ПОСЛЕ `CONFIRM_JAIL_NOTICE` + `MOVE_ANIMATION`
   * в клетку 10). Используется для того, чтобы визуальная индикация
   * (мигание) начиналась СРАЗУ в момент события, а не через ~1-2 секунды
   * пока фишка анимируется к клетке 10. Сервер остаётся единственным
   * источником истины для логики игры; этот набор — только UI-подсказка,
   * которая автоматически очищается, как только `Player.inJail` приходит
   * с сервера (см. синхронизацию в `GameView.vue`).
   */
  jailedIds?: string[];
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

/**
 * Set ID игроков, которых сервер ТОЛЬКО ЧТО отправил в тюрьму
 * (фаза JAIL_NOTICE), но `Player.inJail=true` ещё не пришёл с сервера.
 * Используется для немедленного включения мигания, не дожидаясь
 * окончания `CONFIRM_JAIL_NOTICE` + `MOVE_ANIMATION` (1-2 секунды).
 * `Set` (а не массив) даёт O(1) `has()` при рендере каждой фишки.
 */
const jailedIdsSet = computed<Set<string>>(() => new Set(props.jailedIds ?? []));

/**
 * Показывать ли мигание для фишки `p`:
 *   - `p.inJail` — нормальный случай (игрок в тюрьме, сервер подтвердил);
 *   - `jailedIdsSet.has(p.id)` — UI-оптимистичный случай (фаза JAIL_NOTICE,
 *     событие только что произошло, анимация к клетке 10 ещё идёт).
 * Как только сервер пришлёт реальный `inJail=true`, оптимистичный флаг
 * снимается в `GameView.vue` (см. `jailedIds` watcher), и фишка
 * продолжает мигать уже от канонического `p.inJail`.
 */
function isInJailed(p: { id: string; inJail?: boolean }): boolean {
  return !!p.inJail || jailedIdsSet.value.has(p.id);
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
            :class="{ 'in-jail': isInJailed(p) }"
            :style="{ background: p.color, '--token-glow': p.color }"
            :title="isInJailed(p) ? 'Игрок в тюрьме' : undefined"
            :aria-label="isInJailed(p) ? `${p.icon} (в тюрьме)` : p.icon"
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
  position: relative;
  z-index: 10;
  pointer-events: none;
}

@keyframes jail-pulse {
  0%,
  100% {
    opacity: 1;
    filter: brightness(1.15) saturate(1.2);
    box-shadow:
      0 0 6px var(--token-glow),
      0 0 10px var(--token-glow);
  }
  50% {
    opacity: 0.55;
    filter: brightness(0.7) saturate(0.8);
    box-shadow:
      0 0 3px var(--token-glow),
      0 0 5px var(--token-glow);
  }
}

.player-token.in-jail {
  animation: jail-pulse 1.2s ease-in-out infinite;
  outline: 2px solid var(--token-glow);
  outline-offset: 1px;
}

@media (prefers-reduced-motion: reduce) {
  .player-token.in-jail {
    animation: none;
    opacity: 0.6;
    filter: saturate(0.7);
  }
}
</style>
