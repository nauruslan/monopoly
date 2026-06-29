<script setup lang="ts">
import Modal from "../Modal.vue";
import type { Cell } from "../../types/cell";

defineProps<{
  show: boolean;
  cell: Cell | null;
  money: number;
}>();

const emit = defineEmits<{
  (e: "close"): void;
  (e: "confirm"): void;
  (e: "decline"): void;
}>();
</script>

<template>
  <Modal :show="show" title="🏠 Купить" :subtitle="cell?.name" @close="emit('close')">
    <div v-if="cell" class="property-card">
      <div class="property-card-header" :style="{ background: cell.color || '#555' }">
        {{ cell.name }}
      </div>
      <div class="property-card-body">
        <div class="property-detail">
          <span class="label">Цена</span>
          <span class="value">₽{{ cell.price }}</span>
        </div>
        <div class="property-detail">
          <span class="label">Аренда</span>
          <span class="value">₽{{ cell.rent }}</span>
        </div>
        <div class="property-detail">
          <span class="label">Залог</span>
          <span class="value">₽{{ cell.mortgageValue }}</span>
        </div>
      </div>
    </div>

    <div class="balance-info">
      Баланс:
      <span class="balance-amount">₽{{ money.toLocaleString() }}</span>
      <span v-if="cell && cell.price !== undefined && money < cell.price" class="no-money"
        >❌ Недостаточно средств!</span
      >
    </div>

    <div class="modal-actions">
      <button
        class="action-btn btn-buy"
        :disabled="!cell || cell.price === undefined || money < cell.price"
        @click="emit('confirm')"
      >
        Купить ₽{{ cell?.price }}
      </button>
      <button class="action-btn btn-cancel" @click="emit('decline')">Пропустить</button>
    </div>
  </Modal>
</template>

<style scoped>
.balance-info {
  font-size: 12px;
  margin-bottom: 16px;
}

.balance-amount {
  color: var(--gold);
  font-weight: 700;
}

.no-money {
  display: block;
  color: var(--accent);
  margin-top: 4px;
}

.btn-buy {
  background: linear-gradient(135deg, var(--green), var(--accent));
  color: #fff;
  flex: 2;
  padding: 13px 16px;
  border: none;
  border-radius: var(--radius-sm);
  font-weight: 700;
  cursor: pointer;
  text-transform: uppercase;
}

.btn-buy:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.btn-cancel {
  background: var(--surface-3);
  color: var(--text);
  border: 1px solid var(--glass-border);
  flex: 1;
  padding: 13px 16px;
  border-radius: var(--radius-sm);
  font-weight: 700;
  cursor: pointer;
}
</style>
