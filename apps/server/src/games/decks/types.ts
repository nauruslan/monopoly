/**
 * Доменные типы модуля колод карт.
 *
 * ВАЖНО: в текущей (legacy) реализации колоды — это просто `string[]` id-шников
 * с курсором (см. {@link CardDeckState} в `@monopoly/shared`).
 * Новый модуль DeckModule вводит полноценные:
 *  - {@link CardInstance} — конкретный экземпляр карты в конкретной партии
 *    с состоянием (`IN_DECK` | `DRAWN` | `RESOLVING` | `IN_HAND`)
 *    и привязкой к `originDeckId` / `originBoardFieldId`;
 *  - {@link DeckInstance} — колода, привязанная к ОДНОМУ полю доски
 *    (по умолчанию; общая колода для нескольких полей — отдельный режим,
 *    не используемый в MVP).
 *
 * Эти типы НЕ заменяют существующий `Card` из shared, а работают
 * ПАРАЛЛЕЛЬНО для обратной совместимости со снапшотами БД.
 */
import type { CardEffect } from "@monopoly/shared";

/**
 * Тип колоды в новой (типизированной) нотации.
 *
 * Отличается от legacy `deck: "chance" | "treasury" | "luxury-tax"`
 * (см. {@link CardEffect} и {@link Card} в shared) только синтаксисом —
 * маппинг через {@link legacyToDeckType} / {@link deckTypeToLegacy}.
 */
export type DeckType = "CHANCE" | "COMMUNITY_CHEST" | "LUXURY_TAX";

/**
 * Состояние конкретного экземпляра карты в партии.
 *
 * Жизненный цикл:
 *  - Обычная карта (holdInHand = false):
 *      IN_DECK → DRAWN → RESOLVING → IN_DECK (возврат в конец колоды)
 *  - Специальная карта (holdInHand = true):
 *      IN_DECK → DRAWN → RESOLVING → IN_HAND → (USE | TRANSFER) → IN_DECK
 *
 * Переходы:
 *  - `IN_DECK → DRAWN`: при вытягивании карты игроком (`drawCard`).
 *  - `DRAWN → RESOLVING`: при начале применения эффекта (`applyCardEffect`).
 *  - `RESOLVING → IN_DECK`: для обычной карты (возврат в колоду).
 *  - `RESOLVING → IN_HAND`: для спецкарты (`moveToHand`).
 *  - `IN_HAND → IN_DECK`: при использовании (`useCard`) или передаче
 *    с последующим использованием.
 *  - `IN_HAND → USED`: финальное состояние после `useCard` (для
 *    сценариев, когда карту не возвращают в колоду, а «сжигают»).
 *  - `USED → ...`: терминальное; переходов нет.
 */
export type CardState = "IN_DECK" | "DRAWN" | "RESOLVING" | "IN_HAND" | "USED";

/**
 * Шаблон карты — статическое описание, общее для всех партий.
 *
 * ВАЖНО: НЕ путать с `Card` из `@monopoly/shared/data/cards` — это
 * legacy-тип, который сейчас используется в UI и FSM напрямую.
 * CardTemplate — это надстройка с дополнительными флагами lifecycle.
 *
 * Миграция: для существующих карт из `CHANCE_CARDS` / `TREASURY_CARDS` /
 * `LUXURY_TAX_CARDS` создаётся обёртка через `cardToTemplate()` в
 * {@link card-template.ts} с дефолтами:
 *  - `holdInHand = false` (по умолчанию)
 *  - `transferable = false` (по умолчанию)
 *
 * Исключение: ch7 «Выход из тюрьмы бесплатно» → holdInHand=true, transferable=true.
 */
export interface CardTemplate {
  /** Уникальный ID шаблона. Совпадает с `Card.id` из shared. */
  templateId: string;
  /** Тип колоды, к которой принадлежит шаблон. */
  deckType: DeckType;
  /** Заголовок для UI. */
  title: string;
  /** Текст карточки для UI (может содержать переносы). */
  text: string;
  /**
   * Остаётся ли карта на руках у игрока после применения эффекта.
   * Пример: «Выход из тюрьмы бесплатно» (ch7) → true.
   */
  holdInHand: boolean;
  /**
   * Можно ли передавать карту другим игрокам через `TransferCardCommand`.
   * Пример: «Выход из тюрьмы бесплатно» (ch7) → true.
   */
  transferable: boolean;
  /**
   * Эффект карты. Структуру эффекта см. в `@monopoly/shared/data/cards`
   * (дискриминированный union `CardEffect`).
   */
  effect: CardEffect;
}

/**
 * Экземпляр карты в конкретной партии.
 *
 * В MVP каждая карта существует ровно в одном экземпляре за партию
 * (даже если `allowDuplicates = true` в setup — у дубликатов разные
 * `cardId`, но одинаковый `templateId`).
 *
 * `originDeckId` / `originBoardFieldId` фиксируются при создании
 * и НЕ меняются при передаче между игроками.
 */
export interface CardInstance {
  /** Уникальный ID экземпляра (uuid v4). */
  cardId: string;
  /** ID партии. */
  gameId: string;
  /** ID шаблона (ссылка на {@link CardTemplate}). */
  templateId: string;
  /** ID колоды, в которой карта была создана. */
  originDeckId: string;
  /** ID клетки, к которой привязана исходная колода. */
  originBoardFieldId: number;
  /** Текущее состояние. */
  state: CardState;
  /** ID игрока-владельца (если карта на руках). */
  holderPlayerId?: string;
  /** ISO-строка момента вытягивания. */
  drawnAt?: string;
  /** ISO-строка момента использования. */
  usedAt?: string;
}

/**
 * Колода в конкретной партии.
 *
 * Правило по умолчанию: одна колода = одно поле. В {@link BOARD}
 * (см. `@monopoly/shared/data/board`) есть 3 клетки CHANCE (id=7, 22, 36)
 * и 3 клетки COMMUNITY_CHEST (id=2, 17, 33), плюс одна клетка LUXURY_TAX
 * (id=38). Значит дефолтная конфигурация — 3 CHANCE-колоды + 3
 * COMMUNITY_CHEST-колоды + 1 LUXURY_TAX-колода.
 *
 * `topToBottom[0]` — верхняя карта (следующая для добора).
 * `topToBottom[length-1]` — нижняя карта.
 */
export interface DeckInstance {
  /** Уникальный ID колоды (uuid v4). */
  deckId: string;
  /** ID партии. */
  gameId: string;
  /** Тип колоды. */
  deckType: DeckType;
  /** ID клетки, к которой привязана колода. */
  boardFieldId: number;
  /**
   * Массив `cardId` от верха к низу.
   * Изменяется ТОЛЬКО через:
   *  - `setupDecks` (полная инициализация / перетасовка);
   *  - `drawCard` (shift с начала);
   *  - `returnToBottom` (push в конец);
   *  - `forceReturnHeldCards` (push в конец для IN_HAND карт).
   */
  topToBottom: string[];
}

/**
 * Конфигурация размещения одной колоды.
 * Используется в {@link DeckSetupConfig.placements}.
 */
export interface DeckPlacementConfig {
  /** Тип колоды. */
  deckType: DeckType;
  /** ID клетки, к которой привязать колоду. */
  boardFieldId: number;
  /** Сколько карт должно быть в колоде. */
  cardCount: number;
}

/**
 * Политика обработки пустой колоды.
 *
 *  - `WAIT` — ждать, пока освободятся карты в `DRAWN`/`RESOLVING` состояниях.
 *  - `RETURN_HELD_CARDS` — принудительно вернуть все `IN_HAND` карты этой
 *    колоды в её конец, затем повторить добор.
 *  - `SKIP_DRAW` — пропустить добор (вернуть `null` и эмитнуть
 *    `DECK_EMPTY_FALLBACK_TRIGGERED`).
 *  - `ERROR` — бросить {@link DeckEmptyError}.
 */
export type EmptyDeckPolicy = "WAIT" | "RETURN_HELD_CARDS" | "SKIP_DRAW" | "ERROR";

/**
 * Полная конфигурация для `setupDecks`.
 */
export interface DeckSetupConfig {
  /** Список размещений колод. */
  placements: DeckPlacementConfig[];
  /** Доступные шаблоны карт. */
  templates: CardTemplate[];
  /**
   * Можно ли дублировать шаблоны, если `templates.length < cardCount`.
   * По умолчанию `true` (как в текущей реализации: ch8/ch9/ch10/ch11 —
   * это дубликаты одной карточки «назад на 3»).
   */
  allowDuplicates?: boolean;
  /**
   * Seed для детерминированного перемешивания.
   * Если не задан, генерируется случайный.
   */
  seed?: string;
}

/**
 * Маппинг legacy-нотации колод в новую.
 *
 * Legacy (используется в `Card.deck` и `state.cardDecks`):
 *   - "chance"
 *   - "treasury"
 *   - "luxury-tax"
 *
 * Новая (используется в DeckModule):
 *   - "CHANCE"
 *   - "COMMUNITY_CHEST" (вместо "treasury" — соответствует официальной нотации)
 *   - "LUXURY_TAX"
 */
export type LegacyDeckId = "chance" | "treasury" | "luxury-tax";

/** Маппер: legacy → DeckType. */
export function legacyToDeckType(legacy: LegacyDeckId): DeckType {
  switch (legacy) {
    case "chance":
      return "CHANCE";
    case "treasury":
      return "COMMUNITY_CHEST";
    case "luxury-tax":
      return "LUXURY_TAX";
  }
}

/**
 * Метаданные holdable карты, лежащей у игрока.
 *
 * Хранится в `Player.holdableCards[cardId]`.
 * Содержит минимум для UI и для расчётов в DeckModule.
 */
export interface HoldableCardEntry {
  /** ID шаблона (для совместимости с legacy `Card.id`). */
  templateId: string;
  /** Когда карта была вытянута (ISO). */
  drawnAt: string;
  /** ID исходной колоды (для trace'а). */
  originDeckId: string;
  /**
   * Если `true` — эта запись создана backfill'ом из legacy
   * `player.holdableCards: Record<...>` — кэш на UI. Реальный `CardInstance` с этим
   * `cardId` может не существовать. UI должна показывать такие карты
   * только как «placeholder: Выход из тюрьмы».
   */
  legacyOnly?: boolean;
}

/** Маппер: DeckType → legacy (для совместимости с `state.cardDecks`). */
export function deckTypeToLegacy(deckType: DeckType): LegacyDeckId {
  switch (deckType) {
    case "CHANCE":
      return "chance";
    case "COMMUNITY_CHEST":
      return "treasury";
    case "LUXURY_TAX":
      return "luxury-tax";
  }
}
