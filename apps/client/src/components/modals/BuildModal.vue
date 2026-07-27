<script setup lang="ts">
/**
 * BuildModal — модалка «Строительство» (только СТРОИТЬ / ПРОДАТЬ).
 *
 * Показывается по нажатию кнопки «Строить» в `ActionsPanel.vue`.
 *
 * Функционал:
 *  - покупка/улучшение домов и отелей (BUILD_HOUSE);
 *  - продажа домов и отелей (SELL_HOUSE).
 *
 * Залог/выкуп недвижимости здесь НЕ показываются — для этого
 * существует отдельная модалка `MortgageModal.vue` и отдельная
 * кнопка в ActionsPanel. Эта модалка — ТОЛЬКО про застройку.
 *
 * Дизайн:
 *  - Стеклянные карточки (backdrop-filter), рамки и hover в стиле
 *    meteorite-палитры (см. apps/client/src/styles/style.css).
 *  - Прогресс-бар «лесенки» по группе (5 точек-уровней), с
 *    подсветкой текущего.
 *  - Пилюли для статуса (отель / в залоге / заблокировано).
 *  - Градиентные кнопки в meteorite-стиле с glow-эффектом.
 *
 * ВАЖНО: все финансовые операции и проверки — на СЕРВЕРЕ
 * (см. `BuildService` в apps/server). Клиент лишь рисует UI и шлёт
 * actions. Если сервер отклонит — в `build.setError(...)` появится
 * текст.
 */
import { computed } from "vue";
import Modal from "../Modal.vue";
import { useBuildStore } from "../../stores/build";
import type { Cell, CellType, PropertyGroup } from "@monopoly/shared";

const build = useBuildStore();

/** Локальная обёртка: текущая модалка открыта? */
const show = computed<boolean>(() => build.isOpen);

/** Русское название типа клетки. */
function typeLabel(t: CellType): string {
  if (t === "PROPERTY") return "Участок";
  if (t === "RAILROAD") return "Ж/Д";
  if (t === "UTILITY") return "Предприятие";
  return t;
}

/** Русское название цвета группы. */
const GROUP_RU: Record<string, string> = {
  brown: "Коричневая",
  lightblue: "Голубая",
  pink: "Розовая",
  orange: "Оранжевая",
  red: "Красная",
  yellow: "Жёлтая",
  green: "Зелёная",
  blue: "Синяя",
  railroad: "Железные дороги",
  utility: "Предприятия",
};
function groupLabel(g: PropertyGroup | undefined): string {
  if (!g) return "—";
  return GROUP_RU[g] ?? g;
}

/** Возвращает список уровней застройки (0..4 → дома, 5 → отель) для прогресс-бара. */
function levelArray(): number[] {
  return [0, 1, 2, 3, 4, 5];
}

/** Подпись на кнопке «Построить» (с учётом отеля). */
function buildLabel(item: { isHotelBuild: boolean; cost: number }): string {
  if (item.isHotelBuild) return `ОТЕЛЬ · ₽${item.cost}`;
  return `ПОСТРОИТЬ ДОМ · ₽${item.cost}`;
}

/** Подпись на кнопке «Продать». */
function sellLabel(item: { isHotelSale: boolean; refund: number }): string {
  if (item.isHotelSale) return `ПРОДАТЬ ОТЕЛЬ · +₽${item.refund}`;
  return `ПРОДАТЬ ДОМ · +₽${item.refund}`;
}

/**
 * Список PROPERTY-клеток для отрисовки в модалке.
 *
 * Логика отбора: берём ВСЕ клетки игрока, на которых возможна хотя бы
 * одна из операций build или sell (т.е. PROPERTY с подходящим
 * состоянием). Тултип показывает карточки с текущим уровнем застройки,
 * кнопкой «Построить» (если можно) и кнопкой «Продать» (если есть дома).
 *
 * Раньше в propertyRows попадали только buildable. Это приводило к багу:
 * если у игрока были только клетки, на которых НЕЛЬЗЯ построить (например,
 * 3 клетки одной монополии, на всех по 4 дома — лесенка не позволяет
 * строить дальше до покупки отеля), но МОЖНО продать — карточки
 * скрывались заглушкой. Теперь объединяем buildable + sellable +
 * владельца, и фильтруем только PROPERTY (RAILROAD/UTILITY тут не
 * показываются — у них нет домов).
 */
interface Row {
  cell: Cell;
  canBuild: boolean;
  buildReason?: string;
  buildCost: number;
  isHotelBuild: boolean;
  canSell: boolean;
  sellReason?: string;
  sellRefund: number;
  isHotelSale: boolean;
}

const propertyRows = computed<Row[]>(() => {
  // Собираем уникальные id PROPERTY-клеток, на которых либо можно
  // строить, либо можно продавать, либо просто принадлежит игроку
  // (последнее — для случая «дом есть, но лесенка не позволяет
  // строить дальше, и при этом нечего продавать» — всё равно показать
  // карточку как «заблокировано»).
  const ids = new Set<number>();
  for (const item of build.buildableProperties) ids.add(item.cell.id);
  for (const item of build.sellableProperties) ids.add(item.cell.id);
  for (const cell of build.myProperties) {
    if (cell.type === "PROPERTY") ids.add(cell.id);
  }
  // Резолвим Cell обратно из state.board
  if (!build.state) return [];
  const cells = build.state.board.filter((c) => ids.has(c.id));
  // Сортируем по id (по порядку на доске).
  cells.sort((a, b) => a.id - b.id);

  return cells.map<Row>((cell) => {
    const buildItem = build.buildableProperties.find((x) => x.cell.id === cell.id);
    const sellItem = build.sellableProperties.find((x) => x.cell.id === cell.id);
    return {
      cell,
      canBuild: buildItem?.canBuild ?? false,
      buildReason: buildItem?.reason,
      buildCost: buildItem?.cost ?? 0,
      isHotelBuild: buildItem?.isHotelBuild ?? false,
      canSell: sellItem?.canSell ?? false,
      sellReason: sellItem?.reason,
      sellRefund: sellItem?.refund ?? 0,
      isHotelSale: sellItem?.isHotelSale ?? false,
    };
  });
});

/** Минимальное число домов среди ВСЕХ клеток одной группы у текущего игрока. */
function minHousesInGroup(row: Row): number {
  if (!build.me || !build.state || !row.cell.group) return 0;
  const group = row.cell.group;
  return Math.min(
    ...build.state.board
      .filter((c) => c.type === row.cell.type && c.group === group && c.ownerId === build.me?.id)
      .map((c) => c.houses),
  );
}

/** Можно ли сейчас «двигать лесенку» на этой клетке (т.е. на ней минимум). */
function isAtMinimum(row: Row): boolean {
  if (!row.canBuild) return false;
  return row.cell.houses === minHousesInGroup(row);
}

/** Максимальный houses среди клеток группы (для индикации отеля в лесенке). */
function maxHousesInGroup(row: Row): number {
  if (!build.me || !build.state || !row.cell.group) return 0;
  const group = row.cell.group;
  return Math.max(
    ...build.state.board
      .filter((c) => c.type === row.cell.type && c.group === group && c.ownerId === build.me?.id)
      .map((c) => c.houses),
  );
}

/** Есть ли в модалке хоть одна доступная операция build/sell. */
const hasAnyOperation = computed<boolean>(() =>
  propertyRows.value.some((r) => r.canBuild || r.canSell),
);

/** Сводка для шапки. */
const summary = computed(() => {
  const r = propertyRows.value;
  return {
    total: r.length,
    canBuild: r.filter((x) => x.canBuild).length,
    canSell: r.filter((x) => x.canSell).length,
  };
});

function onBuild(cellId: number): void {
  build.build(cellId);
}
function onSell(cellId: number): void {
  build.sell(cellId);
}
function onClose(): void {
  build.close();
}
function onAcknowledge(): void {
  build.confirmAndClose();
}
</script>

<template>
  <Modal
    :show="show"
    title="🏗️ Строительство"
    :subtitle="`Баланс: ₽${(build.me?.money ?? 0).toLocaleString()}`"
    @close="onClose"
  >
    <!-- Шапка с быстрым обзором: 2 чипа (строить / продать). -->
    <div v-if="propertyRows.length > 0" class="summary">
      <div class="summary-item" :class="{ active: summary.canBuild > 0 }">
        <span class="num">{{ summary.canBuild }}</span>
        <span class="lbl">строить</span>
      </div>
      <div class="summary-divider"></div>
      <div class="summary-item" :class="{ active: summary.canSell > 0 }">
        <span class="num">{{ summary.canSell }}</span>
        <span class="lbl">продать</span>
      </div>
    </div>

    <!-- Два раздельных empty-state:
         1) вообще нет PROPERTY — у игрока нет ни одного участка под застройку;
         2) PROPERTY есть, но ни строить, ни продавать нельзя. -->
    <div v-if="propertyRows.length === 0" class="empty">
      <div class="empty-icon">🛠️</div>
      <div class="empty-title">У вас нет участков под застройку</div>
      <div class="empty-hint">Покупайте свойства, чтобы строить дома и отели.</div>
    </div>
    <div v-else-if="!hasAnyOperation" class="empty">
      <div class="empty-icon">🛠️</div>
      <div class="empty-title">Сейчас нечего строить и нечего продавать</div>
      <div class="empty-hint">
        Проверьте монополию, лесенку и залоги — иконки 🔒 подскажут причину.
      </div>
    </div>

    <!-- Сетка карточек -->
    <div v-else class="cards-grid">
      <div
        v-for="row in propertyRows"
        :key="row.cell.id"
        class="cell-card"
        :class="{
          mortgaged: row.cell.isMortgaged,
          highlight: row.canBuild || row.canSell,
        }"
      >
        <div class="cell-color" :style="{ background: row.cell.color }"></div>
        <div class="cell-head">
          <div class="cell-title">
            <span class="cell-icon">{{ row.cell.icon }}</span>
            <span class="cell-name">{{ row.cell.name }}</span>
          </div>
          <div class="cell-meta">
            <span class="cell-type">{{ typeLabel(row.cell.type) }}</span>
            <span class="cell-group">{{ groupLabel(row.cell.group) }}</span>
          </div>
        </div>

        <!-- Прогресс-бар лесенки -->
        <div class="ladder">
          <div
            v-for="lvl in levelArray()"
            :key="lvl"
            class="ladder-step"
            :class="{
              active: row.cell.houses >= lvl,
              current: row.cell.houses === lvl,
              min: lvl === minHousesInGroup(row) && row.canBuild,
              max: lvl === maxHousesInGroup(row) && row.cell.houses > 0,
            }"
          >
            <span v-if="lvl === 5" class="ladder-icon">🏨</span>
            <span v-else class="ladder-num">{{ lvl }}</span>
          </div>
        </div>

        <!-- Кнопки -->
        <div class="actions">
          <button
            v-if="row.canBuild"
            class="action-btn btn-build"
            :title="`Построить на «${row.cell.name}»`"
            @click="onBuild(row.cell.id)"
          >
            {{ buildLabel({ isHotelBuild: row.isHotelBuild, cost: row.buildCost }) }}
          </button>
          <button
            v-if="row.canSell"
            class="action-btn btn-sell"
            :title="`Продать дом с «${row.cell.name}»`"
            @click="onSell(row.cell.id)"
          >
            {{ sellLabel({ isHotelSale: row.isHotelSale, refund: row.sellRefund }) }}
          </button>
          <!-- Если кнопок нет, но клетка mortgaged — покажем бейдж в карточке -->
        </div>

        <!-- Пилюли-подсказки (всегда видимы, если есть причина) -->
        <div v-if="row.cell.isMortgaged" class="pill pill-mortgaged">🚫 В залоге</div>
        <div v-if="row.buildReason && !row.canBuild" class="reason" :title="row.buildReason">
          🔒 {{ row.buildReason }}
        </div>
        <div v-if="row.sellReason && !row.canSell" class="reason" :title="row.sellReason">
          🔒 {{ row.sellReason }}
        </div>
      </div>
    </div>

    <div v-if="build.lastError" class="error">{{ build.lastError }}</div>

    <template #footer>
      <button class="ack-btn" @click="onAcknowledge">ПРИНЯТЬ</button>
    </template>
  </Modal>
</template>

<style scoped>
.summary {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 14px;
  padding: 8px 12px;
  margin-bottom: 12px;
  background: rgba(149, 114, 218, 0.08);
  border-radius: 8px;
  border: 1px solid rgba(149, 114, 218, 0.18);
}
.summary-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  opacity: 0.5;
  transition: opacity 0.2s;
}
.summary-item.active {
  opacity: 1;
}
.summary-item .num {
  font-size: 20px;
  font-weight: 800;
  line-height: 1;
  color: var(--text1, #fff);
  font-variant-numeric: tabular-nums;
}
.summary-item.active .num {
  background: linear-gradient(135deg, var(--gold, #f5d56a), var(--accent3, #c89848));
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
}
.summary-item .lbl {
  font-size: 10px;
  color: var(--text2, #b8b0d0);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.summary-divider {
  width: 1px;
  height: 24px;
  background: rgba(149, 114, 218, 0.25);
}

.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px 20px;
  text-align: center;
  gap: 8px;
}
.empty-icon {
  font-size: 48px;
  opacity: 0.3;
  margin-bottom: 4px;
}
.empty-title {
  font-size: 14px;
  font-weight: 700;
  color: var(--text1, #fff);
}
.empty-hint {
  font-size: 11px;
  color: var(--text2, #b8b0d0);
  max-width: 280px;
  line-height: 1.4;
}

/* Мягкий баннер: показываем И карточки (ниже), И эту подсказку.
   Делаем компактнее, чтобы не доминировал над сеткой. */
.empty.soft {
  margin: 8px 0 14px;
  padding: 10px 14px;
  flex-direction: row;
  align-items: center;
  gap: 12px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px dashed rgba(255, 255, 255, 0.18);
  border-radius: 10px;
  text-align: left;
}
.empty.soft .empty-icon {
  font-size: 22px;
  opacity: 0.85;
}
.empty.soft .empty-title {
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 2px;
}
.empty.soft .empty-hint {
  font-size: 11px;
  margin-top: 0;
}

.cards-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 12px;
  max-height: 60vh;
  overflow-y: auto;
  padding: 4px;
}
.cell-card {
  position: relative;
  background: rgba(23, 9, 45, 0.6);
  backdrop-filter: blur(12px);
  border: 1px solid rgba(149, 114, 218, 0.2);
  border-radius: 10px;
  padding: 10px 12px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  transition:
    transform 0.15s,
    box-shadow 0.15s,
    border-color 0.15s;
}
.cell-card.highlight {
  border-color: rgba(149, 114, 218, 0.4);
  box-shadow: 0 4px 18px rgba(149, 114, 218, 0.15);
}
.cell-card.highlight:hover {
  transform: translateY(-2px);
  box-shadow: 0 6px 24px rgba(149, 114, 218, 0.25);
}
.cell-card.mortgaged {
  opacity: 0.7;
}
.cell-color {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 3px;
  border-radius: 10px 10px 0 0;
  box-shadow: 0 2px 8px currentColor;
}
.cell-head {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.cell-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 700;
  margin-top: 4px;
}
.cell-icon {
  font-size: 16px;
}
.cell-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cell-meta {
  display: flex;
  justify-content: space-between;
  font-size: 10px;
  color: var(--text2, #b8b0d0);
}
.cell-type {
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.ladder {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 3px;
  padding: 6px 4px;
  background: rgba(0, 0, 0, 0.25);
  border-radius: 6px;
}
.ladder-step {
  height: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(149, 114, 218, 0.08);
  border: 1px solid transparent;
  border-radius: 3px;
  font-size: 9px;
  color: var(--text2, #b8b0d0);
  transition: all 0.2s;
}
.ladder-step.active {
  background: linear-gradient(135deg, var(--gold, #f5d56a), var(--accent3, #c89848));
  color: #1a0930;
  font-weight: 700;
  box-shadow: 0 2px 6px rgba(245, 213, 106, 0.3);
}
.ladder-step.current {
  border: 1px solid var(--neon-cyan, #4d9eff);
  box-shadow: 0 0 0 2px rgba(77, 158, 255, 0.4);
}
.ladder-step.min {
  border: 1px dashed var(--neon-green, #50dc82);
}
.ladder-step.max {
  border: 1px dashed var(--accent1, #b18ff0);
}
.ladder-num {
  font-weight: 700;
}
.ladder-icon {
  font-size: 12px;
}

.actions {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: auto;
}
.action-btn {
  padding: 8px 12px;
  border: none;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.3px;
  cursor: pointer;
  transition:
    transform 0.1s,
    filter 0.15s;
  text-transform: uppercase;
  font-family: inherit;
}
.action-btn:hover {
  filter: brightness(1.1);
}
.action-btn:active {
  transform: translateY(1px);
}
.btn-build {
  background: linear-gradient(135deg, var(--gold, #f5d56a), var(--accent3, #c89848));
  color: #1a0930;
  box-shadow: 0 4px 14px rgba(245, 213, 106, 0.35);
}
.btn-sell {
  background: linear-gradient(135deg, #5b8def, #3a6cc7);
  color: #fff;
  box-shadow: 0 4px 14px rgba(91, 141, 239, 0.35);
}

.pill {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 600;
  align-self: flex-start;
}
.pill-mortgaged {
  background: rgba(255, 122, 122, 0.18);
  color: #ff9b9b;
  border: 1px solid rgba(255, 122, 122, 0.3);
}

.reason {
  font-size: 10px;
  color: var(--text2, #b8b0d0);
  font-style: italic;
  padding: 2px 0;
}

.error {
  margin-top: 12px;
  padding: 8px 12px;
  background: rgba(255, 80, 80, 0.12);
  border: 1px solid rgba(255, 80, 80, 0.3);
  border-radius: 6px;
  color: #ff9b9b;
  font-size: 12px;
  text-align: center;
}

.ack-btn {
  width: 100%;
  padding: 10px;
  background: linear-gradient(135deg, var(--gold, #f5d56a), var(--accent3, #c89848));
  color: #1a0930;
  border: none;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 800;
  letter-spacing: 0.5px;
  cursor: pointer;
  transition: filter 0.15s;
  font-family: inherit;
  text-transform: uppercase;
}
.ack-btn:hover {
  filter: brightness(1.1);
}
</style>
