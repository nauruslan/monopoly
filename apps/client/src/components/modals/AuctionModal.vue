<script setup lang="ts">
/**
 * AuctionModal — модальное окно аукциона (v2, стилистика приложения).
 *
 * Содержимое:
 *  - верхняя сцена: клетка + текущая ставка + круговой таймер;
 *  - список участников: имя, деньги, статус + последняя ставка (или «ПАС»);
 *  - панель действий: своя ставка / быстрая ставка / пас;
 *  - финальный экран (SOLD/UNSOLD) с кнопкой «ОК» для закрытия.
 *
 * UI получает данные ИСКЛЮЧИТЕЛЬНО из `useAuctionStore`, который
 * зеркалит `state.auction` с сервера. Все действия шлют
 * `GameAction` на сервер.
 */
import { computed, ref, watch } from "vue";
import Modal from "../Modal.vue";
import { useAuctionStore } from "../../stores/auction";
import type { Phase } from "@monopoly/shared";
import { useGameStore } from "../../stores/game";

const auctionStore = useAuctionStore();
const game = useGameStore();

// ─── local UI state ─────────────────────────────────────────────────
const bidInput = ref<number>(auctionStore.minNextBid);
const bidError = ref<string | null>(null);

watch(
  () => auctionStore.minNextBid,
  (v) => {
    bidInput.value = v;
    bidError.value = null;
  },
);
watch(
  () => auctionStore.isOnClock,
  (on) => {
    if (on) {
      bidInput.value = auctionStore.minNextBid;
      bidError.value = null;
    }
  },
);

const canSubmitCustom = computed(() => {
  const v = Number(bidInput.value);
  if (!Number.isFinite(v) || v <= 0) return false;
  if (v < auctionStore.minNextBid) return false;
  if (v > auctionStore.myMoney) return false;
  return true;
});

function submitCustomBid() {
  if (!auctionStore.canBid) return;
  const v = Math.floor(Number(bidInput.value));
  if (!Number.isFinite(v)) return;
  if (v < auctionStore.minNextBid) {
    bidError.value = `Минимум: ${auctionStore.minNextBid}₽`;
    return;
  }
  if (v > auctionStore.myMoney) {
    bidError.value = `Недостаточно денег: ${auctionStore.myMoney}₽`;
    return;
  }
  bidError.value = null;
  auctionStore.bid(v);
}

function quickBid(step: number) {
  if (!auctionStore.canBid) return;
  auctionStore.quickBid(step);
}

function pass() {
  // canPass уже требует isOnClock, но на всякий случай — доп. проверка,
  // чтобы случайный клик/крестик не отправил AUCTION_PASS от чужого игрока.
  if (auctionStore.isOnClock && auctionStore.status === "AUCTION_ACTIVE") {
    auctionStore.pass();
  }
}

/**
 * Обработчик @close у Modal (клик по overlay или крестику).
 *
 * Намеренно НЕ вызываем pass() — закрытие модалки во время торгов
 * запрещено, чтобы избежать ложных срабатываний «пас», когда курсор
 * при выделении/очистке инпута суммы случайно выходит за пределы
 * контента. Выйти из аукциона можно только явной кнопкой «ПАС».
 *
 * Если аукцион уже в финальной фазе (FINISHED), overlay/крестик тоже
 * остаются no-op — закрытие происходит только по кнопке «ОК», которая
 * отправляет CONFIRM_AUCTION на сервер.
 */
function onModalCloseAttempt() {
  // no-op: закрытие модалки во время торгов/финала запрещено
}

/**
 * Кнопка «ОК» в финале аукциона.
 * Отправляет CONFIRM_AUCTION — после него сервер выходит из фазы
 * AUCTION_FINISHED и переходит к следующей (BUILDING / ROLLING).
 */
// Тип аргумента sendAction берём из самой сигнатуры метода стора, чтобы
// не зависеть от разрешения `import type { GameAction }` в IDE-режиме
// tsc-plugin (он не всегда подхватывает workspace-пакеты в .vue).
type SendActionArg = Parameters<typeof game.sendAction>[0];
const confirming = ref(false);
function confirmAuctionEnd() {
  if (confirming.value) return;
  confirming.value = true;
  const action = { type: "CONFIRM_AUCTION" } as SendActionArg;
  game.sendAction(action);
}

const quickSteps = [5, 10, 25, 50, 100, 250];

// Модалка видна, пока в state.auction что-то есть
const isOpen = computed(() => auctionStore.status !== "none");

// Phase хелпер для подсветки текущей фазы в GameView
const phase = computed<Phase | null>(() => game.state?.phase ?? null);

// Текст подзаголовка по статусу аукциона
const subtitleText = computed(() => {
  switch (auctionStore.status) {
    case "AWAITING_START":
      return "Готовьтесь к торгам";
    case "AUCTION_ACTIVE":
      return "Делайте ставки или пасуйте";
    case "FINISHED":
      return auctionStore.finishReason === "SOLD" ? "Лот продан" : "Лот не продан";
    default:
      return undefined;
  }
});
</script>

<template>
  <!--
    ВАЖНО: @close намеренно НЕ привязан к pass().
    Крестик / клик по overlay НЕ должны срабатывать как «пас» — иначе
    при выделении/очистке суммы в input (если курсор случайно выходит
    за пределы контента) срабатывает pass, что выкидывает игрока из
    аукциона без явного намерения. Закрытие модалки во время торгов
    запрещено: единственный способ выйти — явная кнопка «ПАС».
  -->
  <Modal :show="isOpen" title="🔨 Аукцион" :subtitle="subtitleText" @close="onModalCloseAttempt">
    <div class="auction">
      <!-- Верхняя сцена: клетка + ставка + таймер -->
      <div class="auction-stage">
        <div class="cell-badge" :class="`group-${auctionStore.cell?.group ?? 'unknown'}`">
          <div class="cell-name">{{ auctionStore.cell?.name ?? "Клетка" }}</div>
          <div class="cell-price">Базовая цена: {{ auctionStore.cell?.price ?? 0 }}₽</div>
        </div>

        <div class="bid-block">
          <div class="bid-label">Текущая ставка</div>
          <div class="bid-amount">{{ auctionStore.currentBid }}₽</div>
          <div class="bid-leader" v-if="auctionStore.leaderPlayer">
            Лидер: <strong>{{ auctionStore.leaderPlayer.name }}</strong>
          </div>
          <div class="bid-leader muted" v-else>Ставок ещё нет</div>
        </div>

        <div class="timer-ring" v-if="auctionStore.status === 'AUCTION_ACTIVE'">
          <svg viewBox="0 0 100 100" class="timer-svg">
            <circle cx="50" cy="50" r="45" class="ring-bg" />
            <circle
              cx="50"
              cy="50"
              r="45"
              class="ring-fg"
              :stroke-dasharray="283"
              :stroke-dashoffset="283 * (1 - auctionStore.timerProgress)"
            />
          </svg>
          <div class="timer-text">{{ auctionStore.turnRemainingSec }}s</div>
        </div>
      </div>

      <!-- Участники (со ставкой или «ПАС») -->
      <div class="participants">
        <div class="panel-title">Участники ({{ auctionStore.participants.length }})</div>
        <div class="participant-grid">
          <div
            v-for="p in auctionStore.participants"
            :key="p.id"
            class="participant"
            :class="[`status-${p.status}`, p.isMe ? 'is-me' : '']"
          >
            <div class="p-name">
              {{ p.name }}
              <span v-if="p.isMe" class="me-tag">(вы)</span>
            </div>
            <div class="p-money">{{ p.money }}₽</div>
            <div class="p-action">
              <!-- Если сделал ставку — показываем её -->
              <span v-if="p.bid !== null" class="p-bid">{{ p.bid }}₽</span>
              <!-- Иначе если спасовал — «ПАС» -->
              <span v-else-if="p.didPass" class="p-pass">ПАС</span>
              <!-- Иначе если он на часах -->
              <span v-else-if="p.isOnClock" class="p-clock">⏱ Ход</span>
              <!-- Иначе если лидер (ставка 0) -->
              <span v-else-if="p.isLeader" class="p-leader">👑 Лидер</span>
              <!-- Иначе просто дефис -->
              <span v-else class="p-dash">—</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Панель действий (только когда аукцион активен) -->
      <div
        v-if="auctionStore.status === 'AUCTION_ACTIVE'"
        class="actions"
        :class="{ 'actions-disabled': !auctionStore.isOnClock }"
      >
        <div class="action-block custom-bid">
          <span class="block-label">Своя ставка</span>
          <input
            v-model.number="bidInput"
            type="number"
            :min="auctionStore.minNextBid"
            :max="auctionStore.myMoney"
            :step="10"
            :disabled="!auctionStore.canBid"
          />
          <button
            class="action-btn btn-roll"
            :disabled="!canSubmitCustom || !auctionStore.canBid"
            @click="submitCustomBid"
          >
            Поставить
          </button>
          <div v-if="bidError" class="error">{{ bidError }}</div>
          <div v-else-if="!auctionStore.isOnClock" class="hint">Сейчас ход другого игрока</div>
          <div v-else class="hint">Минимум: {{ auctionStore.minNextBid }}₽</div>
        </div>

        <div class="action-block quick-bids">
          <span class="block-label">Быстрая ставка</span>
          <div class="quick-grid">
            <button
              v-for="step in quickSteps"
              :key="step"
              class="action-btn btn-quick"
              :disabled="
                !auctionStore.canBid || auctionStore.myMoney < auctionStore.minNextBid + step
              "
              @click="quickBid(step)"
            >
              +{{ step }}₽
            </button>
          </div>
        </div>

        <div class="action-block">
          <button class="action-btn btn-pass" :disabled="!auctionStore.canPass" @click="pass">
            Пас
          </button>
        </div>
      </div>

      <!-- Финальный экран (SOLD/UNSOLD) -->
      <div v-else-if="auctionStore.status === 'FINISHED'" class="result">
        <div class="result-icon">
          <template v-if="auctionStore.finishReason === 'SOLD'">🏆</template>
          <template v-else>🤝</template>
        </div>
        <div v-if="auctionStore.finishReason === 'SOLD'" class="result-sold">
          <div class="result-title">Продано!</div>
          <div class="result-text">
            <strong>{{ auctionStore.winnerInfo?.name ?? "?" }}</strong>
            купил(а)
            <strong>{{ auctionStore.cell?.name ?? "клетку" }}</strong>
            за
            <strong>{{ auctionStore.finalBid }}₽</strong>
          </div>
        </div>
        <div v-else class="result-unsold">
          <div class="result-title">Аукцион не состоялся</div>
          <div class="result-text">Все спасовали без ставок. Клетка остаётся у Банка.</div>
        </div>

        <div class="modal-actions">
          <button class="action-btn btn-roll" :disabled="confirming" @click="confirmAuctionEnd">
            ОК
          </button>
        </div>
      </div>
    </div>
  </Modal>
</template>

<style scoped>
/* Контейнер модалки (внутри Modal.vue) */
.auction {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* Верхняя сцена */
.auction-stage {
  display: grid;
  grid-template-columns: 1fr 1.4fr 1fr;
  gap: 12px;
  align-items: center;
  background: var(--surface-1);
  border: 1px solid var(--glass-border);
  border-radius: 14px;
  padding: 14px;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
}

.cell-badge {
  padding: 12px 14px;
  border-radius: 10px;
  color: #fff;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.4);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.3);
}
.cell-badge .cell-name {
  font-weight: 800;
  font-size: 14px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.cell-badge .cell-price {
  font-size: 11px;
  margin-top: 2px;
  opacity: 0.9;
}
.cell-badge.group-brown {
  background: linear-gradient(135deg, #8b4513, #5a2d0c);
}
.cell-badge.group-lightblue {
  background: linear-gradient(135deg, #87ceeb, #4682b4);
}
.cell-badge.group-pink {
  background: linear-gradient(135deg, #d87093, #a33d6a);
}
.cell-badge.group-orange {
  background: linear-gradient(135deg, #ff8c00, #cc6600);
}
.cell-badge.group-red {
  background: linear-gradient(135deg, #dc143c, #8b0000);
}
.cell-badge.group-yellow {
  background: linear-gradient(135deg, #ffd700, #b8860b);
}
.cell-badge.group-green {
  background: linear-gradient(135deg, #228b22, #0d5a0d);
}
.cell-badge.group-darkblue {
  background: linear-gradient(135deg, #1e3a8a, #0f1f4d);
}
.cell-badge.group-railroad {
  background: linear-gradient(135deg, #555, #222);
}
.cell-badge.group-utility {
  background: linear-gradient(135deg, #b0b0b0, #707070);
}
.cell-badge.group-unknown {
  background: linear-gradient(135deg, #555, #333);
}

.bid-block {
  text-align: center;
}
.bid-label {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 2px;
  color: var(--text3);
}
.bid-amount {
  font-family: "Space Grotesk", monospace;
  font-size: 36px;
  font-weight: 800;
  line-height: 1.1;
  margin: 2px 0 4px;
  background: linear-gradient(135deg, var(--gold), var(--accent3));
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  filter: drop-shadow(0 0 10px rgba(194, 178, 235, 0.25));
}
.bid-leader {
  font-size: 12px;
  color: var(--text2);
}
.bid-leader strong {
  color: var(--text);
}
.bid-leader.muted {
  color: var(--text3);
  font-style: italic;
}

/* Круговой таймер */
.timer-ring {
  position: relative;
  width: 80px;
  height: 80px;
  margin: 0 auto;
}
.timer-svg {
  width: 100%;
  height: 100%;
  transform: rotate(-90deg);
}
.ring-bg {
  fill: none;
  stroke: rgba(255, 255, 255, 0.08);
  stroke-width: 8;
}
.ring-fg {
  fill: none;
  stroke: url(#auctionGradient);
  stroke: var(--accent);
  stroke-width: 8;
  stroke-linecap: round;
  transition: stroke-dashoffset 0.3s linear;
  filter: drop-shadow(0 0 6px rgba(129, 82, 207, 0.5));
}
.timer-text {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: "Space Grotesk", monospace;
  font-size: 16px;
  font-weight: 800;
  color: var(--text);
}

/* Участники */
.participants {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.participant-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 8px;
}
.participant {
  background: var(--surface-1);
  border: 1.5px solid rgba(255, 255, 255, 0.05);
  border-radius: var(--radius-sm);
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  transition: all 0.2s var(--ease-out);
  position: relative;
  overflow: hidden;
}
.participant::before {
  content: "";
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 2px;
  background: rgba(255, 255, 255, 0.1);
  opacity: 0.6;
}
.participant.is-me {
  border-color: var(--accent);
  box-shadow: 0 0 14px rgba(129, 82, 207, 0.25);
}
.participant.is-me::before {
  background: var(--accent);
  opacity: 1;
}

.participant.status-onClock {
  border-color: var(--accent3);
  box-shadow: 0 0 16px rgba(149, 114, 218, 0.35);
  animation: pulseOnClock 1.4s ease-in-out infinite;
}
@keyframes pulseOnClock {
  0%,
  100% {
    box-shadow: 0 0 12px rgba(149, 114, 218, 0.3);
  }
  50% {
    box-shadow: 0 0 24px rgba(149, 114, 218, 0.6);
  }
}

.participant.status-leader::before {
  background: var(--gold);
  opacity: 1;
}
.participant.status-winner {
  border-color: var(--gold);
  background: linear-gradient(135deg, rgba(194, 178, 235, 0.18), rgba(149, 114, 218, 0.1));
  box-shadow: 0 0 18px rgba(194, 178, 235, 0.3);
}
.participant.status-passed {
  opacity: 0.55;
  filter: grayscale(0.4);
}
.participant.status-unsold {
  opacity: 0.7;
}

.p-name {
  font-size: 12px;
  font-weight: 700;
  color: var(--text);
  display: flex;
  align-items: center;
  gap: 6px;
}
.me-tag {
  font-size: 9px;
  font-weight: 700;
  color: var(--accent3);
  text-transform: uppercase;
  letter-spacing: 1px;
}
.p-money {
  font-family: "Space Grotesk", monospace;
  font-size: 11px;
  color: var(--text3);
  font-weight: 600;
}
.p-action {
  font-size: 12px;
  font-weight: 800;
  margin-top: 2px;
  min-height: 16px;
}
.p-bid {
  color: var(--gold);
  text-shadow: 0 0 8px rgba(194, 178, 235, 0.3);
}
.p-pass {
  color: var(--danger);
  letter-spacing: 1.5px;
  font-weight: 800;
}
.p-clock {
  color: var(--accent3);
  font-weight: 700;
  font-size: 11px;
}
.p-leader {
  color: var(--gold);
  font-size: 11px;
}
.p-dash {
  color: var(--text3);
}

/* Панель действий */
.actions {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-top: 4px;
  border-top: 1px solid rgba(255, 255, 255, 0.05);
}
.actions-disabled {
  opacity: 0.65;
}

.action-block {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.block-label {
  font-size: 10px;
  font-weight: 800;
  text-transform: uppercase;
  letter-spacing: 2px;
  color: var(--text3);
}

.custom-bid {
  flex-direction: row;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.custom-bid .block-label {
  width: 100%;
}
.custom-bid input {
  flex: 1;
  min-width: 90px;
  padding: 10px 12px;
  background: var(--surface-2);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-sm);
  color: var(--text);
  font-family: "Space Grotesk", monospace;
  font-size: 14px;
  font-weight: 700;
  outline: none;
  transition: border-color 0.2s;
}
.custom-bid input:focus {
  border-color: var(--accent);
}
.custom-bid input:disabled {
  opacity: 0.5;
}
.custom-bid .error {
  width: 100%;
  font-size: 11px;
  color: var(--danger);
  font-weight: 600;
}
.custom-bid .hint {
  width: 100%;
  font-size: 10px;
  color: var(--text3);
}

.quick-bids {
  gap: 6px;
}
.quick-grid {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 6px;
}

.btn-quick {
  flex: 1;
  min-width: 0;
  padding: 9px 4px;
  border: 1px solid var(--glass-border);
  background: var(--surface-2);
  color: var(--text);
  border-radius: var(--radius-sm);
  font-family: "Space Grotesk", monospace;
  font-size: 11px;
  font-weight: 700;
  cursor: pointer;
  transition: all 0.2s var(--ease-out);
}
.btn-quick:hover:not(:disabled) {
  background: var(--surface-hover);
  border-color: var(--accent);
  transform: translateY(-1px);
}
.btn-quick:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.btn-pass {
  background: var(--surface-2);
  color: var(--text2);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-sm);
  padding: 11px;
  font-weight: 800;
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 1px;
  cursor: pointer;
  transition: all 0.2s;
}
.btn-pass:hover:not(:disabled) {
  background: var(--surface-hover);
  color: var(--text);
  border-color: var(--danger);
}
.btn-pass:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

/* Финальный экран */
.result {
  text-align: center;
  padding: 12px 0 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
}
.result-icon {
  font-size: 56px;
  filter: drop-shadow(0 6px 14px rgba(0, 0, 0, 0.4));
}
.result-title {
  font-size: 22px;
  font-weight: 800;
  background: linear-gradient(135deg, var(--gold), var(--accent3));
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  filter: drop-shadow(0 0 12px rgba(194, 178, 235, 0.3));
}
.result-text {
  font-size: 13px;
  color: var(--text2);
  line-height: 1.5;
  max-width: 360px;
}
.result-text strong {
  color: var(--text);
}

/* Адаптив */
@media (max-width: 540px) {
  .auction-stage {
    grid-template-columns: 1fr;
    text-align: center;
  }
  .timer-ring {
    margin: 0 auto;
  }
  .participant-grid {
    grid-template-columns: 1fr;
  }
  .quick-grid {
    grid-template-columns: repeat(3, 1fr);
  }
}
</style>
