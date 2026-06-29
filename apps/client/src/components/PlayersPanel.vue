<script setup lang="ts">
import type { Player } from "@monopoly/shared";

defineProps<{
  players: Player[];
  currentPlayerId: string;
}>();
</script>

<template>
  <div class="panel">
    <div class="panel-title">Игроки</div>
    <div class="players-grid">
      <div
        v-for="p in players"
        :key="p.id"
        class="player-card"
        :class="{ active: p.id === currentPlayerId }"
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
</style>
