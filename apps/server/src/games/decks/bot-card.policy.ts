/**
 * BotCardPolicy — решения бота по holdable картам и карточным действиям.
 *
 * Заменяет hardcoded проверки `Object.keys(player.holdableCards ?? {}).length > 0` в [`bot.service.ts`](apps/server/src/games/bots/bot.service.ts:130)
 * на более умную логику, использующую DeckModule (когда доступен).
 *
 * ТЕКУЩИЙ MVP:
 *  - `decideJailEscape(player, state)` — что делать, если игрок в тюрьме:
 *      * USE_CARD (consumeJailCard), если есть holdable jail-free
 *      * PAY (заплатить 50₽)
 *      * TRY_DOUBLE (попробовать выйти по дублю)
 *  - `shouldUseHoldableCard(player, cardId)` — стоит ли использовать
 *      holdable карту прямо сейчас (например, jail-free из руки).
 *  - `shouldTransferHoldableCard(player, targetPlayerId, cardId)` —
 *      стоит ли передать holdable карту другому игроку.
 *
 * Все решения работают на DeckModule (holdableCards).
 */
import type { Player, GameState } from "@monopoly/shared";
import { randomUUID } from "crypto";

import {
  countHoldableCards,
  listHoldableCardIds,
  hasHoldableCard,
} from "./holdable-cards.registry";

// Типы решений бота.

/**
 * Решение бота при попытке выйти из тюрьмы.
 *
 * Приоритет (по убыванию):
 *   1. USE_CARD — если есть holdable jail-free карта;
 *   2. PAY       — если есть деньги на штраф (settings.jailFine);
 *   3. TRY_DOUBLE — fallback на дубль.
 */
export type JailEscapeDecision =
  | { kind: "USE_CARD"; cardId: string }
  | { kind: "PAY" }
  | { kind: "TRY_DOUBLE" }
  | { kind: "WAIT" }; // Нет решения (например, нет ни карт, ни денег).

/**
 * Контекст для решений по картам.
 */
export interface BotCardContext {
  readonly player: Player;
  readonly state: GameState;
  /** Стоимость выхода из тюрьмы штрафом (по умолчанию 50₽). */
  readonly jailFine?: number;
}

// Решения по тюрьме.

/**
 * Решить, как бот будет выходить из тюрьмы.
 *
 * Алгоритм:
 *  1. Если есть holdable jail-free карта → USE_CARD;
 *  2. Иначе если хватает денег → PAY;
 *  3. Иначе → TRY_DOUBLE.
 */
export function decideJailEscape(ctx: BotCardContext): JailEscapeDecision {
  const { player } = ctx;
  const jailFine = ctx.jailFine ?? 50;

  // 1) Ищем holdable jail-free карту (приоритет — не тратить деньги).
  const jailFreeCardId = findJailFreeCardInHand(player);
  if (jailFreeCardId) {
    return { kind: "USE_CARD", cardId: jailFreeCardId };
  }

  // 2) Если денег достаточно — платим штраф.
  if (player.money >= jailFine) {
    return { kind: "PAY" };
  }

  // 3) Fallback: пробуем выйти по дублю.
  return { kind: "TRY_DOUBLE" };
}

/**
 * Найти первую holdable jail-free карту у игрока.
 *
 * По новому реестру `player.holdableCards`:
 *   - итерируем `cardId` записи;
 *   - проверяем, что карта имеет `templateId === "ch7"` или подобный.
 *
 * По legacy `Object.keys(player.holdableCards ?? {}).length`:
 *   - возвращаем synthetic ID `legacy-jailfree-<uuid>`, который будет
 *     обработан через `consumeHoldableJailCard()` (fallback).
 */
export function findJailFreeCardInHand(player: Player): string | null {
  const ids = listHoldableCardIds(player);
  if (ids.length === 0) {
    // Legacy fallback.
    if (Object.keys(player.holdableCards ?? {}).length > 0) {
      return `legacy-jailfree-${randomUUID()}`;
    }
    return null;
  }
  // Если есть holdableCards — ищем среди них ch7 (или иной jail-free шаблон).
  for (const cardId of ids) {
    const entry = player.holdableCards?.[cardId];
    if (!entry) continue;
    if (entry.templateId === "ch7" || entry.templateId.includes("jail-free")) {
      return cardId;
    }
  }
  // Если нашли хоть что-то holdable — возвращаем первую как fallback.
  return ids[0] ?? null;
}

// Решения по удерживаемым картам.

/**
 * Стоит ли боту сейчас использовать конкретную holdable карту?
 *
 * Сейчас бот использует карту, если:
 *  - карта — jail-free и игрок в тюрьме;
 *
 * Остальные типы эффектов пока НЕ реализованы (ШАГ 8+).
 */
export function shouldUseHoldableCard(ctx: BotCardContext, cardId: string): boolean {
  const { player, state } = ctx;
  const entry = player.holdableCards?.[cardId];
  if (!entry) return false;

  // ch7 (jail-free) — используем, если в тюрьме и в фазе JAIL_DECISION.
  if (entry.templateId === "ch7") {
    return player.inJail && state.phase === "JAIL_DECISION";
  }

  return false;
}

/**
 * Стоит ли боту передать свою holdable карту другому игроку?
 *
 * Сейчас бот НЕ передаёт карты сам (только через trade).
 * Возвращает false.
 */
export function shouldTransferHoldableCard(
  _ctx: BotCardContext,

  _targetPlayerId: string,

  _cardId: string,
): boolean {
  // Бот не отдаёт jail-free сам — только продаёт за деньги.
  return false;
}

// Агрегатная статистика.

/**
 * Получить «ценность» holdable карт в руке игрока (для trade-расчётов).
 *
 * Простая эвристика: каждая holdable карта стоит N денег для целей trade.
 * Заменяется на реальную оценку в будущих шагах.
 *
 * @param perCardValue значение одной карты (по умолчанию 50₽).
 */
export function evaluateHoldableCardsValue(player: Player, perCardValue: number = 50): number {
  const count = countHoldableCards(player);
  return count * perCardValue;
}

/**
 * Имеет ли игрок хотя бы одну holdable карту?
 *
 * Используется в trade-логике, чтобы бот знал, есть ли у противника
 * актив для торга.
 */
export function hasAnyHoldableCard(player: Player): boolean {
  return countHoldableCards(player) > 0;
}

/**
 * Может ли игрок использовать конкретную карту прямо сейчас?
 *
 * Учитывает фазу игры и текущее состояние игрока.
 */
export function canUseCardNow(ctx: BotCardContext, cardId: string): boolean {
  if (!hasHoldableCard(ctx.player, cardId)) return false;

  // Только в JAIL_DECISION можно использовать jail-free.
  if (ctx.state.phase === "JAIL_DECISION") {
    return true;
  }

  // В других фазах — пока не разрешаем (для будущих эффектов).
  return false;
}
