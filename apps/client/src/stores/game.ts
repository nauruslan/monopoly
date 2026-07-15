import { defineStore } from "pinia";
import { ref, computed } from "vue";
import type { GameState, Phase, Player, Card } from "@monopoly/shared";
import { BOARD, DEFAULT_SETTINGS } from "@monopoly/shared";
import { getSocket, setLastGameId } from "../composables/useSocket";
import type { GameAction } from "@monopoly/shared";

/**
 * Игровой стор Pinia.
 *
 * ВАЖНО: (FSM) сервер — единственный источник правды.
 * Клиент НЕ мутирует `state` локально. Все игровые операции
 * (бросок, покупка, залог, торг, ...) отправляются на сервер
 * через `sendAction(action)`, а обновлённое `state` приходит
 * через WS-событие `game:state`.
 *
 * ## Фазовая синхронизация
 *
 * Каждая «визуальная» фаза на клиенте запускает анимацию, и по её завершении
 * клиент отправляет соответствующее `CONFIRM_*` действие:
 *
 * - `DICE_ANIMATION`      → 2 секунды крутки кубиков → `CONFIRM_DICE_ANIMATION`
 * - `MOVE_ANIMATION`      → 450мс × N шагов фишки → `CONFIRM_MOVE_ANIMATION`
 * - `CARD_REVEAL`         → показ модалки → пользователь жмёт OK → `CONFIRM_CARD`
 * - `RESOLVING_LANDING`   → 400мс пауза → `CONFIRM_LANDING`
 * - `END_TURN`            → 500мс пауза → `CONFIRM_END_TURN`
 *
 * Сервер сам не двигает фишку, пока клиент не подтвердит, что анимация
 * закончилась. Это гарантирует, что эффекты клеток (CHANCE, TAX, ...)
 * срабатывают ТОЛЬКО после полной остановки фишки.
 */
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
    settings: { ...DEFAULT_SETTINGS },
    seed: "client-init",
    createdAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
  });

  // ============ WS-STATE ============
  const gameId = ref<string>("");
  const isConnected = ref(false);
  const socketError = ref<string | null>(null);

  // ============ DICE (значения приходят с сервера) ============
  const diceValues = ref<[number, number]>([1, 1]);
  const diceRolling = ref(false);
  const lastDiceRoll = ref<[number, number] | null>(null);
  const lastDicePlayerId = ref<string | null>(null);
  const lastDiceIsDouble = ref(false);

  // ============ CARDS (последняя карточка с сервера) ============
  const lastDrawnCard = ref<Card | null>(null);
  /**
   * `true` пока фаза `CARD_REVEAL`. Используется для UI-индикации,
   * что карточка ещё не применена.
   */
  const cardPendingConfirm = ref(false);

  const currentPlayer = computed<Player | null>(
    () => state.value.players[state.value.currentPlayerIndex] || null,
  );

  const currentCell = computed(() => {
    const p = currentPlayer.value;
    if (!p) return null;
    return state.value.board[p.position] || null;
  });

  // ============ WS-CONNECTION ============

  function connectAndJoin(gId: string) {
    gameId.value = gId;
    setLastGameId(gId);
    const socket = getSocket();
    if (!socket) {
      console.error("Socket not initialized. Call useSocket(token) first.");
      return;
    }

    socket.off("game:state");
    socket.off("lobby:update");
    socket.off("game:error");
    socket.off("game:dice");
    socket.off("game:card");

    socket.on("game:state", (newState: GameState) => {
      console.log(
        `[game.ts] game:state received: phase=${newState.phase} currentPlayer=${
          newState.players[newState.currentPlayerIndex]?.id
        } pos=${newState.players[newState.currentPlayerIndex]?.position}`,
      );
      state.value = newState;
      // Сбрасываем cardPendingConfirm при смене фазы с CARD_REVEAL.
      if (newState.phase !== "CARD_REVEAL" && newState.phase !== "CARD_EFFECT") {
        cardPendingConfirm.value = false;
      }
      if (newState.phase === "CARD_REVEAL") {
        cardPendingConfirm.value = true;
      }
    });
    socket.on("lobby:update", () => {
      /* обновление списка игроков */
    });
    socket.on("game:error", (e: { message: string }) => {
      socketError.value = e.message;
    });

    socket.on(
      "game:dice",
      (payload: { playerId: string; dice: [number, number]; isDouble: boolean }) => {
        console.log(
          `[game.ts] game:dice received: [${payload.dice[0]}, ${payload.dice[1]}] playerId=${payload.playerId} isDouble=${payload.isDouble}`,
        );
        // Сервер прислал значения кубиков в начале фазы DICE_ANIMATION.
        // Запускаем 2-секундную CSS-анимацию: Dice.vue эмитит 'roll-done'
        // через ROLL_MS, и GameView отправляет CONFIRM_DICE_ANIMATION.
        diceValues.value = payload.dice;
        lastDiceRoll.value = payload.dice;
        lastDicePlayerId.value = payload.playerId;
        lastDiceIsDouble.value = payload.isDouble;
        diceRolling.value = true;
      },
    );

    socket.on("game:card", (payload: { playerId: string; card: Card }) => {
      console.log(`[game.ts] game:card received: playerId=${payload.playerId}`);
      lastDrawnCard.value = payload.card;
      cardPendingConfirm.value = true;
    });

    socket.emit(
      "lobby:join",
      { gameId: gId },
      (response: { ok: boolean; data?: { state: GameState }; error?: string }) => {
        if (response.ok && response.data) {
          state.value = response.data.state;
          isConnected.value = true;
        } else {
          socketError.value = response.error ?? "Join failed";
        }
      },
    );
  }

  function createGameOnServer(playerNames: string[]) {
    const socket = getSocket();
    if (!socket) return Promise.reject(new Error("No socket"));

    return new Promise<{ gameId: string; state: GameState }>((resolve, reject) => {
      socket.emit(
        "lobby:create",
        { playerNames },
        (response: {
          ok: boolean;
          data?: { gameId: string; state: GameState };
          error?: string;
        }) => {
          if (response.ok && response.data) {
            state.value = response.data.state;
            gameId.value = response.data.gameId;
            setLastGameId(response.data.gameId);
            isConnected.value = true;
            resolve(response.data);
          } else {
            reject(new Error(response.error ?? "Create failed"));
          }
        },
      );
    });
  }

  /**
   * Отправить действие на сервер. UI никогда не мутирует `state` локально —
   * сервер пришлёт обновлённый `game:state` после применения.
   */
  function sendAction(action: GameAction) {
    const socket = getSocket();
    if (!socket || !gameId.value) return;

    socket.emit(
      "game:action",
      { gameId: gameId.value, action },
      (response: {
        ok: boolean;
        data?: { state?: GameState; dice?: [number, number]; card?: Card | null };
        error?: string;
      }) => {
        if (!response.ok) {
          console.error("Action failed:", response.error);
          return;
        }
        if (response.data?.card) {
          lastDrawnCard.value = response.data.card;
          cardPendingConfirm.value = true;
        }
      },
    );
  }

  // ============ DICE ANIMATION (UI-only) ============
  function setDiceRolling(v: boolean) {
    diceRolling.value = v;
  }
  function setDiceValues(v: [number, number]) {
    diceValues.value = v;
  }

  /**
   * Сбросить последнюю карточку (вызывается после `CONFIRM_CARD`).
   */
  function clearLastDrawnCard() {
    lastDrawnCard.value = null;
    cardPendingConfirm.value = false;
  }

  return {
    state,
    gameId,
    isConnected,
    socketError,
    diceValues,
    diceRolling,
    lastDiceRoll,
    lastDicePlayerId,
    lastDiceIsDouble,
    currentPlayer,
    currentCell,
    lastDrawnCard,
    cardPendingConfirm,
    connectAndJoin,
    createGameOnServer,
    sendAction,
    setDiceRolling,
    setDiceValues,
    clearLastDrawnCard,
  };
});
