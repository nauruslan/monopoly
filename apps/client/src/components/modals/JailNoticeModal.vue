<script setup lang="ts">
import Modal from "../Modal.vue";

/**
 * Информационное модальное окно «Вы арестованы! Отправляйтесь в тюрьму!».
 *
 * Показывается в фазе JAIL_NOTICE в двух сценариях:
 *   1) Попадание на клетку 30 (GOTO_JAIL) — `reason="cell"`.
 *   2) Три дубля подряд (правило Монополии) — `reason="double"`.
 *   3) (Резерв) Карточка Шанс/Казна с эффектом goto-jail — `reason="card"`.
 *
 * По нажатию «ПРИНЯТЬ» эмитится `close` → GameView шлёт
 * `CONFIRM_JAIL_NOTICE` на сервер, после чего начинается
 * анимация фишки к клетке 10 (ТЮРЬМА).
 */
defineProps<{
  show: boolean;
  reason: "cell" | "card" | "double";
}>();

const emit = defineEmits<{
  (e: "close"): void;
}>();

/**
 * Подзаголовок-причина под главным текстом. Делает окно менее
 * абстрактным — игрок понимает, ПОЧЕМУ его арестовали.
 */
function reasonText(reason: "cell" | "card" | "double"): string {
  switch (reason) {
    case "cell":
      return "Вы попали на клетку «В тюрьму».";
    case "double":
      return "Вы выбросили три дубля подряд.";
    case "card":
    default:
      return "По карточке «Отправляйтесь в тюрьму».";
  }
}
</script>

<template>
  <Modal :show="show" @close="emit('close')">
    <div class="jail-notice-card">
      <div class="jail-icon">🚔</div>
      <div class="jail-type">ВНИМАНИЕ</div>
      <div class="jail-title">Вы арестованы!</div>
      <div class="jail-subtitle">Отправляйтесь в тюрьму.</div>
      <div class="jail-reason">{{ reasonText(reason) }}</div>
    </div>
    <div class="modal-actions">
      <button class="action-btn btn-accept" @click="emit('close')">ПРИНЯТЬ</button>
    </div>
  </Modal>
</template>

<style scoped>
.jail-notice-card {
  padding: 28px 20px 14px;
  text-align: center;
  border-radius: 14px;
  background: linear-gradient(160deg, #2b2f4a 0%, #14172a 100%);
  border: 2px solid #ff7a3c;
  margin: 6px 4px 14px;
  box-shadow: 0 14px 32px rgba(0, 0, 0, 0.35);
  color: #f6f6fb;
  position: relative;
  overflow: hidden;
}

/* Лёгкая «полосатая» фактура, ассоциирующаяся с тюрьмой. */
.jail-notice-card::before {
  content: "";
  position: absolute;
  inset: 0;
  background-image: repeating-linear-gradient(
    135deg,
    rgba(255, 255, 255, 0.04) 0 12px,
    rgba(255, 255, 255, 0) 12px 24px
  );
  pointer-events: none;
}

.jail-icon {
  font-size: 44px;
  line-height: 1;
  margin-bottom: 8px;
  position: relative;
}

.jail-type {
  font-size: 14px;
  font-weight: 700;
  letter-spacing: 1.6px;
  color: #ffb78c;
  text-transform: uppercase;
  margin-bottom: 6px;
  position: relative;
}

.jail-title {
  font-size: 26px;
  font-weight: 800;
  color: #ff7a3c;
  margin-bottom: 6px;
  position: relative;
}

.jail-subtitle {
  font-size: 18px;
  font-weight: 700;
  color: #ffe7d6;
  margin-bottom: 12px;
  position: relative;
}

.jail-reason {
  font-size: 14px;
  font-weight: 500;
  line-height: 1.5;
  color: #b9bdd6;
  position: relative;
}

.modal-actions {
  display: flex;
  justify-content: stretch;
  margin-top: 4px;
}

.action-btn.btn-accept {
  width: 100%;
  padding: 13px 16px;
  border: none;
  border-radius: var(--radius-sm, 8px);
  background: linear-gradient(135deg, #ff7a3c, #ff5e5e);
  color: #fff;
  font-weight: 700;
  font-size: 15px;
  letter-spacing: 0.6px;
  cursor: pointer;
  transition:
    transform 120ms ease,
    box-shadow 120ms ease;
}

.action-btn.btn-accept:hover {
  transform: translateY(-1px);
  box-shadow: 0 8px 20px rgba(0, 0, 0, 0.25);
}
</style>
