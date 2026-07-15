<script setup lang="ts">
import { computed } from "vue";
import { storeToRefs } from "pinia";
import type { Player } from "@monopoly/shared";
import { useGameStore } from "../stores/game";

const props = defineProps<{
  players: Player[];
  currentPlayerId: string;
}>();

const game = useGameStore();
// берём `state` реактивно, чтобы индикатор «Думает…» обновлялся
// при смене `state.botThinking` (сервер рассылает его в `game:state`).
const { state } = storeToRefs(game);

const thinkingPlayerId = computed(() => state.value.botThinking?.playerId ?? null);
</script>

<template>
  <div class="panel">
    <div class="panel-title">Игроки</div>
    <div class="players-grid">
      <div
        v-for="p in players"
        :key="p.id"
        class="player-card"
        :class="{
          active: p.id === currentPlayerId,
          thinking: p.id === thinkingPlayerId,
        }"
        :style="{ '--player-color': p.color }"
      >
        <div class="player-header">
          <div class="player-avatar" :style="{ background: p.color }">
            {{ p.icon }}
          </div>
          <div class="player-name">
            {{ p.displayName }}
            <span v-if="p.inJail" class="jail-badge">🔒</span>
            <span v-if="p.kind === 'bot'" class="bot-badge">🤖</span>
          </div>
        </div>
        <div class="player-money">₽{{ p.money.toLocaleString() }}</div>
        <div class="player-money-bar">
          <div
            class="player-money-fill"
            :style="{ width: Math.min((p.money / 5000) * 100, 100) + '%' }"
          ></div>
        </div>
        <div class="player-props">Собственность: {{ p.properties.length }}</div>
        <!-- индикатор «Думает…» для бота в фазе BOT_THINKING. -->
        <div v-if="p.id === thinkingPlayerId" class="thinking-indicator" aria-live="polite">
          <span class="thinking-dots"> <span>.</span><span>.</span><span>.</span> </span>
          <span class="thinking-text">Думает</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.jail-badge,
.bot-badge {
  font-size: 11px;
  margin-left: 4px;
  opacity: 0.8;
}
/* подсветка карточки + анимированный индикатор «Думает…». */
.player-card.thinking {
  outline: 2px solid #9b6dff;
  outline-offset: 2px;
  animation: card-pulse 1.2s ease-in-out infinite;
}
.thinking-indicator {
  margin-top: 8px;
  padding: 4px 8px;
  background: rgba(155, 109, 255, 0.18);
  border: 1px solid rgba(155, 109, 255, 0.5);
  border-radius: 6px;
  font-size: 12px;
  display: flex;
  align-items: center;
  gap: 4px;
  color: #d6c6ff;
}
.thinking-dots {
  display: inline-flex;
  gap: 1px;
}
.thinking-dots span {
  animation: dot-blink 1.2s infinite;
  font-weight: bold;
}
.thinking-dots span:nth-child(2) {
  animation-delay: 0.2s;
}
.thinking-dots span:nth-child(3) {
  animation-delay: 0.4s;
}
.thinking-text {
  margin-left: 4px;
}
@keyframes dot-blink {
  0%,
  60%,
  100% {
    opacity: 0.2;
  }
  30% {
    opacity: 1;
  }
}
@keyframes card-pulse {
  0%,
  100% {
    box-shadow: 0 0 0 0 rgba(155, 109, 255, 0.4);
  }
  50% {
    box-shadow: 0 0 0 6px rgba(155, 109, 255, 0);
  }
}
</style>
