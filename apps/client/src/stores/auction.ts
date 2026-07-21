/**
 * useAuctionStore — Pinia-store для аукциона на клиенте (v2).
 *
 * Является UI-проекцией `state.auction` с сервера. Не хранит бизнес-логику —
 * только:
 *  - производные computed (minNextBid, isOnClock, canBid, canPass);
 *  - локальный тик-таймер для UI (сама игра идёт по серверу);
 *  - методы `bid`/`pass`, которые шлют `GameAction` на сервер через
 *    основной `useGameStore.sendAction`.
 *  - подписку на события `auction:event` для мгновенного обновления UI
 *    без задержки `game:state` (например, для анимации чужого хода).
 *
 * Все derived-значения берут `state.auction` (server-of-truth), ничего
 * не угадывая.
 */
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { defineStore } from "pinia";
import { useGameStore } from "./game";
import type { GameState } from "@monopoly/shared";

/** Статус аукциона (UI-представление). */
export type AuctionUiStatus = "none" | "AWAITING_START" | "AUCTION_ACTIVE" | "FINISHED";

/** Локальное зеркало последнего AUCTION_TURN_UPDATE для UI. */
interface LocalTurnSnapshot {
  activeBidderId: string | null;
  currentBid: number;
  highestBidderId: string | null;
  activeBidders: string[];
  timeLeft: number;
  receivedAt: number;
}

/** Локальное зеркало последнего AUCTION_ACTION для UI. */
interface LocalActionEntry {
  playerId: string;
  action: "BID" | "PASS" | "TIMEOUT";
  amount?: number;
  at: number;
}

export const useAuctionStore = defineStore("auction", () => {
  const game = useGameStore();

  /** Локальный таймер UI (тикает каждую 100мс). */
  const localNow = ref(Date.now());
  let timerId: ReturnType<typeof setInterval> | null = null;

  function startLocalTimer() {
    if (timerId !== null) return;
    timerId = setInterval(() => {
      localNow.value = Date.now();
    }, 100);
  }

  function stopLocalTimer() {
    if (timerId !== null) {
      clearInterval(timerId);
      timerId = null;
    }
  }

  // События auction:event
  // Сервер шлёт события по каналу auction:event для мгновенного UI.
  const lastTurnUpdate = ref<LocalTurnSnapshot | null>(null);
  const lastAction = ref<LocalActionEntry | null>(null);

  // Текущий мой playerId (устанавливается извне через setMyPlayerId).
  const _myPlayerId = ref<string | null>(null);
  function setMyPlayerId(id: string | null) {
    _myPlayerId.value = id;
  }

  // Следим за наличием аукциона в state — запускаем/останавливаем таймер.
  watch(
    () => game.state?.auction,
    (a) => {
      if (a && a.status === "AUCTION_ACTIVE") startLocalTimer();
      else stopLocalTimer();
    },
    { immediate: true },
  );

  onBeforeUnmount(() => stopLocalTimer());

  // Подписка на WS-события (auction:event)
  function bindSocketListeners() {
    const socket = (
      game as unknown as { socket?: { on: (e: string, cb: (...a: unknown[]) => void) => void } }
    ).socket;
    if (!socket) return;
    socket.on("auction:event", (raw: unknown) => {
      const ev = raw as
        | { type: "AUCTION_START"; [k: string]: unknown }
        | {
            type: "AUCTION_TURN_UPDATE";
            activeBidderId: string | null;
            currentBid: number;
            highestBidderId: string | null;
            activeBidders: string[];
            timeLeft: number;
          }
        | {
            type: "AUCTION_ACTION";
            playerId: string;
            action: "BID" | "PASS" | "TIMEOUT";
            amount?: number;
          }
        | { type: "AUCTION_END"; [k: string]: unknown };
      if (!ev) return;
      switch (ev.type) {
        case "AUCTION_TURN_UPDATE":
          lastTurnUpdate.value = {
            activeBidderId: ev.activeBidderId,
            currentBid: ev.currentBid,
            highestBidderId: ev.highestBidderId,
            activeBidders: ev.activeBidders,
            timeLeft: ev.timeLeft,
            receivedAt: Date.now(),
          };
          break;
        case "AUCTION_ACTION":
          lastAction.value = {
            playerId: ev.playerId,
            action: ev.action,
            amount: ev.amount,
            at: Date.now(),
          };
          break;
        default:
          // AUCTION_START / AUCTION_END: state придёт через game:state.
          break;
      }
    });
  }

  // Пытаемся подписаться сразу; если сокета ещё нет — вызывающий код
  // может повторить через bindSocketListeners после создания.
  bindSocketListeners();

  // computed (server-of-truth)

  const state = computed<GameState | null>(() => game.state);

  const auction = computed(() => state.value?.auction ?? null);

  const status = computed<AuctionUiStatus>(() => {
    if (!auction.value) return "none";
    return auction.value.status as AuctionUiStatus;
  });

  const cellId = computed<number | null>(() => auction.value?.cellId ?? null);

  const cell = computed(() => {
    if (cellId.value === null || !state.value) return null;
    return state.value.board[cellId.value] ?? null;
  });

  const currentBid = computed<number>(() => {
    // Сначала берём AUCTION_TURN_UPDATE (быстрее, чем game:state).
    if (lastTurnUpdate.value) return lastTurnUpdate.value.currentBid;
    return auction.value?.currentBid ?? 0;
  });

  const highestBidderId = computed<string | null>(() => {
    if (lastTurnUpdate.value) return lastTurnUpdate.value.highestBidderId;
    return auction.value?.highestBidderId ?? null;
  });

  const currentBidderId = computed<string | null>(() => {
    if (lastTurnUpdate.value) return lastTurnUpdate.value.activeBidderId;
    return auction.value?.currentBidderId ?? null;
  });

  const bidderOrder = computed<string[]>(() => auction.value?.bidderOrder ?? []);

  const activeBidders = computed<string[]>(() => {
    if (lastTurnUpdate.value) return lastTurnUpdate.value.activeBidders;
    return auction.value?.activeBidders ?? [];
  });

  const actionLog = computed(() => auction.value?.actionLog ?? []);

  const winnerId = computed<string | null>(() => auction.value?.winnerId ?? null);
  const finalBid = computed<number>(() => auction.value?.finalBid ?? 0);
  const finishReason = computed<"SOLD" | "UNSOLD" | null>(
    () => auction.value?.finishReason ?? null,
  );

  // Минимальная ставка: max(1, 5% от cell.price, currentBid+10).
  const minNextBid = computed<number>(() => {
    if (!auction.value) return 0;
    const cellPrice = cell.value?.price ?? 0;
    const minInc = Math.max(10, Math.floor(cellPrice * 0.05));
    return currentBid.value + minInc;
  });

  // myPlayerId
  const myPlayerId = computed<string | null>(() => {
    if (_myPlayerId.value) return _myPlayerId.value;
    if (!state.value) return null;
    // Фолбэк: первый не-бот игрок.
    const me = state.value.players.find((p) => p.kind === "human");
    return me?.id ?? state.value.players[0]?.id ?? null;
  });

  // Производные статусы
  const onClockPlayer = computed<{
    id: string;
    name: string;
    money: number;
  } | null>(() => {
    if (!auction.value || !currentBidderId.value || !state.value) return null;
    const p = state.value.players.find((pl) => pl.id === currentBidderId.value);
    if (!p) return null;
    return { id: p.id, name: p.displayName, money: p.money };
  });

  const leaderPlayer = computed<{
    id: string;
    name: string;
  } | null>(() => {
    if (!highestBidderId.value || !state.value) return null;
    const p = state.value.players.find((pl) => pl.id === highestBidderId.value);
    if (!p) return null;
    return { id: p.id, name: p.displayName };
  });

  const winnerInfo = computed<{
    id: string;
    name: string;
    amount: number;
  } | null>(() => {
    if (!winnerId.value || !state.value) return null;
    const p = state.value.players.find((pl) => pl.id === winnerId.value);
    return { id: winnerId.value, name: p?.displayName ?? "?", amount: finalBid.value };
  });

  /** Сколько секунд осталось (для UI). Использует локальный тик. */
  const turnRemainingSec = computed<number>(() => {
    if (!auction.value || auction.value.status !== "AUCTION_ACTIVE") return 0;
    const total = auction.value.turnDurationMs;
    const started = auction.value.timerStartedAt;
    const remaining = started + total - localNow.value;
    return Math.max(0, Math.ceil(remaining / 1000));
  });

  /** Прогресс 0..1 для круговой шкалы. */
  const timerProgress = computed<number>(() => {
    if (!auction.value) return 0;
    const total = auction.value.turnDurationMs;
    if (total <= 0) return 0;
    const started = auction.value.timerStartedAt;
    const remaining = Math.max(0, started + total - localNow.value);
    return Math.max(0, Math.min(1, remaining / total));
  });

  const isOnClock = computed<boolean>(
    () => myPlayerId.value !== null && myPlayerId.value === currentBidderId.value,
  );

  const isLeader = computed<boolean>(
    () => myPlayerId.value !== null && myPlayerId.value === highestBidderId.value,
  );

  const isParticipant = computed<boolean>(() => {
    if (!auction.value || !myPlayerId.value) return false;
    return activeBidders.value.includes(myPlayerId.value);
  });

  const myMoney = computed<number>(() => {
    if (!state.value || !myPlayerId.value) return 0;
    return state.value.players.find((p) => p.id === myPlayerId.value)?.money ?? 0;
  });

  // Можно ли сделать ставку: на часах, не лидер (лидер пасует),
  // хватает денег (minNextBid + запас).
  const canBid = computed<boolean>(() => {
    if (status.value !== "AUCTION_ACTIVE") return false;
    if (!isOnClock.value) return false;
    return myMoney.value >= minNextBid.value;
  });

  const canPass = computed<boolean>(() => {
    if (status.value !== "AUCTION_ACTIVE") return false;
    if (!isOnClock.value) return false;
    return true;
  });

  // Участники (для UI-карточек)
  // lastBidByPlayer: последняя ставка игрока в текущем аукционе
  // (берём из actionLog; если действий не было — null).
  const lastBidByPlayer = computed<Record<string, number>>(() => {
    const out: Record<string, number> = {};
    const log = auction.value?.actionLog ?? [];
    // идём с конца — первое вхождение = последняя ставка игрока
    for (let i = log.length - 1; i >= 0; i--) {
      const e = log[i];
      if (e.action === "BID" && e.amount !== undefined && out[e.playerId] === undefined) {
        out[e.playerId] = e.amount;
      }
    }
    return out;
  });

  const participants = computed<
    Array<{
      id: string;
      name: string;
      money: number;
      status: "active" | "onClock" | "passed" | "leader" | "winner" | "unsold";
      isMe: boolean;
      isLeader: boolean;
      isOnClock: boolean;
      isPassed: boolean;
      isWinner: boolean;
      /** Текущая ставка игрока в этом аукционе (если делал). */
      bid: number | null;
      /** true, если игрок спасовал (выбыл) в текущем/завершённом аукционе. */
      didPass: boolean;
    }>
  >(() => {
    if (!auction.value || !state.value) return [];
    const a = auction.value;
    const activeSet = new Set(a.activeBidders);
    return a.bidderOrder.map((id) => {
      const player = state.value!.players.find((p) => p.id === id);
      const isPassed = a.status === "AUCTION_ACTIVE" ? !activeSet.has(id) : false;
      const isOnClock = a.currentBidderId === id && a.status === "AUCTION_ACTIVE";
      const isLeader = a.highestBidderId === id;
      const isWinner = a.status === "FINISHED" && a.finishReason === "SOLD" && a.winnerId === id;
      let uiStatus: "active" | "onClock" | "passed" | "leader" | "winner" | "unsold" = "active";
      if (a.status === "FINISHED" && a.finishReason === "UNSOLD") uiStatus = "unsold";
      else if (isWinner) uiStatus = "winner";
      else if (isOnClock) uiStatus = "onClock";
      else if (isLeader) uiStatus = "leader";
      else if (isPassed) uiStatus = "passed";
      return {
        id,
        name: player?.displayName ?? "?",
        money: player?.money ?? 0,
        status: uiStatus,
        isMe: id === myPlayerId.value,
        isLeader,
        isOnClock,
        isPassed,
        isWinner,
        bid: lastBidByPlayer.value[id] ?? null,
        // didPass: был ли пас игрока (зафиксировано в actionLog как PASS/TIMEOUT)
        didPass: (a.actionLog ?? []).some(
          (e) => e.playerId === id && (e.action === "PASS" || e.action === "TIMEOUT"),
        ),
      };
    });
  });

  // actions
  function bid(amount: number): void {
    if (!auction.value) return;
    game.sendAction({ type: "AUCTION_MAKE_BID", amount });
  }

  function pass(): void {
    if (!auction.value) return;
    game.sendAction({ type: "AUCTION_PASS" });
  }

  /** Быстрая ставка «minNextBid + step». */
  function quickBid(step: number): void {
    bid(minNextBid.value + step);
  }

  /** Подключить подписку на WS-события (вызывать после создания сокета). */
  function attach() {
    bindSocketListeners();
  }

  return {
    // setup
    setMyPlayerId,
    attach,
    bindSocketListeners,
    // state
    state,
    auction,
    status,
    cell,
    cellId,
    currentBid,
    highestBidderId,
    currentBidderId,
    bidderOrder,
    activeBidders,
    actionLog,
    winnerId,
    finalBid,
    finishReason,
    // local event cache
    lastTurnUpdate,
    lastAction,
    // derived
    minNextBid,
    onClockPlayer,
    leaderPlayer,
    winnerInfo,
    turnRemainingSec,
    timerProgress,
    myPlayerId,
    isOnClock,
    isLeader,
    isParticipant,
    myMoney,
    canBid,
    canPass,
    participants,
    // actions
    bid,
    pass,
    quickBid,
  };
});
