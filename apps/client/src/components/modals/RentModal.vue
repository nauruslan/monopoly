<script setup lang="ts">
import Modal from "../Modal.vue";

defineProps<{
  show: boolean;
  /** Сумма аренды. */
  amount: number;
  /** Имя владельца клетки. */
  ownerName?: string;
  /** Название клетки, на которую приземлился игрок (например, «Арбат»). */
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
    <div class="rent-display">
      <div class="rent-icon">🏠</div>
      <div class="rent-title">{{ cellName ?? "Чужая собственность" }}</div>
      <div class="rent-amount">Заплатите аренду {{ amount }}₽</div>
      <div v-if="ownerName" class="rent-owner">
        Владелец: <strong>{{ ownerName }}</strong>
      </div>
      <div v-if="money !== undefined" class="rent-hint">
        На вашем счету: <strong>{{ money }}₽</strong>
        <span v-if="money < amount" class="warn"> — не хватает, придётся заложить имущество.</span>
      </div>
    </div>
    <div class="modal-actions">
      <button class="action-btn btn-pay" @click="emit('close')">Оплатить</button>
    </div>
  </Modal>
</template>

<style scoped>
.rent-display {
  text-align: center;
  padding: 24px 18px 8px;
}
.rent-icon {
  font-size: 64px;
  margin-bottom: 8px;
  filter: drop-shadow(0 4px 10px rgba(0, 0, 0, 0.25));
}
.rent-title {
  font-size: 18px;
  font-weight: 700;
  margin-bottom: 6px;
  color: var(--fg, #1d1d28);
}
.rent-amount {
  font-size: 26px;
  font-weight: 800;
  background: linear-gradient(135deg, var(--accent, #ff5e5e), var(--accent2, #ff9a3c));
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  margin-bottom: 6px;
}
.rent-owner {
  font-size: 14px;
  color: #5a5a6a;
  margin-bottom: 10px;
}
.rent-owner strong {
  color: #1d1d28;
}
.rent-hint {
  font-size: 13px;
  color: #5a5a6a;
}
.rent-hint strong {
  color: #1d1d28;
}
.rent-hint .warn {
  color: #c33;
  font-weight: 600;
}

.action-btn.btn-pay {
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
.action-btn.btn-pay:hover {
  transform: translateY(-1px);
  box-shadow: 0 8px 20px rgba(0, 0, 0, 0.15);
}
</style>
