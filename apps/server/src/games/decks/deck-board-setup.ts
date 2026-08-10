/**
 * Правильная инициализация колод по правилам Монополии.
 *
 * КЛЮЧЕВОЕ ОТЛИЧИЕ от {@link setupDecks}:
 *  - Карты ОДНОГО ТИПА (например, CHANCE) перетасовываются ОДИН РАЗ общим
 *    Fisher-Yates, затем делятся на количество колод (полей этого типа)
 *    ПОРЯДКОВО по слотам (slot 0 = первые ceil(N/cards) карт, slot 1 = следующие,
 *    последний слот получает остаток).
 *  - Каждая порция ПЕРЕТАСОВЫВАЕТСЯ ещё раз своим seed-ом (детерминированно).
 *
 * Это реализует правило «изначально каждая карта принадлежит определённой
 * колоде (ШАНС / ПОДОХОДНЫЙ НАЛОГ / РОСКОШНЫЙ НАЛОГ / ОБЩЕСТВЕННАЯ КАЗНА);
 * колоды тасуются независимо друг от друга».
 *
 * Пример: 11 CHANCE-карт, 3 клетки (id=7, 22, 36):
 *  - сначала перетасовываем все 11 → [c5, c1, c11, c3, c7, c2, c4, c9, c10, c8, c6]
 *  - делим поровну:
 *      slot 0 (id=7)  → первые 4   = [c5, c1, c11, c3]
 *      slot 1 (id=22) → следующие 4 = [c7, c2, c4, c9]
 *      slot 2 (id=36) → остаток    = [c10, c8, c6]
 *  - каждую порцию перетасовываем отдельно (своим seed) →
 *      колода на id=7  = [c3, c11, c1, c5]   (порядок придуман для примера)
 *      колода на id=22 = [c4, c2, c9, c7]
 *      колода на id=36 = [c6, c8, c10]
 *
 * Все 11 карт распределены ровно по 3 колодам. Карты одной колоды
 * (например ch7 «выйти из тюрьмы бесплатно») попадают только в ОДНУ
 * колоду — нет «протекания» карт между полями.
 *
 * Для LUXURY_TAX с 1 клеткой и 4 картами:
 *  - одна колода на id=38, перетасованная (все 4 карты в ней).
 *
 * Для LUXURY_TAX с 4 картами и N полей (если в будущем добавят ещё клетки):
 *  - те же правила дележа.
 */
import type { CardInstance, CardTemplate, DeckInstance } from "./types";
import { fisherYates } from "./shuffle";
import { randomId, type Rng } from "./rng";

/**
 * Описание размещения одной колоды на доске.
 */
export interface FieldDeckPlacement {
  /** ID клетки, к которой привязана колода. */
  boardFieldId: number;
  /** Тип колоды (CHANCE / COMMUNITY_CHEST / LUXURY_TAX). */
  deckType: "CHANCE" | "COMMUNITY_CHEST" | "LUXURY_TAX";
}

/**
 * Конфигурация.
 */
export interface SetupPerFieldConfig {
  /** ID партии. */
  gameId: string;
  /** Шаблоны карт (должны иметь поле `deckType`). */
  templates: CardTemplate[];
  /** Размещения колод по клеткам. */
  placements: FieldDeckPlacement[];
  /** Seed для детерминированного shuffle. */
  seed: string;
}

/**
 * Результат.
 */
export interface SetupPerFieldResult {
  decks: DeckInstance[];
  cards: CardInstance[];
  seed: string;
}

/**
 * Распределить шаблоны одного типа поровну по N колодам.
 *
 * Сначала перетасовываем все шаблоны общим Fisher-Yates, потом делим
 * на слоты (как описано в JSDoc модуля).
 *
 * @param templatesForType все шаблоны одного типа (например, все CHANCE)
 * @param slotsCount       количество колод (например, 3 для CHANCE)
 * @param rng              инъектируемый RNG (один общий, Fisher-Yates детерминирован)
 * @returns                массив длиной `slotsCount`, где slots[i] — массив
 *                         шаблонов для i-й колоды (каждый массив перетасован
 *                         отдельно, но детерминированно через тот же rng —
 *                         последовательность next() продолжается)
 */
function distributeAndShuffle(
  templatesForType: CardTemplate[],
  slotsCount: number,
  rng: Rng,
): CardTemplate[][] {
  if (templatesForType.length === 0 || slotsCount <= 0) {
    return Array.from({ length: Math.max(0, slotsCount) }, () => []);
  }

  // 1) Общая перетасовка всех шаблонов этого типа.
  const globallyShuffled = fisherYates(templatesForType, rng);

  // 2) Делим поровну по слотам. Первые слоты получают ceil(N/slotsCount),
  //    последний слот получает остаток.
  //
  // Пример: 11 карт, 3 слота → 11/3 = 3 (базовый), остаток 2.
  //   slot 0: 4 карты (3 + 1 из остатка)
  //   slot 1: 4 карты (3 + 1 из остатка)
  //   slot 2: 3 карты (3 базовых)
  //
  // Обобщение: первые `remainder` слотов получают `base+1` карт,
  // остальные слоты — `base` карт.
  const base = Math.floor(templatesForType.length / slotsCount);
  const remainder = templatesForType.length - base * slotsCount;

  const slots: CardTemplate[][] = [];
  let cursor = 0;
  for (let i = 0; i < slotsCount; i++) {
    const size = i < remainder ? base + 1 : base;
    slots.push(globallyShuffled.slice(cursor, cursor + size));
    cursor += size;
  }

  // 3) Каждую порцию перетасовываем ещё раз ОТДЕЛЬНО (Fisher-Yates через
  //    тот же rng — состояние rng продолжается, что сохраняет
  //    детерминированность).
  for (let i = 0; i < slots.length; i++) {
    slots[i] = fisherYates(slots[i]!, rng);
  }

  return slots;
}

/**
 * Создаёт колоды и карты по правилу «каждая карта принадлежит своей
 * колоде, колоды тасуются независимо».
 *
 * @see описание в JSDoc модуля
 */
export function setupDecksPerField(
  gameId: string,
  config: SetupPerFieldConfig,
  rng: Rng,
): SetupPerFieldResult {
  // Группируем шаблоны по типу.
  const templatesByType: Record<string, CardTemplate[]> = {
    CHANCE: config.templates.filter((t) => t.deckType === "CHANCE"),
    COMMUNITY_CHEST: config.templates.filter((t) => t.deckType === "COMMUNITY_CHEST"),
    LUXURY_TAX: config.templates.filter((t) => t.deckType === "LUXURY_TAX"),
  };

  // Группируем placements по типу.
  const placementsByType: Record<string, FieldDeckPlacement[]> = {
    CHANCE: config.placements.filter((p) => p.deckType === "CHANCE"),
    COMMUNITY_CHEST: config.placements.filter((p) => p.deckType === "COMMUNITY_CHEST"),
    LUXURY_TAX: config.placements.filter((p) => p.deckType === "LUXURY_TAX"),
  };

  const allDecks: DeckInstance[] = [];
  const allCards: CardInstance[] = [];

  for (const deckType of ["CHANCE", "COMMUNITY_CHEST", "LUXURY_TAX"] as const) {
    const templates = templatesByType[deckType] ?? [];
    const placements = placementsByType[deckType] ?? [];
    if (placements.length === 0) continue;

    // Распределяем шаблоны поровну по N слотам (по количеству клеток этого типа).
    const slots = distributeAndShuffle(templates, placements.length, rng);

    // Создаём DeckInstance для каждого размещения.
    placements.forEach((placement, i) => {
      const deckId = `deck-${randomId(rng)}`;
      const slotTemplates = slots[i] ?? [];
      const cardIds: string[] = [];

      for (const tpl of slotTemplates) {
        const cardId = `card-${randomId(rng)}`;
        allCards.push({
          cardId,
          gameId,
          templateId: tpl.templateId,
          originDeckId: deckId,
          originBoardFieldId: placement.boardFieldId,
          state: "IN_DECK",
        });
        cardIds.push(cardId);
      }

      allDecks.push({
        deckId,
        gameId,
        deckType: placement.deckType,
        boardFieldId: placement.boardFieldId,
        topToBottom: cardIds, // уже перетасованы в distributeAndShuffle
      });
    });
  }

  return {
    decks: allDecks,
    cards: allCards,
    seed: rng.seed,
  };
}
