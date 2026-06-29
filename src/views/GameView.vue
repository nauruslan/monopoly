<script setup lang="ts">
import { ref } from "vue";
import Board from "../components/Board.vue";
import { BOARD } from "../data/board";
import type { Cell as CellType } from "../types/cell";

const mockPlayers = ref([
  { id: "p1", position: 0, color: "#FF4D4D", icon: "🔴" },
  { id: "p2", position: 0, color: "#4D9EFF", icon: "🔵" },
  { id: "p3", position: 0, color: "#4CFF4C", icon: "🟢" },
  { id: "p4", position: 0, color: "#FFD700", icon: "🟡" },
]);

function onCellClick(cell: CellType) {
  console.log("Clicked cell:", cell);
}
</script>

<template>
  <div class="game-container">
    <Board :cells="BOARD" :players="mockPlayers" @cell-click="onCellClick">
      <template #center>
        <div class="logo">Монополия</div>
        <div class="logo-sub">neon edition</div>
      </template>
    </Board>
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
</style>
