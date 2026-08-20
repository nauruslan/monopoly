import { Injectable, Logger } from "@nestjs/common";
import { CHANCE_CARDS, TREASURY_CARDS, LUXURY_TAX_CARDS, type Card } from "@monopoly/shared";
import type { Player, GameState } from "@monopoly/shared";
import { countActiveMonopolies } from "@monopoly/shared";
import { drawCard, returnCardToDeck } from "../decks/deck.service";
import { cardsToTemplates } from "../decks/card-template";
import { ensureDecksInitialized } from "../decks/deck-state-adapter";
import { grantJailFreeCard, findCardByTemplateId } from "../decks/holdable-cards.registry";
import type { CardTemplate } from "../decks/types";
// Side-effect import: расширяет Player/GameState через declaration merging.
import "../decks/holdable-cards.registry";

/**
 * Строит `Map<templateId, CardTemplate>` для DeckService из всех карт.
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
 *  - `card`     — `Card` для показа в CardModal и для applyEffect;
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
 * ID клеток коммунальных предприятий (для карточки «nearest-utility»).
 * На DEFAULT_BOARD: 12 — Нефть, 28 — Вода.
 */
const UTILITY_FIELDS = [12, 28] as const;

/**
 * ID клеток железнодорожных станций (для карточки «nearest-railroad»).
 * На DEFAULT_BOARD: 5, 15, 25, 35.
 */
const RAILROAD_FIELDS = [5, 15, 25, 35] as const;

/**
 * Выбрать ближайшую клетку из списка ВПЕРЁД по часовой стрелке,
 * не проходя через клетку 0 (СТАРТ).
 *
 * Правило Монополии для «Advance to the nearest ...»: идём вперёд
 * по часовой от текущей позиции, и берём ПЕРВУЮ подходящую клетку.
 * Если подходящих нет впереди — берём СЛЕДУЮЩУЮ ж/д через круг
 * (то есть первую в списке), и движение пойдёт «через СТАРТ»
 * (что для утилит/ЖД по правилам Монополии допустимо — это не
 * «выводящая» карточка, и начисление goSalary за проход через 0
 * корректно по правилам).
 *
 * @param from текущая позиция игрока
 * @param candidates список подходящих ID клеток (отсортирован по возрастанию)
 * @returns `{ target, direction }` — куда идти и в каком направлении
 */
function pickNearestForward(
  from: number,
  candidates: readonly number[],
): { target: number; direction: "forward" | "backward" } {
  // 1) Ищем первую клетку-кандидат с target > from.
  const sorted = [...candidates].sort((a, b) => a - b);
  const next = sorted.find((id) => id > from);
  if (next !== undefined) {
    return { target: next, direction: "forward" };
  }
  // 2) Все кандидаты <= from — берём первую (минимальную), движение
  //    пойдёт через клетку 0 (forward).
  const first = sorted[0]!;
  return { target: first, direction: "forward" };
}

/**
 * CardHandlerService — обработчик карточек Шанс / Казна / Роскошный налог.
 *
 * FSM: фазы CARD_REVEAL → CARD_EFFECT.
 *
 *  1. `drawFromDeck(deck, state)` — достаёт очередную карту из
 *     DeckModule (state.decks / state.deckCards) через `drawCard(...)`
 *     из deck.service. Если boardFieldId не совпадает (кастомная доска)
 *     — fallback на первый deck соответствующего типа.
 *     НЕ применяет эффект, НЕ мутирует state игрока.
 *     Возвращает `{ card, deckCardId, holdInHand }` — `Card` плюс
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
 * Если эффект карты — `move` / `move-relative` / `goto-jail` /
 * `nearest-utility` / `nearest-railroad`, то после применения сервер
 * переводит партию в:
 *   - `move` / `move-relative` / `nearest-*` → фазу `MOVE_ANIMATION`;
 *   - `goto-jail` → фазу `JAIL_DECISION`;
 *   - остальные (`money`, `jail-free`, `luxury-tax-house`, `pay-each-player`,
 *     `money-if-monopoly`, `money-per-property`, `money-per-monopoly`,
 *     `stay`) → фазу `BUILDING` (или `ROLLING` при `mustRollAgain`).
 *
 * ## Правило «активной монополии» (NEW)
 *
 * В этой версии Монополии понятие «монополия» строже классики:
 * монополия активна только когда ВСЕ клетки цветовой группы
 * принадлежат игроку И ни одна из них не заложена. Заложенная клетка
 * разрушает монополию. Это правило влияет на карточки:
 *
 *  - `money-if-monopoly`  (`ch19`) — если есть хотя бы одна активная
 *    монополия, начисляется `amount`.
 *  - `money-per-monopoly` (`tr12`) — `amountPerMonopoly` × кол-во
 *    активных монополий.
 *
 * Реализация — общий хелпер `countActiveMonopolies` из
 * `@monopoly/shared/monopoly.ts`.
 *
 * ## Правило «perProperty» для `luxury-tax-house` (FIX)
 *
 * Заложенный участок — это СОБСТВЕННОСТЬ игрока, просто переданная
 * банку в качестве залога. Для целей налогообложения (`luxury-tax-house`)
 * важен факт владения, а не ликвидность, поэтому `perProperty` учитывает
 * и заложенные, и незаложенные клетки. Дома/отели на заложенной клетке
 * существовать не могут (это блокирует `MortgageService.canMortgage`),
 * поэтому счётчики `houses`/`hotels` остаются корректными.
 *
 * Карточка `money-per-property` (`tr9`) по-прежнему считает только
 * незаложенные участки — это явно указано в её тексте и в JSDoc
 * эффекта.
 */
@Injectable()
export class CardHandlerService {
  /**
   * Достать очередную карту из указанной колоды (DeckModule).
   *
   * Алгоритм:
   *  1) ensureDecksInitialized(state) — ленивая инициализация state.decks/deckCards
   *     из shared-данных CHANCE_CARDS / TREASURY_CARDS / LUXURY_TAX_CARDS;
   *  2) Преобразуем имя колоды в boardFieldId (7 / 2 / 38);
   *  3) drawCard(ctx, {boardFieldId, playerId}) — снимает верхнюю карту через DeckService;
   *  4) state.decks = result.decks; state.deckCards = result.cards;
   *  5) Конвертируем CardInstance.templateId → `Card` (для applyEffect + CardModal).
   *
   * Если CHANCE/COMMUNITY_CHEST/LUXURY_TAX клетка на boardFieldId=7/2/38 не
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

    // 2) Маппинг deck-name → boardFieldId на DEFAULT_BOARD.
    const targetFieldId = this.deckFieldId(deck);

    // 3) Ищем колоду: сначала точное совпадение boardFieldId, иначе —
    //    первый deck соответствующего типа (для кастомных досок).
    let resolvedFieldId = targetFieldId;
    if (!init.decks.some((d) => d.boardFieldId === targetFieldId)) {
      const targetType =
        deck === "chance" ? "CHANCE" : deck === "treasury" ? "COMMUNITY_CHEST" : "LUXURY_TAX";
      const fallback = init.decks.find((d) => d.deckType === targetType);
      if (!fallback) {
        const card = this.fallbackCard(deck);
        return { card, deckCardId: "", holdInHand: false };
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

    // 7) Конвертируем CardInstance.templateId → `Card`.
    const card = findCardByTemplateId(result.drawnCard.templateId);
    if (card) {
      return { card, deckCardId: result.drawnCard.cardId, holdInHand };
    }

    // Шаблон не найден — fallback.
    Logger.warn(
      `[CardHandlerService] templateId=${result.drawnCard.templateId} не найден в справочнике`,
      "CardHandlerService",
    );
    return {
      card: this.fallbackCard(deck),
      deckCardId: result.drawnCard.cardId,
      holdInHand,
    };
  }

  /**
   * Достать карту из колоды, привязанной к КОНКРЕТНОЙ клетке доски.
   * Используется в GamesService, когда игрок попал на конкретную
   * CHANCE/COMMUNITY_CHEST/LUXURY_TAX клетку.
   *
   * Если для клетки нет своей колоды (кастомная доска, клетка не из
   * DEFAULT_*_FIELD_IDS) — fallback на первый deck того же типа.
   */
  drawFromCell(boardFieldId: number, state: GameState, playerId?: string): DrawFromDeckResult {
    const init = ensureDecksInitialized(state);
    const exact = init.decks.find((d) => d.boardFieldId === boardFieldId);
    if (exact) {
      return this.drawFromCellInternal(boardFieldId, state, playerId ?? "");
    }
    const cell = state.board[boardFieldId];
    const targetType =
      cell?.type === "CHANCE" ? "CHANCE" : cell?.type === "TREASURY" ? "COMMUNITY_CHEST" : null;
    if (!targetType) {
      // LUXURY_TAX и прочие — fallback на chance (drawFromDeck решит по типу).
      if (cell?.type === "TAX") return this.drawFromDeck("luxury-tax", state, playerId);
      return this.drawFromDeck("chance", state, playerId);
    }
    const fallback = init.decks.find((d) => d.deckType === targetType);
    if (!fallback) {
      const deckName = targetType === "CHANCE" ? "chance" : "treasury";
      return { card: this.fallbackCard(deckName), deckCardId: "", holdInHand: false };
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
    const card = findCardByTemplateId(result.drawnCard.templateId);
    if (card) {
      return { card, deckCardId: result.drawnCard.cardId, holdInHand };
    }
    Logger.warn(
      `[CardHandlerService] templateId=${result.drawnCard.templateId} не найден в справочнике`,
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
      card: this.fallbackCard(fallbackDeckName),
      deckCardId: result.drawnCard.cardId,
      holdInHand,
    };
  }

  private deckFieldId(deck: "chance" | "treasury" | "luxury-tax"): number {
    if (deck === "chance") return 7;
    if (deck === "treasury") return 2;
    return 38; // luxury-tax
  }

  /**
   * Fallback: первая попавшаяся карта из источника.
   */
  private fallbackCard(deck: "chance" | "treasury" | "luxury-tax"): Card {
    const allCards: readonly Card[] =
      deck === "chance" ? CHANCE_CARDS : deck === "treasury" ? TREASURY_CARDS : LUXURY_TAX_CARDS;
    return allCards[0]!;
  }

  /**
   * Вернуть вытянутую карту в НИЗ её колоды (правило Монополии
   * «discard to bottom»). Используется GamesService после применения
   * эффекта не-holdable карточки (money / move / move-relative / goto-jail /
   * luxury-tax-house / go-salary / nearest-* / pay-each-player / *-monopoly / *-property).
   *
   * Для holdable карт (`holdInHand === true`) — no-op: такие карты
   * остаются в IN_HAND (см. {@link grantJailFreeCard}) до момента
   * реального использования через `useCardFromHand`.
   *
   * Идемпотентно: если карты уже нет в state.deckCards (например,
   * `deckCardId === ""` для fallback), или её состояние уже
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
    ctx?: { drawnCardId?: string | null },
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
        // Выдаём игроку карточку «выйди из тюрьмы бесплатно».
        //
        // Логика DeckModule:
        //  1) Ленивая инициализация колод (idempotent).
        //  2) Создаём реальный CardInstance в IN_HAND
        //     и синхронизируем `player.holdableCards`
        //     через {@link syncHoldableCards} (вызывается
        //     внутри {@link grantJailFreeCard}).
        ensureDecksInitialized(state);
        grantJailFreeCard(player, state, card.id, { drawnCardId: ctx?.drawnCardId ?? null });
        return { kind: "stay" };
      }

      case "luxury-tax-house": {
        // Формула налога на имущество:
        //   perProperty ₽ за каждый участок (PROPERTY/RAILROAD/UTILITY),
        //   perHouse    ₽ за каждый ДОМ (houses от 1 до 4),
        //   perHotel    ₽ за каждый ОТЕЛЬ (houses === 5).
        //
        // ВАЖНО (FIX): заложенный участок — это СОБСТВЕННОСТЬ игрока,
        // просто переданная банку в качестве залога. Для целей
        // налогообложения важен ФАКТ владения, а не ликвидность,
        // поэтому `perProperty` учитывает и заложенные, и незаложенные
        // клетки.
        //
        // Дома/отели на заложенной клетке существовать не могут
        // (правило `MortgageService.canMortgage` блокирует залог при
        // наличии домов в группе), поэтому счётчики `houses`/`hotels`
        // остаются корректными.
        const { perHouse, perHotel, perProperty } = card.effect;
        let houses = 0;
        let hotels = 0;
        let properties = 0;
        for (const cellId of player.properties) {
          const cell = state.board[cellId];
          if (!cell) continue;
          // Заложенный участок ВСЁ РАВНО принадлежит игроку — учитываем.
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

      case "nearest-utility": {
        // «Идите на ближайшее коммунальное предприятие».
        // По правилам Монополии и по спецификации проекта:
        //  - если фишка на клетках 1..19 → идём к Нефти (12);
        //  - если фишка на клетках 21..39 → идём к Воде (28).
        // Движение НЕ проходит через клетку 0 (СТАРТ).
        const from = player.position;
        const target = from <= 19 ? 12 : 28;
        // Направление:
        //  - 12 > from всегда (т.к. from ∈ 1..19), значит "forward";
        //  - 28 > from всегда (т.к. from ∈ 21..39), значит "forward".
        return { kind: "move", target, direction: "forward" };
      }

      case "nearest-railroad": {
        // «Идите на ближайший железнодорожный вокзал».
        // По спецификации проекта:
        //  - поле события 1..9   → целевое 5;
        //  - поле события 11..19 → целевое 15;
        //  - поле события 21..29 → целевое 25;
        //  - поле события 31..39 → целевое 35.
        // Направление определяется сравнением target с from: если
        // target > from — "forward" (по часовой), иначе "backward".
        // (Сценарий с target <= from для ЖД невозможен при данной
        // спецификации, но на всякий случай обрабатываем.)
        const from = player.position;
        let target: number;
        if (from <= 9) target = 5;
        else if (from <= 19) target = 15;
        else if (from <= 29) target = 25;
        else target = 35;
        const direction: "forward" | "backward" = target > from ? "forward" : "backward";
        return { kind: "move", target, direction };
      }

      case "pay-each-player": {
        // «Вас избрали председателем совета директоров. Заплатите каждому игроку по N₽».
        // Списываем amountPerPlayer у текущего игрока за КАЖДОГО противника
        // (НЕ считая себя), и зачисляем amountPerPlayer каждому противнику.
        // Если противников нет — no-op.
        // Себе платить не надо: «заплатите КАЖДОМУ игроку» = каждому
        // ОСТАЛЬНОМУ игроку (не самому себе).
        const amount = card.effect.amountPerPlayer;
        const opponents = state.players.filter((p) => p.id !== player.id && !p.isBankrupt);
        if (opponents.length > 0) {
          const totalCost = amount * opponents.length;
          // Списываем со счёта инициатора. Баланс может уйти в минус —
          // банкротство сработает в `applyCardEffectAndAdvance`.
          player.money -= totalCost;
          for (const opp of opponents) {
            opp.money += amount;
          }
        }
        return { kind: "stay" };
      }

      case "money-if-monopoly": {
        // «Получите N₽, если у вас есть монополия».
        // Считаем количество АКТИВНЫХ полных цветных наборов у игрока
        // (через общий хелпер `countActiveMonopolies` — учитывает залог:
        // заложенная клетка разрушает монополию).
        // Если 0 активных монополий — карта не даёт денег (no-op).
        const monopolyCount = countActiveMonopolies(player.id, state.board);
        if (monopolyCount > 0) {
          player.money += card.effect.amount;
        }
        return { kind: "stay" };
      }

      case "money-per-property": {
        // «Заработайте N₽ за каждый НЕзаложенный участок».
        // Считаем все участки игрока (PROPERTY/RAILROAD/UTILITY),
        // НЕ находящиеся в залоге. Если таких нет — no-op (0₽).
        let units = 0;
        for (const cellId of player.properties) {
          const cell = state.board[cellId];
          if (!cell) continue;
          if (cell.isMortgaged) continue; // заложенный не считается
          units += 1;
        }
        if (units > 0) {
          player.money += card.effect.amountPerUnit * units;
        }
        return { kind: "stay" };
      }

      case "money-per-monopoly": {
        // «Заработайте N₽ за каждую монополию».
        // Полная цветная группа (например, все 3 красные улицы) = +1 монополия.
        // Используем общий хелпер `countActiveMonopolies` — он учитывает
        // залог: заложенная клетка разрушает монополию.
        const monopolyCount = countActiveMonopolies(player.id, state.board);
        if (monopolyCount > 0) {
          player.money += card.effect.amountPerMonopoly * monopolyCount;
        }
        return { kind: "stay" };
      }

      case "stay": {
        // Нейтральный эффект — ничего не делаем (no-op).
        return { kind: "stay" };
      }
    }
  }
}
