<script setup lang="ts">
/**
 * BankruptcyModal — модалка «Банкротство».
 *
 * Показывается, когда у текущего игрока отрицательный баланс и сервер
 * перевёл партию в фазу `BANKRUPTCY_LIQUIDATE`.
 *
 * Правила (Монополия):
 *  - Игрок может продать дома/отели (BANKRUPTCY_LIQUIDATE_HOUSES) — за
 *    половину стоимости дома.
 *  - Может заложить незаложенные клетки без домов (BANKRUPTCY_MORTGAGE).
 *  - Когда денег хватает — нажимает «Подтвердить оплату» (BANKRUPTCY_CONFIRM).
 *  - Если нечего продать/заложить — кнопка «Объявить банкротство»
 *    (BANKRUPTCY_DECLARE) удаляет игрока из партии.
 *
 * ВАЖНО: сервер — единственный источник правды. Клиент только отправляет
 * действия через `sendAction(...)`. Обновлённое состояние приходит через
 * WS-событие `game:state`, и модалка перерисовывается.
 */
import { computed } from "vue";
import Modal from "../Modal.vue";
import type { Cell } from "@monopoly/shared";
import { useGameStore } from "../../stores/game";

const props = defineProps<{
  show: boolean;
  /** ID текущего игрока (кто банкротится). */
  myPlayerId: string | null;
  /** Сколько игрок должен покрыть (для отображения). */
  debt: number;
  /** Текущий баланс игрока. */
  money: number;
  /** Клетки игрока (уже отфильтрованные по `ownerId === myPlayerId`). */
  myProperties: Cell[];
  /** Имя кредитора (если банкротство вызвано арендой/налогом с привязкой). */
  creditorName?: string | null;
  /** Сколько всего можно выручить (дома + залог). */
  maxLiquidity: number;
}>();

const game = useGameStore();

/** Дом можно продать, только если он есть и клетка не заложена. */
const housesForSale = computed<Cell[]>(() =>
  props.myProperties
    .filter((c) => (c.houses ?? 0) > 0 && !c.isMortgaged)
    .sort((a, b) => (b.housePrice ?? 0) - (a.housePrice ?? 0)),
);

/**
 * Клетки, которые можно заложить:
 *  - не в залоге;
 *  - без домов на самой клетке;
 *  - в группе нет других клеток этого игрока с домами (правило Монополии).
 */
const mortgageable = computed<Cell[]>(() => {
  const myId = props.myPlayerId;
  if (!myId) return [];
  return props.myProperties
    .filter((c) => !c.isMortgaged && (c.houses ?? 0) === 0)
    .filter((c) => {
      const groupHasHouses = props.myProperties.some(
        (other) =>
          other.type === c.type &&
          other.group === c.group &&
          other.id !== c.id &&
          (other.houses ?? 0) > 0,
      );
      return !groupHasHouses;
    })
    .sort((a, b) => (b.mortgageValue ?? 0) - (a.mortgageValue ?? 0));
});

/**
 * Клетки, которые можно ПРОДАТЬ Банку за 100% номинала (правило ТЗ).
 *  - принадлежат игроку;
 *  - не заложены;
 *  - без построек на самой клетке;
 *  - в цветовой группе нет других клеток этого игрока с домами;
 *  - имеют положительную номинальную цену.
 */
const sellableToBank = computed<Cell[]>(() => {
  const myId = props.myPlayerId;
  if (!myId) return [];
  return props.myProperties
    .filter((c) => !c.isMortgaged && (c.houses ?? 0) === 0 && (c.price ?? 0) > 0)
    .filter((c) => {
      const groupHasHouses = props.myProperties.some(
        (other) =>
          other.type === c.type &&
          other.group === c.group &&
          other.id !== c.id &&
          (other.houses ?? 0) > 0,
      );
      return !groupHasHouses;
    })
    .sort((a, b) => (b.price ?? 0) - (a.price ?? 0));
});

/** Сколько денег останется после полной ликвидации. */
const projectedMoney = computed<number>(() => props.money + props.maxLiquidity);

/** Хватает ли ликвидности, чтобы покрыть долг? */
const canCoverDebt = computed<boolean>(() => projectedMoney.value >= 0);

/** Кнопка «Подтвердить оплату» активна только если баланс уже >= 0. */
const canConfirm = computed<boolean>(() => props.money >= 0);

// Стоимость продажи одного дома = половина цены дома (правило Монополии).
function sellHousePrice(cell: Cell): number {
  return Math.floor((cell.housePrice ?? 0) / 2);
}

function onSellHouse(cellId: number): void {
  game.sendAction({ type: "BANKRUPTCY_LIQUIDATE_HOUSES", cellId });
}

function onMortgage(cellId: number): void {
  game.sendAction({ type: "BANKRUPTCY_MORTGAGE", cellId });
}

/**
 * Продать клетку Банку за 100% номинала (правило ТЗ).
 * Клетка становится UNOWNED, деньги сразу зачисляются игроку.
 */
function onSellToBank(cellId: number): void {
  game.sendAction({ type: "BANKRUPTCY_SELL_PROPERTY", cellId });
}

function onConfirm(): void {
  game.sendAction({ type: "BANKRUPTCY_CONFIRM" });
}

function onDeclare(): void {
  game.sendAction({ type: "BANKRUPTCY_DECLARE" });
}
</script>

<template>
  <Modal
    :show="show"
    title="💸 Банкротство!"
    :subtitle="`Долг: ₽${debt.toLocaleString()} · На счету: ₽${money.toLocaleString()}`"
    :closable="false"
  >
    <p class="hint">
      Баланс ушёл в минус. Продайте дома или заложите участки, чтобы восстановить ликвидность. Если
      восстановить невозможно — придётся объявить банкротство и выбыть из партии.
    </p>

    <p v-if="creditorName" class="creditor">
      Кредитор: <strong>{{ creditorName }}</strong>
    </p>

    <p class="liquidity">
      Максимум можно выручить: <strong>₽{{ maxLiquidity.toLocaleString() }}</strong> → после
      ликвидации баланс: <strong>₽{{ projectedMoney.toLocaleString() }}</strong>
      <span v-if="!canCoverDebt" class="warn"> — этого недостаточно, банкротство неизбежно. </span>
    </p>

    <!-- Дома на продажу -->
    <section v-if="housesForSale.length > 0" class="section">
      <h3 class="section-title">Продать дома</h3>
      <div class="cards">
        <div v-for="cell in housesForSale" :key="`h-${cell.id}`" class="card">
          <div class="card-header" :style="{ background: cell.color || '#555' }">
            <span class="card-name">{{ cell.name }}</span>
            <span class="badge">Домов: {{ cell.houses }}</span>
          </div>
          <div class="card-body">
            <div class="card-row">
              <span class="label">Цена продажи 1 дома</span>
              <span class="value">₽{{ sellHousePrice(cell) }}</span>
            </div>
          </div>
          <div class="card-action">
            <button class="action-btn btn-sell" @click="onSellHouse(cell.id)">
              💰 Продать за ₽{{ sellHousePrice(cell) }}
            </button>
          </div>
        </div>
      </div>
    </section>

    <!-- Клетки под залог -->
    <section v-if="mortgageable.length > 0" class="section">
      <h3 class="section-title">Заложить участки (50%)</h3>
      <div class="cards">
        <div v-for="cell in mortgageable" :key="`m-${cell.id}`" class="card">
          <div class="card-header" :style="{ background: cell.color || '#555' }">
            <span class="card-name">{{ cell.name }}</span>
            <span class="badge">Залог: ₽{{ cell.mortgageValue ?? 0 }}</span>
          </div>
          <div class="card-body">
            <div class="card-row">
              <span class="label">Тип</span>
              <span class="value">
                <template v-if="cell.type === 'PROPERTY'">Участок</template>
                <template v-else-if="cell.type === 'RAILROAD'">Ж/д</template>
                <template v-else-if="cell.type === 'UTILITY'">Предприятие</template>
                <template v-else>{{ cell.type }}</template>
              </span>
            </div>
          </div>
          <div class="card-action">
            <button class="action-btn btn-mortgage" @click="onMortgage(cell.id)">
              🔒 Заложить ₽{{ cell.mortgageValue ?? 0 }}
            </button>
          </div>
        </div>
      </div>
    </section>

    <!-- Клетки на продажу Банку (100% номинала) -->
    <section v-if="sellableToBank.length > 0" class="section">
      <h3 class="section-title">Продать Банку (100%)</h3>
      <div class="cards">
        <div v-for="cell in sellableToBank" :key="`s-${cell.id}`" class="card">
          <div class="card-header" :style="{ background: cell.color || '#555' }">
            <span class="card-name">{{ cell.name }}</span>
            <span class="badge">Цена: ₽{{ cell.price ?? 0 }}</span>
          </div>
          <div class="card-body">
            <div class="card-row">
              <span class="label">Тип</span>
              <span class="value">
                <template v-if="cell.type === 'PROPERTY'">Участок</template>
                <template v-else-if="cell.type === 'RAILROAD'">Ж/д</template>
                <template v-else-if="cell.type === 'UTILITY'">Предприятие</template>
                <template v-else>{{ cell.type }}</template>
              </span>
            </div>
          </div>
          <div class="card-action">
            <button class="action-btn btn-sell-to-bank" @click="onSellToBank(cell.id)">
              🏦 Продать Банку за ₽{{ cell.price ?? 0 }}
            </button>
          </div>
        </div>
      </div>
    </section>

    <!-- Ничего нельзя ликвидировать -->
    <p v-if="housesForSale.length === 0 && mortgageable.length === 0" class="empty">
      У вас нет ни домов, ни участков, доступных для ликвидации.
    </p>

    <div class="modal-actions">
      <button
        class="action-btn btn-confirm"
        :disabled="!canConfirm"
        :title="canConfirm ? 'Подтвердить оплату' : 'Сначала восстановите баланс'"
        @click="onConfirm"
      >
        ✅ Подтвердить оплату
      </button>
      <button class="action-btn btn-declare" @click="onDeclare">💀 Объявить банкротство</button>
    </div>
  </Modal>
</template>

<style scoped>
.hint {
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-muted);
  margin: 0 0 12px;
  text-align: center;
}

.creditor {
  font-size: 12px;
  color: var(--text-muted);
  text-align: center;
  margin: 0 0 12px;
}

.creditor strong {
  color: var(--text);
}

.liquidity {
  font-size: 12px;
  color: var(--text);
  text-align: center;
  margin: 0 0 16px;
  padding: 8px 12px;
  background: var(--surface-2);
  border-radius: var(--radius-sm);
}

.liquidity strong {
  color: var(--gold);
}

.liquidity .warn {
  color: var(--accent);
  font-weight: 600;
  margin-left: 4px;
}

.section {
  margin-bottom: 14px;
}

.section-title {
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-muted);
  margin: 0 0 8px;
  padding-left: 4px;
}

.cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 10px;
  max-height: 38vh;
  overflow-y: auto;
  padding: 2px;
}

.card {
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-sm);
  background: var(--surface-1);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.card-header {
  padding: 7px 9px;
  font-size: 12px;
  font-weight: 700;
  color: #fff;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}

.card-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.badge {
  font-size: 9px;
  background: rgba(0, 0, 0, 0.45);
  padding: 2px 6px;
  border-radius: 6px;
  letter-spacing: 0.5px;
  flex-shrink: 0;
}

.card-body {
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.card-row {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  gap: 8px;
}

.label {
  color: var(--text-muted);
}

.value {
  font-weight: 600;
  color: var(--text);
}

.card-action {
  padding: 0 10px 10px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.action-btn {
  width: 100%;
  padding: 9px 10px;
  border: none;
  border-radius: var(--radius-sm);
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  cursor: pointer;
  transition:
    background 0.15s ease,
    transform 0.1s ease;
  color: #fff;
}

.btn-sell {
  background: linear-gradient(135deg, #f5a623, #d4801f);
}

.btn-sell:hover {
  background: linear-gradient(135deg, #ffb84a, #e0943a);
  transform: translateY(-1px);
}

.btn-mortgage {
  background: linear-gradient(135deg, #6b8aff, #4a6dd0);
}

.btn-mortgage:hover {
  background: linear-gradient(135deg, #8aa3ff, #6080e0);
  transform: translateY(-1px);
}

.btn-sell-to-bank {
  background: linear-gradient(135deg, #2ecc71, #16a085);
}

.btn-sell-to-bank:hover {
  background: linear-gradient(135deg, #4ade80, #1abc9c);
  transform: translateY(-1px);
}

.empty {
  text-align: center;
  padding: 20px 12px;
  color: var(--text-muted);
  font-size: 13px;
  font-style: italic;
  background: var(--surface-2);
  border-radius: var(--radius-sm);
}

.modal-actions {
  display: flex;
  gap: 10px;
  margin-top: 16px;
  justify-content: stretch;
}

.btn-confirm,
.btn-declare {
  flex: 1;
  padding: 12px 16px;
  border: none;
  border-radius: var(--radius-sm);
  font-weight: 700;
  font-size: 13px;
  cursor: pointer;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  transition:
    filter 0.15s ease,
    transform 0.1s ease;
}

.btn-confirm {
  background: linear-gradient(135deg, var(--green), var(--accent));
  color: #fff;
}

.btn-confirm:hover:not(:disabled) {
  filter: brightness(1.1);
  transform: translateY(-1px);
}

.btn-confirm:disabled {
  background: var(--surface-3);
  color: var(--text-muted);
  cursor: not-allowed;
  opacity: 0.55;
}

.btn-declare {
  background: linear-gradient(135deg, var(--accent), #c33);
  color: #fff;
}

.btn-declare:hover {
  filter: brightness(1.1);
  transform: translateY(-1px);
}
</style>
