<script setup lang="ts">
import { ref, watch, nextTick, computed, onMounted, onBeforeUnmount } from "vue";
import { useGameStore } from "../stores/game";
import type { GameEvent } from "@monopoly/shared";

/**
 * Журнал событий (полная история партии).
 *
 * Источник истины — `state.events` (массив на сервере, входит в
 * snapshot `GameState`). На каждое обновление `game:state` клиент
 * получает свежий `state.events`, и мы добавляем только НОВЫЕ
 * события (по `id`) — без перезаписи и без дублирования.
 *
 * Подписка на `game:event` НЕ используется, потому что эти же
 * события уже лежат в `state.events` и в snapshot'е после каждого
 * applyAction — watcher на state.events покрывает оба пути.
 *
 * ВАЖНО:
 *  - Журнал хранит ВСЕ события партии (без удаления и без
 *    ограничения количества). На сервере `state.events` — это
 *    «журнал правды» без кольцевой обрезки, поэтому мы просто
 *    отображаем всё, что в нём лежит.
 *  - В `events.value` (локальный массив) мы кладём только
 *    инкрементальные добавления (новые `id`), а полную перезапись
 *    делаем только при первом запуске (или при реконнекте).
 *  - Для оптимизации отрисовки большого числа строк список
 *    `log-list` имеет `overflow-y: auto` и достаточно высокий
 *    `max-height`; при необходимости в будущем можно подключить
 *    виртуализацию (vue-virtual-scroller), но сейчас задача —
 *    «показать все события партии» решается стандартным списком
 *    (браузеры спокойно рендерят тысячи DOM-узлов).
 */
const game = useGameStore();
const events = ref<GameEvent[]>([]);
const listEl = ref<HTMLElement | null>(null);
// Map «id события → событие» для быстрой проверки дубликатов.
const seenIds = new Set<string>();

// Статистика для UI (в шапке панели).
const totalEvents = computed(() => events.value.length);

// Формат времени события (часы:минуты).
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

// Прокручиваем список к самой свежей записи (вниз).
function scrollToBottom() {
  void nextTick(() => {
    if (listEl.value) {
      listEl.value.scrollTop = listEl.value.scrollHeight;
    }
  });
}

// Резолвим имя игрока и его kind (human/bot) по id из текущего `state`.
function playerName(id: string | undefined): string {
  if (!id) return "?";
  const p = game.state.players.find((pl) => pl.id === id);
  return p?.displayName ?? "?";
}
function playerKindClass(id: string | undefined): "log-player-human" | "log-player-bot" {
  if (!id) return "log-player-human";
  const p = game.state.players.find((pl) => pl.id === id);
  return p?.kind === "bot" ? "log-player-bot" : "log-player-human";
}

/**
 * Реактивный watcher на `state.events`.
 *
 * Логика:
 *  1) Если `events.value` пуст (первый запуск) — кладём ВСЕ события
 *     из snapshot (без лимита).
 *  2) Инкрементальные добавления: ищем новые события по `id` и
 *     добавляем их в конец массива. Храним `seenIds`, чтобы
 *     избежать дублирования при реконнекте / повторном получении
 *     `game:state`.
 *  3) Если последнее известное событие исчезло (например, при
 *     полной перезагрузке state из-за bot-snapshot) — перезагружаем
 *     журнал целиком.
 *
 * ВАЖНО: события НИКОГДА не удаляются из `events.value`. По ТЗ
 * журнал должен показывать ВСЮ историю партии, включая «все
 * сообщения за игру, а не последние сколько-то — все и ничто
 * удаляться не должно».
 */
watch(
  () => game.state.events,
  (newEvents) => {
    if (!newEvents || newEvents.length === 0) {
      events.value = [];
      seenIds.clear();
      return;
    }
    // Первая инициализация (или сброс): берём ВСЕ события из snapshot.
    if (events.value.length === 0) {
      events.value = [...newEvents];
      seenIds.clear();
      newEvents.forEach((e) => seenIds.add(e.id));
      scrollToBottom();
      return;
    }
    // Инкрементальное добавление: только те, что новее последнего
    // известного события в локальном массиве.
    const lastId = events.value[events.value.length - 1]?.id;
    const lastIdx = lastId ? newEvents.findIndex((e) => e.id === lastId) : -1;
    // Если последнее известное событие исчезло из state — перезагружаем
    // журнал целиком (защита от редких race-условий).
    if (lastIdx === -1 && events.value.length > 0) {
      events.value = [...newEvents];
      seenIds.clear();
      newEvents.forEach((e) => seenIds.add(e.id));
      scrollToBottom();
      return;
    }
    // Добавляем только события, которых ещё нет в нашем множестве.
    const additions: GameEvent[] = [];
    for (let i = lastIdx + 1; i < newEvents.length; i++) {
      const e = newEvents[i];
      if (e && !seenIds.has(e.id)) {
        seenIds.add(e.id);
        additions.push(e);
      }
    }
    if (additions.length > 0) {
      events.value = [...events.value, ...additions];
      scrollToBottom();
    }
  },
  { immediate: true, deep: true },
);

onMounted(() => {
  // Намеренно НЕ подписываемся на socket.on("game:event") —
  // все события попадают в журнал через state.events.
});
onBeforeUnmount(() => {
  // no-op: подписок на сокет не было.
});
</script>

<template>
  <div class="panel log-panel">
    <div class="panel-title">
      Журнал
      <span class="log-counter">({{ totalEvents }})</span>
    </div>
    <div class="log-list" ref="listEl">
      <div v-if="events.length === 0" class="log-entry log-empty">🎮 Ожидание событий...</div>
      <div v-for="e in events" :key="e.id" class="log-entry" :class="e.type">
        <span class="log-time">{{ formatTime(e.at) }}</span>
        <span class="log-message">
          <span
            v-if="e.playerId && playerName(e.playerId) !== '?'"
            class="log-player"
            :class="playerKindClass(e.playerId)"
            >{{ playerName(e.playerId) }}</span
          >
          <span v-html="e.message"></span>
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.log-panel {
  max-height: 360px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
.log-panel .panel-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.log-counter {
  font-size: 11px;
  opacity: 0.7;
  font-weight: normal;
  margin-left: auto;
}
.log-list {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
  scrollbar-width: thin;
  /* Дополнительный max-height на случай длинного журнала — клиент
     видит старые сообщения скроллом наверх. */
  max-height: 320px;
}
.log-entry {
  font-size: 12px;
  padding: 4px 6px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.03);
  display: flex;
  align-items: center;
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
.log-entry.tax {
  background: rgba(255, 140, 0, 0.12);
}
.log-entry.auction {
  background: rgba(150, 100, 255, 0.12);
}
.log-entry.pass {
  background: rgba(120, 120, 120, 0.12);
  opacity: 0.85;
}
.log-entry.trade {
  background: rgba(80, 200, 255, 0.12);
}
.log-entry.jail {
  background: rgba(200, 80, 80, 0.12);
}
.log-entry.system {
  background: rgba(255, 255, 255, 0.04);
  opacity: 0.9;
}
.log-time {
  opacity: 0.5;
  font-size: 10px;
  flex-shrink: 0;
  line-height: 1.4;
}
.log-message {
  flex: 1;
  line-height: 1.4;
}
.log-player {
  font-weight: 600;
  padding: 0 4px;
  border-radius: 3px;
  margin-right: 4px;
  font-size: 11px;
}
.log-player-human {
  background: rgba(80, 200, 255, 0.2);
  color: #8cdcff;
}
.log-player-bot {
  background: rgba(255, 130, 80, 0.2);
  color: #ffb380;
}
</style>
