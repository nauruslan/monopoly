<script setup lang="ts">
import { computed } from "vue";
import type { Cell, GameState, Player, BoardSide } from "@monopoly/shared";
import {
  RAILROAD_RENT_BY_COUNT,
  UTILITY_MULTIPLIER_BY_COUNT,
  UNMORTGAGE_INTEREST_RATE,
} from "@monopoly/shared";

/**
 * CellTooltip — расширенный тултип клетки при наведении/клике.
 *
 * Состав секций зависит от типа клетки:
 *  - PROPERTY: базовая рента, рента с монополией (×2), таблица
 *    [1дом..4дома, отель], цена покупки дома, возврат при продаже,
 *    залог, выкуп;
 *  - RAILROAD: таблица ренты в зависимости от числа станций у владельца
 *    (1/2/3/4 → 25/50/100/200);
 *  - UTILITY: множитель для 1 (×4) и 2 (×10) предприятий;
 *  - TAX: фиксированная сумма либо пометка о luxury-карточках;
 *  - CHANCE / TREASURY / JAIL / GOTO_JAIL / PARKING / GO: краткое описание.
 *
 * Владелец подсвечивается цветом (если передан) и текущий счёт домов
 * (для PROPERTY) — отдельной строкой.
 *
 * Замечание: тултип носит чисто СПРАВОЧНЫЙ характер. Вся валидация
 * финансовых операций и финальные суммы считаются на сервере
 * (BuildService / MortgageService). Здесь мы показываем то, что
 * посчитал клиент (на основании `state.board`).
 *
 * ПОЗИЦИОНИРОВАНИЕ (GDD §1.1 — hover-тултип):
 *  - `x` / `y` — координаты левого-верхнего угла тултипа В VIEWPORT
 *    (fixed-координаты). Их считает GameView, учитывая:
 *      1. Сторону клетки (top/bottom/left/right) — чтобы тултип
 *         «торчал» ВНУТРЬ игровой доски и не уходил за неё:
 *         * bottom → тултип ВЫШЕ клетки (низ тултипа у верхней грани клетки)
 *         * top    → тултип НИЖЕ клетки
 *         * left   → тултип СПРАВА от клетки
 *         * right  → тултип СЛЕВА от клетки
 *      2. Реальные `getBoundingClientRect()` клетки и доски,
 *         чтобы тултип остался внутри `boardEl` (если он не
 *         помещается — координаты обрезаются по границам доски).
 *  - `side` — на какой стороне доски находится клетка; нужно,
 *    чтобы при позиционировании «через transform» CSS-классы могли
 *    подсказать визуально, с какой стороны пришёл тултип (стрелка
 *    или просто маркер). Сейчас используется для логики clamp.
 */
const props = defineProps<{
  cell: Cell | null;
  owner: Player | undefined;
  x: number;
  y: number;
  side?: BoardSide;
  /**
   * Полное состояние игры — нужно для подсчёта числа станций
   * (RAILROAD) и предприятий (UTILITY) у текущего владельца, а также
   * для проверки наличия полной монополии по цвету.
   */
  state: GameState | null;
}>();

/** Сколько станций (RAILROAD) у текущего владельца. */
const ownedRailroadCount = computed<number>(() => {
  if (!props.state || !props.cell?.ownerId) return 0;
  return props.state.board.filter((c) => c.type === "RAILROAD" && c.ownerId === props.cell!.ownerId)
    .length;
});

/** Сколько предприятий (UTILITY) у текущего владельца. */
const ownedUtilityCount = computed<number>(() => {
  if (!props.state || !props.cell?.ownerId) return 0;
  return props.state.board.filter((c) => c.type === "UTILITY" && c.ownerId === props.cell!.ownerId)
    .length;
});

/** Сколько клеток данной цветовой группы ВСЕГО на доске. */
const groupSize = computed<number>(() => {
  if (!props.state || !props.cell?.group) return 0;
  return props.state.board.filter((c) => c.type === "PROPERTY" && c.group === props.cell!.group)
    .length;
});

/** Сколько клеток группы принадлежит текущему владельцу. */
const ownedInGroup = computed<number>(() => {
  if (!props.state || !props.cell?.group || !props.cell.ownerId) return 0;
  return props.state.board.filter(
    (c) =>
      c.type === "PROPERTY" && c.group === props.cell!.group && c.ownerId === props.cell!.ownerId,
  ).length;
});

/** Есть ли у владельца полная монополия (по цвету). */
const hasMonopoly = computed<boolean>(
  () => groupSize.value > 0 && ownedInGroup.value === groupSize.value,
);

/** Базовая рента без монополии (без удвоения). */
const baseRent = computed<number | undefined>(() => props.cell?.rent);

/** Рента при полной монополии (обычно ×2). */
const monopolyRent = computed<number | undefined>(() => {
  if (baseRent.value === undefined) return undefined;
  if (!hasMonopoly.value) return undefined;
  return baseRent.value * 2;
});

/** Возврат при продаже одного дома = housePrice / 2. */
const houseRefund = computed<number | undefined>(() => {
  if (props.cell?.housePrice === undefined) return undefined;
  return Math.floor(props.cell.housePrice / 2);
});

/**
 * Возврат при продаже отеля (классические правила).
 *
 * Отель = 5 домов (houses=5). При продаже «распадается» на 4 дома
 * (5 → 4): игрок получает refund как за 1 дом = `housePrice / 2`.
 * Оставшиеся 4 дома можно продать далее по одному (по лесенке).
 *
 * Пример: housePrice = 50 → возврат за сам отель = 25
 *         (а 4 оставшихся дома потом: 4 × 25 = 100).
 */
const hotelRefund = computed<number | undefined>(() => {
  if (props.cell?.housePrice === undefined) return undefined;
  return Math.floor(props.cell.housePrice / 2);
});

/** Стоимость выкупа из залога (mortgageValue * 1.1, ceil). */
const unmortgageCost = computed<number | undefined>(() => {
  if (props.cell?.mortgageValue === undefined) return undefined;
  return Math.ceil(props.cell.mortgageValue * UNMORTGAGE_INTEREST_RATE);
});

/**
 * Описание клетки-действия (Шанс, Казна, Тюрьма, GO, ...).
 * Используется в тултипе вместо финансовой информации.
 */
const SPECIAL_DESCRIPTIONS: Partial<Record<string, string>> = {
  GO: "Старт. Получите ₽200 при проходе (или ₽400 по правилам GDD).",
  CHANCE: "Карточка Шанс: случайное событие из колоды.",
  TREASURY: "Общественная казна: случайное событие из колоды.",
  JAIL: "Просто визит (вы не в тюрьме).",
  GOTO_JAIL: "Отправляет в тюрьму (см. карточку).",
  PARKING: "Бесплатная стоянка. В этой версии без бонусов.",
};

/** Описание для налоговых клеток. */
const taxDescription = computed<string | null>(() => {
  const c = props.cell;
  if (!c) return null;
  if (c.taxVariant === "income") {
    return c.taxAmount !== undefined
      ? `Фиксированный подоходный налог: ₽${c.taxAmount}`
      : "Подоходный налог (см. карточку).";
  }
  if (c.taxVariant === "luxury") {
    return "Роскошный налог — случайная карточка с формулой.";
  }
  return null;
});

/**
 * Рента утилиты (предприятия). Зависит от числа утилит у владельца
 * и суммы кубиков: `rent = diceSum * multiplier`. В тултипе показываем
 * обе формулы (×4 для одной, ×10 для двух), чтобы игрок понимал
 * «потолок» и «пол» возможной ренты.
 */
const utilityMultiplier = computed<number | undefined>(() => {
  const n = ownedUtilityCount.value;
  if (n === 0) return undefined;
  return UTILITY_MULTIPLIER_BY_COUNT[n];
});

/**
 * CSS-классы тултипа, описывающие, из какого «сектора» доски он
 * пришёл. Позволяют при желании нарисовать стрелку/маркер с нужной
 * стороны (сейчас классы не используются, но зарезервированы для
 * будущей стилизации).
 */
const sideClass = computed<string>(() => {
  if (!props.side) return "side-unknown";
  return `side-${props.side}`;
});
</script>

<template>
  <div
    v-if="cell"
    class="cell-tooltip visible"
    :class="sideClass"
    :style="{ left: x + 'px', top: y + 'px' }"
  >
    <!-- Цветная полоска группы -->
    <div v-if="cell.color" class="tooltip-color-bar" :style="{ background: cell.color }"></div>

    <!-- Заголовок: иконка + название + тип-бейдж -->
    <div class="tooltip-header">
      <span class="tooltip-name">{{ cell.icon }} {{ cell.name }}</span>
      <span
        v-if="cell.type === 'RAILROAD'"
        class="tooltip-badge badge-railroad"
        title="Железная дорога"
      >
        Ж/Д
      </span>
      <span
        v-else-if="cell.type === 'UTILITY'"
        class="tooltip-badge badge-utility"
        title="Коммунальное предприятие"
      >
        Утилита
      </span>
    </div>

    <!-- ============ PROPERTY ============ -->
    <template v-if="cell.type === 'PROPERTY'">
      <div v-if="cell.price" class="tooltip-row">
        <span class="lbl">Цена</span>
        <span class="val gold">₽{{ cell.price }}</span>
      </div>

      <div v-if="baseRent !== undefined" class="tooltip-row">
        <span class="lbl">Рента</span>
        <span class="val">₽{{ baseRent }}</span>
      </div>

      <div v-if="monopolyRent !== undefined" class="tooltip-row highlight">
        <span class="lbl">Рента (монополия ×2)</span>
        <span class="val gold">₽{{ monopolyRent }}</span>
      </div>

      <!-- Полная таблица ренты -->
      <div v-if="cell.rentTable && cell.rentTable.length === 6" class="rent-table">
        <div class="rent-row">
          <span class="rent-label">1 дом</span>
          <span class="rent-val">₽{{ cell.rentTable[1] }}</span>
        </div>
        <div class="rent-row">
          <span class="rent-label">2 дома</span>
          <span class="rent-val">₽{{ cell.rentTable[2] }}</span>
        </div>
        <div class="rent-row">
          <span class="rent-label">3 дома</span>
          <span class="rent-val">₽{{ cell.rentTable[3] }}</span>
        </div>
        <div class="rent-row">
          <span class="rent-label">4 дома</span>
          <span class="rent-val">₽{{ cell.rentTable[4] }}</span>
        </div>
        <div class="rent-row hotel-row">
          <span class="rent-label">🏨 Отель</span>
          <span class="rent-val">₽{{ cell.rentTable[5] }}</span>
        </div>
      </div>

      <!-- Цена дома / возврат -->
      <div v-if="cell.housePrice !== undefined" class="tooltip-row">
        <span class="lbl">Цена 1 дома</span>
        <span class="val">₽{{ cell.housePrice }}</span>
      </div>
      <div v-if="houseRefund !== undefined" class="tooltip-row">
        <span class="lbl">Возврат за дом</span>
        <span class="val">₽{{ houseRefund }}</span>
      </div>
      <!--
        Возврат за отель показываем сразу, как только у клетки известна
        цена дома (даже если сейчас 0 домов — это плановая стоимость
        продажи, когда игрок дорастёт до отеля). Это то, о чём просил
        пользователь: «при ховере на карточках недвижимости всплывает
        окно, нужно добавить стоимость продажи отеля».
      -->
      <div v-if="hotelRefund !== undefined" class="tooltip-row">
        <span class="lbl">Возврат за отель</span>
        <span class="val">₽{{ hotelRefund }} + 4 дома</span>
      </div>
      <div
        v-if="cell.housePrice !== undefined && cell.houses === 4"
        class="tooltip-note"
        title="При продаже отель «распадается» на 4 дома (5 → 4), refund как за 1 дом"
      >
        🏨 Отель = 5 → 4 (остаётся 4 дома), возврат ₽{{ hotelRefund }}
      </div>

      <!-- Залог / выкуп -->
      <div v-if="cell.mortgageValue !== undefined" class="tooltip-row">
        <span class="lbl">Залог</span>
        <span class="val">₽{{ cell.mortgageValue }}</span>
      </div>
      <div v-if="unmortgageCost !== undefined" class="tooltip-row">
        <span class="lbl">Выкуп (+10%)</span>
        <span class="val">₽{{ unmortgageCost }}</span>
      </div>

      <!-- Бейдж монополии / текущий счёт домов -->
      <div
        v-if="hasMonopoly"
        class="tooltip-monopoly-badge"
        title="У владельца полная монополия по этой цветовой группе"
      >
        👑 Монополия
      </div>
      <div v-else-if="cell.group" class="tooltip-note">
        Группа «{{ cell.group }}»: {{ ownedInGroup }}/{{ groupSize }} у владельца
      </div>
    </template>

    <!-- ============ RAILROAD ============ -->
    <template v-else-if="cell.type === 'RAILROAD'">
      <div v-if="cell.price" class="tooltip-row">
        <span class="lbl">Цена</span>
        <span class="val gold">₽{{ cell.price }}</span>
      </div>
      <div class="rent-table">
        <div
          v-for="n in 4"
          :key="n"
          class="rent-row"
          :class="{
            'rent-current': ownedRailroadCount === n,
            'rent-dimmed': ownedRailroadCount !== n,
          }"
        >
          <span class="rent-label"
            >{{ n }} станц{{ n === 1 ? "ия" : n < 5 ? "ии" : "ий" }} у владельца</span
          >
          <span class="rent-val">₽{{ RAILROAD_RENT_BY_COUNT[n] }}</span>
        </div>
      </div>
      <div v-if="cell.mortgageValue !== undefined" class="tooltip-row">
        <span class="lbl">Залог</span>
        <span class="val">₽{{ cell.mortgageValue }}</span>
      </div>
      <div v-if="unmortgageCost !== undefined" class="tooltip-row">
        <span class="lbl">Выкуп (+10%)</span>
        <span class="val">₽{{ unmortgageCost }}</span>
      </div>
      <div v-if="ownedRailroadCount > 0" class="tooltip-note">
        У владельца станций: <b>{{ ownedRailroadCount }}/4</b>
      </div>
    </template>

    <!-- ============ UTILITY ============ -->
    <template v-else-if="cell.type === 'UTILITY'">
      <div v-if="cell.price" class="tooltip-row">
        <span class="lbl">Цена</span>
        <span class="val gold">₽{{ cell.price }}</span>
      </div>
      <div class="rent-table">
        <div
          class="rent-row"
          :class="{
            'rent-current': ownedUtilityCount === 1,
            'rent-dimmed': ownedUtilityCount !== 1,
          }"
        >
          <span class="rent-label">1 предприятие</span>
          <span class="rent-val">сумма кубиков × 4</span>
        </div>
        <div
          class="rent-row"
          :class="{
            'rent-current': ownedUtilityCount === 2,
            'rent-dimmed': ownedUtilityCount !== 2,
          }"
        >
          <span class="rent-label">2 предприятия (комплект)</span>
          <span class="rent-val">сумма кубиков × 10</span>
        </div>
      </div>
      <div v-if="utilityMultiplier !== undefined" class="tooltip-row highlight">
        <span class="lbl">Текущая рента</span>
        <span class="val gold">сумма кубиков × {{ utilityMultiplier }}</span>
      </div>
      <div v-if="cell.mortgageValue !== undefined" class="tooltip-row">
        <span class="lbl">Залог</span>
        <span class="val">₽{{ cell.mortgageValue }}</span>
      </div>
      <div v-if="unmortgageCost !== undefined" class="tooltip-row">
        <span class="lbl">Выкуп (+10%)</span>
        <span class="val">₽{{ unmortgageCost }}</span>
      </div>
      <div v-if="ownedUtilityCount > 0" class="tooltip-note">
        У владельца предприятий: <b>{{ ownedUtilityCount }}/2</b>
      </div>
    </template>

    <!-- ============ TAX ============ -->
    <template v-else-if="cell.type === 'TAX'">
      <div v-if="taxDescription" class="tooltip-note">{{ taxDescription }}</div>
    </template>

    <!-- ============ CHANCE / TREASURY / JAIL / ... ============ -->
    <template v-else-if="SPECIAL_DESCRIPTIONS[cell.type]">
      <div class="tooltip-note">{{ SPECIAL_DESCRIPTIONS[cell.type] }}</div>
    </template>

    <!-- ============ Owner + Houses footer ============ -->
    <div v-if="owner" class="tooltip-footer">
      <span class="owner-dot" :style="{ background: owner.color }"></span>
      <span class="owner-name">👤 {{ owner.displayName }}</span>
    </div>
    <div v-if="cell.type === 'PROPERTY' && cell.houses > 0" class="tooltip-footer houses-footer">
      <span v-if="cell.houses === 5" class="hotel-marker">🏨 Отель</span>
      <span v-else class="houses-marker"> 🏠 × {{ cell.houses }} </span>
    </div>
    <div v-if="cell.isMortgaged" class="tooltip-footer mortgaged-footer">🚫 В залоге</div>
  </div>
</template>

<style scoped>
.cell-tooltip {
  position: fixed;
  background: rgba(23, 9, 45, 0.98);
  backdrop-filter: blur(24px);
  border-radius: 12px;
  padding: 12px 14px;
  box-shadow:
    0 12px 40px rgba(0, 0, 0, 0.6),
    0 0 0 1px rgba(149, 114, 218, 0.2);
  z-index: 500;
  pointer-events: none;
  max-width: 280px;
  min-width: 200px;
  font-size: 11px;
  line-height: 1.4;
  color: var(--text1, #fff);
}

.tooltip-color-bar {
  height: 4px;
  border-radius: 2px;
  margin-bottom: 8px;
  box-shadow: 0 2px 8px currentColor;
}

.tooltip-header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}

.tooltip-name {
  font-size: 13px;
  font-weight: 700;
  flex: 1;
}

.tooltip-badge {
  font-size: 9px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  padding: 2px 6px;
  border-radius: 4px;
  background: rgba(149, 114, 218, 0.25);
  color: var(--accent2, #b18ff0);
  white-space: nowrap;
}

.badge-railroad {
  background: rgba(180, 130, 60, 0.25);
  color: #f0c878;
}

.badge-utility {
  background: rgba(80, 180, 220, 0.25);
  color: #88d8f0;
}

.tooltip-row {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 12px;
  padding: 2px 0;
  border-top: 1px dashed rgba(149, 114, 218, 0.15);
  font-size: 11px;
}

.tooltip-row .lbl {
  color: var(--text2, #b8b0d0);
  font-size: 10px;
}

.tooltip-row .val {
  font-weight: 700;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--text1, #fff);
}

.tooltip-row .val.gold {
  color: var(--gold, #f5d56a);
}

.tooltip-row.highlight {
  background: linear-gradient(90deg, rgba(245, 213, 106, 0.1), transparent);
  margin: 0 -6px;
  padding: 3px 6px;
  border-radius: 4px;
  border-top: none;
}

.rent-table {
  margin: 6px 0;
  border: 1px solid rgba(149, 114, 218, 0.2);
  border-radius: 6px;
  overflow: hidden;
}

.rent-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 3px 8px;
  font-size: 10px;
  background: rgba(149, 114, 218, 0.05);
  border-top: 1px solid rgba(149, 114, 218, 0.1);
}

.rent-row:first-child {
  border-top: none;
}

.rent-label {
  color: var(--text2, #b8b0d0);
}

.rent-val {
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: var(--text1, #fff);
}

.rent-row.hotel-row {
  background: linear-gradient(90deg, rgba(245, 213, 106, 0.15), rgba(149, 114, 218, 0.05));
}

.rent-row.rent-current {
  background: linear-gradient(90deg, rgba(80, 220, 130, 0.18), rgba(149, 114, 218, 0.05));
  box-shadow: inset 2px 0 0 #50dc82;
}

.rent-row.rent-dimmed {
  opacity: 0.55;
}

.tooltip-note {
  font-size: 10px;
  color: var(--text2, #b8b0d0);
  margin-top: 4px;
  font-style: italic;
}

.tooltip-monopoly-badge {
  display: inline-block;
  margin-top: 6px;
  padding: 2px 8px;
  font-size: 10px;
  font-weight: 700;
  border-radius: 4px;
  background: linear-gradient(135deg, #f5d56a, #d4a82e);
  color: #1a0930;
  box-shadow: 0 2px 6px rgba(245, 213, 106, 0.4);
}

.tooltip-footer {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid rgba(149, 114, 218, 0.2);
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10px;
  color: var(--text2, #b8b0d0);
}

.owner-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  box-shadow: 0 0 4px currentColor;
}

.owner-name {
  color: var(--text1, #fff);
  font-weight: 600;
}

.houses-footer .houses-marker,
.houses-footer .hotel-marker {
  color: var(--gold, #f5d56a);
  font-weight: 700;
}

.mortgaged-footer {
  color: #ff7a7a;
  font-weight: 600;
}
</style>
