/**
 * Утилиты конвертации legacy `Card` (из `@monopoly/shared/data/cards`) →
 * `CardTemplate` (DeckModule).
 *
 * ВАЖНО: legacy `Card` сейчас используется в UI ([`CardModal.vue`](apps/client/src/components/modals/CardModal.vue:1))
 * и FSM ([`games.service.ts`](apps/server/src/games/games.service.ts:1)). Мы не
 * ломаем этот контракт — просто оборачиваем каждый legacy-шаблон в `CardTemplate`
 * с дефолтными `holdInHand = false`, `transferable = false`.
 *
 * Исключение явно прописано в коде: `ch7` «Выход из тюрьмы бесплатно» →
 * `holdInHand = true`, `transferable = true`.
 */
import type { Card, CardEffect } from "@monopoly/shared";
import type { CardTemplate, DeckType, LegacyDeckId } from "./types";
import { legacyToDeckType } from "./types";

/**
 * Маппинг: `templateId` → `holdInHand` / `transferable` override.
 *
 * В будущем это поле можно вынести в `cards.ts` (shared) для прямого
 * декларирования, но пока — здесь, чтобы не менять shared API.
 */
interface TemplateOverride {
  holdInHand: boolean;
  transferable: boolean;
}

const TEMPLATE_OVERRIDES: Readonly<Record<string, TemplateOverride>> = {
  // «Выход из тюрьмы бесплатно» (ch7).
  ch7: { holdInHand: true, transferable: true },
  // В текущей колоде только одна такая карточка (CHANCE).
  // Если в TREASURY появится аналогичная — добавить tr_id.
};

/**
 * Маппинг legacy `deck` → `CardTemplate.deckType`.
 */
function deckTypeFromLegacy(legacy: LegacyDeckId): DeckType {
  return legacyToDeckType(legacy);
}

/**
 * Преобразует legacy `Card` в `CardTemplate`.
 *
 * `templateId` берётся из `card.id`. `title` формируется как
 * короткое описание (для UI заголовка модалки), `text` — из `card.text`.
 *
 * @param card legacy `Card` (из `CHANCE_CARDS` / `TREASURY_CARDS` / `LUXURY_TAX_CARDS`)
 * @returns CardTemplate с дефолтными `holdInHand=false` / `transferable=false`
 *          (или override из {@link TEMPLATE_OVERRIDES}).
 */
export function cardToTemplate(card: Card): CardTemplate {
  const override = TEMPLATE_OVERRIDES[card.id];
  return {
    templateId: card.id,
    deckType: deckTypeFromLegacy(card.deck),
    // В legacy Card нет поля title, поэтому используем короткое имя по id.
    title: formatTitle(card.id, card.text),
    text: card.text,
    holdInHand: override?.holdInHand ?? false,
    transferable: override?.transferable ?? false,
    effect: card.effect,
  };
}

/**
 * Преобразует массив legacy `Card` в массив `CardTemplate`.
 */
export function cardsToTemplates(cards: readonly Card[]): CardTemplate[] {
  return cards.map(cardToTemplate);
}

/**
 * Форматирует title карточки из id и text.
 *
 * Стратегия: берём первую строку `text` (до точки или переноса) и
 * делаем Title Case. Для однозначности сохраняем id.
 *
 * Пример:
 *   formatTitle("ch7", "Выйдите из тюрьмы бесплатно")
 *     → "Выйдите Из Тюрьмы Бесплатно"
 */
function formatTitle(id: string, text: string): string {
  // Берём первую строку до точки или переноса.
  const firstLine = text.split(/[.\n]/, 1)[0]?.trim() ?? text.trim();
  return firstLine;
}

/**
 * Проверяет, является ли legacy-карта `holdInHand` (по хардкод-правилам).
 *
 * Используется в тестах и в `setupDecks` для валидации.
 */
export function isLegacyCardHoldable(card: Card): boolean {
  return TEMPLATE_OVERRIDES[card.id]?.holdInHand ?? false;
}

/**
 * Возвращает `CardEffect` из `CardTemplate` (для unit-тестов и совместимости).
 */
export function getTemplateEffect(template: CardTemplate): CardEffect {
  return template.effect;
}
