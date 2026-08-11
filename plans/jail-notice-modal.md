# План: модальное окно «Вы арестованы! Отправляйтесь в тюрьму.»

## Цель

Добавить в игру специальное информационное модальное окно «Вы арестованы!
Отправляйтесь в тюрьму!», показываемое в 2 случаях:

1. **Клетка 30 (GOTO_JAIL)** — сейчас используется `CARD_REVEAL` с текстом
   Chance-карточки «отправляйтесь в тюрьму» — но поле 30 это НЕ колода ШАНС.
2. **Три дубля подряд** — сейчас НЕТ никакого уведомления, игрок просто
   анимируется на клетку 10 и оказывается в `JAIL_DECISION` без объяснений.

Окно должно быть в стиле карточек колод (как [CardModal.vue](../apps/client/src/components/modals/CardModal.vue)),
содержать заголовок и текст причины ареста, иметь кнопку «ПРИНЯТЬ» для игрока-человека
и авто-закрытие 2-3 секунды для бота.

Только после закрытия окна начинается анимация фишки к клетке 10 ТЮРЬМА.

В журнал добавить запись «Игрок выкинул три дубля подряд и попал в тюрьму».

## Архитектура решения

### 1. Сервер: новая фаза `JAIL_NOTICE`

#### 1.1. Новый `Phase` в [`packages/shared/src/types/game.ts`](../packages/shared/src/types/game.ts)

Добавить значение `"JAIL_NOTICE"` в `Phase`-union после `"CARD_EFFECT"`.

Это новая UX-фаза (как `CARD_REVEAL`), показывающая информационное окно.

#### 1.2. Новый `GameAction` в [`packages/shared/src/types/action.ts`](../packages/shared/src/types/action.ts)

Добавить в `GameAction`:
```ts
/** Клиент/бот закрыл информационное модальное окно «Вы арестованы!»
 *  (JAIL_NOTICE). Сервер начинает анимацию фишки к клетке 10. */
| { type: "CONFIRM_JAIL_NOTICE" }
```

#### 1.3. Новые поля в `GameState`

Добавить в `GameState` поле `jailNotice?: { playerId: string; reason: "cell" | "card" | "double" }` —
контекст активного модального окна (по аналогии с `state.cardContext`).
Без `state.cardContext`-стиля — это поле в корне `GameState`.

#### 1.4. Новый handler `handleJailNotice` в [`games.service.ts`](../apps/server/src/games/games.service.ts)

```ts
private async handleJailNotice(
  state: GameState,
  player: Player,
  action: GameAction,
): Promise<{ event?: GameEvent }> {
  if (action.type !== "CONFIRM_JAIL_NOTICE") {
    throw new ForbiddenException(...);
  }
  // После подтверждения окна — переходим к анимации фишки.
  // from / to / direction уже сохранены в state.moveAnimation.
  // Если окно было для клетки 30 (cell), нужно ещё построить moveAnimation.
  // Реальная логика зависит от сценария, см. ниже.
  ...
}
```

#### 1.5. Логика входа в `JAIL_NOTICE`

Есть **два** места входа в фазу `JAIL_NOTICE`:

**Сценарий A — Клетка 30 (GOTO_JAIL):**
* Сейчас в [`handleResolvingLanding`](../apps/server/src/games/games.service.ts:1128-1160):
  ```
  if (cell.type === "GOTO_JAIL") {
    const jailCard = CHANCE_CARDS.find(...);
    if (jailCard) {
      state.cardContext = { ... };
      state.phase = "CARD_REVEAL";  // ← заменить на "JAIL_NOTICE"
      return { card: jailCard };
    }
  }
  ```
* Заменить: установить `state.jailNotice = { playerId, reason: "card" }`,
  `state.phase = "JAIL_NOTICE"`.
* `state.moveAnimation` пока НЕ заполняется — заполнится на следующем шаге
  (в `handleJailNotice` при `CONFIRM_JAIL_NOTICE`).
* Журнал: `this.log.logJailEntered(state, player, "cell")` — текст причины
  «при попадании на клетку 30».

**Сценарий B — Три дубля подряд:**
* Сейчас в [`handleDiceAnimation`](../apps/server/src/games/games.service.ts:824-930):
  ```
  if (player.consecutiveDoubles >= 3) {
    const from = player.position;
    const to = 10;
    // ... выбор direction
    player.position = to;
    state.moveAnimation = { ..., direction };
    state.pendingJailFromCard = true;
    state.pendingJailReason = "double";
    player.mustRollAgain = false;
    player.consecutiveDoubles = 0;
    state.lastDice = ...;
    state.phase = "MOVE_ANIMATION";  // ← заменить на "JAIL_NOTICE"
    return {};
  }
  ```
* Заменить: `state.jailNotice = { playerId, reason: "double" }`,
  `state.phase = "JAIL_NOTICE"`. **Убрать** пока заполнение
  `state.moveAnimation` и `state.lastDice` (тоже заполнятся после
  `CONFIRM_JAIL_NOTICE`).
* Журнал: `this.log.logJailEntered(state, player, "double")` —
  добавить отдельный метод `logJailEnteredDouble` с текстом
  «Игрок X выкинул три дубля подряд и попал в тюрьму» (см. п. 1.6).

#### 1.6. Логика выхода из `JAIL_NOTICE` (после `CONFIRM_JAIL_NOTICE`)

`handleJailNotice` строит `state.moveAnimation` по тому же правилу
«не через СТАРТ» (forward/backward), что и раньше:
```ts
const from = player.position;  // ещё НЕ 10
const to = 10;
let direction: "forward" | "backward";
let steps: number;
if (from < to) {
  direction = "forward";
  steps = to - from;
} else {
  direction = "backward";
  steps = from - to;
}
player.position = to;  // КРИТИЧНО: для isCardMove-ветки в handleMoveAnimation
state.moveAnimation = { playerId, from, to, steps, isDouble: ...reason === "double", direction };
state.pendingJailFromCard = true;
state.pendingJailReason = state.jailNotice!.reason;  // "card" или "double" (cell → "card")
state.jailNotice = undefined;
state.phase = "MOVE_ANIMATION";
```

Дальше flow стандартный: `CONFIRM_MOVE_ANIMATION` → `RESOLVING_LANDING`
→ ветка `JAIL + pendingJailFromCard` в [handleResolvingLanding:1300](../apps/server/src/games/games.service.ts:1300) →
`sendToJail` + `JAIL_DECISION`.

#### 1.7. Журнал — новый метод в [`log.service.ts`](../apps/server/src/games/handlers/log.service.ts)

Добавить два (или один параметризованный) метода в `LogService`:

```ts
/** Универсальное сообщение о попадании в тюрьму через информационное окно.
 *  Сохраняет причину в payload для фильтров UI. */
logJailNoticeShown(
  state: GameState,
  player: Player,
  reason: "cell" | "card" | "double",
): GameEvent { ... }

/** Сообщение «Игрок выкинул три дубля подряд и попал в тюрьму».
 *  Текст отличается от обычного «попал в тюрьму», так как нужно явно
 *  объяснить причину ареста (правило 3 дублей). */
logJailEnteredByTriples(
  state: GameState,
  player: Player,
): GameEvent { ... }
```

Для сценария B (3-й дубль) в `handleJailNotice` нужно вызвать
`this.log.logJailEnteredByTriples(state, player)` ДО перехода в `MOVE_ANIMATION`.

### 2. Сервер: диспетчер

В [`dispatch`](../apps/server/src/games/games.service.ts:509-621) добавить case `"JAIL_NOTICE"`.

Добавить `"JAIL_NOTICE"` в `isWaitingForClientConfirm` и в
`confirmActionForPhase` (возвращает `{ type: "CONFIRM_JAIL_NOTICE" }`).

Добавить `"JAIL_NOTICE"` в массивы вспомогательных методов:
- `scheduleBotConfirmFallback` (проверка `phase === "JAIL_NOTICE"`)
- `RESTORABLE_PHASES_AFTER_TRADE`
- `botDecisionToAction` (через `botDecisionToActionForJailNotice` НЕ нужно —
  бот просто отправляет `CONFIRM_JAIL_NOTICE` через 2-3 секунды, это
  обрабатывается через `confirmActionForPhase`, аналог `CARD_REVEAL`).

### 3. Клиент: новый компонент [`JailNoticeModal.vue`](../apps/client/src/components/modals/)

Создать `/apps/client/src/components/modals/JailNoticeModal.vue` —
по стилю как `CardModal.vue` (карточка с градиентом, заголовком и кнопкой),
но с тюремной цветовой схемой (тёмно-синий/чёрный фон, оранжевый акцент),
иконкой «⛓️» или «🚔», заголовком «ВНИМАНИЕ» и текстом «Вы арестованы!
Отправляйтесь в тюрьму!».

Props:
- `show: boolean`
- `reason: "cell" | "card" | "double"` — для подзаголовка:
  - `cell` → «при попадании на клетку „В тюрьму"»
  - `card` → «по карточке „Отправляйтесь в тюрьму"»
  - `double` → «выбросив три дубля подряд»

Emits:
- `(e: "close"): void` — кнопка «ПРИНЯТЬ»

### 4. Клиент: интеграция в [`GameView.vue`](../apps/client/src/views/GameView.vue)

1. Импорт `JailNoticeModal`.
2. Локальные `ref`-ы:
   - `showJailNoticeModal = ref(false)`
   - `jailNoticeReason = ref<"cell" | "card" | "double">("card")`
3. В watcher `state.value.phase` (по аналогии с `CARD_REVEAL`):
   - На `phase === "JAIL_NOTICE"`:
     - `jailNoticeReason.value = state.value.jailNotice?.reason ?? "card"`
     - `showJailNoticeModal.value = true`
     - Для бота: `setTimeout(() => sendConfirmForCurrentPhase("JAIL_NOTICE", { type: "CONFIRM_JAIL_NOTICE" }), 2500)`
   - При `newPhase !== "JAIL_NOTICE"`: `showJailNoticeModal.value = false`.
4. Функция `onCloseJailNotice()` — вызывает `sendAction({ type: "CONFIRM_JAIL_NOTICE" })`.
5. В `<template>` после `<CardModal>` добавить `<JailNoticeModal>`.

### 5. Стор [`apps/client/src/stores/game.ts`](../apps/client/src/stores/game.ts)

Действие `CONFIRM_JAIL_NOTICE` уже отправится через `sendAction()` —
отдельных изменений в сторе не требуется. Поле `state.jailNotice`
приходит как часть `state` через `socket.on("game:state")`.

### 6. Тесты — обновления

#### 6.1. [`games.service.fsm.spec.ts`](../apps/server/src/games/__tests__/games.service.fsm.spec.ts)

**Тест «3 дубля подряд»:**
* Сейчас: `CONFIRM_DICE_ANIMATION` → сразу `MOVE_ANIMATION`.
* Стало: `CONFIRM_DICE_ANIMATION` → `JAIL_NOTICE` (новое).
* Шаг за шагом:
  1. `CONFIRM_DICE_ANIMATION` → `phase=JAIL_NOTICE`, `state.jailNotice.reason="double"`.
     `state.moveAnimation=undefined`, `player.position` ещё прежний (30).
  2. `CONFIRM_JAIL_NOTICE` → `phase=MOVE_ANIMATION`, `player.position=10`,
     `state.moveAnimation` заполнен с правильным direction.
  3. `CONFIRM_MOVE_ANIMATION` → `phase=RESOLVING_LANDING`.
  4. `CONFIRM_LANDING` → `phase=JAIL_DECISION`, `inJail=true`, etc.

**Тест «GOTO_JAIL cell»:**
* Сейчас: `CONFIRM_LANDING` → `CARD_REVEAL` (через `cardContext`).
* Стало: `CONFIRM_LANDING` → `JAIL_NOTICE` (через `jailNotice`).
* Шаг за шагом:
  1. `CONFIRM_LANDING` → `phase=JAIL_NOTICE`, `state.jailNotice.reason="card"`,
     `state.cardContext=undefined`.
  2. `CONFIRM_JAIL_NOTICE` → `phase=MOVE_ANIMATION`, etc.

#### 6.2. Тесты в `special-cells-double.spec.ts`, `card-double-roll.spec.ts`, `bot-double-roll.spec.ts`

В этих файлах встречаются `phase === "CARD_REVEAL" + cardContext.effect.kind === "goto-jail"`.
Это **ДРУГОЙ** сценарий — карточка из колоды Шанс/Казна с эффектом `goto-jail`,
вытянутая при попадании на CHANCE/TREASURY клетку. Эту ветку НЕ трогаем —
она остаётся через `CARD_REVEAL`/`CARD_EFFECT`/`applyCardEffectAndAdvance`.
Никаких изменений в этих файлах не требуется.

#### 6.3. Новый тест: «Журнал при 3 дублях пишет правильную причину»

В `games.service.fsm.spec.ts` (или новый файл `jail-notice.spec.ts`)
добавить тест, проверяющий, что после `CONFIRM_DICE_ANIMATION` для 3 дублей:
* В `state.events` есть запись с текстом «Игрок X выкинул три дубля подряд и попал в тюрьму»
  (или с `kind === "JAIL_NOTICE_DOUBLE"` в payload).

#### 6.4. Обновление `bot-double-roll.spec.ts` (если есть зависимость от фазы)

После перепроектирования 3-й дубль больше не выпадает в `MOVE_ANIMATION`
сразу, а сначала в `JAIL_NOTICE`. Тесты, которые раньше проверяли
`expect(phase).toBe("MOVE_ANIMATION")` после `CONFIRM_DICE_ANIMATION`
для 3-го дубля, нужно обновить на `expect(phase).toBe("JAIL_NOTICE")`.

### 7. План миграции/безопасность

* `state.jailNotice` — опциональное поле, обратная совместимость с
  сохранёнными `GameState` в БД (Drizzle) не нарушается (можно его
  НЕ сохранять — это transient UX-state, как `state.cardContext`).
* Существующая логика `CARD_REVEAL` для SHANCE/TREASURY клеток
  (не `GOTO_JAIL`) остаётся нетронутой.
* `applyCardEffectAndAdvance` (ветка `outcome.kind === "goto-jail"`)
  для карточек Шанс/Казна — НЕ трогаем (она вызывается через CARD_REVEAL
  и её flow: модалка карточки → эффект → MOVE_ANIMATION → JAIL_DECISION).
  Изменение только в `handleResolvingLanding` для `cell.type === "GOTO_JAIL"`.

### 8. Очерёдность реализации

1. ✅ Сервер: добавить `Phase = "JAIL_NOTICE"` и `GameAction = "CONFIRM_JAIL_NOTICE"`
   в shared types.
2. ✅ Сервер: добавить `state.jailNotice` в `GameState`.
3. ✅ Сервер: добавить `handleJailNotice` и case в `dispatch`.
4. ✅ Сервер: добавить `JAIL_NOTICE` в `isWaitingForClientConfirm`,
   `confirmActionForPhase`, и массивы в `scheduleBotConfirmFallback`/торговле/проч.
5. ✅ Сервер: переключить `handleDiceAnimation` (3-й дубль) с `MOVE_ANIMATION` на `JAIL_NOTICE`.
6. ✅ Сервер: переключить `handleResolvingLanding` для `GOTO_JAIL` клетки с `CARD_REVEAL` на `JAIL_NOTICE`.
7. ✅ Сервер: добавить `logJailNoticeShown` и `logJailEnteredByTriples` в `LogService`.
8. ✅ Клиент: создать `JailNoticeModal.vue`.
9. ✅ Клиент: интегрировать в `GameView.vue` + бот-таймер на 2.5 с.
10. ✅ Тесты: добавить покрытие JAIL_NOTICE в `games.service.fsm.spec.ts`.
11. ✅ Тесты: обновить соседние тесты, которые задевал рефакторинг.
12. ✅ Прогнать `tsc --noEmit`, `jest`, `eslint`.

### 9. Открытые вопросы

* ✅ Подсчёт `moveAnimation.steps`: остаётся как раньше (абсолютное число клеток
  по выбранному направлению).
* ✅ Кнопка модального окна: «ПРИНЯТЬ» по требованию пользователя.
* ✅ Бот-таймер: 2500 мс (как для `CARD_REVEAL`) — соответствует «2-3 секунды».
* ✅ Текст причины: один общий заголовок «Вы арестованы! Отправляйтесь в тюрьму!» +
  подзаголовок с конкретной причиной (cell/card/double).
* ⚠️ Логирование: где звать `logJailEntered` — ДО `JAIL_NOTICE`
  (чтобы запись в журнале появилась при показе окна) или ПОСЛЕ
  `CONFIRM_JAIL_NOTICE` (как сейчас)? **Решение:** звать ДО показа окна
  (т.е. при входе в `JAIL_NOTICE`), чтобы игроки сразу в чате/логе видели
  причину. `logJailEnteredByTriples` для 3 дублей.
