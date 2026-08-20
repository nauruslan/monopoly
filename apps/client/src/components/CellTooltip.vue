<script setup lang="ts">
import { computed } from "vue";
import type { Cell, GameState, Player, BoardSide } from "@monopoly/shared";
import {
  RAILROAD_RENT_BY_COUNT,
  UTILITY_MULTIPLIER_BY_COUNT,
  UNMORTGAGE_INTEREST_RATE,
  hasActiveMonopoly,
} from "@monopoly/shared";

/**
 * CellTooltip — расширенный тултип клетки при наведении/клике.
 *
 * Состав секций зависит от типа клетки:
 *  - PROPERTY: цена, единый блок ренты (базовая, ×2 при монополии,
 *    1..4 дома, отель), цена покупки дома, возврат при продаже, залог,
 *    выкуп, бейдж монополии;
 *  - RAILROAD: цена, таблица ренты в зависимости от числа станций у
 *    владельца (1/2/3/4 → 25/50/100/200);
 *  - UTILITY: цена, таблица формул (×4 для одной, ×10 для двух);
 *  - TAX: фиксированная сумма либо пометка о luxury-карточках;
 *  - CHANCE / TREASURY / JAIL / GOTO_JAIL / PARKING / GO: краткое описание.
 *
 * Подсветка текущей ренты (`.rent-row.rent-current`) устанавливается
 * ДИНАМИЧЕСКИ на основании `cell.houses` и `hasMonopoly`, чтобы игрок
 * видел, какую сумму он получит/заплатит ПРЯМО СЕЙЧАС, а не всегда
 * строку «Отель».
 *
 * Замечание: тултип носит чисто СПРАВОЧНЫЙ характер. Вся валидация
 * финансовых операций и финальные суммы считаются на сервере
 * (BuildService / MortgageService). Здесь мы показываем то, что
 * посчитал клиент (на основании `state.board`).
 *
 * ПОЗИЦИОНИРОВАНИЕ (hover-тултип):
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

/**
 * Сколько станций (RAILROAD) у текущего владельца.
 * Заложенные станции НЕ считаются — ренту они не приносят.
 */
const ownedRailroadCount = computed<number>(() => {
  if (!props.state || !props.cell?.ownerId) return 0;
  return props.state.board.filter(
    (c) => c.type === "RAILROAD" && c.ownerId === props.cell!.ownerId && !c.isMortgaged,
  ).length;
});

/**
 * Сколько предприятий (UTILITY) у текущего владельца.
 * Заложенные предприятия НЕ считаются — ренту они не приносят.
 */
const ownedUtilityCount = computed<number>(() => {
  if (!props.state || !props.cell?.ownerId) return 0;
  return props.state.board.filter(
    (c) => c.type === "UTILITY" && c.ownerId === props.cell!.ownerId && !c.isMortgaged,
  ).length;
});

/**
 * Сколько клеток данной цветовой группы ВСЕГО на доске.
 */
const groupSize = computed<number>(() => {
  if (!props.state || !props.cell?.group) return 0;
  return props.state.board.filter((c) => c.type === "PROPERTY" && c.group === props.cell!.group)
    .length;
});

/**
 * Сколько клеток группы принадлежит текущему владельцу.
 * (Используется только для информационного бейджа «N из M у вас»,
 *  не путать с проверкой монополии — см. `hasMonopoly` ниже.)
 */
const ownedInGroup = computed<number>(() => {
  if (!props.state || !props.cell?.group || !props.cell.ownerId) return 0;
  return props.state.board.filter(
    (c) =>
      c.type === "PROPERTY" && c.group === props.cell!.group && c.ownerId === props.cell!.ownerId,
  ).length;
});

/**
 * Есть ли у владельца АКТИВНАЯ монополия по цвету.
 * «Активная» = ВСЕ клетки группы принадлежат ему И ни одна из них не заложена.
 * Если хоть один участок заложен — монополия СЧИТАЕТСЯ СЛОМАННОЙ:
 * рента не удваивается, строить нельзя, бонусные карточки по монополии не даются.
 */
const hasMonopoly = computed<boolean>(() => {
  if (!props.state || !props.cell || props.cell.type !== "PROPERTY") return false;
  if (!props.cell.ownerId || !props.cell.group) return false;
  return hasActiveMonopoly(props.cell.ownerId, props.cell.group, props.state.board);
});

/** Возврат при продаже одного дома = housePrice / 2. */
const houseRefund = computed<number | undefined>(() => {
  if (props.cell?.housePrice === undefined) return undefined;
  return Math.floor(props.cell.housePrice / 2);
});

/** Стоимость выкупа из залога (mortgageValue * 1.1, ceil). */
const unmortgageCost = computed<number | undefined>(() => {
  if (props.cell?.mortgageValue === undefined) return undefined;
  return Math.ceil(props.cell.mortgageValue * UNMORTGAGE_INTEREST_RATE);
});

/**
 * Базовая рента из `rentTable[0]` (гарантированно number при наличии
 * таблицы). Используется в шаблоне как безопасный источник значения
 * для строки «Рента ×2 (монополия)» — умножение на 2 не упрётся в
 * `undefined`, на что ругается TS-плагин при прямом доступе к
 * `cell.rentTable[0]`.
 */
const baseRentFromTable = computed<number>(() => {
  const rt = props.cell?.rentTable;
  if (rt && rt.length === 6 && typeof rt[0] === "number") return rt[0];
  return props.cell?.rent ?? 0;
});

/**
 * Если участок (PROPERTY) заложен — вся рента с этой клетки = ₽0.
 * Используется в шаблоне, чтобы показать зачёркнутую старую сумму
 * и «= ₽0» рядом (как при скидке в магазине).
 */
const isMortgaged = computed<boolean>(() => props.cell?.isMortgaged === true);

/**
 * Какая именно строка блока рент сейчас активна.
 *
 * Возвращает «индекс» в логическом массиве строк:
 *  - 0 — базовая рента (без домов, без монополии)
 *  - 1 — рента ×2 (без домов, но есть монополия)
 *  - 2 — 1 дом
 *  - 3 — 2 дома
 *  - 4 — 3 дома
 *  - 5 — 4 дома
 *  - 6 — отель
 *  - null — клетка не PROPERTY / нет rentTable (нечего подсвечивать)
 *
 * Используется в шаблоне для простановки класса `.rent-current`.
 */
const currentRentIndex = computed<number | null>(() => {
  const c = props.cell;
  if (!c || c.type !== "PROPERTY") return null;
  if (!c.rentTable || c.rentTable.length !== 6) return null;
  if (c.houses === 5) return 6;
  if (c.houses >= 1 && c.houses <= 4) return 1 + c.houses; // 1..4 → 2..5
  // 0 домов
  return hasMonopoly.value ? 1 : 0;
});

/**
 * Нужно ли показывать блок «Владелец» в футере.
 *
 * Скрываем для клеток, у которых владельца быть не может:
 *  - GO          — стартовая клетка, банковская;
 *  - JAIL        — обычный «визит» (а не тюрьма-резиденция);
 *  - GOTO_JAIL   — клетка-указатель, недвижимости нет;
 *  - PARKING     — бесплатная стоянка;
 *  - CHANCE      — колода;
 *  - TREASURY    — колода;
 *  - TAX         — банковская клетка.
 *
 * Для PROPERTY / RAILROAD / UTILITY — показываем всегда: либо
 * конкретного владельца, либо «Нет», если клетка ничейная.
 */
const showOwner = computed<boolean>(() => {
  const t = props.cell?.type;
  if (!t) return false;
  return t === "PROPERTY" || t === "RAILROAD" || t === "UTILITY";
});

/**
 * Описание клетки-действия (Шанс, Казна, Тюрьма, GO, ...).
 * Используется в тултипе вместо финансовой информации.
 */
const SPECIAL_DESCRIPTIONS: Partial<Record<string, string>> = {
  GO: "Получите ₽200 при проходе или ₽400 при остановке на этом поле.",
  CHANCE: "Карточка Шанс: случайное событие из колоды.",
  TREASURY: "Общественная казна: случайное событие из колоды.",
  JAIL: "Место для арестованных игроков и их посетителей.",
  GOTO_JAIL: "Отправляйтесь в тюрьму.",
  PARKING: "Отдохните на бесплатной стоянке.",
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
    <!-- Заголовок: иконка + название -->
    <div class="tooltip-header">
      <span class="tooltip-name">{{ cell.icon }} {{ cell.name }}</span>
    </div>

    <!-- PROPERTY -->
    <template v-if="cell.type === 'PROPERTY'">
      <div v-if="cell.price" class="tooltip-row">
        <span class="lbl">Цена</span>
        <span class="val gold">₽{{ cell.price }}</span>
      </div>

      <!--
        Единый блок ренты: базовая → ×2 (монополия) → 1дом → 2дома →
        3дома → 4дома → отель. Без рамки и разделителей; подсветка
        динамически указывает на АКТУАЛЬНУЮ ренту для этой клетки.
      -->
      <div v-if="cell.rentTable && cell.rentTable.length === 6" class="rent-list">
        <!--
          При залоге зачёркиваем ТОЛЬКО строку «Рента» и показываем ₽0
          рядом — остальные строки ренты остаются как есть.
          (currentRentIndex уже возвращает 0 при isMortgaged, поэтому
           подсветка .rent-current автоматически указывает на эту строку.)
        -->
        <div
          class="rent-row"
          :class="{
            'rent-current': currentRentIndex === 0,
            'rent-dimmed': currentRentIndex !== 0 && currentRentIndex !== null,
          }"
        >
          <span class="rent-label">Рента</span>
          <span class="rent-val">
            <template v-if="isMortgaged">
              <span class="rent-val-strikethrough">₽{{ cell.rentTable[0] }}</span>
              <span class="rent-val-zero">₽0</span>
            </template>
            <template v-else>₽{{ cell.rentTable[0] }}</template>
          </span>
        </div>
        <div
          class="rent-row"
          :class="{
            'rent-current': currentRentIndex === 1,
            'rent-dimmed': currentRentIndex !== 1 && currentRentIndex !== null,
          }"
        >
          <span class="rent-label">Рента ×2 (монополия)</span>
          <span class="rent-val">₽{{ baseRentFromTable * 2 }}</span>
        </div>
        <div
          class="rent-row"
          :class="{
            'rent-current': currentRentIndex === 2,
            'rent-dimmed': currentRentIndex !== 2 && currentRentIndex !== null,
          }"
        >
          <span class="rent-label">1 дом</span>
          <span class="rent-val">₽{{ cell.rentTable[1] }}</span>
        </div>
        <div
          class="rent-row"
          :class="{
            'rent-current': currentRentIndex === 3,
            'rent-dimmed': currentRentIndex !== 3 && currentRentIndex !== null,
          }"
        >
          <span class="rent-label">2 дома</span>
          <span class="rent-val">₽{{ cell.rentTable[2] }}</span>
        </div>
        <div
          class="rent-row"
          :class="{
            'rent-current': currentRentIndex === 4,
            'rent-dimmed': currentRentIndex !== 4 && currentRentIndex !== null,
          }"
        >
          <span class="rent-label">3 дома</span>
          <span class="rent-val">₽{{ cell.rentTable[3] }}</span>
        </div>
        <div
          class="rent-row"
          :class="{
            'rent-current': currentRentIndex === 5,
            'rent-dimmed': currentRentIndex !== 5 && currentRentIndex !== null,
          }"
        >
          <span class="rent-label">4 дома</span>
          <span class="rent-val">₽{{ cell.rentTable[4] }}</span>
        </div>
        <div
          class="rent-row"
          :class="{
            'rent-current': currentRentIndex === 6,
            'rent-dimmed': currentRentIndex !== 6 && currentRentIndex !== null,
          }"
        >
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

      <!-- Залог / выкуп -->
      <div v-if="cell.mortgageValue !== undefined" class="tooltip-row">
        <span class="lbl">Залог</span>
        <span class="val">₽{{ cell.mortgageValue }}</span>
      </div>
      <div v-if="unmortgageCost !== undefined" class="tooltip-row">
        <span class="lbl">Выкуп (+10%)</span>
        <span class="val">₽{{ unmortgageCost }}</span>
      </div>

      <!-- Бейдж монополии.
           Теперь учитывается правило: монополия считается активной,
           только если ВСЕ участки группы принадлежат владельцу и НИ
           ОДИН из них не заложен (см. hasActiveMonopoly в shared). -->
      <div
        v-if="hasMonopoly"
        class="tooltip-monopoly-badge"
        title="У владельца активная монополия по этой цветовой группе (все участки его и ни один не заложен)"
      >
        👑 Монополия
      </div>
      <!--
        Подсказка: игрок собрал всю группу, но один из участков заложен —
        монополия считается «сломанной» и удвоенная рента НЕ работает.
      -->
      <div
        v-else-if="ownedInGroup === groupSize && groupSize > 0 && cell.isMortgaged === false"
        class="tooltip-note tooltip-warn"
        title="Один из участков этой цветовой группы заложен — монополия не активна"
      >
        ⚠️ Монополия сломана: в группе есть заложенный участок
      </div>
    </template>

    <!-- RAILROAD -->
    <template v-else-if="cell.type === 'RAILROAD'">
      <div v-if="cell.price" class="tooltip-row">
        <span class="lbl">Цена</span>
        <span class="val gold">₽{{ cell.price }}</span>
      </div>
      <div class="rent-list">
        <div
          v-for="n in 4"
          :key="n"
          class="rent-row"
          :class="{
            'rent-current': ownedRailroadCount === n,
            'rent-dimmed': ownedRailroadCount !== n && ownedRailroadCount > 0,
          }"
        >
          <span class="rent-label">{{ n }} вокзал{{ n === 1 ? "" : "а" }}</span>
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
    </template>

    <!-- UTILITY -->
    <template v-else-if="cell.type === 'UTILITY'">
      <div v-if="cell.price" class="tooltip-row">
        <span class="lbl">Цена</span>
        <span class="val gold">₽{{ cell.price }}</span>
      </div>
      <div class="rent-list">
        <div
          class="rent-row"
          :class="{
            'rent-current': ownedUtilityCount === 1,
            'rent-dimmed': ownedUtilityCount !== 1 && ownedUtilityCount > 0,
          }"
        >
          <span class="rent-label">1 предприятие</span>
          <span class="rent-val">кубики × 4</span>
        </div>
        <div
          class="rent-row"
          :class="{
            'rent-current': ownedUtilityCount === 2,
            'rent-dimmed': ownedUtilityCount !== 2 && ownedUtilityCount > 0,
          }"
        >
          <span class="rent-label">2 предприятия</span>
          <span class="rent-val">кубики × 10</span>
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
    </template>

    <!-- TAX -->
    <template v-else-if="cell.type === 'TAX'">
      <div v-if="taxDescription" class="tooltip-note">{{ taxDescription }}</div>
    </template>

    <!-- CHANCE / TREASURY / JAIL / ... -->
    <template v-else-if="SPECIAL_DESCRIPTIONS[cell.type]">
      <div class="tooltip-note">{{ SPECIAL_DESCRIPTIONS[cell.type] }}</div>
    </template>

    <!-- Owner footer (Владелец) — только для собственности  -->
    <div v-if="showOwner" class="tooltip-footer">
      <span class="lbl">Владелец:</span>
      <span v-if="owner" class="owner-block">
        <span class="owner-dot" :style="{ background: owner.color }"></span>
        <span class="owner-name">{{ owner.displayName }}</span>
      </span>
      <span v-else class="owner-empty">Нет</span>
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
  font-family: inherit;
  color: #fff;
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
  color: #fff;
}
.tooltip-row {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 12px;
  padding: 3px 0;
  font-size: 11px;
  line-height: 1.4;
  color: #fff;
}
.tooltip-row .lbl {
  color: #fff;
  font-size: 11px;
  font-weight: 500;
}
.tooltip-row .val {
  font-weight: 600;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: #fff;
  text-align: right;
}
.tooltip-row .val.gold {
  color: var(--gold, #f5d56a);
}
.rent-list {
  margin: 0;
}
.rent-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 3px 0;
  font-size: 11px;
  line-height: 1.4;
  font-family: inherit;
  color: #fff;
  border-radius: 4px;
  transition:
    background 0.15s ease,
    opacity 0.15s ease;
}

.rent-label {
  color: #fff;
  font-size: 11px;
  font-weight: 500;
}

.rent-val {
  font-weight: 600;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: #fff;
}
.rent-row.rent-current {
  background: linear-gradient(90deg, rgba(149, 114, 218, 0.32), rgba(149, 114, 218, 0.12));
  padding: 5px 8px;
  margin: 0 -8px;
  color: #fff;
}

.rent-row.rent-current .rent-label,
.rent-row.rent-current .rent-val {
  color: #fff;
  font-weight: 700;
}
.rent-row.rent-dimmed {
  background: transparent;
}
.tooltip-note {
  font-size: 11px;
  color: #fff;
  margin-top: 4px;
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
  border-top: 1px dashed rgba(149, 114, 218, 0.2);
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: #fff;
}
.tooltip-footer .lbl {
  color: #fff;
  font-size: 11px;
}
.owner-block {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.owner-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  box-shadow: 0 0 4px currentColor;
}
.owner-name {
  color: #fff;
  font-weight: 600;
}
.owner-empty {
  color: #fff;
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
/*
  Визуализация «залог → рента = 0»:
   - старая сумма перечёркнута по середине (как в магазинах при скидке);
   - рядом зелёная «= ₽0» — это и есть текущая рента.
  Подсветка строки (`.rent-current`) указывает именно на строку
  «Рента» благодаря тому, что `currentRentIndex === 0` при залоге.
*/
.rent-val-strikethrough {
  text-decoration: line-through;
  text-decoration-color: rgba(255, 255, 255, 0.7);
  text-decoration-thickness: 2px;
  margin-right: 6px;
  color: rgba(255, 255, 255, 0.55);
}
.rent-val-zero {
  color: #7ee08a;
  font-weight: 700;
}
</style>
