/**
 * Сервис инициализации колод карт для партии.
 *
 * Создаёт:
 *  - {@link DeckInstance} для каждого размещения из {@link DeckSetupConfig};
 *  - {@link CardInstance} для каждой карты в каждой колоде (с уникальным `cardId`);
 *  - перемешивает колоды детерминированно через `seed`.
 *
 * ВАЖНО: не сохраняет ничего сам — возвращает `SetupDecksResult`, и вызывающий
 * код (GamesService / GameInitializer) сам кладёт в `state.decks` и `state.cards`.
 */
import { randomUUID } from "crypto";
import type {
  CardInstance,
  CardTemplate,
  DeckInstance,
  DeckSetupConfig,
  EmptyDeckPolicy,
} from "./types";
import { NotEnoughCardTemplatesError } from "./errors";
import type { Rng } from "./rng";
import { createRng } from "./rng";
import { fisherYates, sampleWithReplacement, sampleWithoutReplacement } from "./shuffle";

/**
 * Результат `setupDecks`.
 */
export interface SetupDecksResult {
  decks: DeckInstance[];
  cards: CardInstance[];
  /** Фактический seed, использованный для shuffle (после генерации). */
  seed: string;
}

/**
 * Контейнер для колод и карт по типу колоды (`chance`, `treasury`,
 * `luxury-tax`). Каждый тип хранит массив `DeckInstance` — одну
 * колоду на каждую клетку доски, к которой он привязан.
 *
 * Инициализируется через {@link setupDecks} и монтируется в `state`
 * через `state.decks` / `state.deckCards` (см. {@link ensureDecksInitialized}).
 */
export interface DecksContainer {
  chance: DeckInstance[];
  treasury: DeckInstance[];
  "luxury-tax": DeckInstance[];
  /** Глобальный список всех карт партии (для быстрого поиска по `cardId`). */
  cards: CardInstance[];
  /** Политика обработки пустой колоды (по умолчанию — `SKIP_DRAW`). */
  emptyDeckPolicy: EmptyDeckPolicy;
  /** Seed, использованный для shuffle (для детерминированного replay). */
  seed: string;
}

/**
 * Создаёт колоды и карты по конфигурации.
 *
 * @param gameId ID партии (для привязки `CardInstance.gameId`).
 * @param config Конфигурация: размещения, шаблоны, seed, allowDuplicates.
 * @param rng Опциональный инъектируемый RNG (если не задан — создаётся по `config.seed`).
 * @returns Список колод и карт, готовых к добавлению в `state.decks`.
 *
 * @throws {@link NotEnoughCardTemplatesError} если шаблонов нужного типа
 *         меньше, чем запрошено карт, и `allowDuplicates = false`.
 */
export function setupDecks(gameId: string, config: DeckSetupConfig, rng?: Rng): SetupDecksResult {
  const usedRng = rng ?? createRng(config.seed);

  // Группируем шаблоны по типу колоды для быстрого доступа.
  const templatesByType: Record<string, CardTemplate[]> = {
    CHANCE: config.templates.filter((t) => t.deckType === "CHANCE"),
    COMMUNITY_CHEST: config.templates.filter((t) => t.deckType === "COMMUNITY_CHEST"),
    LUXURY_TAX: config.templates.filter((t) => t.deckType === "LUXURY_TAX"),
  };

  const allDecks: DeckInstance[] = [];
  const allCards: CardInstance[] = [];

  for (const placement of config.placements) {
    const deckTypeTemplates = templatesByType[placement.deckType] ?? [];
    if (deckTypeTemplates.length === 0 && placement.cardCount > 0) {
      throw new NotEnoughCardTemplatesError(
        placement.deckType,
        deckTypeTemplates.length,
        placement.cardCount,
      );
    }

    const deckId = randomUUID();
    const cardIds: string[] = [];
    const deckCards: CardInstance[] = [];

    // 1) Выбираем нужное количество шаблонов для колоды.
    let chosenTemplates: CardTemplate[];
    if (deckTypeTemplates.length >= placement.cardCount) {
      // Шаблонов хватает — берём случайное подмножество.
      chosenTemplates = sampleWithoutReplacement(deckTypeTemplates, placement.cardCount, usedRng);
    } else {
      // Шаблонов не хватает.
      if (config.allowDuplicates === false) {
        throw new NotEnoughCardTemplatesError(
          placement.deckType,
          deckTypeTemplates.length,
          placement.cardCount,
        );
      }
      // allowDuplicates (по умолчанию true) — берём с заменой.
      chosenTemplates = sampleWithReplacement(deckTypeTemplates, placement.cardCount, usedRng);
    }

    // 2) Создаём экземпляры карт (с уникальным cardId, даже при дублях шаблона).
    for (const tpl of chosenTemplates) {
      const cardId = randomUUID();
      const card: CardInstance = {
        cardId,
        gameId,
        templateId: tpl.templateId,
        originDeckId: deckId,
        originBoardFieldId: placement.boardFieldId,
        state: "IN_DECK",
      };
      deckCards.push(card);
      cardIds.push(cardId);
    }

    // 3) Перемешиваем порядок карт в колоде (Fisher-Yates).
    const shuffledCardIds = fisherYates(cardIds, usedRng);

    // 4) Создаём колоду.
    const deck: DeckInstance = {
      deckId,
      gameId,
      deckType: placement.deckType,
      boardFieldId: placement.boardFieldId,
      topToBottom: shuffledCardIds,
    };

    allDecks.push(deck);
    allCards.push(...deckCards);
  }

  return {
    decks: allDecks,
    cards: allCards,
    seed: usedRng.seed,
  };
}

/**
 * Создаёт {@link DecksContainer} для партии.
 *
 * Удобная обёртка над {@link setupDecks}, которая сразу группирует колоды
 * по типу и добавляет дефолтные поля.
 */
export function createDecksContainer(
  gameId: string,
  config: DeckSetupConfig,
  emptyDeckPolicy: EmptyDeckPolicy = "SKIP_DRAW",
  rng?: Rng,
): DecksContainer {
  const result = setupDecks(gameId, config, rng);
  return {
    chance: result.decks.filter((d) => d.deckType === "CHANCE"),
    treasury: result.decks.filter((d) => d.deckType === "COMMUNITY_CHEST"),
    "luxury-tax": result.decks.filter((d) => d.deckType === "LUXURY_TAX"),
    cards: result.cards,
    emptyDeckPolicy,
    seed: result.seed,
  };
}
