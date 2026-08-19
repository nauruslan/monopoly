export interface Card {
  id: string;
  /**
   * Колода, к которой принадлежит карта:
   *  - "chance"      — Шанс
   *  - "treasury"    — Казна
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
 *  - "money"               — начислить/списать amount (со знаком) на счёт игрока.
 *  - "move"                — телепорт на клетку target. Если money задан — начислить
 *                            бонус при прохождении/прибытии на GO.
 *  - "move-relative"       — сдвиг на steps (вперёд/назад) с оборачиванием по 40.
 *  - "goto-jail"           — прямая отправка в тюрьму (клетка 10).
 *  - "jail-free"           — выдать карточку "выйди из тюрьмы бесплатно".
 *  - "go-salary"           — начислить goSalary и перейти на клетку 0.
 *  - "luxury-tax-house"    — формула налога на имущество:
 *                            perHouse       ₽ за каждый ДОМ,
 *                            perHotel       ₽ за каждый ОТЕЛЬ (houses === 5),
 *                            perProperty    ₽ за каждый участок (PROPERTY/RAILROAD/UTILITY).
 *  - "nearest-utility"     — телепорт на ближайшее коммунальное предприятие (клетки 12 или 28).
 *                            После приземления обычный handleResolvingLanding обработает
 *                            ренту/событие клетки. Движение НЕ проходит через клетку 0.
 *  - "nearest-railroad"    — телепорт на ближайшую ж/д станцию (5, 15, 25 или 35).
 *                            Аналогично nearest-utility.
 *  - "pay-each-player"     — заплатить каждому ПРОТИВНИКУ amountPerPlayer ₽
 *                            (списание у текущего игрока, зачисление каждому противнику).
 *                            Себе платить НЕ надо.
 *  - "money-if-monopoly"   — начислить amount ₽, если у игрока есть хотя бы одна
 *                            монополия (полный цветной набор). Иначе — no-op.
 *  - "money-per-property"  — начислить amountPerUnit ₽ за каждый НЕзаложенный
 *                            участок игрока (PROPERTY/RAILROAD/UTILITY).
 *                            Заложенные участки НЕ считаются.
 *  - "money-per-monopoly"  — начислить amountPerMonopoly ₽ за каждую полную
 *                            монополию игрока (полный цветной набор).
 *  - "stay"                — нейтральный эффект; не меняет state (используется
 *                            как fallback / no-op).
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
  | { kind: "luxury-tax-house"; perHouse: number; perHotel: number; perProperty: number }
  | { kind: "nearest-utility" }
  | { kind: "nearest-railroad" }
  | { kind: "pay-each-player"; amountPerPlayer: number }
  | { kind: "money-if-monopoly"; amount: number }
  | { kind: "money-per-property"; amountPerUnit: number }
  | { kind: "money-per-monopoly"; amountPerMonopoly: number }
  | { kind: "stay" };

/**
 * Колода Шанс — 20 карточек.
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
    // Карточка «Идите на СТАРТ». Деньги НЕ начисляются напрямую —
    // при приземлении на клетку id=0 (GO/СТАРТ) сервер начислит
    // двойную выплату (2× goSalary) в handleResolvingLanding
    // (ветка cell.type === "GO"). Здесь намеренно НЕ указан
    // `passedGo` и НЕ используется `go-salary` (т.к. тот сразу
    // начисляет goSalary — для новой логики нам это не нужно).
    deck: "chance",
    text: "Идите на СТАРТ",
    direction: "forward",
    effect: { kind: "move", target: 0 },
  },
  {
    id: "ch2",
    deck: "chance",
    text: "Банк выплачивает вам дивиденды 50�",
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
    text: "День рождения! Получите 50�",
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
  {
    id: "ch10",
    deck: "chance",
    text: "Вернитесь на 5 клеток назад",
    direction: "backward",
    effect: { kind: "move-relative", steps: -5, direction: "backward" },
  },
  {
    id: "ch11",
    deck: "chance",
    text: "Вернитесь на 2 клетки назад",
    direction: "backward",
    effect: { kind: "move-relative", steps: -2, direction: "backward" },
  },

  {
    id: "ch12",
    deck: "chance",
    text: "Пройдите вперёд на 2 клетки",
    direction: "forward",
    effect: { kind: "move-relative", steps: 2, direction: "forward" },
  },
  {
    id: "ch13",
    deck: "chance",
    text: "Пройдите вперёд на 3 клетки",
    direction: "forward",
    effect: { kind: "move-relative", steps: 3, direction: "forward" },
  },
  {
    id: "ch14",
    deck: "chance",
    text: "Пройдите вперёд на 5 клеток",
    direction: "forward",
    effect: { kind: "move-relative", steps: 5, direction: "forward" },
  },
  /**
   * Ближайшее коммунальное предприятие (клетки 12 и 28).
   * Сервер при applyEffect выбирает кратчайший путь ВПЕРЁД по часовой
   * (правила Монополии — «не проходим через СТАРТ»): если фишка на
   * клетках 1..19 → идём к 12; если на 21..39 → к 28.
   * Направление определяется сравнением target с from (см. card-handler).
   */
  {
    id: "ch15",
    deck: "chance",
    text: "Идите на ближайшее коммунальное предприятие",
    effect: { kind: "nearest-utility" },
  },
  /**
   * Ближайшая ж/д станция (5, 15, 25, 35).
   * Сервер при applyEffect выбирает первую ж/д ВПЕРЁД по часовой,
   * не проходя через СТАРТ (target > from).
   */
  {
    id: "ch16",
    deck: "chance",
    text: "Идите на ближайший железнодорожный вокзал",
    effect: { kind: "nearest-railroad" },
  },
  /**
   * «Вас избрали председателем совета директоров» —
   * списание 50₽ с каждого ПРОТИВНИКА (зачисление каждому противнику).
   * Себе платить не нужно. Если противников нет — no-op.
   */
  {
    id: "ch17",
    deck: "chance",
    text: "Вас избрали председателем совета директоров. Заплатите каждому игроку по 50₽",
    effect: { kind: "pay-each-player", amountPerPlayer: 50 },
  },
  {
    id: "ch18",
    deck: "chance",
    text: "Банк платит вам дивиденды 200₽",
    effect: { kind: "money", amount: 200 },
  },
  /**
   * «Наступил срок платежа по вашей ссуде на строительство.
   * Получите 300₽, если у вас есть монополия».
   * Если у игрока нет монополии — карта не даёт денег.
   */
  {
    id: "ch19",
    deck: "chance",
    text: "Наступил срок платежа по вашей ссуде на строительство. Получите 300₽, если у вас есть монополия",
    effect: { kind: "money-if-monopoly", amount: 300 },
  },
  {
    id: "ch20",
    deck: "chance",
    text: "У вас сломался автомобиль. Ремонт обошелся в 50₽",
    effect: { kind: "money", amount: -50 },
  },
];

/**
 * Колода Казна — 12 карточек (смесь налогов и прибыли).
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

  /**
   * «Выйдите из тюрьмы бесплатно» — аналог ch7, но из колоды Казна.
   * Также holdable (transferable=true), чтобы можно было передать.
   */
  {
    id: "tr7",
    deck: "treasury",
    text: "Выйдите из тюрьмы бесплатно",
    effect: { kind: "jail-free" },
  },
  {
    id: "tr8",
    deck: "treasury",
    text: "Получите 250₽ за консалтинговые услуги",
    effect: { kind: "money", amount: 250 },
  },
  /**
   * «На продаже акций вы зарабатываете по 50� за каждый незаложенный
   * участок». Считаются ВСЕ участки игрока (PROPERTY/RAILROAD/UTILITY),
   * НЕ находящиеся в залоге.
   */
  {
    id: "tr9",
    deck: "treasury",
    text: "На продаже акций вы зарабатываете по 50₽ за каждый незаложенный участок",
    effect: { kind: "money-per-property", amountPerUnit: 50 },
  },
  {
    id: "tr10",
    deck: "treasury",
    text: "Возмещение подоходного налога. Получите 200₽",
    effect: { kind: "money", amount: 200 },
  },
  {
    id: "tr11",
    deck: "treasury",
    text: "Наступил срок исполнения платежа по страхованию жизни. Получите 100₽",
    effect: { kind: "money", amount: 100 },
  },
  /**
   * «На продаже акций вы зарабатываете по 200₽ за каждую монополию».
   * Монополия — полный цветной набор (например, все 3 красные улицы).
   * Если у игрока 2 монополии — 2 × 200₽ = 400₽.
   */
  {
    id: "tr12",
    deck: "treasury",
    text: "На продаже акций вы зарабатываете по 200₽ за каждую монополию",
    effect: { kind: "money-per-monopoly", amountPerMonopoly: 200 },
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
