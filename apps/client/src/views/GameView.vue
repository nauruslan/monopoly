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
import RentModal from "../components/modals/RentModal.vue";
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

// Допустимые кнопки панели действий (ОСНОВНОЙ ЦИКЛ).
//
// ВАЖНО: правила активности кнопок «Бросить кубики» и «Завершить»
// дублируют логику из `apps/server/src/games/turn-permissions.ts`.
// Это сделано намеренно (server-driven архитектура): UI и FSM
// синхронизируются по одним и тем же бизнес-правилам, без зависимости
// клиентского бандла от server-only кода.
//
// После выпадения дубля фаза возвращается в `ROLLING` с
// `mustRollAgain=true`. Раньше UI показывал активные ОБЕ кнопки
// (Бросить и Завершить) — игрок мог нажать «Завершить» и ход
// перескакивал к другому игроку, хотя правила требуют повторного
// броска. Теперь:
//   - `canRoll`     активна, если это ход игрока, фаза ROLLING
//                    и он не в тюрьме (бросок ОБЯЗАТЕЛЕН после дубля);
//   - `canEndTurn`  активна, если фаза BUILDING и `mustRollAgain=false`
//                    (завершение хода разрешено).
// В фазе ROLLING кнопка «Завершить» ВСЕГДА неактивна — бросок обязателен.
const canRoll = computed(() => {
  if (!isMyTurn.value) return false;
  if (state.value.phase !== "ROLLING") return false;
  if (currentPlayer.value?.inJail) return false;
  return true;
});
const canBuy = computed(
  () => isMyTurn.value && state.value.phase === "BUY_DECISION" && !currentPlayer.value?.inJail,
);
const canEndTurn = computed(() => {
  if (!isMyTurn.value) return false;
  // В тюрьме (JAIL_DECISION) единственный способ продолжить — END_TURN.
  if (state.value.phase === "JAIL_DECISION") return true;
  // Завершить ход можно ТОЛЬКО в фазе BUILDING (после покупки/события).
  // В фазе ROLLING бросок обязателен — кнопка «Завершить» неактивна
  // даже в начале хода без `mustRollAgain` (бросок всё равно обязателен).
  if (state.value.phase !== "BUILDING") return false;
  if (diceRolling.value) return false;
  // Если после события игрок ОБЯЗАН бросить ещё раз (правило дубля) —
  // `END_TURN` недопустим, сервер сам переключит фазу в ROLLING.
  if (currentPlayer.value?.mustRollAgain) return false;
  return true;
});
const mustRollAgain = computed(() => currentPlayer.value?.mustRollAgain === true);

// Модалки
const showBuyModal = ref(false);
const showCardModal = ref(false);
const cardText = ref("");
const cardDeck = ref<"chance" | "treasury" | "luxury-tax">("chance");

const showTaxModal = ref(false);
const taxAmount = ref(0);
const taxCellName = ref("");

const showRentModal = ref(false);
const rentAmount = ref(0);
const rentOwnerName = ref("");
const rentCellName = ref("");

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
  // Передаём прямо в стор — клиент и так подписан на game:state,
  // никакого «in-flight» флага не нужно: сервер всё равно отклонит
  // дубль (фаза уже не та), а UI синхронизируется по game:state.
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
    // Только что попал в тюрьму (в этом ходу) — модалку с тремя способами
    // выхода НЕ показываем: игроку остаётся только END_TURN. Модалка
    // появится в начале СЛЕДУЮЩЕГО хода, когда `state.justEnteredJail`
    // будет сброшен в `handleStartTurn`.
    showJailModal.value = newPhase === "JAIL_DECISION" && !state.value.justEnteredJail;
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
      // В TAX_PAYMENT мы только что приземлились — currentPlayer.position
      // уже финален, но в крайнем случае используем moveAnimation.to.
      const pos = currentPlayer.value?.position ?? state.value.moveAnimation?.to ?? -1;
      const cell = state.value.board[pos];
      if (cell && cell.taxAmount) {
        taxAmount.value = cell.taxAmount;
        taxCellName.value = cell.name;
        showTaxModal.value = true;
      }
    }
    if (newPhase !== "TAX_PAYMENT") {
      showTaxModal.value = false;
    }

    // PAY_RENT — аренда чужой собственности.
    // Сервер прислал state.phase = "PAY_RENT" + state.rentContext.
    // Деньги ещё НЕ списаны — показываем модалку «Заплатите N₽ владельцу X».
    // По «Оплатить» шлём CONFIRM_RENT_PAYMENT — сервер списывает деньги
    // и переходит в BUILDING (или ROLLING при mustRollAgain).
    if (newPhase === "PAY_RENT" && isMyTurn.value) {
      const ctx = state.value.rentContext;
      if (ctx && ctx.amount > 0) {
        rentAmount.value = ctx.amount;
        rentOwnerName.value = ctx.ownerName ?? "";
        const pos = currentPlayer.value?.position ?? state.value.moveAnimation?.to ?? -1;
        const cell = state.value.board[pos];
        rentCellName.value = cell?.name ?? "";
        showRentModal.value = true;
      } else {
        // Страховка: если сервер не положил rentContext (аномалия),
        // не блокируем партию — подтверждаем сразу, деньги не спишутся
        // (handlePayRent в этом случае тоже ничего не делает).
        console.warn("[GameView] PAY_RENT без rentContext — авто-CONFIRM");
        dispatchAction({ type: "CONFIRM_RENT_PAYMENT" });
      }
    }
    if (newPhase !== "PAY_RENT") {
      showRentModal.value = false;
    }

    // CARD_REVEAL — анализ состояния: гарантируем, что модалка карточки
    // показана. Стор `game.ts` уже вытащил cardContext.card в lastDrawnCard.
    // Если же по какой-то причине lastDrawnCard не пришёл (WS-событие
    // потерялось), пробуем ещё раз взять из state.cardContext.
    // открываем модалку ТОЛЬКО если сервер
    // подтвердил наличие карты в `state.cardContext`. Без этой проверки
    // `lastDrawnCard` мог прийти из предыдущего CARD_REVEAL (например, после
    // reconnect'а или повторного mount), и модалка появлялась повторно.
    if (newPhase === "CARD_REVEAL" && isMyTurn.value) {
      if (state.value.cardContext?.card) {
        // Свежая карта с сервера — синхронизируем UI и показываем модалку.
        lastDrawnCard.value = state.value.cardContext.card;
        cardText.value = state.value.cardContext.card.text;
        cardDeck.value =
          (state.value.cardContext.card.deck as "chance" | "treasury" | "luxury-tax") ?? "chance";
        showCardModal.value = true;
      } else if (lastDrawnCard.value) {
        // Fallback: WS-событие `game:card` потерялось, но lastDrawnCard
        // остался с момента предыдущего CARD_REVEAL. Не показываем модалку
        // повторно — используем кешированную карту, но только если мы
        // уверены, что это ТЕКУЩАЯ карта (а не из прошлого цикла).
        // Чтобы исключить дубль, требуем совпадение с уже сохранённым
        // cardContext. Если cardContext нет — лучше авто-confirm, чем
        // показывать старую карту.
        console.warn(
          "[GameView] CARD_REVEAL без cardContext, но есть lastDrawnCard — авто-CONFIRM",
        );
        dispatchAction({ type: "CONFIRM_CARD" });
      } else {
        // Страховка: если модалку нечем заполнить, не блокируем партию —
        // шлём CONFIRM_CARD сразу, чтобы сервер не «завис» в CARD_REVEAL.
        console.warn("[GameView] CARD_REVEAL без cardContext — авто-CONFIRM");
        dispatchAction({ type: "CONFIRM_CARD" });
      }
    }
    if (newPhase !== "CARD_REVEAL") {
      showCardModal.value = false;
    }

    // MOVE_ANIMATION — запускаем визуальное перемещение фишки.
    // Сервер прислал `state.moveAnimation = { from, to, ... }`. Запускаем
    // animatePlayerTo от `from` к `to`; внутри по завершении отправится
    // CONFIRM_MOVE_ANIMATION.
    //
    // ВАЖНО: срабатывает и для обычного броска кубиков, и для телепорта
    // карточки (move / move-relative) — оба пути теперь заполняют
    // state.moveAnimation в GamesService.
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
// Мгновенный телепорт в тюрьму: когда сервер только что отправил игрока
// в тюрьму (картой/3 дублями/клеткой), state.justEnteredJail=true,
// фаза JAIL_DECISION, но MOVE_ANIMATION не запускается. Синхронизируем
// displayPositions с реальной player.position (тюрьма = 10), чтобы
// фишка «прыгнула» без анимации.
//
// ВАЖНО: watcher регистрируется ВНУТРИ setup как самостоятельный
// top-level watch — иначе он не будет реактивным (раньше был вложен
// внутрь phase watcher'а, что приводило к пересозданию и потере
// срабатывания, а также к TDZ-ошибке из-за `let animTimers` ниже).
const displayPositions = ref<Record<string, number>>({});
let animTimers: Record<string, number> = {};

watch(
  () => state.value.justEnteredJail,
  (justEntered) => {
    if (!justEntered) return;
    const p = currentPlayer.value;
    if (!p) return;
    // Очистим активный таймер анимации, если он был.
    if (animTimers[p.id]) {
      clearInterval(animTimers[p.id]);
      delete animTimers[p.id];
    }
    displayPositions.value = {
      ...displayPositions.value,
      [p.id]: p.position,
    };
  },
);

// Подстраховка: если сервер прислал state с уже justEnteredJail=true
// (например, при reconnect/mount), watcher на phase мог не сработать.
// Следим за изменением currentPlayer.position пока justEnteredJail=true
// — если позиция поменялась (телепорт на 10), мгновенно синхронизируем.
watch(
  () => [currentPlayer.value?.id, currentPlayer.value?.position] as const,
  ([, pos], [, oldPos]) => {
    if (pos === undefined || oldPos === undefined) return;
    if (pos === oldPos) return;
    if (!state.value.justEnteredJail) return;
    const p = currentPlayer.value;
    if (!p) return;
    if (animTimers[p.id]) {
      clearInterval(animTimers[p.id]);
      delete animTimers[p.id];
    }
    displayPositions.value = {
      ...displayPositions.value,
      [p.id]: pos,
    };
  },
);

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
// ранний `watch(() => game.lastDrawnCard)` открывал
// модалку на КАЖДОЕ появление карты — из WS-события `game:card`, из
// `state.cardContext` и из `response.data.card` callback'а `sendAction`.
// Сейчас показом модалки управляет ЕДИНСТВЕННЫЙ phase-watcher
// он использует
// только что полученный с сервера `state.cardContext.card` и не
// полагается на lastDrawnCard. Поэтому отдельный watcher на lastDrawnCard
// был источником двойного открытия и теперь удалён.

function onCloseCard() {
  if (!showCardModal.value) return; // защита от двойного onCloseCard
  showCardModal.value = false;
  // Очищаем lastDrawnCard в сторе, чтобы при следующей карточке watcher
  // в сторе (если он там нужен) сработал корректно. UI-источник истины
  // для модалки — это `state.phase === "CARD_REVEAL"` + `state.cardContext`.
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

// Модалка аренды (фаза PAY_RENT)
function onCloseRent() {
  showRentModal.value = false;
  if (state.value.phase === "PAY_RENT" && isMyTurn.value) {
    dispatchAction({ type: "CONFIRM_RENT_PAYMENT" });
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

      <RentModal
        :show="showRentModal"
        :amount="rentAmount"
        :owner-name="rentOwnerName"
        :cell-name="rentCellName"
        :money="currentPlayer?.money ?? 0"
        @close="onCloseRent"
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
