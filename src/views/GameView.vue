<script setup lang="ts">
import { ref, computed } from "vue";
import { useRoute } from "vue-router";
import Board from "../components/Board.vue";
import PlayersPanel from "../components/PlayersPanel.vue";
import ActionsPanel from "../components/ActionsPanel.vue";
import CellTooltip from "../components/CellTooltip.vue";
import BuyModal from "../components/modals/BuyModal.vue";
import CardModal from "../components/modals/CardModal.vue";
import { BOARD } from "../data/board";
import type { Cell } from "../types/cell";
import type { Player } from "../types/player";

const route = useRoute();
const gameId = route.params.id;

const players = ref<Player[]>([
  {
    id: "p1",
    displayName: "Игрок 1",
    kind: "human",
    color: "#FF4D4D",
    icon: "🔴",
    money: 1500,
    position: 0,
    inJail: false,
    jailTurns: 0,
    properties: [],
    isBankrupt: false,
  },
  {
    id: "p2",
    displayName: "Бот 1",
    kind: "bot",
    color: "#4D9EFF",
    icon: "🔵",
    money: 1500,
    position: 0,
    inJail: false,
    jailTurns: 0,
    properties: [],
    isBankrupt: false,
  },
  {
    id: "p3",
    displayName: "Бот 2",
    kind: "bot",
    color: "#4CFF4C",
    icon: "🟢",
    money: 1500,
    position: 0,
    inJail: false,
    jailTurns: 0,
    properties: [],
    isBankrupt: false,
  },
  {
    id: "p4",
    displayName: "Бот 3",
    kind: "bot",
    color: "#FFD700",
    icon: "🟡",
    money: 1500,
    position: 0,
    inJail: false,
    jailTurns: 0,
    properties: [],
    isBankrupt: false,
  },
]);

const currentPlayerId = "p1";
const diceValues = ref<[number, number]>([1, 1]);
const diceRolling = ref(false);

const showBuyModal = ref(false);
const showCardModal = ref(false);
const cardText = ref("");
const isTreasuryCard = ref(false);

const hoveredCell = ref<Cell | null>(null);
const tooltipPos = ref({ x: 0, y: 0 });

const currentCell = computed<Cell | null>(() => {
  const p = players.value.find((p) => p.id === currentPlayerId);
  return p ? BOARD[p.position] || null : null;
});

const cellOwner = computed(() => players.value.find((p) => p.id === currentCell.value?.ownerId));

function onCellClick(cell: Cell, e: MouseEvent) {
  hoveredCell.value = cell;
  tooltipPos.value = { x: e.clientX + 12, y: e.clientY + 12 };
}

function onRoll() {
  console.log("🎲 Roll");
}
function onBuy() {
  showBuyModal.value = true;
}
function onConfirmBuy() {
  showBuyModal.value = false;
}
function onEndTurn() {
  console.log("✅ End turn");
}
</script>

<template>
  <div class="game-container">
    <Board :cells="BOARD" :players="players" @cell-click="onCellClick" />

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
      :money="players[0]!.money"
      @close="showBuyModal = false"
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
