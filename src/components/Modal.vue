<script setup lang="ts">
defineProps<{
  show: boolean;
  title?: string;
  subtitle?: string;
}>();

const emit = defineEmits<{
  (e: "close"): void;
}>();
</script>

<template>
  <div v-if="show" class="modal-overlay active" @click.self="emit('close')">
    <div class="modal">
      <button class="modal-close" @click="emit('close')">✕</button>
      <div v-if="title" class="modal-title">{{ title }}</div>
      <div v-if="subtitle" class="modal-subtitle">{{ subtitle }}</div>
      <slot />
    </div>
  </div>
</template>
