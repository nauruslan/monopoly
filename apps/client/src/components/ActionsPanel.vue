<script setup lang="ts">
import { reactive, computed } from "vue";

defineProps<{
  canRoll: boolean;
  canBuild: boolean;
  canEndTurn: boolean;
  canTrade: boolean;
  canMortgage: boolean;
}>();

const emit = defineEmits<{
  (e: "roll"): void;
  (e: "open-build"): void;
  (e: "end-turn"): void;
  (e: "open-trade"): void;
  (e: "open-mortgage"): void;
}>();

interface TooltipState {
  pinnedKey: string | null;
  activeKey: string | null;
  timer: number | null;
  pos: { top: number; left: number; width: number } | null;
}

const tip = reactive<TooltipState>({
  pinnedKey: null,
  activeKey: null,
  timer: null,
  pos: null,
});

/** Задержка появления тултипа: 1 секунда. */
const TOOLTIP_DELAY_MS = 1000;

function onEnter(e: MouseEvent | FocusEvent, key: string): void {
  tip.pinnedKey = key;
  const target = e.currentTarget as HTMLElement;
  const rect = target.getBoundingClientRect();
  tip.pos = {
    top: rect.top,
    left: rect.left + rect.width / 2,
    width: rect.width,
  };
  if (tip.timer !== null) window.clearTimeout(tip.timer);
  tip.timer = window.setTimeout(() => {
    if (tip.pinnedKey === key) {
      const r = (
        document.querySelector(`[data-tip-key="${key}"]`) as HTMLElement | null
      )?.getBoundingClientRect();
      if (r) {
        tip.pos = { top: r.top, left: r.left + r.width / 2, width: r.width };
      }
      tip.activeKey = key;
    }
    tip.timer = null;
  }, TOOLTIP_DELAY_MS);
}

function onLeave(): void {
  tip.pinnedKey = null;
  if (tip.timer !== null) {
    window.clearTimeout(tip.timer);
    tip.timer = null;
  }
  tip.activeKey = null;
  tip.pos = null;
}

const tooltipLabel = computed(() => {
  switch (tip.activeKey) {
    case "roll":
      return "Бросить кубики";
    case "build":
      return "Строить";
    case "trade":
      return "Торговля";
    case "mortgage":
      return "Залог / Выкуп";
    case "end":
      return "Завершить ход";
    default:
      return "";
  }
});
</script>

<template>
  <div class="actions-wrap">
    <div class="actions">
      <button
        class="action-btn"
        data-tip-key="roll"
        :class="{ active: tip.activeKey === 'roll' }"
        :disabled="!canRoll"
        :aria-label="'Бросить кубики'"
        @click="emit('roll')"
        @mouseenter="onEnter($event, 'roll')"
        @mouseleave="onLeave"
        @focus="onEnter($event, 'roll')"
        @blur="onLeave"
      >
        <span class="btn-icon">🎲</span>
      </button>

      <button
        class="action-btn"
        data-tip-key="build"
        :class="{ active: tip.activeKey === 'build' }"
        :disabled="!canBuild"
        :aria-label="'Строить'"
        @click="emit('open-build')"
        @mouseenter="onEnter($event, 'build')"
        @mouseleave="onLeave"
        @focus="onEnter($event, 'build')"
        @blur="onLeave"
      >
        <span class="btn-icon">🏗️</span>
      </button>

      <button
        class="action-btn"
        data-tip-key="trade"
        :class="{ active: tip.activeKey === 'trade' }"
        :disabled="!canTrade"
        :aria-label="'Торговля'"
        @click="emit('open-trade')"
        @mouseenter="onEnter($event, 'trade')"
        @mouseleave="onLeave"
        @focus="onEnter($event, 'trade')"
        @blur="onLeave"
      >
        <span class="btn-icon">🤝</span>
      </button>

      <button
        class="action-btn"
        data-tip-key="mortgage"
        :class="{ active: tip.activeKey === 'mortgage' }"
        :disabled="!canMortgage"
        :aria-label="'Залог/Выкуп'"
        @click="emit('open-mortgage')"
        @mouseenter="onEnter($event, 'mortgage')"
        @mouseleave="onLeave"
        @focus="onEnter($event, 'mortgage')"
        @blur="onLeave"
      >
        <span class="btn-icon">🏦</span>
      </button>

      <button
        class="action-btn"
        data-tip-key="end"
        :class="{ active: tip.activeKey === 'end' }"
        :disabled="!canEndTurn"
        :aria-label="'Завершить ход'"
        @click="emit('end-turn')"
        @mouseenter="onEnter($event, 'end')"
        @mouseleave="onLeave"
        @focus="onEnter($event, 'end')"
        @blur="onLeave"
      >
        <span class="btn-icon">✅</span>
      </button>
    </div>

    <Teleport to="body">
      <div
        v-if="tip.activeKey && tip.pos"
        class="floating-tip"
        :style="{
          top: tip.pos.top + 'px',
          left: tip.pos.left + 'px',
        }"
      >
        {{ tooltipLabel }}
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.actions-wrap {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  width: 100%;
  background: transparent;
  border: none;
  padding: 0;
  min-height: 0;
  min-width: 0;
}

.actions {
  display: inline-flex;
  justify-content: center;
  align-items: center;
  flex-wrap: nowrap;
  gap: 10px;
  margin: 0 auto;
}

.action-btn {
  position: relative;
  flex: 0 0 auto;
  width: 80px;
  height: 80px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  margin: 0;
  background: transparent;
  border: none;
  border-radius: 10px;
  cursor: pointer;
  font-family: inherit;
  transition: none;
  transform: none !important;
  vertical-align: top;
  min-height: 0;
  min-width: 0;
}

.action-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.btn-icon {
  font-size: 36px;
  line-height: 1;
  width: 80px;
  height: 80px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin: 0;
  padding: 0;
  color: rgba(245, 233, 255, 0.85);
  transform: none !important;
}

.action-btn:not(:disabled):hover .btn-icon {
  color: #ffd86b;
}
.action-btn:not(:disabled):active .btn-icon,
.action-btn.active .btn-icon {
  color: #ffffff;
}

.floating-tip {
  position: fixed;
  transform: translate(-50%, calc(-100% - 10px));
  padding: 5px 10px;
  background: rgba(15, 8, 35, 0.95);
  border: 1px solid rgba(149, 114, 218, 0.6);
  border-radius: 6px;
  color: #f5e9ff;
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  pointer-events: none;
  z-index: 9999;
  box-shadow: 0 6px 16px rgba(0, 0, 0, 0.5);
  animation: floatingTipIn 0.15s ease-out;
}

.floating-tip::after {
  content: "";
  position: absolute;
  top: 100%;
  left: 50%;
  transform: translateX(-50%);
  border: 5px solid transparent;
  border-top-color: rgba(149, 114, 218, 0.6);
}

@keyframes floatingTipIn {
  from {
    opacity: 0;
    transform: translate(-50%, calc(-100% - 6px));
  }
  to {
    opacity: 1;
    transform: translate(-50%, calc(-100% - 10px));
  }
}
</style>
