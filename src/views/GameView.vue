<script setup lang="ts">
import { ref } from "vue";
import Board from "../components/Board.vue";
import PlayersPanel from "../components/PlayersPanel.vue";
import ActionsPanel from "../components/ActionsPanel.vue";
import BuyModal from "../components/modals/BuyModal.vue";
import CardModal from "../components/modals/CardModal.vue";
import CellTooltip from "../components/CellTooltip.vue";
import { BOARD } from "../data/board";
import type { Cell as CellType } from "../types/cell";
import type { Player } from "../types/player";

const mockPlayers = ref<Player[]>([
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
    jailCards: 0,
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
    jailCards: 0,
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
    jailCards: 0,
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
    jailCards: 0,
    properties: [],
    isBankrupt: false,
  },
]);

const currentPlayerId = "p1";

const canRoll = ref(true);
const canBuy = ref(true);
const canEndTurn = ref(true);

const showBuyModal = ref(false);
const showCardModal = ref(false);
const cardText = ref("");
const isTreasuryCard = ref(false);

const hoveredCell = ref<CellType | null>(null);
const tooltipPos = ref({ x: 0, y: 0 });

function onCellClick(payload: { cell: CellType; event: MouseEvent }) {
  hoveredCell.value = payload.cell;
  tooltipPos.value = {
    x: payload.event.clientX + 12,
    y: payload.event.clientY + 12,
  };
}

function onCellLeave() {
  hoveredCell.value = null;
}

function onRoll() {
  console.log("🎲 Roll clicked");
}
function onBuy() {
  showBuyModal.value = true;
}
function onConfirmBuy() {
  showBuyModal.value = false;
  console.log("✅ Bought");
}
function onEndTurn() {
  console.log("✅ End turn");
}
</script>

<template>
  <div class="game-container" @mouseleave="onCellLeave">
    <Board :cells="BOARD" :players="mockPlayers" @cell-click="onCellClick">
      <template #center>
        <div class="logo">Монополия</div>
        <div class="logo-sub">neon edition</div>
      </template>
    </Board>
    <aside class="sidebar">
      <PlayersPanel :players="mockPlayers" :current-player-id="currentPlayerId" />
      <ActionsPanel
        :can-roll="canRoll"
        :can-buy="canBuy"
        :can-end-turn="canEndTurn"
        @roll="onRoll"
        @buy="onBuy"
        @end-turn="onEndTurn"
      />
    </aside>

    <BuyModal
      :show="showBuyModal"
      :cell="{
        id: 1,
        name: 'Старая дорога',
        type: 'PROPERTY',
        group: 'brown',
        color: '#8B4513',
        price: 60,
        rent: 2,
        housePrice: 50,
        mortgageValue: 30,
        houses: 0,
        isMortgaged: false,
      }"
      :money="1500"
      @close="showBuyModal = false"
      @confirm="onConfirmBuy"
    />

    <CardModal
      :show="showCardModal"
      :card-text="cardText"
      :is-treasury="isTreasuryCard"
      @close="showCardModal = false"
    />

    <CellTooltip
      :cell="hoveredCell"
      :owner="mockPlayers.find((p) => p.id === hoveredCell?.ownerId)"
      :x="tooltipPos.x"
      :y="tooltipPos.y"
    />
  </div>
</template>

<style scoped>
.game-container {
  display: flex;
  gap: 24px;
  padding: 20px;
  max-width: 1200px;
  margin: 0 auto;
  justify-content: center;
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
