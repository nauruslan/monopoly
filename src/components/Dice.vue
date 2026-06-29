<script setup lang="ts">
// Заглушка — полная реализация позже
defineProps<{
  values: [number, number];
  rolling: boolean;
}>();
</script>

<template>
  <div class="dice-stub">🎲 {{ values[0] }} + {{ values[1] }}</div>
</template>

<style scoped>
.dice-stub {
  margin-top: 16px;
  font-size: 20px;
  font-weight: 600;
  color: var(--neon-cyan, #4d9eff);
  letter-spacing: 2px;
  opacity: 0.8;
}
</style>
