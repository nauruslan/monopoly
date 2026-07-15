<script setup lang="ts">
import Modal from "../Modal.vue";

/**
 * Универсальная модалка для карточек Шанс / Общественная казна / Роскошный налог.
 *
 * Отображает заголовок в зависимости от `deck`:
 *   - "chance"      → "❓ Шанс"
 *   - "treasury"    → "🏛️ Казна"
 *   - "luxury-tax"  → "💎 Роскошный налог"
 *
 * Закрытие модалки приводит к отправке `CONFIRM_CARD`
 * Сам эффект карты применяется ТОЛЬКО после закрытия (на сервере).
 */
defineProps<{
  show: boolean;
  cardText: string;
  deck: "chance" | "treasury" | "luxury-tax";
}>();

const emit = defineEmits<{
  (e: "close"): void;
}>();
</script>

<template>
  <Modal :show="show" @close="emit('close')">
    <div
      class="chance-card-display"
      :class="{
        treasury: deck === 'treasury',
        'luxury-tax': deck === 'luxury-tax',
      }"
    >
      <div class="card-type">
        <template v-if="deck === 'chance'">❓ Шанс</template>
        <template v-else-if="deck === 'treasury'">🏛️ Казна</template>
        <template v-else>💎 Роскошный налог</template>
      </div>
      <div class="card-text">{{ cardText }}</div>
    </div>
    <div class="modal-actions">
      <button class="action-btn btn-roll" @click="emit('close')">OK</button>
    </div>
  </Modal>
</template>

<style scoped>
.chance-card-display {
  padding: 28px 20px 12px;
  text-align: center;
  border-radius: 14px;
  background: linear-gradient(160deg, #fff8e0 0%, #ffe7a8 100%);
  border: 2px solid #f0b400;
  margin: 6px 4px 14px;
  box-shadow: 0 12px 28px rgba(0, 0, 0, 0.18);
}
.chance-card-display.treasury {
  background: linear-gradient(160deg, #e7f2ff 0%, #c1d8ff 100%);
  border-color: #4a90e2;
}
.chance-card-display.luxury-tax {
  background: linear-gradient(160deg, #ffe5f1 0%, #ffc1de 100%);
  border-color: #d63384;
}
.card-type {
  font-size: 22px;
  font-weight: 800;
  margin-bottom: 14px;
  letter-spacing: 0.4px;
  color: #4a2c00;
}
.chance-card-display.treasury .card-type {
  color: #1f3d6b;
}
.chance-card-display.luxury-tax .card-type {
  color: #802057;
}
.card-text {
  font-size: 16px;
  line-height: 1.5;
  font-weight: 500;
  color: #2d1a00;
  white-space: pre-line;
}
.chance-card-display.treasury .card-text {
  color: #11254a;
}
.chance-card-display.luxury-tax .card-text {
  color: #4a0d2d;
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
