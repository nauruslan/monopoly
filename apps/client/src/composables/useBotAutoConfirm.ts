import { onScopeDispose } from "vue";

/**
 * useBotAutoConfirm — централизованный менеджер «одноразовых» таймеров
 * для авто-подтверждения визуальных фаз, которые бот/система должны
 * закрыть через N миллисекунд (CARD_REVEAL, JAIL_NOTICE, TAX_PAYMENT,
 * PAY_RENT, RESOLVING_LANDING, END_TURN, ...).
 *
 * ## Что делает
 *
 * 1. `schedule(key, fn, ms)` — **отменяет предыдущий таймер с тем же
 *    `key`** (если он был) и ставит новый. Это решает кейс «вход в
 *    одну и ту же фазу дважды подряд».
 * 2. `cancel(key)` — отменяет конкретный таймер. Используется
 *    при выходе из фазы и при ручном закрытии модалки пользователем.
 * 3. `cancelAll()` — отменяет ВСЕ таймеры. Используется в
 *    `onBeforeUnmount`.
 * 4. Автоматически вызывает `cancelAll()` при уходе текущего
 *    Vue-effect-scope (через `onScopeDispose`), чтобы таймеры не
 *    «выстреливали» после удаления компонента.
 *
 * ## Защита от устаревших таймеров с тем же `key`
 *
 * Внутри callback'а рекомендуется сверять «token фазы» (например,
 * `state.cardContext.card.id` или счётчик входов) — потому что
 * даже `clearTimeout` не спасает, если callback уже поставлен в
 * очередь микротасков. Подробнее — см. JSDoc метода `schedule`.
 *
 * ## Использование
 *
 * ```ts
 * const autoConfirm = useBotAutoConfirm();
 *
 * // В phase-watcher при входе в фазу CARD_REVEAL:
 * autoConfirm.schedule('CARD_REVEAL', () => {
 *   if (state.phase === 'CARD_REVEAL' &&
 *       state.cardContext?.card?.id === currentCardId) {
 *     sendConfirmForCurrentPhase('CARD_REVEAL', { type: 'CONFIRM_CARD' });
 *   }
 * }, 2500);
 *
 * // При выходе из фазы:
 * if (newPhase !== 'CARD_REVEAL') {
 *   autoConfirm.cancel('CARD_REVEAL');
 *   showCardModal.value = false;
 * }
 *
 * // При ручном закрытии модалки:
 * function onCloseCard() {
 *   autoConfirm.cancel('CARD_REVEAL');
 *   showCardModal.value = false;
 *   sendConfirmForCurrentPhase('CARD_REVEAL', { type: 'CONFIRM_CARD' });
 * }
 * ```
 *
 * @see apps/client/src/views/GameView.vue — точка применения.
 */

export interface BotAutoConfirmApi {
  /**
   * Поставить таймер с уникальным ключом. Если таймер с таким `key`
   * уже был — он отменяется и заменяется новым. Это основная защита
   * от «накопления» устаревших таймеров.
   *
   * ВАЖНО: внутри `fn` рекомендуется проверять актуальность фазы
   * и «token» (например, `cardContext.card.id`), потому что:
   *  - `setTimeout` callback может стоять в очереди микротасков
   *    на момент `clearTimeout`;
   *  - callback может сработать после `clearTimeout`, если фаза
   *    уже сменилась на ту же самую (например, CARD_REVEAL →
   *    MOVE_ANIMATION → CARD_REVEAL с новой картой).
   *
   * @param key уникальный ключ (обычно имя фазы: 'CARD_REVEAL', 'JAIL_NOTICE', ...).
   *            Если передадите разные ключи для разных карточек одной фазы —
   *            старый таймер НЕ будет отменён автоматически.
   * @param fn  callback, вызываемый по истечении `ms`.
   * @param ms  задержка в миллисекундах.
   * @returns id таймера (на случай ручной отмены).
   */
  schedule(key: string, fn: () => void, ms: number): ReturnType<typeof setTimeout>;

  /**
   * Отменить таймер по ключу. No-op, если таймера с таким ключом нет.
   */
  cancel(key: string): void;

  /**
   * Проверить, есть ли активный таймер с таким ключом.
   * Полезно для логирования и для гард-условий «не ставить, если уже есть».
   */
  has(key: string): boolean;

  /**
   * Отменить ВСЕ активные таймеры. Вызывается автоматически
   * при уходе Vue-effect-scope (через `onScopeDispose`).
   * В `onBeforeUnmount` тоже стоит вызвать — для надёжности.
   */
  cancelAll(): void;
}

export function useBotAutoConfirm(): BotAutoConfirmApi {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  function cancel(key: string): void {
    const t = timers.get(key);
    if (t !== undefined) {
      clearTimeout(t);
      timers.delete(key);
    }
  }

  function schedule(key: string, fn: () => void, ms: number): ReturnType<typeof setTimeout> {
    // Защита от накопления: новый таймер по тому же ключу
    // ОТМЕНЯЕТ предыдущий. Это решает кейс «вход в фазу CARD_REVEAL
    // дважды подряд без явного cancel между».
    cancel(key);
    const id = setTimeout(() => {
      // Удаляем из реестра ДО вызова callback'а — иначе cancel()
      // внутри callback'а не сможет найти этот id.
      timers.delete(key);
      try {
        fn();
      } catch (err) {
        // Не даём ошибке в callback'е уронить эффект-scope.

        console.error(`[useBotAutoConfirm] callback for key="${key}" threw:`, err);
      }
    }, ms);
    timers.set(key, id);
    return id;
  }

  function has(key: string): boolean {
    return timers.has(key);
  }

  function cancelAll(): void {
    for (const id of timers.values()) {
      clearTimeout(id);
    }
    timers.clear();
  }

  // Автоматическая очистка при уходе effect-scope. Это покрывает
  // случай, когда компонент удаляется, но в коде забыли вызвать
  // cancelAll() в onBeforeUnmount.
  try {
    onScopeDispose(cancelAll);
  } catch {
    // onScopeDispose можно вызвать только внутри effect-scope (setup).
    // Если кто-то вызовет useBotAutoConfirm() вне setup — пропускаем
    // авто-привязку и надеемся на ручной cancelAll().
  }

  return { schedule, cancel, has, cancelAll };
}
