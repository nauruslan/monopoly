import { defineStore } from "pinia";
import { ref, computed } from "vue";
import type { GameState, Phase } from "../types/game";
import type { Player } from "../types/player";
import { BOARD } from "../data/board";
import { DEFAULT_SETTINGS } from "../types/game";

export const useGameStore = defineStore("game", () => {
  const state = ref<GameState>({
    id: "",
    version: 1,
    status: "waiting",
    currentPlayerIndex: 0,
    phase: "IDLE" as Phase,
    round: 1,
    players: [],
    board: BOARD.map((c) => ({ ...c })),
    createdAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
  });

  const currentPlayer = computed<Player | null>(
    () => state.value.players[state.value.currentPlayerIndex] || null,
  );

  const currentCell = computed(() => {
    const p = currentPlayer.value;
    if (!p) return null;
    return state.value.board[p.position] || null;
  });

  function initGame(playerNames: string[]) {
    const colors = [
      "#FF4D4D",
      "#4D9EFF",
      "#4CFF4C",
      "#FFD700",
      "#FF8C42",
      "#8152cf",
      "#ab90e3",
      "#22d3ee",
    ];
    const icons = ["🔴", "🔵", "🟢", "🟡", "🟠", "🟣", "🟤", "⚪"];
    state.value.id = Math.random().toString(36).substring(2, 9);
    state.value.status = "active";
    state.value.round = 1;
    state.value.currentPlayerIndex = 0;
    state.value.phase = "ROLLING";
    state.value.players = playerNames.map((name, i) => ({
      id: `p${i + 1}`,
      displayName: name,
      kind: i === 0 ? "human" : "bot",
      color: colors[i % colors.length]!,
      icon: icons[i % icons.length]!,
      money: DEFAULT_SETTINGS.startingMoney,
      position: 0,
      inJail: false,
      jailTurns: 0,
      jailCards: 0,
      properties: [],
      isBankrupt: false,
    }));
    state.value.board = BOARD.map((c) => ({
      ...c,
      ownerId: undefined,
      houses: 0,
      isMortgaged: false,
    }));
    state.value.createdAt = new Date().toISOString();
    state.value.lastActivityAt = new Date().toISOString();
  }

  function endTurn() {
    if (state.value.players.length === 0) return;
    state.value.currentPlayerIndex =
      (state.value.currentPlayerIndex + 1) % state.value.players.length;
    if (state.value.currentPlayerIndex === 0) {
      state.value.round += 1;
    }
    state.value.phase = "ROLLING";
    state.value.lastActivityAt = new Date().toISOString();
  }

  return {
    state,
    currentPlayer,
    currentCell,
    initGame,
    endTurn,
  };
});
