<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from "vue";
import { storeToRefs } from "pinia";
import { useRoute, useRouter } from "vue-router";
import Board from "../components/Board.vue";
import PlayersPanel from "../components/PlayersPanel.vue";
import ActionsPanel from "../components/ActionsPanel.vue";
import CellTooltip from "../components/CellTooltip.vue";
import BuyModal from "../components/modals/BuyModal.vue";
import CardModal from "../components/modals/CardModal.vue";
import TaxModal from "../components/modals/TaxModal.vue";
import JailModal from "../components/modals/JailModal.vue";
import GameOverModal from "../components/modals/GameOverModal.vue";
import AuctionModal from "../components/modals/AuctionModal.vue";
import TradeModal from "../components/modals/TradeModal.vue";
import SettingsPanel from "../components/SettingsPanel.vue";
import LogPanel from "../components/LogPanel.vue";
import { useAuthStore } from "../stores/auth";
import { useGameStore } from "../stores/game";
import { useSettingsStore } from "../stores/settings";
import { useSocket, disconnectSocket } from "../composables/useSocket";
import type { Cell, GameAction, TradeOffer, Phase } from "@monopoly/shared";

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const game = useGameStore();
const settings = useSettingsStore();

const players = computed(() => state.value.players);
const cells = computed(() => state.value.board);
const currentPlayerId = computed(() => currentPlayer.value?.id || "");

// Dice: берём реактивно из store
const {
  state,
  diceValues,
  diceRolling,
  currentPlayer,
  lastDiceRoll,
  cardPendingConfirm,
  lastDrawnCard,
} = storeToRefs(game);

// Кому принадлежит ход
const myPlayerId = computed(() => players.value[0]?.id ?? "");
const isMyTurn = computed(
  () => currentPlayer.value?.kind === "human" && currentPlayer.value?.id === myPlayerId.value,
);

// Допустимые кнопки панели действий (ОСНОВНОЙ ЦИКЛ)
const canRoll = computed(
  () => isMyTurn.value && state.value.phase === "ROLLING" && !currentPlayer.value?.inJail,
);
const canBuy = computed(() => isMyTurn.value && state.value.phase === "BUY_DECISION");
const canEndTurn = computed(
  () =>
    isMyTurn.value &&
    (state.value.phase === "ROLLING" || state.value.phase === "BUILDING") &&
    !diceRolling.value,
);
const mustRollAgain = computed(() => currentPlayer.value?.mustRollAgain === true);

// Модалки
const showBuyModal = ref(false);
const showCardModal = ref(false);
const cardText = ref("");
const cardDeck = ref<"chance" | "treasury" | "luxury-tax">("chance");

const showTaxModal = ref(false);
const taxAmount = ref(0);
const taxCellName = ref("");

const showJailModal = ref(false);
const showAuctionModal = ref(false);
const showTradeModal = ref(false);

const hoveredCell = ref<Cell | null>(null);
const tooltipPos = ref({ x: 0, y: 0 });

const currentCell = computed<Cell | null>(() => game.currentCell);
const cellOwner = computed(() => players.value.find((p) => p.id === currentCell.value?.ownerId));

let diceBlinkInterval: number | null = null;
function stopBlink() {
  if (diceBlinkInterval !== null) {
    clearInterval(diceBlinkInterval);
    diceBlinkInterval = null;
  }
}

onMounted(() => {
  const socket = useSocket(auth.token);
  if (!socket) {
    console.warn("No socket — token empty, redirect to /");
    router.push("/");
    return;
  }
  if (typeof route.params.id === "string") {
    game.connectAndJoin(route.params.id);
  }
});

onBeforeUnmount(() => {
  stopBlink();
});

function onCellClick(payload: { cell: Cell; event: MouseEvent }) {
  hoveredCell.value = payload.cell;
  tooltipPos.value = {
    x: payload.event.clientX + 12,
    y: payload.event.clientY + 12,
  };
}

function dispatchAction(action: GameAction) {
  game.sendAction(action);
}

// росок кубиков (фаза ROLLING)
function onRoll() {
  if (!canRoll.value) return;
  // Клиент только отправляет ROLL_DICE. Сервер ответит `game:dice`
  // в начале фазы DICE_ANIMATION — store поставит diceRolling=true,
  // Dice.vue запустит 2-сек анимацию и по 'roll-done' вышлем
  // CONFIRM_DICE_ANIMATION.
  stopBlink();
  dispatchAction({ type: "ROLL_DICE" });
}

// Анимация кубиков (фаза DICE_ANIMATION)
// Dice.vue эмитит 'roll-done' ровно через 2 секунды.
// По этому событию шлём CONFIRM_DICE_ANIMATION — сервер переходит
// в MOVE_ANIMATION.
function onDiceRollDone() {
  game.setDiceRolling(false);
  if (state.value.phase === "DICE_ANIMATION" && isMyTurn.value) {
    dispatchAction({ type: "CONFIRM_DICE_ANIMATION" });
  }
}

watch(
  () => diceRolling.value,
  (rolling) => {
    if (!rolling) {
      stopBlink();
    }
  },
);

// Реакция на смену фазы
watch(
  () => state.value.phase,
  (newPhase: Phase) => {
    showJailModal.value = newPhase === "JAIL_DECISION";
    showBuyModal.value = newPhase === "BUY_DECISION" && isMyTurn.value;
    showAuctionModal.value =
      (newPhase === "AUCTION_BIDDING" || newPhase === "AUCTION_RESOLVE") &&
      (state.value.auction?.activeBidders?.includes(myPlayerId.value) ?? false);
    showTradeModal.value =
      (newPhase === "TRADING_NEGOTIATE" || newPhase === "TRADING_CONFIRM") &&
      !!state.value.trade &&
      (state.value.trade.initiatorId === myPlayerId.value ||
        state.value.trade.recipientId === myPlayerId.value);

    // TAX_PAYMENT — Подоходный налог
    // Сервер прислал state.phase = "TAX_PAYMENT" и не менял player.money.
    // Показываем модалку «Заплатите N₽». По ОК шлём CONFIRM_TAX —
    // сервер спишет деньги.
    if (newPhase === "TAX_PAYMENT" && isMyTurn.value) {
      const cell = state.value.board[currentPlayer.value?.position ?? -1];
      if (cell && cell.taxAmount) {
        taxAmount.value = cell.taxAmount;
        taxCellName.value = cell.name;
        showTaxModal.value = true;
      }
    }
    if (newPhase !== "TAX_PAYMENT") {
      showTaxModal.value = false;
    }

    // MOVE_ANIMATION — запускаем визуальное перемещение фишки.
    // Сервер прислал `state.moveAnimation = { from, to, ... }`, а позиция
    // игрока (`p.position`) ещё не изменена. Запускаем animatePlayerTo
    // от `from` к `to`; внутри неё же по завершении отправится
    // CONFIRM_MOVE_ANIMATION.
    if (newPhase === "MOVE_ANIMATION" && state.value.moveAnimation) {
      const ma = state.value.moveAnimation;
      animatePlayerTo(ma.playerId, ma.from, ma.to);
    }

    // RESOLVING_LANDING — пауза 400мс, потом авто-CONFIRM_LANDING
    // Только если это мой ход. Для бота — сервер сам пошлёт.
    if (newPhase === "RESOLVING_LANDING" && isMyTurn.value) {
      setTimeout(() => {
        if (state.value.phase === "RESOLVING_LANDING") {
          dispatchAction({ type: "CONFIRM_LANDING" });
        }
      }, 400);
    }

    // END_TURN — пауза 500мс, потом авто-CONFIRM_END_TURN
    if (newPhase === "END_TURN" && isMyTurn.value) {
      setTimeout(() => {
        if (state.value.phase === "END_TURN") {
          dispatchAction({ type: "CONFIRM_END_TURN" });
        }
      }, 500);
    }
  },
);

// Обработчики модалок
function onPayJailFine() {
  showJailModal.value = false;
  dispatchAction({ type: "PAY_JAIL_FINE" });
}

function onUseJailCard() {
  showJailModal.value = false;
  dispatchAction({ type: "USE_JAIL_CARD" });
}

function onTryDouble() {
  showJailModal.value = false;
  dispatchAction({ type: "TRY_DOUBLE" });
}

function onAuctionBid(amount: number) {
  if (!Number.isFinite(amount) || amount <= 0) {
    console.warn("Auction bid rejected: invalid amount", amount);
    return;
  }
  dispatchAction({ type: "AUCTION_BID", amount });
}

function onAuctionPass() {
  showAuctionModal.value = false;
  dispatchAction({ type: "AUCTION_PASS" });
}

function onTradeAccept() {
  dispatchAction({ type: "TRADE_ACCEPT" });
}

function onTradeReject() {
  showTradeModal.value = false;
  dispatchAction({ type: "TRADE_REJECT" });
}

function onTradeCounter(_offer: TradeOffer) {
  dispatchAction({ type: "TRADE_COUNTER", offer: _offer });
}

function onTradeCancel() {
  showTradeModal.value = false;
  dispatchAction({ type: "TRADE_CANCEL" });
}

// Анимация хода фишки (фаза MOVE_ANIMATION)
// ВАЖНО: на промежуточных клетках НИЧЕГО не срабатывает.
// Анимация идёт по stepDelay × N шагов.
// По завершении — отправляем CONFIRM_MOVE_ANIMATION → сервер
// финально перемещает игрока в handleMoveAnimation, и мы получаем
// обновлённый state с новой позицией.
const displayPositions = ref<Record<string, number>>({});

/**
 * Следим за появлением/исчезновением игроков: новых — инициализируем
 * их позицией из `state`, удалённых — выбрасываем.
 *
 * ВАЖНО: `displayPositions` НЕ обновляется автоматически по `p.position` —
 * только через `animatePlayerTo(...)`, который вызывается из watcher'а
 * `state.value.phase === "MOVE_ANIMATION"`. Это нужно, чтобы
 * анимация движения срабатывала РОВНО один раз при входе в фазу, а не
 * дублировалась, когда сервер финально обновляет `p.position` в
 * RESOLVING_LANDING (что было главным багом).
 */
watch(
  () => players.value.map((p) => p.id).join("|"),
  (newIds, oldIds) => {
    const prev = new Set((oldIds ?? "").split("|").filter(Boolean));
    const next: Record<string, number> = { ...displayPositions.value };
    for (const p of players.value) {
      if (!prev.has(p.id) || next[p.id] === undefined) {
        next[p.id] = p.position;
      }
    }
    for (const id of Array.from(Object.keys(next))) {
      if (!players.value.some((p) => p.id === id)) delete next[id];
    }
    displayPositions.value = next;
  },
  { immediate: true },
);

/**
 * Анимировать фишку `playerId` от `from` к `to` по клеткам.
 * Используется только в фазе MOVE_ANIMATION. По завершении
 * шлёт CONFIRM_MOVE_ANIMATION.
 */
let animTimers: Record<string, number> = {};
function animatePlayerTo(playerId: string, from: number, to: number) {
  if (animTimers[playerId]) {
    clearInterval(animTimers[playerId]);
    delete animTimers[playerId];
  }

  const steps = (to - from + 40) % 40;
  if (steps === 0) {
    displayPositions.value = { ...displayPositions.value, [playerId]: to };
    return;
  }

  const baseMs = 450;
  const stepDelay = baseMs / Math.max(0.25, settings.animationSpeed);
  let i = 0;
  const id = window.setInterval(() => {
    i += 1;
    const next = (from + i) % 40;
    displayPositions.value = { ...displayPositions.value, [playerId]: next };
    if (i >= steps) {
      clearInterval(id);
      delete animTimers[playerId];
      try {
        // По завершении анимации — отправляем подтверждение.
        if (state.value.phase === "MOVE_ANIMATION" && isMyTurn.value) {
          dispatchAction({ type: "CONFIRM_MOVE_ANIMATION" });
        }
      } catch (e) {
        console.warn("CONFIRM_MOVE_ANIMATION dispatch failed", e);
      }
    }
  }, stepDelay);
  animTimers[playerId] = id;
}

onBeforeUnmount(() => {
  for (const id of Object.values(animTimers)) clearInterval(id);
  animTimers = {};
});

//  Модалка карточки (фаза CARD_REVEAL)
watch(
  () => game.lastDrawnCard,
  (card) => {
    if (card) {
      cardText.value = card.text;
      cardDeck.value = (card.deck as "chance" | "treasury" | "luxury-tax") ?? "chance";
      showCardModal.value = true;
    }
  },
);

function onCloseCard() {
  showCardModal.value = false;
  // Очищаем lastDrawnCard в сторе, чтобы при следующей карточке watcher сработал.
  game.clearLastDrawnCard();
  // Если мы в CARD_REVEAL и наш ход — подтверждаем.
  if (state.value.phase === "CARD_REVEAL" && isMyTurn.value) {
    dispatchAction({ type: "CONFIRM_CARD" });
  }
}

// Модалка фиксированного налога (фаза TAX_PAYMENT)
function onCloseTax() {
  showTaxModal.value = false;
  if (state.value.phase === "TAX_PAYMENT" && isMyTurn.value) {
    dispatchAction({ type: "CONFIRM_TAX" });
  }
}

function onBuy() {
  if (!canBuy.value) return;
  showBuyModal.value = true;
}
function onConfirmBuy() {
  showBuyModal.value = false;
  dispatchAction({ type: "BUY_PROPERTY" });
}
function onDeclineBuy() {
  showBuyModal.value = false;
  dispatchAction({ type: "DECLINE_BUY" });
}

function onEndTurn() {
  if (!canEndTurn.value) {
    console.warn("End turn rejected: not my turn or wrong phase");
    return;
  }
  dispatchAction({ type: "END_TURN" });
}

function logout() {
  auth.logout();
  disconnectSocket();
  router.push("/");
}
</script>

<template>
  <div class="game-container">
    <div v-if="!game.isConnected" class="connecting">
      <p>🔄 Подкл��чение к серверу...</p>
    </div>

    <template v-else>
      <SettingsPanel />

      <Board
        :cells="cells"
        :players="players"
        :display-positions="displayPositions"
        :dice-values="diceValues"
        :dice-rolling="diceRolling"
        @cell-click="onCellClick"
        @dice-roll-done="onDiceRollDone"
      />

      <aside class="sidebar">
        <PlayersPanel :players="players" :current-player-id="currentPlayerId" />
        <ActionsPanel
          :can-roll="canRoll"
          :can-buy="canBuy"
          :can-end-turn="canEndTurn"
          :must-roll-again="mustRollAgain"
          @roll="onRoll"
          @buy="onBuy"
          @end-turn="onEndTurn"
        />
        <LogPanel />
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
        :deck="cardDeck"
        @close="onCloseCard"
      />

      <TaxModal
        :show="showTaxModal"
        :amount="taxAmount"
        :cell-name="taxCellName"
        :money="currentPlayer?.money ?? 0"
        @close="onCloseTax"
      />

      <JailModal
        :show="showJailModal"
        :jail-cards="currentPlayer?.jailCards || 0"
        :money="currentPlayer?.money || 0"
        @pay="onPayJailFine"
        @use-card="onUseJailCard"
        @try-double="onTryDouble"
        @close="showJailModal = false"
      />

      <AuctionModal
        :show="showAuctionModal"
        :state="state"
        @bid="onAuctionBid"
        @pass="onAuctionPass"
        @close="onAuctionPass"
      />

      <TradeModal
        :show="showTradeModal"
        :state="state"
        :my-player-id="myPlayerId"
        :is-confirm-phase="state.phase === 'TRADING_CONFIRM'"
        @accept="onTradeAccept"
        @reject="onTradeReject"
        @counter="onTradeCounter"
        @cancel="onTradeCancel"
        @close="onTradeCancel"
      />

      <CellTooltip :cell="hoveredCell" :owner="cellOwner" :x="tooltipPos.x" :y="tooltipPos.y" />

      <GameOverModal />
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
}
</style>
