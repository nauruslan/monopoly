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
 */
export function canRollDice(state: GameState, player: Player): boolean {
  if (!baseChecksOk(state, player)) return false;
  if (!isCurrentPlayer(state, player)) return false;
  if (state.phase !== "ROLLING") return false;
  if (player.inJail) return false;
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
  if (state.phase !== "BUILDING") return false;
  if (player.mustRollAgain) return false;
  return true;
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
 * Правила:
 *  - партия активна;
 *  - игрок не банкрот;
 *  - это ход именно этого игрока;
 *  - фаза = `BUILDING` (торговля разрешена только в фазе строительства);
 *  - игрок НЕ в тюрьме (правила Монополии запрещают торговлю в тюрьме).
 */
export function canTrade(state: GameState, player: Player): boolean {
  if (!baseChecksOk(state, player)) return false;
  if (!isCurrentPlayer(state, player)) return false;
  if (state.phase !== "BUILDING") return false;
  if (player.inJail) return false;
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
