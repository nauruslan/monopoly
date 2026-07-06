<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import Board from "../components/Board.vue";
import PlayersPanel from "../components/PlayersPanel.vue";
import ActionsPanel from "../components/ActionsPanel.vue";
import CellTooltip from "../components/CellTooltip.vue";
import BuyModal from "../components/modals/BuyModal.vue";
import CardModal from "../components/modals/CardModal.vue";
import JailModal from "../components/modals/JailModal.vue";
import { useAuthStore } from "../stores/auth";
import { useGameStore } from "../stores/game";
import { useSocket, disconnectSocket } from "../composables/useSocket";
import type { Cell, GameAction } from "@monopoly/shared";
import { drawCard } from "@monopoly/shared";

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const game = useGameStore();

const _gameId = route.params.id;

const players = computed(() => game.state.players);
const cells = computed(() => game.state.board);
const currentPlayerId = computed(() => game.currentPlayer?.id || "");

// Локальное состояние UI
const diceValues = ref<[number, number]>([1, 1]);
const diceRolling = ref(false);

const showBuyModal = ref(false);
const showCardModal = ref(false);
const cardText = ref("");
const isTreasuryCard = ref(false);

const showJailModal = ref(false);

const hoveredCell = ref<Cell | null>(null);
const tooltipPos = ref({ x: 0, y: 0 });

const currentCell = computed<Cell | null>(() => game.currentCell);

const cellOwner = computed(() => players.value.find((p) => p.id === currentCell.value?.ownerId));

// Подключаемся к WebSocket при монтировании компонента.
// ВАЖНО: useSocket может вернуть null, если токен пуст — в этом случае
// редиректим на / (страница логина).
onMounted(() => {
  const socket = useSocket(auth.token);
  if (!socket) {
    alert("Сначала войдите в игру");
    router.push("/");
    return;
  }
  if (typeof route.params.id === "string") {
    game.connectAndJoin(route.params.id);
  }
});

onUnmounted(() => {
  // Не отключаем socket — он singleton, переиспользуется.
  // Для logout используется disconnectSocket() отдельно.
});

function onCellClick(payload: { cell: Cell; event: MouseEvent }) {
  hoveredCell.value = payload.cell;
  tooltipPos.value = {
    x: payload.event.clientX + 12,
    y: payload.event.clientY + 12,
  };
}

function dispatchAction(action: GameAction) {
  // Локальный rollAndMove оставлен для анимации (UI/тесты Step29).
  // Основной путь — отправка на сервер через WS.
  game.sendAction(action);
}

async function onRoll() {
  if (game.state.phase !== "ROLLING") return;
  diceRolling.value = true;
  await new Promise((r) => setTimeout(r, 800));
  // Локальная анимация движения (UI), затем синхронизация с сервером.
  await game.rollAndMove();
  diceValues.value = [Math.ceil(Math.random() * 6), Math.ceil(Math.random() * 6)];
  diceRolling.value = false;
  const player = game.currentPlayer;
  if (player) dispatchAction({ type: "ROLL_DICE" });
}

watch(
  () => game.state.phase,
  (newPhase) => {
    if (newPhase === "JAIL_DECISION") showJailModal.value = true;
    else showJailModal.value = false;
  },
);

function onPayJailFine() {
  game.payJailFine();
  showJailModal.value = false;
  dispatchAction({ type: "PAY_JAIL_FINE" });
}

function onUseJailCard() {
  game.useJailCard();
  showJailModal.value = false;
  dispatchAction({ type: "USE_JAIL_CARD" });
}

function onTryDouble() {
  showJailModal.value = false;
  game.setPhase("ROLLING");
  game.rollAndMove();
  dispatchAction({ type: "ROLL_DICE" });
}

watch(
  () => game.currentPlayer?.position,
  (newPos, oldPos) => {
    if (newPos === oldPos) return;
    const cell = game.currentCell;
    const player = game.currentPlayer;
    if (!cell || !player) return;

    setTimeout(() => {
      if (cell.type === "CHANCE") {
        const card = drawCard("chance");
        game.applyCardEffect(card, player);
        cardText.value = card.text;
        isTreasuryCard.value = false;
        showCardModal.value = true;
      } else if (cell.type === "TREASURY") {
        const card = drawCard("treasury");
        game.applyCardEffect(card, player);
        cardText.value = card.text;
        isTreasuryCard.value = true;
        showCardModal.value = true;
      } else if (cell.type === "TAX" && cell.taxAmount) {
        player.money -= cell.taxAmount;
      } else if (cell.type === "GOTO_JAIL") {
        game.sendToJail();
      } else if (
        (cell.type === "PROPERTY" || cell.type === "RAILROAD" || cell.type === "UTILITY") &&
        cell.ownerId &&
        cell.ownerId !== player.id
      ) {
        const rent = game.calculateRent(cell, cell.ownerId);
        if (rent > 0) game.payRent(cell.ownerId, rent);
      }
    }, 600);
  },
);

function onBuy() {
  showBuyModal.value = true;
}
function onConfirmBuy() {
  if (game.buyProperty()) {
    showBuyModal.value = false;
    dispatchAction({ type: "BUY_PROPERTY" });
  }
}
function onDeclineBuy() {
  game.declineBuy();
  showBuyModal.value = false;
  dispatchAction({ type: "DECLINE_BUY" });
}
function onEndTurn() {
  console.log("✅ End turn");
  game.endTurn();
  dispatchAction({ type: "END_TURN" });
}

// Удобный helper для logout (на случай будущей кнопки)
function logout() {
  auth.logout();
  disconnectSocket();
  router.push("/");
}
</script>

<template>
  <div class="game-container">
    <div v-if="!game.isConnected" class="connecting">
      <p>🔄 Подключение к серверу...</p>
    </div>

    <template v-else>
      <Board :cells="cells" :players="players" @cell-click="onCellClick" />

      <aside class="sidebar">
        <PlayersPanel :players="players" :current-player-id="currentPlayerId" />
        <ActionsPanel
          :can-roll="true"
          :can-buy="true"
          :can-end-turn="true"
          @roll="onRoll"
          @buy="onBuy"
          @end-turn="onEndTurn"
        />
      </aside>

      <BuyModal
        :show="showBuyModal"
        :cell="currentCell"
        :money="players[0]?.money ?? 0"
        @close="onDeclineBuy"
        @confirm="onConfirmBuy"
      />

      <CardModal
        :show="showCardModal"
        :card-text="cardText"
        :is-treasury="isTreasuryCard"
        @close="showCardModal = false"
      />

      <JailModal
        :show="showJailModal"
        :jail-cards="game.currentPlayer?.jailCards || 0"
        :money="game.currentPlayer?.money || 0"
        @pay="onPayJailFine"
        @use-card="onUseJailCard"
        @try-double="onTryDouble"
        @close="showJailModal = false"
      />

      <CellTooltip :cell="hoveredCell" :owner="cellOwner" :x="tooltipPos.x" :y="tooltipPos.y" />
    </template>
  </div>
</template>

<style scoped>
.game-container {
  display: flex;
  gap: 24px;
  padding: 20px;
  max-width: 1560px;
  margin: 0 auto;
  align-items: flex-start;
}
.sidebar {
  flex: 1;
  min-width: 300px;
  max-width: 380px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.connecting {
  flex: 1;
  text-align: center;
  padding: 80px 20px;
  font-size: 18px;
  color: var(--text2);
}
</style>
