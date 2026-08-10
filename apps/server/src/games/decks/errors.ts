/**
 * Типизированные ошибки модуля DeckModule.
 *
 * Каждая ошибка:
 *  - имеет `code` (строковый идентификатор для логов и API);
 *  - наследует базовый класс {@link DeckError};
 *  - безопасна для логирования (не содержит полного `state`);
 *  - содержит контекст (id колоды / карты / игрока).
 */

/**
 * Базовый класс для всех ошибок DeckModule.
 *
 * Не использовать напрямую — наследовать и уточнять `code`.
 */
export abstract class DeckError extends Error {
  /** Строковый код ошибки (для логов, мониторинга, API). */
  public abstract readonly code: string;
  /** Имя класса (для логов). */
  public readonly name = "DeckError";

  constructor(
    message: string,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    // Корректное наследование Error для транспилированного в ES5 кода.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Колоды с указанным id не существует. */
export class DeckNotFoundError extends DeckError {
  public readonly code = "DECK_NOT_FOUND";

  constructor(deckId: string) {
    super(`Deck with id "${deckId}" not found`, { deckId });
  }
}

/** Карты с указанным id не существует. */
export class CardNotFoundError extends DeckError {
  public readonly code = "CARD_NOT_FOUND";

  constructor(cardId: string) {
    super(`Card with id "${cardId}" not found`, { cardId });
  }
}

/** Колода пуста и политика не разрешает пропуск / ожидание. */
export class DeckEmptyError extends DeckError {
  public readonly code = "DECK_EMPTY";

  constructor(deckId: string, extra?: Record<string, unknown>) {
    super(`Deck "${deckId}" is empty and cannot be drawn from`, { deckId, ...extra });
  }
}

/**
 * Попытка перевести карту в состояние, недопустимое из текущего.
 *
 * Примеры:
 *  - попытка вернуть в колоду карту, которая уже `IN_DECK`;
 *  - попытка переместить в руку карту, которая в `IN_HAND`;
 *  - попытка применить эффект к карте в `IN_DECK` (нужно `DRAWN`/`RESOLVING`).
 */
export class InvalidCardStateError extends DeckError {
  public readonly code = "INVALID_CARD_STATE";

  constructor(cardId: string, fromState: string, toState: string) {
    super(`Card "${cardId}" cannot transition from ${fromState} to ${toState}`, {
      cardId,
      fromState,
      toState,
    });
  }
}

/**
 * Карта находится не в `IN_HAND` (а в колоде, или DRAWN, ...).
 * Бросается при попытке `useCard` или `transferCard`.
 */
export class CardNotInHandError extends DeckError {
  public readonly code = "CARD_NOT_IN_HAND";

  constructor(cardId: string, extra?: Record<string, unknown>) {
    super(`Card "${cardId}" is not in any player's hand`, { cardId, ...extra });
  }
}

/**
 * Игрок пытается использовать/передать карту, которая принадлежит другому.
 */
export class CardNotOwnedByPlayerError extends DeckError {
  public readonly code = "CARD_NOT_OWNED";

  constructor(cardId: string, expectedPlayerId: string, actualPlayerId: string | undefined) {
    super(
      `Card "${cardId}" is owned by "${actualPlayerId ?? "nobody"}", not by "${expectedPlayerId}"`,
      { cardId, expectedPlayerId, actualPlayerId },
    );
  }
}

/**
 * Попытка передать карту с `transferable = false`.
 */
export class CardCannotBeTransferredError extends DeckError {
  public readonly code = "CARD_NOT_TRANSFERABLE";

  constructor(cardId: string, templateId: string) {
    super(`Card "${cardId}" (template "${templateId}") cannot be transferred`, {
      cardId,
      templateId,
    });
  }
}

/**
 * Попытка переместить в руку карту, у которой `holdInHand = false`.
 */
export class CardCannotBeHeldError extends DeckError {
  public readonly code = "CARD_NOT_HOLDABLE";

  constructor(cardId: string, templateId: string) {
    super(`Card "${cardId}" (template "${templateId}") cannot be held in hand`, {
      cardId,
      templateId,
    });
  }
}

/**
 * Попытка вернуть карту в колоду, отличную от её `originDeckId`.
 */
export class CardOriginMismatchError extends DeckError {
  public readonly code = "CARD_ORIGIN_MISMATCH";

  constructor(cardId: string, expectedDeckId: string, actualDeckId: string) {
    super(
      `Card "${cardId}" belongs to deck "${actualDeckId}", cannot return to "${expectedDeckId}"`,
      { cardId, expectedDeckId, actualDeckId },
    );
  }
}

/**
 * Шаблонов меньше, чем запрошено карт, и `allowDuplicates = false`.
 * Бросается в `setupDecks`.
 */
export class NotEnoughCardTemplatesError extends DeckError {
  public readonly code = "NOT_ENOUGH_TEMPLATES";

  constructor(deckType: string, available: number, required: number) {
    super(`Not enough card templates for deck "${deckType}": need ${required}, have ${available}`, {
      deckType,
      available,
      required,
    });
  }
}

/**
 * Эффект карты требует выбора от игрока/бота, но выбор не предоставлен.
 * Бросается в `resolveCardEffect` при попытке применить эффект
 * с `pendingChoice`, если `CardOption` не выбран.
 */
export class CardEffectChoiceRequiredError extends DeckError {
  public readonly code = "CARD_CHOICE_REQUIRED";

  constructor(cardId: string) {
    super(`Card "${cardId}" requires a player choice before applying effect`, { cardId });
  }
}

/**
 * Невалидная команда (например, `UseCardCommand` без `cardId`).
 * Бросается на уровне command-валидаторов ДО входа в DeckService.
 */
export class CommandValidationError extends DeckError {
  public readonly code = "COMMAND_VALIDATION";

  constructor(commandType: string, reason: string) {
    super(`Invalid command "${commandType}": ${reason}`, { commandType, reason });
  }
}
