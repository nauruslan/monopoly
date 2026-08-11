/**
 * DeckStateAdapter — инициализация колод DeckModule на стандартной доске.
 *
 * Архитектура DeckModule:
 *  - Все колоды живут в `state.decks` (DeckInstance[]).
 *  - КАЖДАЯ КЛЕТКА CHANCE/COMMUNITY_CHEST/LUXURY_TAX имеет СВОЮ DeckInstance,
 *    привязанную к этой клетке через `boardFieldId`.
 *  - Карты одного типа перетасовываются общим Fisher-Yates, делятся
 *    поровну между клетками этого типа (по правилу Монополии), и
 *    каждая порция перетасовывается отдельно — независимо.
 */
import {
  BOARD,
  CHANCE_CARDS,
  TREASURY_CARDS,
  LUXURY_TAX_CARDS,
  type Card,
  type GameState,
} from "@monopoly/shared";

import type { CardInstance, CardTemplate, DeckInstance } from "./types";
import { cardsToTemplates } from "./card-template";
import { setupDecksPerField, type SetupPerFieldResult } from "./deck-board-setup";
import type { Rng } from "./rng";
import { createRng } from "./rng";

/**
 * BoardFieldId для колод разных типов в DEFAULT_BOARD.
 *
 * Извлечено из BOARD (см. `@monopoly/shared/data/board.ts`):
 *  - CHANCE:  3 клетки (id=7, 22, 36)
 *  - TREASURY (= COMMUNITY_CHEST): 3 клетки (id=2, 17, 33)
 *  - LUXURY_TAX: 1 клетка (id=38)
 */
const DEFAULT_CHANCE_FIELD_IDS: number[] = [];
const DEFAULT_TREASURY_FIELD_IDS: number[] = [];
const DEFAULT_LUXURY_TAX_FIELD_IDS: number[] = [];

(function scanBoard() {
  for (const cell of BOARD) {
    if (cell.type === "CHANCE") DEFAULT_CHANCE_FIELD_IDS.push(cell.id);
    else if (cell.type === "TREASURY") DEFAULT_TREASURY_FIELD_IDS.push(cell.id);
    else if (cell.type === "TAX" && cell.id === 38) {
      DEFAULT_LUXURY_TAX_FIELD_IDS.push(cell.id);
    }
  }
})();

/**
 * Расширенный тип `GameState` — здесь лежат поля DeckModule.
 */
declare module "@monopoly/shared" {
  interface GameState {
    /** Колоды DeckModule. */
    decks?: DeckInstance[];
    /** Все карты партии. */
    deckCards?: CardInstance[];
    /** Seed для DeckModule (дублирует `state.seed`). */
    deckSeed?: string;
  }
}

/** Шаблоны для всех колод (из shared-данных). */
function buildAllTemplates(): CardTemplate[] {
  return [
    ...cardsToTemplates(CHANCE_CARDS),
    ...cardsToTemplates(TREASURY_CARDS),
    ...cardsToTemplates(LUXURY_TAX_CARDS),
  ];
}

/** Placements для всех клеток доски, к которым привязаны колоды. */
function buildAllPlacements() {
  return [
    ...DEFAULT_CHANCE_FIELD_IDS.map((fid) => ({ boardFieldId: fid, deckType: "CHANCE" as const })),
    ...DEFAULT_TREASURY_FIELD_IDS.map((fid) => ({
      boardFieldId: fid,
      deckType: "COMMUNITY_CHEST" as const,
    })),
    ...DEFAULT_LUXURY_TAX_FIELD_IDS.map((fid) => ({
      boardFieldId: fid,
      deckType: "LUXURY_TAX" as const,
    })),
  ];
}

/**
 * Lazy-инициализация `state.decks` и `state.deckCards`.
 *
 * Если новые поля уже инициализированы — возвращаем их как есть. Идемпотентно.
 *
 * Источник карт: shared-данные CHANCE_CARDS / TREASURY_CARDS / LUXURY_TAX_CARDS.
 *
 * Архитектура колод:
 *  - КАЖДАЯ КЛЕТКА CHANCE/COMMUNITY_CHEST/LUXURY_TAX имеет СВОЮ DeckInstance
 *    с boardFieldId этой клетки.
 *  - Карты одного типа распределяются поровну между клетками этого типа
 *    (см. setupDecksPerField) и каждая колода перетасовывается
 *    независимо (Fisher-Yates со своим seed).
 */
export function ensureDecksInitialized(
  state: GameState,
  _rng?: Rng,
): { decks: DeckInstance[]; cards: CardInstance[]; seed: string } {
  if (state.decks && state.deckCards && state.decks.length > 0) {
    return {
      decks: state.decks,
      cards: state.deckCards,
      seed: state.deckSeed ?? state.seed,
    };
  }

  const seed = state.seed;
  const allTemplates = buildAllTemplates();
  const placements = buildAllPlacements();
  const rng = createRng(seed);

  const result = setupDecksPerField(
    state.id,
    { gameId: state.id, templates: allTemplates, placements, seed },
    rng,
  );

  state.decks = result.decks;
  state.deckCards = result.cards;
  state.deckSeed = seed;

  return { decks: result.decks, cards: result.cards, seed };
}

/**
 * Полная переинициализация колод через per-field алгоритм.
 * Используется в GameInitializerService при создании партии (не lazy).
 */
export function setupDecksForBoardPerField(state: GameState, rng?: Rng): SetupPerFieldResult {
  const seed = state.seed;
  const usedRng = rng ?? createRng(seed);
  const allTemplates = buildAllTemplates();
  const placements = buildAllPlacements();

  return setupDecksPerField(
    state.id,
    { gameId: state.id, templates: allTemplates, placements, seed },
    usedRng,
  );
}
