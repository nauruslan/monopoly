export interface Card {
  id: string;
  /**
   * Колода, к которой принадлежит карта:
   *  - "chance"      — Шанс
   *  - "treasury"    — Общественная казна
   *  - "luxury-tax"  — Роскошный налог (набор карточек-формул)
   */
  deck: "chance" | "treasury" | "luxury-tax";
  /** Текст карточки для UI. */
  text: string;
  /**
   * Направление движения для карточек с эффектом `move` / `move-relative`
   * / `go-salary` (необязательное поле).
   *
   * Используется UI для:
   *  - корректной подсветки/иконки стрелки на карточке;
   *  - подсказки пользователю о направлении (вперёд/назад) ДО того, как
   *    сервер пришлёт `state.moveAnimation.direction` в фазе MOVE_ANIMATION.
   *
   * Сервер определяет реальное направление по знаку `steps` (`move-relative`)
   * или по соотношению `target`/`from` (`move`). Это поле — подсказка
   * для UI и логирования.
   */
  direction?: "forward" | "backward";
  /** Эффект, применяемый ПОСЛЕ закрытия модалки игроком. */
  effect: CardEffect;
}

/**
 * CardEffect — дискриминированное объединение эффектов карточек.
 *
 * Семантика:
 *  - "money"             — начислить/списать amount (со знаком) на счёт игрока.
 *  - "move"              — телепорт на клетку target. Если money задан — начислить
 *                          бонус при прохождении/прибытии на GO.
 *  - "move-relative"     — сдвиг на steps (вперёд/назад) с оборачиванием по 40.
 *  - "goto-jail"         — прямая отправка в тюрьму (клетка 10).
 *  - "jail-free"         — выдать карточку "выйди из тюрьмы бесплатно".
 *  - "go-salary"         — начислить goSalary и перейти на клетку 0.
 *  - "luxury-tax-house"  — формула налога на имущество:
 *                          perHouse       ₽ за каждый ДОМ,
 *                          perHotel       ₽ за каждый ОТЕЛЬ (houses === 5),
 *                          perProperty    ₽ за каждый участок (PROPERTY/RAILROAD/UTILITY).
 */
export type CardEffect =
  | { kind: "money"; amount: number }
  | { kind: "move"; target: number; money?: number }
  | { kind: "goto-jail" }
  | { kind: "jail-free" }
  /**
   * `move-relative` — сдвиг на `steps` клеток.
   *  - `steps > 0`  — движение ВПЕРЁД по часовой стрелке (увеличение номера клетки);
   *  - `steps < 0`  — движение НАЗАД против часовой стрелки (уменьшение номера клетки).
   *
   * Поле `direction` — необязательный «каноничный» указатель направления
   * для UI/логирования. Сервер определяет реальное направление по знаку `steps`:
   *  - steps < 0  → `direction = "backward"` (анимация против часовой);
   *  - steps > 0  → `direction = "forward"`  (анимация по часовой);
   *  - steps === 0 → не движение (без анимации).
   *
   * Начисление goSalary (прохождение через клетку 0) происходит ТОЛЬКО при
   * движении ВПЕРЁД и только если игрок реально «обернулся» через 0.
   * Движение назад НИКОГДА не начисляет goSalary.
   */
  | { kind: "move-relative"; steps: number; direction?: "forward" | "backward" }
  | { kind: "go-salary" }
  | { kind: "luxury-tax-house"; perHouse: number; perHotel: number; perProperty: number };

/**
 * Колода Шанс — 11 карточек.
 * Колода перемешивается один раз в начале партии, и карты идут по кругу.
 *
 * Для карточек, предписывающих движение НАЗАД (steps < 0), на верхнем
 * уровне `Card` проставлен флаг `direction: "backward"`. Это позволяет
 * UI сразу показать корректную иконку/стрелку на карточке ДО её
 * подтверждения (когда `state.moveAnimation.direction` ещё не известен).
 *
 * `effect.direction` для `move-relative` — дублирующий «каноничный»
 * указатель направления; сервер всё равно выводит направление из знака
 * `steps`, но это поле полезно для логирования и тестов.
 */
export const CHANCE_CARDS: Card[] = [
  {
    id: "ch1",
    deck: "chance",
    text: "Отправляйтесь на Вперёд. Получите 200₽",
    direction: "forward",
    effect: { kind: "go-salary" },
  },
  {
    id: "ch2",
    deck: "chance",
    text: "Банк выплачивает вам дивиденды 50₽",
    effect: { kind: "money", amount: 50 },
  },
  {
    id: "ch3",
    deck: "chance",
    text: "Штраф за превышение скорости 15₽",
    effect: { kind: "money", amount: -15 },
  },
  {
    id: "ch4",
    deck: "chance",
    text: "Отправляйтесь в тюрьму",
    effect: { kind: "goto-jail" },
  },
  {
    id: "ch5",
    deck: "chance",
    text: "День рождения! Получите 50₽",
    effect: { kind: "money", amount: 50 },
  },
  {
    id: "ch6",
    deck: "chance",
    text: "Переместитесь на ул. Арбат",
    direction: "forward",
    effect: { kind: "move", target: 37 },
  },
  {
    id: "ch7",
    deck: "chance",
    text: "Выйдите из тюрьмы бесплатно",
    effect: { kind: "jail-free" },
  },
  /**
   * Классическая карточка Шанс: «Вернитесь на 3 клетки назад».
   *
   * ВАЖНО: `direction: "backward"` и `steps: -3`. Сервер по знаку `steps`
   * определяет реальное направление, ставит `state.moveAnimation.direction`
   * в `"backward"`, и клиент анимирует фишку ПРОТИВ часовой стрелки
   * (10 → 9 → 8 → 7, а НЕ 10 → 11 → 12 → ... → 7 как было раньше).
   */
  {
    id: "ch8",
    deck: "chance",
    text: "Вернитесь на 3 клетки назад",
    direction: "backward",
    effect: { kind: "move-relative", steps: -3, direction: "backward" },
  },
  /**
   * Классическая карточка Шанс (американская версия): «Go Back 3 Spaces».
   * Дубликат `ch8` под другим id — у нас в колоде больше слотов для
   * классических шанс-карт (обычно 16), и Шанс-карты дублируются чаще Казны.
   */
  {
    id: "ch9",
    deck: "chance",
    text: "Вернитесь на 3 клетки назад",
    direction: "backward",
    effect: { kind: "move-relative", steps: -3, direction: "backward" },
  },
  /**
   * Классическая карточка Шанс: «Go to Jail» (уже есть как `ch4`) — а вот
   * «Advance to the nearest Utility» / «Advance to the nearest Railroad»
   * в нашей колоде закрыты телепортом на ближайшую по правилам клетку.
   * Добавим одну полезную «назад» карточку «Вернитесь на старт» нельзя
   * (это всегда вперёд через GO) — но «Назад на 5 клеток» имеет смысл,
   * особенно если игрок близко к налоговой/тюрьме.
   */
  {
    id: "ch10",
    deck: "chance",
    text: "Вернитесь на 5 клеток назад",
    direction: "backward",
    effect: { kind: "move-relative", steps: -5, direction: "backward" },
  },
  /**
   * Классическая карточка Шанс: «Take a walk on the Boardwalk» — это
   * телепорт (target = 39) — но мы оставим ещё один кейс НАЗАД:
   * «Вернитесь на старт» (target = 0) — это `move` вперёд, не назад.
   * Поэтому «-2 клетки» как дополнительный шаг.
   */
  {
    id: "ch11",
    deck: "chance",
    text: "Вернитесь на 2 клетки назад",
    direction: "backward",
    effect: { kind: "move-relative", steps: -2, direction: "backward" },
  },
];

/**
 * Колода Общественная казна — 6 карточек (смесь налогов и прибыли).
 */
export const TREASURY_CARDS: Card[] = [
  {
    id: "tr1",
    deck: "treasury",
    text: "Наследство: получите 100₽",
    effect: { kind: "money", amount: 100 },
  },
  {
    id: "tr2",
    deck: "treasury",
    text: "Больничные расходы: заплатите 100₽",
    effect: { kind: "money", amount: -100 },
  },
  {
    id: "tr3",
    deck: "treasury",
    text: "Ошибка банка в вашу пользу: 200₽",
    effect: { kind: "money", amount: 200 },
  },
  {
    id: "tr4",
    deck: "treasury",
    text: "Отправляйтесь в тюрьму",
    effect: { kind: "goto-jail" },
  },
  {
    id: "tr5",
    deck: "treasury",
    text: "Бесплатная парковка. Перейдите на клетку 20",
    effect: { kind: "move", target: 20 },
  },
  {
    id: "tr6",
    deck: "treasury",
    text: "Школьные сборы: заплатите 50₽",
    effect: { kind: "money", amount: -50 },
  },
];

/**
 * Колода Роскошный налог — 4 карточки.
 *
 * Каждая карточка описывает ФОРМУЛУ налога на имущество игрока.
 * При выпадении сервер:
 *   1) показывает карточку в модалке (CARD_REVEAL);
 *   2) после CONFIRM_CARD считает houses/отели/участки и списывает.
 */
export const LUXURY_TAX_CARDS: Card[] = [
  {
    id: "lt1",
    deck: "luxury-tax",
    text: "Налог на имущество: 25₽ за каждый участок, 100₽ за каждый дом, 200₽ за отель",
    effect: { kind: "luxury-tax-house", perHouse: 100, perHotel: 200, perProperty: 25 },
  },
  {
    id: "lt2",
    deck: "luxury-tax",
    text: "Налог на роскошь: 40₽ за каждый участок, 150₽ за каждый дом, 300₽ за отель",
    effect: { kind: "luxury-tax-house", perHouse: 150, perHotel: 300, perProperty: 40 },
  },
  {
    id: "lt3",
    deck: "luxury-tax",
    text: "Страховой взнос: 20₽ за участок, 75₽ за дом, 150₽ за отель",
    effect: { kind: "luxury-tax-house", perHouse: 75, perHotel: 150, perProperty: 20 },
  },
  {
    id: "lt4",
    deck: "luxury-tax",
    text: "Коммунальный сбор: 30₽ за участок, 120₽ за дом, 250₽ за отель",
    effect: { kind: "luxury-tax-house", perHouse: 120, perHotel: 250, perProperty: 30 },
  },
];

/**
 * Вспомогательное: перемешать копию массива по алгоритму Фишера-Йейтса.
 * Принимает функцию RNG (например, `seedrandom(...)`).
 */
export function shuffle<T>(arr: readonly T[], rng: () => number): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = a[i]!;
    a[i] = a[j]!;
    a[j] = tmp;
  }
  return a;
}

/**
 * ВНИМАНИЕ: legacy-функция, оставлена для обратной совместимости.
 * Реальный «детерминированный» розыгрыш теперь делает `drawFromDeck(state, deck)` —
 * он использует заранее перемешанную колоду и курсор, а не Math.random.
 */
export function drawCard(deck: "chance" | "treasury"): Card {
  const cards = deck === "chance" ? CHANCE_CARDS : TREASURY_CARDS;
  return cards[Math.floor(Math.random() * cards.length)]!;
}
