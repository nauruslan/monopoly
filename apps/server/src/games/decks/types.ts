/**
 * Доменные типы модуля колод карт (DeckModule).
 *
 * Модуль вводит полноценную модель карт с состояниями:
 *  - {@link CardInstance} — конкретный экземпляр карты в партии с состоянием
 *    (`IN_DECK` | `DRAWN` | `RESOLVING` | `IN_HAND` | `USED`) и
 *    привязкой к `originDeckId` / `originBoardFieldId`;
 *  - {@link DeckInstance} — колода, привязанная к ОДНОМУ полю доски.
 *  - {@link CardTemplate} — статическое описание карточки (title, text, effect,
 *    флаги `holdInHand` / `transferable`).
 *
 * На доске по умолчанию:
 *  - 3 клетки CHANCE (id=7, 22, 36) → 3 колоды CHANCE;
 *  - 3 клетки COMMUNITY_CHEST (id=2, 17, 33) → 3 колоды COMMUNITY_CHEST;
 *  - 1 клетка LUXURY_TAX (id=38) → 1 колода LUXURY_TAX.
 */
import type { CardEffect } from "@monopoly/shared";

/** Тип колоды. */
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
 *  - `DRAWN → RESOLVING`: при начале применения эффекта (`markCardResolving`).
 *  - `RESOLVING → IN_DECK`: для обычной карты (возврат в колоду).
 *  - `RESOLVING → IN_HAND`: для спецкарты (`holdCardInHand`).
 *  - `IN_HAND → IN_DECK`: при использовании (`useCardFromHand`) или передаче
 *    с последующим использованием.
 *  - `IN_HAND → USED`: финальное состояние после `useCardFromHand`
 *    (для сценариев, когда карту не возвращают в колоду, а «сжигают»).
 *  - `USED → ...`: терминальное; переходов нет.
 */
export type CardState = "IN_DECK" | "DRAWN" | "RESOLVING" | "IN_HAND" | "USED";

/**
 * Шаблон карты — статическое описание, общее для всех партий.
 *
 * Создаётся через `cardToTemplate()` в {@link card-template.ts} на основе
 * карточек из `@monopoly/shared/data/cards` (CHANCE_CARDS / TREASURY_CARDS /
 * LUXURY_TAX_CARDS) с дефолтами:
 *  - `holdInHand = false`
 *  - `transferable = false`
 *
 * Исключение: ch7 «Выход из тюрьмы бесплатно» → `holdInHand=true`, `transferable=true`.
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
   * Можно ли передавать карту другим игрокам через `transferCard`.
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
 * Правило по умолчанию: одна колода = одно поле доски.
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
   *  - `returnCardToDeck` (push в конец);
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
 *  - `SKIP_DRAW` — пропустить добор (вернуть ошибку `DeckEmptyError`).
 *  - `ERROR` — выбросить `DeckEmptyError`.
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
 * Метаданные holdable карты, лежащей у игрока.
 *
 * Хранится в `Player.holdableCards[cardId]`.
 * Содержит минимум для UI и для расчётов в DeckModule.
 */
export interface HoldableCardEntry {
  /** ID шаблона (совпадает с `Card.id` из shared). */
  templateId: string;
  /** Когда карта была вытянута (ISO). */
  drawnAt: string;
  /** ID исходной колоды (для trace'а). */
  originDeckId: string;
}
