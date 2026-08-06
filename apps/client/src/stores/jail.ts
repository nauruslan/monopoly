/**
 * useJailStore — Pinia-store для UI модалки «Выход из тюрьмы» на клиенте.
 *
 * Модалка с тремя опциями:
 *   - заплатить 50₽ (PAY_JAIL_FINE);
 *   - использовать карточку выхода (USE_JAIL_CARD);
 *   - попробовать выбросить дубль (TRY_DOUBLE).
 *
 * ВНИМАНИЕ: Этот стор содержит ТОЛЬКО локальное UI-состояние
 * (открыта/закрыта модалка, последнее сообщение об ошибке).
 * ВСЯ серверная логика (правила 3 попыток, штраф, карточки,
 * `tryDoubleOrPay`) живёт на сервере — см. `JailHandlerService`
 * в apps/server и `handleJailDecision` в `GamesService`.
 * Клиент только:
 *   - открывает/закрывает модалку (в ответ на серверные фазы);
 *   - шлёт `PAY_JAIL_FINE` / `USE_JAIL_CARD` / `TRY_DOUBLE` actions;
 *   - получает ошибки от сервера и отображает их.
 */
import { computed, ref } from "vue";
import { defineStore } from "pinia";
import { useGameStore } from "./game";
import type { GameState, Player } from "@monopoly/shared";

export const useJailStore = defineStore("jail", () => {
  const game = useGameStore();

  //  Local state

  /** Открыта ли модалка выхода из тюрьмы. */
  const isOpen = ref<boolean>(false);

  /** Текст последней ошибки от сервера. */
  const lastError = ref<string | null>(null);

  //  Computed (server-of-truth)

  const state = computed<GameState | null>(() => game.state);

  /** Текущий игрок (для которого мы показываем модалку). */
  const me = computed<Player | null>(() => {
    if (!state.value) return null;
    return state.value.players.find((p) => p.kind === "human") ?? null;
  });

  /** «Только что попал в тюрьму» для меня. Строгая проверка по targetPlayer. */
  const isJustEnteredForMe = computed<boolean>(() => {
    const s = state.value;
    if (!s) return false;
    const meId = me.value?.id;
    const target = s.players[s.currentPlayerIndex];
    if (!meId || !target) return false;
    // В позиции «тюрьма» (клетка 10). Если игрок только что попал — там.
    // Дополнительно проверяем `justEnteredJail` как дополнительный сигнал,
    // но ГЛАВНОЕ — позиция = 10 и target — это я.
    return !!s.justEnteredJail && target.id === meId && target.position === 10;
  });

  /** Могу ли я сейчас выйти из тюрьмы (PAY_FINE / USE_CARD / TRY_DOUBLE). */
  const canActInJail = computed<boolean>(() => {
    const s = state.value;
    if (!s || !me.value) return false;
    return (
      s.phase === "JAIL_DECISION" &&
      !isJustEnteredForMe.value &&
      me.value.inJail === true &&
      me.value.money >= 0 // в тюрьме тоже нужно платить; банкрот блокирует
    );
  });

  //  Actions

  /** Открыть модалку. */
  function open(): void {
    lastError.value = null;
    isOpen.value = true;
  }

  /** Закрыть модалку (без отправки на сервер). */
  function close(): void {
    lastError.value = null;
    isOpen.value = false;
  }

  /** Заплатить штраф 50₽. */
  function payFine(): void {
    lastError.value = null;
    game.sendAction({ type: "PAY_JAIL_FINE" });
    // Сервер сам закроет модалку через `phase → ROLLING` → close().
  }

  /** Использовать карточку выхода из тюрьмы. */
  function useCard(): void {
    lastError.value = null;
    game.sendAction({ type: "USE_JAIL_CARD" });
  }

  /** Попробовать выбросить дубль. */
  function tryDouble(): void {
    lastError.value = null;
    game.sendAction({ type: "TRY_DOUBLE" });
  }

  function setError(msg: string | null): void {
    lastError.value = msg;
  }

  return {
    // state
    isOpen,
    lastError,
    // computed
    state,
    me,
    isJustEnteredForMe,
    canActInJail,
    // actions
    open,
    close,
    payFine,
    useCard,
    tryDouble,
    setError,
  };
});
