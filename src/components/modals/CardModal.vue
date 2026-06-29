<script setup lang="ts">
import Modal from "../Modal.vue";

defineProps<{
  show: boolean;
  cardText: string;
  isTreasury: boolean;
}>();

const emit = defineEmits<{
  (e: "close"): void;
}>();
</script>

<template>
  <Modal :show="show" @close="emit('close')">
    <div class="chance-card-display" :class="{ treasury: isTreasury }">
      <div class="card-type">
        {{ isTreasury ? "🏛️ Казна" : "❓ Шанс" }}
      </div>
      <div class="card-text">{{ cardText }}</div>
    </div>
    <div class="modal-actions">
      <button class="action-btn btn-roll" @click="emit('close')">OK</button>
    </div>
  </Modal>
</template>

<style scoped>
.action-btn.btn-roll {
  width: 100%;
  padding: 13px 16px;
  border: none;
  border-radius: var(--radius-sm);
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  color: #fff;
  font-weight: 700;
  cursor: pointer;
}
</style>
