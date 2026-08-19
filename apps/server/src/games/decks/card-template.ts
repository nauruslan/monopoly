/**
 * Утилиты конвертации карточек из `@monopoly/shared/data/cards` →
 * `CardTemplate` (DeckModule).
 *
 * В DeckModule каждый шаблон дополнен флагами lifecycle
 * (`holdInHand`, `transferable`) и заголовком для UI, которых нет
 * в базовом `Card`. Все карточки создаются по единым правилам.
 *
 * Исключение явно прописано в коде: `ch7` «Выход из тюрьмы бесплатно» →
 * `holdInHand = true`, `transferable = true`.
 */
import type { Card, CardEffect } from "@monopoly/shared";
import type { CardTemplate, DeckType } from "./types";

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
  // «Выход из тюрьмы бесплатно» (tr7) — аналогичная из колоды Казна.
  tr7: { holdInHand: true, transferable: true },
};

/**
 * Преобразует `Card` в `CardTemplate`.
 *
 * `templateId` берётся из `card.id`. `title` формируется как
 * короткое описание (для UI заголовка модалки), `text` — из `card.text`.
 *
 * @param card `Card` (из `CHANCE_CARDS` / `TREASURY_CARDS` / `LUXURY_TAX_CARDS`)
 * @returns CardTemplate с дефолтными `holdInHand=false` / `transferable=false`
 *          (или override из {@link TEMPLATE_OVERRIDES}).
 */
export function cardToTemplate(card: Card): CardTemplate {
  const override = TEMPLATE_OVERRIDES[card.id];
  return {
    templateId: card.id,
    deckType: deckTypeFromCard(card),
    title: formatTitle(card.text),
    text: card.text,
    holdInHand: override?.holdInHand ?? false,
    transferable: override?.transferable ?? false,
    effect: card.effect,
  };
}

/**
 * Преобразует массив `Card` в массив `CardTemplate`.
 */
export function cardsToTemplates(cards: readonly Card[]): CardTemplate[] {
  return cards.map(cardToTemplate);
}

/**
 * Маппинг `card.deck` → `CardTemplate.deckType`.
 */
function deckTypeFromCard(card: Card): DeckType {
  if (card.deck === "chance") return "CHANCE";
  if (card.deck === "treasury") return "COMMUNITY_CHEST";
  return "LUXURY_TAX";
}

/**
 * Форматирует title карточки из её текста.
 *
 * Стратегия: берём первую строку `text` (до точки или переноса).
 *
 * Пример:
 *   formatTitle("Выйдите из тюрьмы бесплатно")
 *     → "Выйдите из тюрьмы бесплатно"
 */
function formatTitle(text: string): string {
  // Берём первую строку до точки или переноса.
  const firstLine = text.split(/[.\n]/, 1)[0]?.trim() ?? text.trim();
  return firstLine;
}

/**
 * Проверяет, является ли карта `holdInHand` (по хардкод-правилам).
 *
 * Используется в тестах и в `setupDecks` для валидации.
 */
export function isCardHoldable(card: Card): boolean {
  return TEMPLATE_OVERRIDES[card.id]?.holdInHand ?? false;
}

/**
 * Возвращает `CardEffect` из `CardTemplate` (для unit-тестов и совместимости).
 */
export function getTemplateEffect(template: CardTemplate): CardEffect {
  return template.effect;
}
