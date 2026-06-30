import { defineStore } from "pinia";
import { ref, computed, watch } from "vue";
import type { GameState, Phase, Player, Cell, Card } from "@monopoly/shared";
import { BOARD, DEFAULT_SETTINGS, drawCard } from "@monopoly/shared";
import { rollDice } from "../composables/useDice";
import { decideBotAction } from "../composables/botAI";
import type { Player as PlayerType } from "@monopoly/shared";

// Временный placeholder на стороне клиента. Когда сервер создаёт партию,
// он генерирует криптослучайный seed и
// сохраняет его в stateSnapshot.seed и в games.rng_seed.
const PLACEHOLDER_SEED = "client-init";

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
    seed: PLACEHOLDER_SEED,
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

  watch(
    () => state.value.currentPlayerIndex,
    async () => {
      const player = currentPlayer.value;
      if (!player) return;
      if (player.kind !== "bot") return;
      if (state.value.status !== "active") return;

      await new Promise((r) => setTimeout(r, 1000 + Math.random() * 1000));

      if (state.value.phase === "ROLLING") {
        await rollAndMove();
      } else if (state.value.phase === "BUY_DECISION") {
        const action = decideBotAction(player, state.value);
        if (action === "BUY") buyProperty();
        await new Promise((r) => setTimeout(r, 500));
        endTurn();
      } else if (state.value.phase === "BUILDING") {
        await new Promise((r) => setTimeout(r, 500));
        endTurn();
      }
    },
  );

  async function rollAndMove() {
    if (!currentPlayer.value || state.value.phase !== "ROLLING") return;

    const [d1, d2] = rollDice();
    const steps = d1 + d2;
    const isDouble = d1 === d2;
    const player = currentPlayer.value;

    // Логика тюрьмы
    if (player.inJail) {
      if (isDouble) {
        player.inJail = false;
        player.jailTurns = 0;
      } else {
        player.jailTurns += 1;
        if (player.jailTurns >= 3) {
          player.money = Math.max(0, player.money - 50);
          player.inJail = false;
          player.jailTurns = 0;
        } else {
          endTurn();
          return;
        }
      }
    }

    state.value.phase = "MOVING";

    // Правило 3 дублей
    if (isDouble) {
      const currentDoubles = (state.value as any).consecutiveDoubles || 0;
      const newDoubles = currentDoubles + 1;
      (state.value as any).consecutiveDoubles = newDoubles;
      if (newDoubles >= 3) {
        sendToJail();
        (state.value as any).consecutiveDoubles = 0;
        return;
      }
    } else {
      (state.value as any).consecutiveDoubles = 0;
    }

    // Анимированное движение
    for (let i = 0; i < steps; i++) {
      await new Promise((r) => setTimeout(r, 300));
      player.position = (player.position + 1) % 40;
      if (player.position === 0) {
        player.money += DEFAULT_SETTINGS.goSalary;
      }
    }

    state.value.phase = "BUY_DECISION";
  }

  function sendToJail() {
    const player = currentPlayer.value;
    if (!player) return;
    player.position = 10;
    player.inJail = true;
    player.jailTurns = 0;
    (state.value as any).consecutiveDoubles = 0;
    state.value.phase = "JAIL_DECISION";
  }

  function buyProperty(): boolean {
    const cell = currentCell.value;
    const player = currentPlayer.value;
    if (!cell || !player) return false;
    if (cell.ownerId) return false;
    if (cell.price === undefined || player.money < cell.price) return false;

    player.money -= cell.price;
    player.properties.push(cell.id);
    cell.ownerId = player.id;
    state.value.phase = "BUILDING";
    return true;
  }

  function declineBuy() {
    state.value.phase = "BUILDING";
  }

  function payJailFine() {
    const player = currentPlayer.value;
    if (!player || !player.inJail) return;
    player.money = Math.max(0, player.money - 50);
    player.inJail = false;
    player.jailTurns = 0;
    state.value.phase = "ROLLING";
  }

  function useJailCard() {
    const player = currentPlayer.value;
    if (!player || !player.inJail || player.jailCards === 0) return;
    player.jailCards -= 1;
    player.inJail = false;
    player.jailTurns = 0;
    state.value.phase = "ROLLING";
  }

  function ownsMonopoly(cell: Cell, player: Player): boolean {
    if (!cell.group) return false;
    const groupCells = state.value.board.filter((c) => c.group === cell.group);
    return groupCells.every((c) => c.ownerId === player.id);
  }

  function canBuildHouse(cellId: number): boolean {
    const player = currentPlayer.value;
    if (!player) return false;
    const cell = state.value.board[cellId];
    if (!cell) return false;
    if (cell.ownerId !== player.id) return false;
    if (!ownsMonopoly(cell, player)) return false;
    if (cell.houses >= 4) return false;
    if (cell.housePrice === undefined || player.money < cell.housePrice) return false;

    // Правило равномерного строительства
    if (cell.group) {
      const groupCells = state.value.board.filter((c) => c.group === cell.group);
      const minHouses = Math.min(...groupCells.map((c) => c.houses));
      if (cell.houses > minHouses) return false;
    }
    return true;
  }

  function buildHouse(cellId: number): boolean {
    const player = currentPlayer.value;
    if (!player) return false;
    if (!canBuildHouse(cellId)) return false;
    const cell = state.value.board[cellId];
    if (!cell || cell.housePrice === undefined) return false;
    player.money -= cell.housePrice;
    const next: 0 | 1 | 2 | 3 | 4 | 5 =
      cell.houses < 5 ? ((cell.houses + 1) as 0 | 1 | 2 | 3 | 4 | 5) : 5;
    cell.houses = next;
    return true;
  }

  function calculateRent(cell: Cell, ownerId: string, diceRoll?: [number, number]): number {
    if (cell.isMortgaged) return 0;
    const owner = state.value.players.find((p) => p.id === ownerId);
    if (!owner) return 0;

    if (cell.type === "PROPERTY") {
      if (cell.houses === 0 && ownsMonopoly(cell, owner)) {
        return (cell.rent ?? 0) * 2;
      }
      if (cell.houses > 0 && cell.rentTable && cell.rentTable[cell.houses] !== undefined) {
        return cell.rentTable[cell.houses]!;
      }
      return cell.rent ?? 0;
    }

    if (cell.type === "RAILROAD") {
      const rrCount = owner.properties.filter((pid) => {
        const c = state.value.board[pid];
        return c && c.type === "RAILROAD";
      }).length;
      return [25, 50, 100, 200][rrCount - 1] ?? 25;
    }

    if (cell.type === "UTILITY") {
      const utilCount = owner.properties.filter((pid) => {
        const c = state.value.board[pid];
        return c && c.type === "UTILITY";
      }).length;
      const mult = utilCount === 2 ? 10 : 4;
      return diceRoll ? mult * (diceRoll[0] + diceRoll[1]) : 0;
    }

    return 0;
  }

  function payRent(toPlayerId: string, amount: number): boolean {
    const payer = currentPlayer.value;
    const receiver = state.value.players.find((p) => p.id === toPlayerId);
    if (!payer || !receiver) return false;
    if (amount <= 0) return true;
    payer.money -= amount;
    receiver.money += amount;
    return true;
  }

  const lastDrawnCard = ref<Card | null>(null);

  function drawChanceCard(): Card {
    return drawFromDeck("chance");
  }

  function drawTreasuryCard(): Card {
    return drawFromDeck("treasury");
  }

  function drawFromDeck(deck: "chance" | "treasury"): Card {
    const card = drawCard(deck);
    const player = currentPlayer.value;
    if (player) {
      applyCardEffect(card, player);
    }
    lastDrawnCard.value = card;
    state.value.phase = "BUILDING";
    return card;
  }

  function applyCardEffect(card: Card, player: PlayerType) {
    switch (card.effect.kind) {
      case "money":
        player.money += card.effect.amount;
        break;
      case "move":
        player.position = card.effect.target;
        if (card.effect.money) player.money += card.effect.money;
        break;
      case "move-relative":
        player.position = (player.position + card.effect.steps + 40) % 40;
        break;
      case "goto-jail":
        sendToJail();
        break;
      case "jail-free":
        player.jailCards += 1;
        break;
    }
  }

  function setPhase(phase: Phase) {
    state.value.phase = phase;
  }

  return {
    state,
    currentPlayer,
    currentCell,
    lastDrawnCard,
    initGame,
    endTurn,
    rollAndMove,
    sendToJail,
    buyProperty,
    declineBuy,
    payJailFine,
    useJailCard,
    ownsMonopoly,
    canBuildHouse,
    buildHouse,
    calculateRent,
    payRent,
    setPhase,
    applyCardEffect,
    drawChanceCard,
    drawTreasuryCard,
    drawFromDeck,
  };
});
