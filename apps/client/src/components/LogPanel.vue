<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, nextTick, watch } from "vue";
import { getSocket } from "../composables/useSocket";
import { useGameStore } from "../stores/game";
import type { GameEvent } from "@monopoly/shared";

/**
 * Журнал событий
 *
 * Подписывается на `game:event` (broadcast из Gateway) и рисует
 * последние 60 событий с автоматической прокруткой вниз. При
 * `lobby:join` / `reconnect:request_state` наполняется из
 * `state.events` (присылается в snapshot).
 */
const game = useGameStore();
const events = ref<GameEvent[]>([]);
const listEl = ref<HTMLElement | null>(null);

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString("ru-RU", {
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

function addEntry(e: GameEvent) {
  events.value = [...events.value, e].slice(-60);
  void nextTick(() => {
    if (listEl.value) {
      listEl.value.scrollTop = listEl.value.scrollHeight;
    }
  });
}

// При получении state с сервера (lobby:join / reconnect:request_state)
// заполняем журнал из `state.events`. Дальнейшие обновления приходят
// через `game:event`.
watch(
  () => game.state.events,
  (newEvents) => {
    if (newEvents && newEvents.length > 0) {
      // Берём последние 60 (на случай если snapshot большой).
      events.value = newEvents.slice(-60);
    }
  },
  { immediate: true },
);

onMounted(() => {
  const socket = getSocket();
  if (!socket) return;
  socket.on("game:event", addEntry);
});

onBeforeUnmount(() => {
  const socket = getSocket();
  if (!socket) return;
  socket.off("game:event", addEntry);
});
</script>

<template>
  <div class="panel log-panel">
    <div class="panel-title">Журнал</div>
    <div class="log-list" ref="listEl">
      <div v-if="events.length === 0" class="log-entry log-empty">🎮 Ожидание событий...</div>
      <div
        v-for="e in events"
        :key="e.id"
        class="log-entry"
        :class="e.type"
        :data-time="formatTime(e.at)"
      >
        <span class="log-time">{{ formatTime(e.at) }}</span>
        <span v-html="e.message"></span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.log-panel {
  max-height: 260px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
.log-list {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
  scrollbar-width: thin;
}
.log-entry {
  font-size: 12px;
  padding: 4px 6px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.03);
  display: flex;
  gap: 8px;
  color: var(--text, #fff);
}
.log-empty {
  opacity: 0.6;
  font-style: italic;
}
.log-entry.move {
  background: rgba(155, 109, 255, 0.1);
}
.log-entry.rent {
  background: rgba(255, 100, 100, 0.1);
}
.log-entry.buy {
  background: rgba(100, 255, 150, 0.1);
}
.log-entry.chance {
  background: rgba(255, 200, 100, 0.1);
}
.log-entry.win {
  background: rgba(255, 215, 0, 0.2);
  font-weight: bold;
}
.log-time {
  opacity: 0.5;
  font-size: 10px;
  flex-shrink: 0;
}
</style>
