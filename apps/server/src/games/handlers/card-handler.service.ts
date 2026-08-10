import { Injectable, Logger } from "@nestjs/common";
import { CHANCE_CARDS, TREASURY_CARDS, LUXURY_TAX_CARDS, type Card } from "@monopoly/shared";
import type { Player, GameState } from "@monopoly/shared";
import { drawCard, returnCardToDeck } from "../decks/deck.service";
import { cardsToTemplates } from "../decks/card-template";
import { ensureDecksInitialized, findLegacyCardByTemplateId } from "../decks/deck-state-adapter";
import { syncHoldableCards } from "../decks/holdable-cards.registry";
import { grantJailFreeCard } from "../decks/holdable-cards.registry";
import type { CardTemplate } from "../decks/types";
// Side-effect import: расширяет Player/GameState через declaration merging.
import "../decks/holdable-cards.registry";

/**
 * Строит `Map<templateId, CardTemplate>` для DeckService из всех legacy-карт.
 *
 * Используется только в {@link CardHandlerService.drawFromDeck} для
 * удовлетворения обязательного поля `DeckContext.templatesById`.
 * В продакшене шаблоны можно закешировать в `state.deckTemplates`,
 * но для MVP каждый draw пересобирает — cost O(N) и не критичен
 * (несколько сотен карт, десятки вызовов за партию).
 */
function buildTemplatesById(): ReadonlyMap<string, CardTemplate> {
  const all: CardTemplate[] = [
    ...cardsToTemplates(CHANCE_CARDS),
    ...cardsToTemplates(TREASURY_CARDS),
    ...cardsToTemplates(LUXURY_TAX_CARDS),
  ];
  return new Map(all.map((t) => [t.templateId, t] as const));
}

/**
 * Результат вытягивания карты из колоды.
 *
 *  - `card`     — legacy `Card` для показа в CardModal и для applyEffect;
 *  - `deckCardId` — ID в DeckModule (`state.deckCards[].cardId`), нужен
 *    вызывающему коду (GamesService), чтобы после применения эффекта
 *    вернуть НЕ-holdable карту в НИЗ колоды (правило Монополии
 *    «discard to bottom»). Для holdable карт этот id сохраняется
 *    в cardContext, но в колоду карта не возвращается — она уходит
 *    в IN_HAND через `holdCardInHand` внутри `applyEffect`.
 *  - `holdInHand` — флаг из шаблона, чтобы GamesService мог быстро
 *    понять, нужно ли вообще планировать возврат карты в колоду.
 */
export interface DrawFromDeckResult {
  card: Card;
  deckCardId: string;
  holdInHand: boolean;
}

/**
 * CardHandlerService — обработчик карточек Шанс / Общественная казна / Роскошный налог.
 *
 * FSM: фазы CARD_REVEAL → CARD_EFFECT.
 *
 *  1. `drawFromDeck(deck, state)` — достаёт очередную карту из
 *     DeckModule (state.decks / state.deckCards) через `drawCard(...)`
 *     из deck.service. Если boardFieldId не совпадает (кастомная доска)
 *     — fallback на первый deck соответствующего типа.
 *     НЕ применяет эффект, НЕ мутирует state игрока.
 *     Возвращает `{ card, deckCardId, holdInHand }` — legacy `Card` плюс
 *     идентификатор DeckModule-карты, чтобы GamesService мог вернуть её
 *     в низ колоды (правило «discard to bottom»).
 *
 *  2. `applyEffect()` — применяет эффект карты к игроку/стейту.
 *     Вызывается в фазе `CARD_EFFECT` (ПОСЛЕ закрытия модалки).
 *     Внутри для holdable карт переводит CardInstance в IN_HAND
 *     (через `holdCardInHand`); не-holdable карты остаются в DRAWN,
 *     и GamesService сам вызывает `returnCardToDeck` после эффекта.
 *
 *  3. `returnDrawnCardIfNeeded()` — helper, который GamesService
 *     вызывает ПОСЛЕ применения эффекта в каждой ветке.
 *     Если карта ещё в DRAWN/RESOLVING — возвращает её в низ колоды
 *     (правило Монополии). Если уже USED/IN_HAND — no-op.
 *
 * Если эффект карты — `move` / `move-relative` / `goto-jail`,
 * то после применения сервер переводит партию в:
 *   - `move` / `move-relative` → фазу `MOVE_ANIMATION`;
 *   - `goto-jail` → фазу `JAIL_DECISION`;
 *   - остальные (`money`, `jail-free`, `luxury-tax-house`) → фазу `BUILDING`
 *     (или `ROLLING` при `mustRollAgain`).
 */
@Injectable()
export class CardHandlerService {
  /**
   * Достать очередную карту из указанной колоды (DeckModule).
   *
   * Алгоритм:
   *  1) ensureDecksInitialized(state) — ленивая инициализация state.decks/deckCards
   *     из legacy state.cardDecks (для совместимости со старыми снапшотами БД);
   *  2) Преобразуем legacy deck-name в boardFieldId (7 / 2 / 38);
   *  3) drawCard(ctx, {boardFieldId, playerId}) — снимает верхнюю карту через DeckService;
   *  4) state.decks = result.decks; state.deckCards = result.cards;
   *  5) Конвертируем CardInstance.templateId → legacy Card (для applyEffect + CardModal).
   *
   * Если CHANCE/TREASURY/LUXURY_TAX клетка на boardFieldId=7/2/38 не
   * представлена в state.decks (тестовая кастомная доска), fallback на
   * первый deck соответствующего типа.
   *
   * @param deck "chance" | "treasury" | "luxury-tax"
   * @param state полный state партии (мутируется: state.decks/deckCards)
   * @param playerId опционально: ID текущего игрока (для событий DeckModule)
   */
  drawFromDeck(
    deck: "chance" | "treasury" | "luxury-tax",
    state: GameState,
    playerId?: string,
  ): DrawFromDeckResult {
    // 1) Lazy init DeckModule (idempotent).
    const init = ensureDecksInitialized(state);

    // 2) Маппинг legacy deck-name → boardFieldId на DEFAULT_BOARD.
    const targetFieldId = this.legacyDeckFieldId(deck);

    // 3) Ищем колоду: сначала точное совпадение boardFieldId, иначе —
    //    первый deck соответствующего типа (для кастомных досок).
    let resolvedFieldId = targetFieldId;
    if (!init.decks.some((d) => d.boardFieldId === targetFieldId)) {
      const targetType =
        deck === "chance" ? "CHANCE" : deck === "treasury" ? "COMMUNITY_CHEST" : "LUXURY_TAX";
      const fallback = init.decks.find((d) => d.deckType === targetType);
      if (!fallback) {
        const legacy = this.fallbackLegacyCard(deck);
        return { card: legacy, deckCardId: "", holdInHand: false };
      }
      resolvedFieldId = fallback.boardFieldId;
    }

    // 4) DRAW через DeckService — верхняя карта IN_DECK → DRAWN.
    const templates = buildTemplatesById();
    const result = drawCard(
      {
        gameId: state.id,
        decks: init.decks,
        cards: init.cards,
        templatesById: templates,
        emptyDeckPolicy: "ERROR",
      },
      { boardFieldId: resolvedFieldId, playerId: playerId ?? "" },
    );

    // 5) Применяем мутации обратно в state.
    state.decks = result.decks as typeof state.decks;
    state.deckCards = result.cards as typeof state.deckCards;

    // 6) Определяем, holdable ли карта (нужно GamesService для решения,
    //    возвращать ли её потом в низ колоды).
    const template = templates.get(result.drawnCard.templateId);
    const holdInHand = template?.holdInHand ?? false;

    // 7) Конвертируем CardInstance.templateId → legacy Card.
    const legacy = findLegacyCardByTemplateId(result.drawnCard.templateId);
    if (legacy) {
      return { card: legacy, deckCardId: result.drawnCard.cardId, holdInHand };
    }

    // Шаблон не найден в legacy-источнике — fallback.
    Logger.warn(
      `[CardHandlerService] templateId=${result.drawnCard.templateId} не найден в legacy cards`,
      "CardHandlerService",
    );
    return {
      card: this.fallbackLegacyCard(deck),
      deckCardId: result.drawnCard.cardId,
      holdInHand,
    };
  }

  /**
   * Legacy-метод для обратной совместимости. Возвращает только legacy `Card`.
   * Не рекомендуется к использованию — `drawFromDeck` отдаёт ещё и
   * `deckCardId` / `holdInHand`, которые нужны GamesService.
   */
  draw(deck: "chance" | "treasury", state: GameState): Card {
    return this.drawFromDeck(deck, state).card;
  }

  /**
   * Вернуть вытянутую карту в НИЗ её колоды (правило Монополии
   * «discard to bottom»). Используется GamesService после применения
   * эффекта не-holdable карточки (money / move / move-relative / goto-jail /
   * luxury-tax-house / go-salary).
   *
   * Для holdable карт (`holdInHand === true`) — no-op: такие карты
   * остаются в IN_HAND (см. {@link grantJailFreeCard}) до момента
   * реального использования через `useCardFromHand`.
   *
   * Идемпотентно: если карты уже нет в state.deckCards (например,
   * `deckCardId === ""` для legacy-fallback), или её состояние уже
   * не DRAWN/RESOLVING — no-op.
   *
   * @param deckCardId ID DeckModule-карты (из `state.cardContext.deckCardId`)
   * @param reason     причина возврата (`RESOLVED` — эффект применён;
   *                   `DROPPED` — игрок сознательно сбросил, для будущего)
   */
  returnDrawnCardIfNeeded(
    state: GameState,
    deckCardId: string | null,
    reason: "RESOLVED" | "DROPPED" = "RESOLVED",
  ): void {
    if (!deckCardId) return;
    const decks = state.decks;
    const cards = state.deckCards;
    if (!decks || !cards) return;
    const card = cards.find((c) => c.cardId === deckCardId);
    if (!card) return;
    // Возвращаем только если карта реально в DRAWN/RESOLVING.
    // Для IN_HAND/USED — no-op (holdable или сожжённая).
    if (card.state !== "DRAWN" && card.state !== "RESOLVING") return;

    try {
      const result = returnCardToDeck(
        {
          gameId: state.id,
          decks,
          cards,
          templatesById: buildTemplatesById(),
          emptyDeckPolicy: "ERROR",
        },
        { cardId: deckCardId, reason },
      );
      state.decks = result.decks as typeof state.decks;
      state.deckCards = result.cards as typeof state.deckCards;
    } catch (err) {
      // Не валим партию из-за сбоя в DeckModule — логируем и идём дальше.
      Logger.warn(
        `[CardHandlerService.returnDrawnCardIfNeeded] failed for cardId=${deckCardId}: ${(err as Error).message}`,
        "CardHandlerService",
      );
    }
  }

  /**
   * Маппинг legacy deck-name → boardFieldId на DEFAULT_BOARD.
   */

  /**
   * Per-field вариант: достать карту из колоды, привязанной к КОНКРЕТНОЙ
   * клетке доски (boardFieldId). Используется в GamesService, когда игрок
   * попал на конкретную CHANCE/TREASURY/LUXURY_TAX клетку.
   *
   * Если для клетки нет своей колоды (кастомная доска, клетка не из
   * DEFAULT_*_FIELD_IDS) — fallback на первый deck того же типа.
   *
   * @param boardFieldId ID клетки, на которой стоит игрок
   * @param state полный state партии
   * @param playerId опционально: ID текущего игрока (для событий DeckModule)
   */
  drawFromCell(
    boardFieldId: number,
    state: GameState,
    playerId?: string,
  ): DrawFromDeckResult {
    const init = ensureDecksInitialized(state);
    const exact = init.decks.find((d) => d.boardFieldId === boardFieldId);
    if (exact) {
      return this.drawFromCellInternal(boardFieldId, state, playerId ?? "");
    }
    const cell = state.board[boardFieldId];
    const targetType =
      cell?.type === "CHANCE"
        ? "CHANCE"
        : cell?.type === "TREASURY"
          ? "COMMUNITY_CHEST"
          : null;
    if (!targetType) {
      // LUXURY_TAX и прочие — fallback на chance (drawFromDeck решит по типу).
      if (cell?.type === "TAX") return this.drawFromDeck("luxury-tax", state, playerId);
      return this.drawFromDeck("chance", state, playerId);
    }
    const fallback = init.decks.find((d) => d.deckType === targetType);
    if (!fallback) {
      const legacyDeck = targetType === "CHANCE" ? "chance" : "treasury";
      return { card: this.fallbackLegacyCard(legacyDeck), deckCardId: "", holdInHand: false };
    }
    return this.drawFromCellInternal(fallback.boardFieldId, state, playerId ?? "");
  }

  /**
   * Внутренний хелпер: фактически вызывает drawCard и обновляет state.
   * Принимает уже РЕШЁННЫЙ boardFieldId (точно соответствующий колоде).
   */
  private drawFromCellInternal(
    resolvedFieldId: number,
    state: GameState,
    playerId: string,
  ): DrawFromDeckResult {
    const init = ensureDecksInitialized(state);
    const templates = buildTemplatesById();
    const result = drawCard(
      {
        gameId: state.id,
        decks: init.decks,
        cards: init.cards,
        templatesById: templates,
        emptyDeckPolicy: "ERROR",
      },
      { boardFieldId: resolvedFieldId, playerId },
    );
    state.decks = result.decks as typeof state.decks;
    state.deckCards = result.cards as typeof state.deckCards;
    const template = templates.get(result.drawnCard.templateId);
    const holdInHand = template?.holdInHand ?? false;
    const legacy = findLegacyCardByTemplateId(result.drawnCard.templateId);
    if (legacy) {
      return { card: legacy, deckCardId: result.drawnCard.cardId, holdInHand };
    }
    Logger.warn(
      `[CardHandlerService] templateId=${result.drawnCard.templateId} не найден в legacy cards`,
      "CardHandlerService",
    );
    const deck = init.decks.find((d) => d.boardFieldId === resolvedFieldId);
    const fallbackDeckName =
      deck?.deckType === "CHANCE"
        ? "chance"
        : deck?.deckType === "COMMUNITY_CHEST"
          ? "treasury"
          : "luxury-tax";
    return {
      card: this.fallbackLegacyCard(fallbackDeckName),
      deckCardId: result.drawnCard.cardId,
      holdInHand,
    };
  }

  private legacyDeckFieldId(deck: "chance" | "treasury" | "luxury-tax"): number {
    if (deck === "chance") return 7;
    if (deck === "treasury") return 2;
    return 38; // luxury-tax
  }

  /**
   * Fallback: первая попавшаяся legacy-карта из источника.
   */
  private fallbackLegacyCard(deck: "chance" | "treasury" | "luxury-tax"): Card {
    const allCards: readonly Card[] =
      deck === "chance" ? CHANCE_CARDS : deck === "treasury" ? TREASURY_CARDS : LUXURY_TAX_CARDS;
    return allCards[0]!;
  }

  /**
   * Применить эффект карты к игроку/стейту.
   *
   * НЕ вызывает анимаций и НЕ меняет `state.phase` — этим занимается GamesService.
   *
   * @param card уже вытянутая карта
   * @param player игрок, на которого действует карта
   * @param state полный state (мутируется)
   * @returns информация о результате: нужно ли переместить фишку и куда
   */
  applyEffect(
    card: Card,
    player: Player,
    state: GameState,
  ):
    | { kind: "stay" }
    | { kind: "move"; target: number; passedGo?: boolean; direction?: "forward" | "backward" }
    | {
        kind: "move-relative";
        steps: number;
        direction: "forward" | "backward";
        passedGo?: boolean;
      }
    | { kind: "goto-jail" } {
    switch (card.effect.kind) {
      case "money": {
        // Положительная или отрицательная сумма (`amount` уже со знаком).
        player.money += card.effect.amount;
        return { kind: "stay" };
      }

      case "move": {
        // Телепорт на конкретную клетку.
        // Если есть `money` (бонус за прохождение GO) — начисляем.
        if (card.effect.money !== undefined) {
          player.money += card.effect.money;
        }
        // Направление НЕ определяем здесь — `GamesService` сам вычислит
        // его на основе соотношения `from` (текущая позиция игрока) и
        // `target`, чтобы фишка не «наматывала» через СТАРТ ради
        // 200₽ бонуса:
        //  - target=0 (СТАРТ) → всегда "forward" (правило игры)
        //  - target=10 (JAIL), target=20 (PARKING), target=30 (GOTO_JAIL)
        //    → всегда "backward" (тюрьма/парковка — «отдых»)
        //  - остальные → "backward" если from > target, иначе "forward"
        return { kind: "move", target: card.effect.target, direction: undefined };
      }

      case "go-salary": {
        // Карточка «Идите на СТАРТ» (исторический вариант: «Отправляйтесь
        // на Вперёд. Получите goSalary»). В ТЕКУЩЕЙ ВЕРСИИ эта карта не
        // используется — ch1 переведён в эффект `move` с target=0,
        // а двойная выплата 2× goSalary за приземление на СТАРТ
        // начисляется автоматически в `handleResolvingLanding`.
        // Оставляем ветку как fallback на случай старых снапшотов БД.
        player.money += state.settings.goSalary;
        return { kind: "move", target: 0, passedGo: true, direction: "forward" };
      }

      case "move-relative": {
        // Сдвиг на N клеток (вперёд/назад) с оборачиванием по 40.
        // Серверная сторона сама посчитает passedGo.
        //
        // Направление определяется по знаку `steps`:
        //  - steps > 0  → "forward"  (по часовой, классический ход фишки);
        //  - steps < 0  → "backward" (против часовой, фишка идёт назад).
        //
        // Если в `effect.direction` явно указано значение — используем
        // его (это «каноничный» источник истины, полезно для тестов и
        // для случаев, когда нужно форсировать направление).
        const inferredDirection: "forward" | "backward" =
          card.effect.steps >= 0 ? "forward" : "backward";
        const direction = card.effect.direction ?? inferredDirection;
        return { kind: "move-relative", steps: card.effect.steps, direction };
      }

      case "goto-jail": {
        // Прямой переход в тюрьму (минуя клетку GOTO_JAIL на доске).
        //
        // ВАЖНО: сам `JailHandlerService.sendToJail` будет вызван
        // в `GamesService.applyCardEffectAndAdvance` (ветка
        // `outcome.kind === "goto-jail"`) — там же, где решается
        // следующая фаза. Здесь же мы НЕ мутируем игрока, чтобы
        // избежать двойной работы / циркулярной зависимости.
        return { kind: "goto-jail" };
      }

      case "jail-free": {
        // Выдаём карточку "выйди из тюрьмы бесплатно".
        //
        // Логика DeckModule:
        //  1) Инициализируем DeckModule (lazy, idempotent);
        //  2) Пробуем создать реальный CardInstance в IN_HAND (через DeckModule);
        //  3) Синхронизируем holdable-карты (DeckModule)
        //     `player.holdableCards` через {@link syncHoldableCards}.
        //
        // Если DeckModule по какой-то причине не смог выдать карту
        // (например, ch7 уже вытянут ранее), fallback на legacy-счётчик.
        ensureDecksInitialized(state);
        const result = grantJailFreeCard(player, state, card.id);
        if (result) {
          // syncHoldableCards уже выполнен внутри grantJailFreeCard.
        } else {
          // Fallback: только legacy-счётчик (на всякий случай).
          syncHoldableCards(player, state, { delta: 1 });
        }
        return { kind: "stay" };
      }

      case "luxury-tax-house": {
        // Формула налога на имущество:
        //   perProperty ₽ за каждый участок (PROPERTY/RAILROAD/UTILITY),
        //   perHouse    ₽ за каждый ДОМ (houses от 1 до 4),
        //   perHotel    ₽ за каждый ОТЕЛЬ (houses === 5).
        const { perHouse, perHotel, perProperty } = card.effect;
        let houses = 0;
        let hotels = 0;
        let properties = 0;
        for (const cellId of player.properties) {
          const cell = state.board[cellId];
          if (!cell) continue;
          if (cell.isMortgaged) continue; // заложенная не считается
          properties += 1;
          if (cell.houses >= 1 && cell.houses <= 4) houses += cell.houses;
          else if (cell.houses === 5) hotels += 1;
        }
        const total = perHouse * houses + perHotel * hotels + perProperty * properties;
        // Списываем ПОЛНОСТЬЮ. Если у игрока не хватает денег — баланс
        // уходит в минус, и триггер банкротства должен сработать в
        // `applyCardEffectAndAdvance` (после возврата в `games.service`).
        // НЕ клампим в 0 — это скрывает долг и ломает правила.
        player.money -= total;
        return { kind: "stay" };
      }
    }
  }
}
