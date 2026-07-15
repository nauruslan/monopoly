<script setup lang="ts">
import Modal from "../Modal.vue";

defineProps<{
  show: boolean;
  /** Сумма фиксированного налога. */
  amount: number;
  /** Название клетки (например, «Подоходный налог»). */
  cellName?: string;
  /** Текущий баланс игрока (для подсказки «может не хватить»). */
  money?: number;
}>();

const emit = defineEmits<{
  (e: "close"): void;
}>();
</script>

<template>
  <Modal :show="show" @close="emit('close')">
    <div class="tax-display">
      <div class="tax-icon">💰</div>
      <div class="tax-title">{{ cellName ?? "Налог" }}</div>
      <div class="tax-amount">Заплатите {{ amount }}₽</div>
      <div v-if="money !== undefined" class="tax-hint">
        На вашем счету: <strong>{{ money }}₽</strong>
        <span v-if="money < amount" class="warn"> — не хватает, придётся заложить имущество.</span>
      </div>
    </div>
    <div class="modal-actions">
      <button class="action-btn btn-roll" @click="emit('close')">ОК</button>
    </div>
  </Modal>
</template>

<style scoped>
.tax-display {
  text-align: center;
  padding: 24px 18px 8px;
}
.tax-icon {
  font-size: 64px;
  margin-bottom: 8px;
  filter: drop-shadow(0 4px 10px rgba(0, 0, 0, 0.25));
}
.tax-title {
  font-size: 18px;
  font-weight: 700;
  margin-bottom: 6px;
  color: var(--fg, #1d1d28);
}
.tax-amount {
  font-size: 28px;
  font-weight: 800;
  background: linear-gradient(135deg, var(--accent, #ff5e5e), var(--accent2, #ff9a3c));
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  margin-bottom: 10px;
}
.tax-hint {
  font-size: 14px;
  color: #5a5a6a;
}
.tax-hint strong {
  color: #1d1d28;
}
.tax-hint .warn {
  color: #c33;
  font-weight: 600;
}

.action-btn.btn-roll {
  width: 100%;
  padding: 13px 16px;
  border: none;
  border-radius: var(--radius-sm, 8px);
  background: linear-gradient(135deg, var(--accent, #ff5e5e), var(--accent2, #ff9a3c));
  color: #fff;
  font-weight: 700;
  font-size: 15px;
  cursor: pointer;
  transition:
    transform 120ms ease,
    box-shadow 120ms ease;
}
.action-btn.btn-roll:hover {
  transform: translateY(-1px);
  box-shadow: 0 8px 20px rgba(0, 0, 0, 0.15);
}
</style>
