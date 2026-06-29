<script setup lang="ts">
defineProps<{
  canRoll: boolean;
  canBuy: boolean;
  canEndTurn: boolean;
}>();

const emit = defineEmits<{
  (e: "roll"): void;
  (e: "buy"): void;
  (e: "end-turn"): void;
}>();
</script>

<template>
  <div class="panel">
    <div class="panel-title">Действия</div>
    <div class="actions">
      <button class="action-btn btn-roll" :disabled="!canRoll" @click="emit('roll')">
        🎲 Бросить кубики
      </button>
      <button class="action-btn btn-buy" :disabled="!canBuy" @click="emit('buy')">🏠 Купить</button>
      <button class="action-btn btn-end" :disabled="!canEndTurn" @click="emit('end-turn')">
        ✅ Завершить
      </button>
    </div>
  </div>
</template>

<style scoped>
.actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.action-btn {
  flex: 1;
  min-width: 100px;
  padding: 13px 16px;
  border: none;
  border-radius: var(--radius-sm);
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
  text-transform: uppercase;
  letter-spacing: 1px;
  transition: all 0.25s var(--ease-out);
}

.action-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.btn-roll {
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  color: #fff;
  flex: 2;
  font-size: 13px;
}

.btn-buy {
  background: linear-gradient(135deg, var(--green), var(--accent));
  color: #fff;
}

.btn-end {
  background: linear-gradient(135deg, var(--accent2), var(--accent3));
  color: #fff;
}
</style>
