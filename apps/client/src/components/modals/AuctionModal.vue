<script setup lang="ts">
import { ref, computed, watch } from "vue";
import Modal from "../Modal.vue";
import type { Cell, GameState, Player } from "@monopoly/shared";

/**
 * AuctionModal — модалка аукциона.
 *
 * Открывается автоматически через watch(phase === "AUCTION_BIDDING")
 * в GameView. Игрок вводит ставку и подтверждает или пропускает.
 *
 * Когда аукцион завершается (фаза AUCTION_RESOLVE), модалка показывает
 * результат — кто и за сколько купил клетку (или что никто не купил).
 */
const props = defineProps<{
  show: boolean;
  state: GameState;
}>();

const emit = defineEmits<{
  (e: "bid", amount: number): void;
  (e: "pass"): void;
  (e: "close"): void;
}>();

const bidAmount = ref(0);

const auction = computed(() => props.state.auction);
const cell = computed<Cell | null>(() => {
  if (!auction.value) return null;
  return props.state.board[auction.value.cellId] ?? null;
});

const currentPlayer = computed<Player | null>(
  () => props.state.players[props.state.currentPlayerIndex] ?? null,
);

const minBid = computed(() => {
  if (!auction.value) return 0;
  const base = auction.value.currentBid ?? 0;
  const cellPrice = cell.value?.price ?? 0;
  const increment = Math.max(10, Math.floor(cellPrice * 0.05));
  return base + increment;
});

const isMyTurnToBid = computed(() => {
  if (!auction.value) return false;
  return auction.value.activeBidders.includes(currentPlayer.value?.id ?? "");
});

// Обновляем поле ввода при смене аукциона / текущего игрока
watch(
  () => auction.value?.currentBid,
  () => {
    bidAmount.value = minBid.value;
  },
  { immediate: true },
);

function onConfirm() {
  if (bidAmount.value < minBid.value) return;
  emit("bid", bidAmount.value);
}

function onPass() {
  emit("pass");
}
</script>

<template>
  <Modal :show="show" title="🔨 Аукцион" :subtitle="cell?.name ?? ''" @close="emit('close')">
    <div v-if="auction && cell" class="auction-card">
      <div class="auction-header" :style="{ background: cell.color || '#555' }">
        {{ cell.name }}
      </div>

      <div class="auction-info">
        <div class="auction-row">
          <span class="label">Текущая ставка</span>
          <span class="value">₽{{ auction.currentBid ?? 0 }}</span>
        </div>
        <div class="auction-row">
          <span class="label">Лидер</span>
          <span class="value">
            {{
              auction && auction.highestBidderId
                ? (props.state.players.find((p) => p.id === auction.highestBidderId)?.displayName ??
                  "—")
                : "—"
            }}
          </span>
        </div>
        <div class="auction-row">
          <span class="label">Мин. следующая</span>
          <span class="value">₽{{ minBid }}</span>
        </div>
        <div class="auction-row">
          <span class="label">У вас</span>
          <span class="value">₽{{ currentPlayer?.money?.toLocaleString() ?? 0 }}</span>
        </div>
      </div>

      <div v-if="isMyTurnToBid" class="auction-actions">
        <input
          v-model.number="bidAmount"
          type="number"
          :min="minBid"
          :max="currentPlayer?.money ?? 0"
          class="bid-input"
        />
        <button class="action-btn btn-bid" :disabled="bidAmount < minBid" @click="onConfirm">
          Сделать ставку
        </button>
        <button class="action-btn btn-pass" @click="onPass">Пропустить</button>
      </div>
      <div v-else class="waiting">⏳ Ожидание ставок других игроков…</div>
    </div>
  </Modal>
</template>

<style scoped>
.auction-card {
  font-size: 13px;
}

.auction-header {
  padding: 8px 10px;
  border-radius: 8px;
  color: #fff;
  font-weight: 700;
  margin-bottom: 14px;
  text-align: center;
}

.auction-info {
  margin-bottom: 16px;
}

.auction-row {
  display: flex;
  justify-content: space-between;
  padding: 4px 0;
}

.auction-row .label {
  color: var(--text-muted);
}

.auction-row .value {
  font-weight: 700;
  color: var(--gold);
}

.auction-actions {
  display: flex;
  gap: 8px;
  margin-top: 14px;
}

.bid-input {
  flex: 1;
  padding: 10px 12px;
  background: var(--surface-3);
  color: var(--text);
  border: 1px solid var(--glass-border);
  border-radius: 6px;
  font-size: 14px;
  font-weight: 700;
}

.bid-input:focus {
  outline: none;
  border-color: var(--accent);
}

.action-btn {
  padding: 10px 16px;
  border: none;
  border-radius: 6px;
  font-weight: 700;
  cursor: pointer;
  text-transform: uppercase;
  font-size: 12px;
}

.action-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.btn-bid {
  background: linear-gradient(135deg, var(--green), var(--accent));
  color: #fff;
}

.btn-pass {
  background: var(--surface-3);
  color: var(--text);
  border: 1px solid var(--glass-border);
}

.waiting {
  text-align: center;
  padding: 12px;
  color: var(--text-muted);
  font-size: 13px;
}
</style>
