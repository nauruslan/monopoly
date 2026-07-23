<script setup lang="ts">
/**
 * MortgageModal — модалка «Залог/Выкуп».
 *
 * Показывается по нажатию кнопки «Залог/Выкуп» в `ActionsPanel.vue`.
 *
 * Структура:
 *  - Список всех клеток игрока.
 *  - Для каждой клетки — карточка с названием/цветом, признаком залога
 *    и кнопкой «Заложить» (если можно) или «Выкупить» (если можно).
 *  - Если клетку нельзя ни заложить, ни выкупить (напр., в группе есть
 *    дома) — кнопка заблокирована с подсказкой.
 *  - Внизу — кнопка «ПРИНЯТЬ», которая закрывает модалку.
 *
 * ВАЖНО: все финансовые операции и проверки делаются на СЕРВЕРЕ
 * (см. MortgageService). Клиент лишь рисует UI и шлёт actions.
 * Если сервер отклонит — в game.ts выставится `mortgage.setError(...)`
 * и текст ошибки появится в нижней панели.
 */
import { computed } from "vue";
import Modal from "../Modal.vue";
import { useMortgageStore } from "../../stores/mortgage";
import type { Cell } from "@monopoly/shared";

const mortgage = useMortgageStore();

/** Локальная обёртка: текущая модалка открыта? */
const show = computed<boolean>(() => mortgage.isOpen);

/**
 * Удобный список для отрисовки: пары (cell, действие).
 * Действие определяется по состоянию клетки:
 *   - заложена + хватает денег → "unmortgage"
 *   - не заложена + можно заложить → "mortgage"
 *   - иначе → null (кнопка disabled с подсказкой).
 */
interface Row {
  cell: Cell;
  /** "mortgage" | "unmortgage" | null */
  action: "mortgage" | "unmortgage" | null;
  /** Сумма операции (для подписи на кнопке). */
  amount: number;
  /** Пояснение, почему кнопка disabled (если action === null). */
  reason: string | null;
}

const rows = computed<Row[]>(() => {
  const list = mortgage.myProperties;
  return list
    .slice() // не мутируем
    .sort((a, b) => a.id - b.id)
    .map((cell) => {
      if (cell.isMortgaged) {
        const cost = mortgage.getUnmortgageCost(cell);
        if (mortgage.me && mortgage.me.money >= cost) {
          return { cell, action: "unmortgage", amount: cost, reason: null };
        }
        return {
          cell,
          action: null,
          amount: cost,
          reason: "Недостаточно денег для выкупа",
        };
      }
      // Не заложена: можно ли заложить?
      const inMortgageableList = mortgage.mortgageableProperties.some((c) => c.id === cell.id);
      if (inMortgageableList) {
        return {
          cell,
          action: "mortgage",
          amount: cell.mortgageValue ?? 0,
          reason: null,
        };
      }
      // Кнопка заблокирована. Определяем причину для подсказки.
      if (cell.houses > 0) {
        return { cell, action: null, amount: 0, reason: "Сначала продайте дома" };
      }
      if (cell.group && mortgage.state) {
        const groupHasHouses = mortgage.state.board.some(
          (c) =>
            c.type === cell.type &&
            c.group === cell.group &&
            c.ownerId === mortgage.me?.id &&
            c.houses > 0,
        );
        if (groupHasHouses) {
          return {
            cell,
            action: null,
            amount: 0,
            reason: "В группе есть дома — сначала продайте ВСЕ дома в этой цветовой группе",
          };
        }
      }
      return { cell, action: null, amount: 0, reason: "Нельзя заложить" };
    });
});

function onAction(row: Row): void {
  if (row.action === "mortgage") mortgage.mortgage(row.cell.id);
  else if (row.action === "unmortgage") mortgage.unmortgage(row.cell.id);
}

function onClose(): void {
  mortgage.close();
}

function onAcknowledge(): void {
  mortgage.acknowledge();
}
</script>

<template>
  <Modal
    :show="show"
    title="🏦 Залог / Выкуп"
    :subtitle="`Баланс: ₽${(mortgage.me?.money ?? 0).toLocaleString()}`"
    @close="onClose"
  >
    <p class="hint">
      Выберите участок, чтобы заложить или выкупить из залога (стоимость выкупа × 1.1, округлено
      вверх).
    </p>

    <!-- Пустой случай: у игрока нет клеток -->
    <div v-if="rows.length === 0" class="empty">
      У вас пока нет клеток, которые можно заложить или выкупить.
    </div>

    <!-- Сетка карточек клеток -->
    <div v-else class="cards">
      <div
        v-for="row in rows"
        :key="row.cell.id"
        class="card"
        :class="{ mortgaged: row.cell.isMortgaged }"
      >
        <div class="card-header" :style="{ background: row.cell.color || '#555' }">
          <span class="card-name">{{ row.cell.name }}</span>
          <span v-if="row.cell.isMortgaged" class="badge-mortgaged">В ЗАЛОГЕ</span>
        </div>
        <div class="card-body">
          <div class="card-row">
            <span class="label">Тип</span>
            <span class="value">
              <template v-if="row.cell.type === 'PROPERTY'">Участок</template>
              <template v-else-if="row.cell.type === 'RAILROAD'">Ж/д</template>
              <template v-else-if="row.cell.type === 'UTILITY'">Предприятие</template>
              <template v-else>{{ row.cell.type }}</template>
            </span>
          </div>
          <div class="card-row">
            <span class="label">Залог. стоимость</span>
            <span class="value">₽{{ row.cell.mortgageValue ?? 0 }}</span>
          </div>
          <div v-if="row.cell.isMortgaged" class="card-row">
            <span class="label">Цена выкупа</span>
            <span class="value highlight">₽{{ row.amount }}</span>
          </div>
        </div>
        <div class="card-action">
          <button
            v-if="row.action === 'mortgage'"
            class="action-btn btn-mortgage"
            :title="`Получить ₽${row.amount}`"
            @click="onAction(row)"
          >
            🔒 Заложить ₽{{ row.amount }}
          </button>
          <button
            v-else-if="row.action === 'unmortgage'"
            class="action-btn btn-unmortgage"
            :title="`Заплатить ₽${row.amount}`"
            @click="onAction(row)"
          >
            🔓 Выкупить ₽{{ row.amount }}
          </button>
          <button v-else class="action-btn btn-disabled" disabled :title="row.reason ?? ''">
            {{ row.cell.isMortgaged ? "🔓 Выкупить" : "🔒 Заложить" }}
          </button>
          <p v-if="row.reason" class="reason">{{ row.reason }}</p>
        </div>
      </div>
    </div>

    <!-- Сообщение об ошибке от сервера -->
    <div v-if="mortgage.lastError" class="error">❌ {{ mortgage.lastError }}</div>

    <!-- Кнопка закрытия -->
    <div class="modal-actions">
      <button class="action-btn btn-acknowledge" @click="onAcknowledge">ПРИНЯТЬ</button>
    </div>
  </Modal>
</template>

<style scoped>
.hint {
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-muted);
  margin: 0 0 14px;
  text-align: center;
}

.empty {
  text-align: center;
  padding: 24px 12px;
  color: var(--text-muted);
  font-size: 13px;
  font-style: italic;
}

.cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
  gap: 12px;
  max-height: 50vh;
  overflow-y: auto;
  padding: 4px;
}

.card {
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-sm);
  background: var(--surface-1);
  overflow: hidden;
  display: flex;
  flex-direction: column;
  transition: transform 0.15s ease;
}

.card.mortgaged {
  opacity: 0.85;
}

.card:hover {
  transform: translateY(-2px);
}

.card-header {
  padding: 8px 10px;
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

.badge-mortgaged {
  font-size: 9px;
  background: rgba(0, 0, 0, 0.45);
  padding: 2px 6px;
  border-radius: 6px;
  letter-spacing: 0.5px;
  flex-shrink: 0;
}

.card-body {
  padding: 10px;
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

.value.highlight {
  color: var(--gold);
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
}

.btn-mortgage {
  background: linear-gradient(135deg, #f5a623, #d4801f);
  color: #fff;
}

.btn-mortgage:hover {
  background: linear-gradient(135deg, #ffb84a, #e0943a);
  transform: translateY(-1px);
}

.btn-unmortgage {
  background: linear-gradient(135deg, var(--green), var(--accent));
  color: #fff;
}

.btn-unmortgage:hover {
  filter: brightness(1.1);
  transform: translateY(-1px);
}

.btn-disabled {
  background: var(--surface-3);
  color: var(--text-muted);
  cursor: not-allowed;
  opacity: 0.55;
}

.reason {
  margin: 0;
  font-size: 10px;
  color: var(--accent);
  text-align: center;
  line-height: 1.3;
}

.error {
  margin-top: 12px;
  padding: 10px 12px;
  background: rgba(255, 80, 80, 0.12);
  border: 1px solid var(--accent);
  border-radius: var(--radius-sm);
  color: var(--accent);
  font-size: 12px;
  text-align: center;
}

.modal-actions {
  display: flex;
  gap: 10px;
  margin-top: 16px;
  justify-content: center;
}

.btn-acknowledge {
  flex: 1;
  background: linear-gradient(135deg, var(--accent), var(--accent-2));
  color: #fff;
  padding: 12px 18px;
  border: none;
  border-radius: var(--radius-sm);
  font-weight: 700;
  font-size: 13px;
  letter-spacing: 0.5px;
  cursor: pointer;
  text-transform: uppercase;
  transition:
    filter 0.15s ease,
    transform 0.1s ease;
}

.btn-acknowledge:hover {
  filter: brightness(1.1);
  transform: translateY(-1px);
}
</style>
