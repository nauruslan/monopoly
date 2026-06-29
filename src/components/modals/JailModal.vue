<script setup lang="ts">
import Modal from "../Modal.vue";

defineProps<{
  show: boolean;
  jailCards: number;
  money: number;
}>();

const emit = defineEmits<{
  (e: "pay"): void;
  (e: "use-card"): void;
  (e: "try-double"): void;
  (e: "close"): void;
}>();
</script>

<template>
  <Modal :show="show" title="🔒 Тюрьма" subtitle="Выберите способ выхода" @close="emit('close')">
    <p style="margin-bottom: 16px; font-size: 13px">Вы можете выйти из тюрьмы тремя способами:</p>

    <div class="modal-actions" style="flex-direction: column">
      <button class="action-btn btn-buy" :disabled="money < 50" @click="emit('pay')">
        💸 Заплатить ₽50
      </button>
      <button class="action-btn btn-buy" :disabled="jailCards === 0" @click="emit('use-card')">
        🎫 Использовать карточку ({{ jailCards }})
      </button>
      <button class="action-btn btn-roll" @click="emit('try-double')">
        🎲 Попробовать выбросить дубль
      </button>
    </div>
  </Modal>
</template>

<style scoped>
.action-btn {
  width: 100%;
  margin-bottom: 8px;
  padding: 14px;
  border: none;
  border-radius: var(--radius-sm);
  font-weight: 700;
  cursor: pointer;
}
.btn-buy {
  background: linear-gradient(135deg, var(--green), var(--accent));
  color: #fff;
}
.btn-roll {
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  color: #fff;
}
.action-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
</style>
