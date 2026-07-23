import { defineStore } from "pinia";
import { ref, computed } from "vue";
import type { GameState, Phase, Player, Card, GameEvent } from "@monopoly/shared";
import { BOARD, DEFAULT_SETTINGS } from "@monopoly/shared";
import { getSocket, setLastGameId } from "../composables/useSocket";
import type { GameAction } from "@monopoly/shared";
import { useTradeStore } from "./trade";

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

  // WS-STATE
  const gameId = ref<string>("");
  const isConnected = ref(false);
  const socketError = ref<string | null>(null);

  // DICE (значения приходят с сервера)
  const diceValues = ref<[number, number]>([1, 1]);
  const diceRolling = ref(false);
  const lastDiceRoll = ref<[number, number] | null>(null);
  const lastDicePlayerId = ref<string | null>(null);
  const lastDiceIsDouble = ref(false);

  // CARDS (последняя карточка с сервера)
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

  // WS-CONNECTION

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
    socket.off("game:event");

    socket.on("game:state", (newState: GameState) => {
      console.log(
        `[game.ts] game:state received: phase=${newState.phase} currentPlayer=${
          newState.players[newState.currentPlayerIndex]?.id
        } pos=${newState.players[newState.currentPlayerIndex]?.position}`,
      );
      const previousPhase = state.value.phase;
      state.value = newState;
      // Сбрасываем cardPendingConfirm при смене фазы с CARD_REVEAL.
      if (newState.phase !== "CARD_REVEAL" && newState.phase !== "CARD_EFFECT") {
        cardPendingConfirm.value = false;
      }
      // восстановление значений кубиков при reconnect/reload.
      // Сервер хранит «последний бросок» в `state.lastDice`. Если игрок
      // перезагрузил страницу прямо во время DICE_ANIMATION (или только
      // что подключился к активной партии), у него нет события `game:dice`
      // в прошлом, и UI показывает дефолтные [1,1] — это дезориентирует.
      // Синхронизируем локальный кеш с сервером:
      if (newState.phase === "DICE_ANIMATION" && newState.lastDice) {
        diceValues.value = newState.lastDice.dice;
        lastDiceIsDouble.value = newState.lastDice.isDouble;
        diceRolling.value = true;
        // `lastDiceRoll`/`lastDicePlayerId` здесь не заполняем — это
        // «архив» для UI, он используется только когда анимация
        // закончилась, и заполняется в `game:dice`-обработчике.
      } else if (newState.phase !== "DICE_ANIMATION" && newState.phase !== "MOVE_ANIMATION") {
        // Во всех «деловых» фазах кубики крутиться не должны. Сбрасываем
        // флаг, чтобы кнопка "Бросить кубики" могла снова стать активной
        // после возврата из DICE_ANIMATION.
        diceRolling.value = false;
      }
      if (newState.phase === "CARD_REVEAL") {
        cardPendingConfirm.value = true;
        // Анализ состояния: берём карту прямо из `state.cardContext`,
        // чтобы UI мог отрисовать модалку даже если WS-событие `game:card`
        // по какой-то причине не дошло (потеря пакета, реконнект и т.п.).
        if (newState.cardContext?.card) {
          lastDrawnCard.value = newState.cardContext.card;
        }
      }
      // После CARD_REVEAL карта «съедена» — обнуляем локальный кеш
      // НЕЗАВИСИМО от того, очистил ли сервер cardContext.
      // (Раньше очистка зависела от `!newState.cardContext` — ненадёжно:
      // для move/move-relative сервер оставлял cardContext заполненным
      // до следующего CARD_REVEAL, и `lastDrawnCard` не сбрасывался, из-за
      // чего модалка могла появиться второй раз при повторном получении
      // game:state — reconnect, повторный mount и т.п.)
      if (previousPhase === "CARD_REVEAL" && newState.phase !== "CARD_REVEAL") {
        lastDrawnCard.value = null;
        cardPendingConfirm.value = false;
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
    });

    /**
     * Подписка на события игрового журнала. Используется не только для
     * `LogPanel`, но и для обновления UI-состояния торговли: когда сервер
     * присылает `TRADE_COMPLETED` / `TRADE_REJECTED` / `TRADE_CANCELLED`,
     * мы переключаем trade-store на экран уведомления о результате, чтобы
     * пользователь увидел «Сделка состоялась!» / «Сделка отклонена» /
     * «Сделка отменена» и подтвердил это нажатием «Принять».
     */
    socket.on("game:event", (ev: GameEvent) => {
      handleGameEventForTrade(ev);
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

  /**
   * Реакция на игровые события, относящиеся к торговле. Вызывается
   * из `game:event`-обработчика.
   *
   * Показывает модальное окно уведомления с результатом сделки.
   * Закрывается оно ТОЛЬКО через кнопку «Принять» в `TradeModal.vue`.
   */
  function handleGameEventForTrade(ev: GameEvent): void {
    if (
      ev.kind !== "TRADE_COMPLETED" &&
      ev.kind !== "TRADE_REJECTED" &&
      ev.kind !== "TRADE_CANCELLED"
    ) {
      return;
    }
    const trade = useTradeStore();
    const myId = trade.myId;
    const otherId = ev.payload?.otherPlayerId;
    // Имя второй стороны для UI: пробуем взять из trade.recipient (если
    // ещё не закрыли модалку), иначе по otherPlayerId, иначе "игрок".
    let partnerName = "игрок";
    if (otherId) {
      const p = state.value.players.find((pl) => pl.id === otherId);
      if (p) partnerName = p.displayName;
    } else if (trade.recipient) {
      partnerName = trade.recipient.displayName;
    } else if (myId && ev.playerId && ev.playerId !== myId) {
      const p = state.value.players.find((pl) => pl.id === ev.playerId);
      if (p) partnerName = p.displayName;
    }

    // Сервер уже прислал готовое русское сообщение в `ev.message` —
    // используем его как «детали», чтобы текст был консистентным с
    // игровым журналом.
    let status: "accepted" | "rejected" | "cancelled";
    let title: string;
    if (ev.kind === "TRADE_COMPLETED") {
      status = "accepted";
      // Если событие относится ко мне как инициатору — поздравляем,
      // иначе — нейтральное уведомление.
      if (ev.playerId === myId) {
        title = "🎉 Сделка состоялась!";
      } else {
        title = "✅ Сделка состоялась";
      }
    } else if (ev.kind === "TRADE_REJECTED") {
      status = "rejected";
      title = "❌ Сделка отклонена";
    } else {
      status = "cancelled";
      title = "🚫 Сделка отменена";
    }

    trade.setResult({
      status,
      partnerName,
      title,
      details: ev.message,
    });
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
      },
    );
  }

  // DICE ANIMATION (UI-only)
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
