<script setup lang="ts">
defineProps<{
  canRoll: boolean;
  canBuy: boolean;
  canEndTurn: boolean;
  // флаг «выпал дубль, бросьте ещё раз» (правило дубля).
  mustRollAgain?: boolean;
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
    <div v-if="mustRollAgain" class="double-banner" role="status" aria-live="polite">
      🎯 Дубль! Бросьте кубики ещё раз.
    </div>
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
.double-banner {
  margin-bottom: 10px;
  padding: 8px 10px;
  background: linear-gradient(135deg, rgba(155, 109, 255, 0.25), rgba(255, 215, 0, 0.2));
  border: 1px solid rgba(155, 109, 255, 0.6);
  border-radius: 8px;
  color: #f5e9ff;
  font-size: 13px;
  font-weight: 600;
  text-align: center;
  animation: double-pulse 1.4s ease-in-out infinite;
}

@keyframes double-pulse {
  0%,
  100% {
    transform: scale(1);
    box-shadow: 0 0 0 0 rgba(155, 109, 255, 0.5);
  }
  50% {
    transform: scale(1.02);
    box-shadow: 0 0 0 6px rgba(155, 109, 255, 0);
  }
}

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
