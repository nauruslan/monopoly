<script setup lang="ts">
const props = defineProps<{
  show: boolean;
  title?: string;
  subtitle?: string;
  /**
   * Можно ли закрыть модалку через ✕ или клик по оверлею.
   * По умолчанию `true`. Если `false` — модалка закрывается только изнутри
   * (например, через кнопку «Принять» в `TradeModal.vue` на экране
   * уведомления о результате сделки).
   */
  closable?: boolean;
}>();

const emit = defineEmits<{
  (e: "close"): void;
}>();

function onOverlayClick() {
  if (props.closable === false) return;
  emit("close");
}
</script>

<template>
  <div v-if="show" class="modal-overlay active" @click.self="onOverlayClick">
    <div class="modal">
      <button
        v-if="closable !== false"
        class="modal-close"
        @click="emit('close')"
        aria-label="Закрыть"
      >
        ✕
      </button>
      <div v-if="title" class="modal-title">{{ title }}</div>
      <div v-if="subtitle" class="modal-subtitle">{{ subtitle }}</div>
      <slot />
    </div>
  </div>
</template>
