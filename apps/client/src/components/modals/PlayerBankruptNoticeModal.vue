<script setup lang="ts">
/**
 * PlayerBankruptNoticeModal — глобальное уведомление для всех клиентов.
 *
 * когда любой игрок объявляет себя банкротом, ВСЕ клиенты
 * (и сам банкрот, и остальные) должны увидеть нон-блокирующее
 * уведомление "Игрок [Имя] обанкротился!" с указанием причины
 * (кому или Банку).
 *
 * Это read-only модалка — без действий, только информация.
 * Закрывается автоматически через 3 секунды или по клику вне модалки.
 */
import { computed, onUnmounted, ref, watch } from "vue";
import Modal from "../Modal.vue";

const props = defineProps<{
  show: boolean;
  /** Имя обанкротившегося игрока. */
  playerName: string;
  /** Имя кредитора (кому перешли активы), либо null (Банк). */
  creditorName: string | null;
}>();

const emit = defineEmits<{
  (e: "close"): void;
}>();

const remaining = ref(3);
let timer: ReturnType<typeof setInterval> | null = null;

const creditorText = computed(() => {
  if (props.creditorName) {
    return `Активы переданы игроку «${props.creditorName}»`;
  }
  return "Активы возвращены Банку";
});

function clear() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

function close() {
  clear();
  remaining.value = 3;
  emit("close");
}

watch(
  () => props.show,
  (v) => {
    clear();
    if (v) {
      remaining.value = 3;
      timer = setInterval(() => {
        remaining.value -= 1;
        if (remaining.value <= 0) {
          clear();
          emit("close");
        }
      }, 1000);
    }
  },
);

onUnmounted(clear);
</script>

<template>
  <Modal
    :show="show"
    title="💀 Банкротство!"
    :subtitle="`Игрок «${playerName}» выбыл из партии`"
    :closable="true"
    @close="close"
  >
    <div class="bankrupt-notice">
      <div class="big-icon">💀</div>
      <p class="message">
        Игрок <strong>{{ playerName }}</strong> обанкротился и выбывает из партии.
      </p>
      <p class="creditor">{{ creditorText }}</p>
      <p class="auto-close">Окно закроется автоматически через {{ remaining }}с…</p>
    </div>
  </Modal>
</template>

<style scoped>
.bankrupt-notice {
  text-align: center;
  padding: 16px 8px 4px;
}

.big-icon {
  font-size: 48px;
  margin-bottom: 8px;
  filter: drop-shadow(0 2px 6px rgba(0, 0, 0, 0.4));
}

.message {
  font-size: 14px;
  line-height: 1.5;
  margin: 0 0 8px;
  color: var(--text);
}

.message strong {
  color: var(--accent);
  font-weight: 700;
}

.creditor {
  font-size: 12px;
  color: var(--text-muted);
  margin: 0 0 16px;
}

.auto-close {
  font-size: 11px;
  color: var(--text-muted);
  font-style: italic;
  margin: 0;
}
</style>
