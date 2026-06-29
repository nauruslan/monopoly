<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { useRoute } from "vue-router";
import Board from "../components/Board.vue";
import PlayersPanel from "../components/PlayersPanel.vue";
import ActionsPanel from "../components/ActionsPanel.vue";
import CellTooltip from "../components/CellTooltip.vue";
import BuyModal from "../components/modals/BuyModal.vue";
import CardModal from "../components/modals/CardModal.vue";
import { useGameStore } from "../stores/game";
import type { Cell } from "../types/cell";
import { drawCard } from "../data/cards";

const route = useRoute();
const game = useGameStore();
// route-параметр пока не используется напрямую
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

const hoveredCell = ref<Cell | null>(null);
const tooltipPos = ref({ x: 0, y: 0 });

const currentCell = computed<Cell | null>(() => game.currentCell);

const cellOwner = computed(() => players.value.find((p) => p.id === currentCell.value?.ownerId));

function onCellClick(payload: { cell: Cell; event: MouseEvent }) {
  hoveredCell.value = payload.cell;
  tooltipPos.value = {
    x: payload.event.clientX + 12,
    y: payload.event.clientY + 12,
  };
}

async function onRoll() {
  if (game.state.phase !== "ROLLING") return;
  diceRolling.value = true;
  await new Promise((r) => setTimeout(r, 800));
  await game.rollAndMove();
  diceValues.value = [Math.ceil(Math.random() * 6), Math.ceil(Math.random() * 6)];
  diceRolling.value = false;
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
      }
    }, 600);
  },
);

function onBuy() {
  showBuyModal.value = true;
}
function onConfirmBuy() {
  if (game.buyProperty()) showBuyModal.value = false;
}
function onDeclineBuy() {
  game.declineBuy();
  showBuyModal.value = false;
}
function onEndTurn() {
  console.log("✅ End turn");
}
</script>

<template>
  <div class="game-container">
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

    <CellTooltip :cell="hoveredCell" :owner="cellOwner" :x="tooltipPos.x" :y="tooltipPos.y" />
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
</style>
