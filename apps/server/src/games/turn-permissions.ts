import type { GameState, Player } from "@monopoly/shared";

/**
 * Утилиты проверки прав игрока на игровые действия.
 *
 * ## Зачем отдельный модуль
 *
 * Логика «когда игрок может бросить кубики / завершить ход» — это
 * бизнес-правила Монополии, а не детали FSM. Они должны быть:
 *
 *   1) переиспользуемы (и на сервере — для валидации входящих actions,
 *      и на клиенте — для отрисовки активных кнопок);
 *   2) легко тестируемы (чистые функции без side-effects);
 *   3) документируемы в одном месте.
 *
 * Раньше аналогичные проверки были зашиты в `GameView.vue` и
 * `dispatch` сервера — причём логика немного расходилась: сервер
 * считал `END_TURN` недопустимым в `ROLLING` (правильно), а UI
 * показывал кнопку «Завершить» активной — из-за чего игрок мог
 * «пропустить» обязательный бросок кубиков (например, после дубля).
 *
 * ## Правила Монополии, которые реализуются здесь
 *
 *  - `ROLL_DICE` (бросок кубиков):
 *      * Только в фазе `ROLLING`.
 *      * Только для текущего игрока (`currentPlayerIndex`).
 *      * Только если игрок НЕ в тюрьме (для тюрьмы — отдельная
 *        ветка `JAIL_DECISION` с действиями `TRY_DOUBLE` / `PAY_JAIL_FINE`
 *        / `USE_JAIL_CARD`).
 *      * Только если игрок НЕ банкрот и партия активна.
 *      * `mustRollAgain=true` НЕ блокирует бросок — наоборот,
 *        делает его обязательным.
 *
 *      ## Правило «дубль + карточка Шанс/Казна»
 *
 *      Если игрок выбросил дубль (mustRollAgain=true) и затем попал на
 *      клетку Шанс/Казна, `applyCardEffectAndAdvance` в GamesService
 *      сбрасывает `mustRollAgain=false` и `consecutiveDoubles=0` ПРИ
 *      эффектах `move` / `move-relative` / `go-salary` (т.е. для
 *      карточек, перемещающих фишку на конкретную/другую клетку).
 *      Логика: «выводящая» из обычного цикла карточка обрывает серию
 *      дублей — игрок должен либо заплатить/попасть в тюрьму/попасть
 *      на парковку и т.п. и завершить ход, а не бросать ещё раз.
 *
 *      Для карточек-«stay» (`money` / `jail-free` / `luxury-tax-house`)
 *      `mustRollAgain` НЕ сбрасывается — игрок остаётся на той же
 *      клетке, и после `afterRentOrTax` фаза становится `ROLLING`
 *      (повторный бросок обязателен).
 *
 *  - `END_TURN` (завершение хода):
 *      * В фазе `BUILDING` (обычный случай: после покупки/события).
 *      * В фазе `ROLLING` — НЕЛЬЗЯ. Бросок в начале хода обязателен;
 *        даже без `mustRollAgain` пропустить его нельзя.
 *      * Только для текущего игрока, не банкрота, активной партии.
 *      * `mustRollAgain=true` в фазе `BUILDING` означает, что после
 *        события игрок ОБЯЗАН бросить ещё раз — `END_TURN` блокируется
 *        (сервер при `END_TURN` в `BUILDING` с `mustRollAgain=true`
 *        сам переключит фазу в `ROLLING`).
 *
 *  - `BUY_PROPERTY` (покупка клетки):
 *      * Только в фазе `BUY_DECISION` для текущего игрока.
 *      * ТОЛЬКО если игрок НЕ в тюрьме. В тюрьме покупка
 *        запрещена правилами Монополии — в текущем ходу игрок
 *        может только «Завершить ход».
 *
 *  - `TRADE_OFFER` (торговля):
 *      * Только в фазе `BUILDING` для текущего игрока.
 *      * ТОЛЬКО если игрок НЕ в тюрьме. Правила Монополии
 *        запрещают торговлю в тюрьме.
 *
 * Использование:
 *
 *   - Сервер: `GamesService.applyAction` вызывает `canRollDice`/`canEndTurn`
 *     в начале обработки для защиты от «пропуска обязательного действия»
 *     со стороны клиента. Раньше защита была в `dispatch`, но она была
 *     менее явной и зависела от точной фазы.
 *   - Клиент: импортируется в shared-пакет либо (на текущем этапе)
 *     дублируется в `GameView.vue` (см. комментарий там).
 */

/**
 * Является ли `player` тем, чьё сейчас ход.
 *
 * Учитывает interrupt-фазы: если партия в фазе торговли/аукциона/банкротства,
 * `currentPlayerIndex` указывает на «основного» владельца хода, но реально
 * отвечает другая сторона. Для универсальной проверки «мой ли это ход» это
 * всё равно подходит — кнопки `Бросить`/`Завершить` имеют смысл только
 * для текущего игрока, а в interrupt-фазах они в любом случае неактивны
 * (фаза ≠ ROLLING/BUILDING).
 */
export function isCurrentPlayer(state: GameState, player: Player): boolean {
  const current = state.players[state.currentPlayerIndex];
  return !!current && current.id === player.id;
}

/**
 * Базовые условия: партия активна, игрок существует, не банкрот.
 */
function baseChecksOk(state: GameState, player: Player): boolean {
  if (state.status !== "active") return false;
  if (player.isBankrupt) return false;
  return true;
}

/**
 * Может ли `player` сейчас бросить кубики.
 *
 * Возвращает `true` ТОЛЬКО если:
 *  - партия активна;
 *  - игрок не банкрот;
 *  - это ход именно этого игрока;
 *  - фаза = `ROLLING`;
 *  - игрок НЕ в тюрьме (для тюрьмы — `JAIL_DECISION` со своими действиями).
 *
 * Флаг `mustRollAgain` не влияет на результат: если он `true`,
 * бросок ОБЯЗАТЕЛЕН (а не запрещён).
 *
 * `justArrivedAtParking` блокирует бросок: если игрок только что
 * отправлен на парковку по карточке «Отправляйтесь на парковку»,
 * право на ещё один бросок (после дубля) ТЕРЯЕТСЯ — игрок может
 * только завершить ход. Сбрасывается в `handleStartTurn`.
 */
export function canRollDice(state: GameState, player: Player): boolean {
  if (!baseChecksOk(state, player)) return false;
  if (!isCurrentPlayer(state, player)) return false;
  if (state.phase !== "ROLLING") return false;
  if (player.inJail) return false;
  // Арест через парковку: цепочка «бросок → движение → эффект» уже
  // отыграна, новый бросок в ЭТОМ ходу запрещён.
  if (state.justArrivedAtParking) return false;
  return true;
}

/**
 * Может ли `player` сейчас завершить ход.
 *
 * Возвращает `true` ТОЛЬКО если:
 *  - партия активна;
 *  - игрок не банкрот;
 *  - это ход именно этого игрока;
 *  - фаза = `BUILDING`;
 *  - `mustRollAgain === false` (иначе сервер форсит повторный бросок).
 *
 * ВАЖНО: в фазе `ROLLING` завершить ход НЕЛЬЗЯ — бросок в начале хода
 * обязателен. Это и есть основной bugfix: UI не должен показывать
 * активную кнопку «Завершить» в начале хода или после дубля.
 */
export function canEndTurn(state: GameState, player: Player): boolean {
  if (!baseChecksOk(state, player)) return false;
  if (!isCurrentPlayer(state, player)) return false;
  // В фазе BUILDING — обычное завершение хода (после покупки/события).
  if (state.phase === "BUILDING") {
    if (player.mustRollAgain) return false;
    return true;
  }
  // В фазе JAIL_DECISION — завершить ход разрешено только если
  // игрок ТОЛЬКО ЧТО попал в тюрьму (justEnteredJail=true).
  // В этом ходу по правилам Монополии игрок НЕ принимает решения
  // о выходе — только «Завершить ход». Модалка с тремя способами
  // выхода появится в начале СЛЕДУЮЩЕГО хода, когда handleStartTurn
  // сбросит justEnteredJail.
  if (state.phase === "JAIL_DECISION" && state.justEnteredJail) {
    return true;
  }
  return false;
}

/**
 * Может ли `player` сейчас покупать недвижимость.
 *
 * Правила:
 *  - партия активна;
 *  - игрок не банкрот;
 *  - это ход именно этого игрока;
 *  - фаза = `BUY_DECISION`;
 *  - игрок НЕ в тюрьме (правилами Монополии торговля и покупка в тюрьме
 *    запрещены — в текущем ходу игрок может только «Завершить ход»).
 *
 * Используется и сервером (`handleBuyDecision`), и UI (`canBuy` в `GameView`).
 */
export function canBuyProperty(state: GameState, player: Player): boolean {
  if (!baseChecksOk(state, player)) return false;
  if (!isCurrentPlayer(state, player)) return false;
  if (state.phase !== "BUY_DECISION") return false;
  if (player.inJail) return false;
  return true;
}

/**
 * Может ли `player` сейчас инициировать обмен.
 *
 * Правила (GDD §1.1: торги в любой момент хода):
 *  - партия активна;
 *  - игрок не банкрот;
 *  - это ход именно этого игрока;
 *  - фаза партии — одна из «своих» Turn FSM (разрешено ТОРГОВАТЬ как ДО броска,
 *    так и ПОСЛЕ — на этапе строительства, передвижения фишки и т.п.);
 *  - ЗАПРЕЩЕНО во время анимации движения (`MOVE_ANIMATION`) и в interrupt-фазах
 *    (аукцион, банкротство, чужая торговля, FINISHED, BOT_THINKING и т.п.);
 *  - игрок НЕ в тюрьме (правилами Монополии торговля в тюрьме запрещена).
 */
export function canTrade(state: GameState, player: Player): boolean {
  if (!baseChecksOk(state, player)) return false;
  if (!isCurrentPlayer(state, player)) return false;
  if (player.inJail) return false;

  // Разрешённые фазы — все «свои» фазы хода, плюс финальные/глобальные
  // терминальные фазы явно запрещены.
  const allowed: ReadonlyArray<GameState["phase"]> = [
    "START_TURN",
    "ROLLING",
    "DICE_ANIMATION",
    "RESOLVING_LANDING",
    "PAY_RENT",
    "TAX_PAYMENT",
    "BUY_DECISION",
    "CARD_REVEAL",
    "CARD_EFFECT",
    "BUILDING",
    "JAIL_DECISION",
    "END_TURN",
  ];
  if (!allowed.includes(state.phase)) return false;

  // Анимация движения фишки — единственная «своя» фаза, где мы НЕ хотим
  // открывать диалог торговли (иначе клиент словит десинхронизацию).
  if (state.moveAnimation) return false;

  return true;
}

/**
 * Должен ли `player` сейчас бросить кубики (т.е. бросок обязателен).
 *
 * Используется UI для подсветки/обучения и сервером для контроля,
 * что игрок не пытается «пропустить» обязательный бросок. Сейчас
 * `mustRollAgain` — единственный источник «обязательности»:
 * если он `true`, фаза всегда `ROLLING` (см. логику дублей
 * в `handleDiceAnimation` → `afterRentOrTax`).
 */
export function mustRollDiceNow(state: GameState, player: Player): boolean {
  if (!baseChecksOk(state, player)) return false;
  if (!isCurrentPlayer(state, player)) return false;
  if (state.phase !== "ROLLING") return false;
  if (player.inJail) return false;
  return player.mustRollAgain === true;
}
