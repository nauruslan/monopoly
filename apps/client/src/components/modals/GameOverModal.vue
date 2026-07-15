<script setup lang="ts">
import { computed } from "vue";
import { useRouter } from "vue-router";
import { useGameStore } from "../../stores/game";

const game = useGameStore();
const router = useRouter();

const winner = computed(() => {
  if (game.state.status !== "finished" || !game.state.winnerId) return null;
  return game.state.players.find((p) => p.id === game.state.winnerId) ?? null;
});

const isCurrentPlayerWinner = computed(() => {
  return winner.value?.kind === "human";
});

function playAgain() {
  // Кнопка "сыграть ещё" → lobby:create
  router.push("/lobby");
}
</script>

<template>
  <div v-if="game.state.status === 'finished'" class="modal-overlay">
    <div class="modal">
      <h2>🏁 Партия окончена!</h2>
      <p v-if="winner">
        Победитель:
        <strong :style="{ color: winner.color }">
          {{ winner.displayName }} {{ winner.icon }}
        </strong>
      </p>
      <p v-else>Партия завершена.</p>
      <p v-if="isCurrentPlayerWinner">🎉 Поздравляем!</p>
      <p v-else-if="winner">Не расстраивайся — в следующий раз повезёт!</p>
      <button @click="playAgain">Сыграть ещё</button>
    </div>
  </div>
</template>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.7);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  backdrop-filter: blur(4px);
}
.modal {
  background: var(--bg1, #1a1a2e);
  border: 2px solid #ffd700;
  border-radius: 12px;
  padding: 32px 48px;
  text-align: center;
  max-width: 480px;
  color: var(--text, #fff);
  box-shadow: 0 12px 48px rgba(0, 0, 0, 0.5);
}
.modal h2 {
  margin: 0 0 16px;
  font-size: 24px;
}
.modal p {
  margin: 8px 0;
  font-size: 14px;
}
.modal strong {
  font-size: 18px;
}
button {
  margin-top: 20px;
  padding: 12px 32px;
  background: #ffd700;
  color: #000;
  border: none;
  border-radius: 6px;
  font-size: 16px;
  font-weight: bold;
  cursor: pointer;
  transition: background 0.2s;
}
button:hover {
  background: #ffed4e;
}
</style>
