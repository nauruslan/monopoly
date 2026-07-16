import { Injectable } from "@nestjs/common";
import {
  CHANCE_CARDS,
  TREASURY_CARDS,
  LUXURY_TAX_CARDS,
  shuffle,
  type Card,
} from "@monopoly/shared";
import type { Player, GameState } from "@monopoly/shared";
import seedrandom from "seedrandom";

/**
 * CardHandlerService — обработчик карточек Шанс / Общественная казна / Роскошный налог.
 *
 * ВАЖНО: после рефакторинга FSM (фазы CARD_REVEAL → CARD_EFFECT)
 * сервис разделён на ДВЕ функции:
 *
 * 1. `drawFromDeck(deck, state)` — достаёт очередную карту из ЗАРАНЕЕ
 *    перемешанной колоды (`state.cardDecks[deck]`), инкрементирует курсор.
 *    Если курсор дошёл до конца — колода перемешивается заново (новый
 *    проход RNG через `state.seed`, чтобы остаться детерминированным).
 *    НЕ применяет эффект, НЕ мутирует state игрока.
 *    Возвращает карту для показа в модалке.
 *
 * 2. `applyEffect()` — применяет эффект карты к игроку/стейту.
 *    Вызывается в фазе `CARD_EFFECT` (ПОСЛЕ закрытия модалки).
 *
 * Если эффект карты — `move` / `move-relative` / `go-salary` / `goto-jail`,
 * то после применения сервер должен перевести партию в:
 *  - `move` / `move-relative` / `go-salary` → фазу `MOVE_ANIMATION`
 *    (телепорт-анимация фишки на новую клетку);
 *  - `goto-jail` → фазу `JAIL_DECISION`;
 *  - остальные (`money`, `jail-free`, `luxury-tax-house`) → фазу `BUILDING`
 *    (или в `ROLLING` при `mustRollAgain`).
 */
@Injectable()
export class CardHandlerService {
  /**
   * Достать очередную карту из указанной колоды.
   *
   * Алгоритм:
   *  1) Найти `state.cardDecks[deck]`. Если нет — fallback на случайную
   *     карту из констант (для обратной совместимости со старыми
   *     снапшотами БД).
   *  2) Прочитать `cards[cursor]`, инкрементировать `cursor`.
   *  3) Если `cursor === cards.length` — перетасовать заново,
   *     сбросить `cursor = 0`, и взять cards[0] (новая партия раунда).
   *  4) Найти полную `Card` по id в массиве-источнике (CHANCE/TREASURY/LUXURY).
   *
   * @param deck "chance" | "treasury" | "luxury-tax"
   * @param state полный state партии
   */
  drawFromDeck(deck: "chance" | "treasury" | "luxury-tax", state: GameState): Card {
    const allCards: readonly Card[] =
      deck === "chance" ? CHANCE_CARDS : deck === "treasury" ? TREASURY_CARDS : LUXURY_TAX_CARDS;

    const sourceName =
      deck === "chance" ? "chance" : deck === "treasury" ? "treasury" : "luxury-tax";

    // Lazy init: если у state нет cardDecks (старый снапшот) — построим.
    if (!state.cardDecks) {
      this.rebuildDecks(state);
    }

    let cardIds = state.cardDecks![sourceName].cards;
    let cursor = state.cardDecks![sourceName].cursor;

    // Если курсор на конце или карточек меньше, чем в исходной колоде —
    // перетасовываем заново.
    if (cursor >= cardIds.length) {
      const rng = seedrandom(`${state.seed}:reshuffle:${sourceName}:${Date.now()}`);
      cardIds = shuffle(allCards, rng).map((c) => c.id);
      cursor = 0;
      state.cardDecks![sourceName] = { cards: cardIds, cursor };
    }

    const cardId = cardIds[cursor]!;
    state.cardDecks![sourceName].cursor = cursor + 1;

    const card = allCards.find((c) => c.id === cardId);
    if (!card) {
      // Защита: id мог устареть. Возьмём первую попавшуюся.
      return allCards[0]!;
    }
    return card;
  }

  /**
   * Legacy-метод для обратной совместимости. Использовался в старом коде
   * через `draw(deck, state)`. Теперь это тонкая обёртка над `drawFromDeck`.
   */
  draw(deck: "chance" | "treasury", state: GameState): Card {
    return this.drawFromDeck(deck, state);
  }

  /**
   * Построить все три колоды с нуля на основе `state.seed`.
   */
  private rebuildDecks(state: GameState): void {
    const make = (source: readonly Card[], rng: () => number) => ({
      cards: shuffle(source, rng).map((c) => c.id),
      cursor: 0,
    });
    state.cardDecks = {
      chance: make(CHANCE_CARDS, seedrandom(`${state.seed}:deck:chance`)),
      treasury: make(TREASURY_CARDS, seedrandom(`${state.seed}:deck:treasury`)),
      "luxury-tax": make(LUXURY_TAX_CARDS, seedrandom(`${state.seed}:deck:luxury-tax`)),
    };
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
        // Направление определяется соотношением target/position.
        // Здесь position ЕЩЁ НЕ изменён (мутация будет в GamesService),
        // поэтому направление для move по правилам всегда «forward»:
        // игрок перемещается в указанную клетку напрямую (телепорт),
        // а анимация строится по кратчайшему пути через игровое поле.
        // Для классической Монополии любой телепорт всегда ВПЕРЁД по
        // правилам (если target < from — это всё равно forward через 0).
        return { kind: "move", target: card.effect.target, direction: "forward" };
      }

      case "go-salary": {
        // Карточка «Отправляйтесь на Вперёд. Получите goSalary».
        // Начисляем goSalary всегда, перемещаем на клетку 0.
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
        player.jailCards += 1;
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
        // Списываем; баланс НЕ уходит в минус (защита от двойного банкротства —
        // банкротство запускается в games.service).
        player.money = Math.max(0, player.money - total);
        return { kind: "stay" };
      }
    }
  }
}
