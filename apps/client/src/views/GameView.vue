<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from "vue";
import { storeToRefs } from "pinia";
import { useRoute, useRouter } from "vue-router";
import Board from "../components/Board.vue";
import PlayersPanel from "../components/PlayersPanel.vue";
import ActionsPanel from "../components/ActionsPanel.vue";
import CellTooltip from "../components/CellTooltip.vue";
import BuyModal from "../components/modals/BuyModal.vue";
import CardModal from "../components/modals/CardModal.vue";
import TaxModal from "../components/modals/TaxModal.vue";
import RentModal from "../components/modals/RentModal.vue";
import JailModal from "../components/modals/JailModal.vue";
import GameOverModal from "../components/modals/GameOverModal.vue";
import AuctionModal from "../components/modals/AuctionModal.vue";
import TradeModal from "../components/modals/TradeModal.vue";
import MortgageModal from "../components/modals/MortgageModal.vue";
import BuildModal from "../components/modals/BuildModal.vue";
import BankruptcyModal from "../components/modals/BankruptcyModal.vue";
import PlayerBankruptNoticeModal from "../components/modals/PlayerBankruptNoticeModal.vue";
import JailNoticeModal from "../components/modals/JailNoticeModal.vue";
import SettingsPanel from "../components/SettingsPanel.vue";
import LogPanel from "../components/LogPanel.vue";
import { useAuthStore } from "../stores/auth";
import { useGameStore } from "../stores/game";
import { useTradeStore } from "../stores/trade";
import { useMortgageStore } from "../stores/mortgage";
import { useBuildStore } from "../stores/build";
import { useAuctionStore } from "../stores/auction";
import { useJailStore } from "../stores/jail";
import { useSettingsStore } from "../stores/settings";
import { useSocket, disconnectSocket } from "../composables/useSocket";
import type { Cell, GameAction, TradeOffer, Phase, BoardSide } from "@monopoly/shared";
import { getCellSide } from "@monopoly/shared";

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const game = useGameStore();
const settings = useSettingsStore();

const players = computed(() => state.value.players);
// На доске показываем только живых игроков. Банкроты (`isBankrupt`)
// сохраняются в `state.players` для истории и для PlayersPanel
// (где выводится бейдж «БАНКРОТ»), но их фишка не должна торчать
// на игровом поле. ВАЖНО: сервер сам не очищает `player.position` —
// если этого не сделать здесь, маркер банкрота так и останется
// висеть на клетке, на которой он «умер».
const boardPlayers = computed(() => players.value.filter((p) => !p.isBankrupt));
const cells = computed(() => state.value.board);
const currentPlayerId = computed(() => currentPlayer.value?.id || "");

// Dice: берём реактивно из store
const {
  state,
  diceValues,
  diceRolling,
  currentPlayer,
  lastDiceRoll,
  cardPendingConfirm,
  lastDrawnCard,
} = storeToRefs(game);

// Кому принадлежит ход. В текущей реализации `Player` (см.
// packages/shared/src/types/player.ts) НЕ содержит поля `userId` —
// сервер не отдаёт идентификатор залогиненного пользователя в
// `state.players`. Поэтому «мой» ID определяется как ID первого
// human-игрока в партии (host). В одиночных партиях (1 человек + боты)
// это работает корректно: я один human, и когда ход переходит ко мне,
// `myPlayerId` указывает на меня.
const auctionStore = useAuctionStore();
const myPlayerId = computed<string>(() => {
  const me = state.value?.players?.find((p) => p.kind === "human");
  if (me) return me.id;
  return players.value[0]?.id ?? "";
});
// Синхронизируем с auctionStore и tradeStore (нужно для фильтрации
// модалок в `game.ts` — модалку результата сделки показываем ТОЛЬКО
// её участникам, и для проверки `isMyTurn` в `BUILDING_PHASE`).
const tradeStore = useTradeStore();
watch(
  myPlayerId,
  (id) => {
    auctionStore.setMyPlayerId(id);
    tradeStore.setMyPlayerId(id);
  },
  { immediate: true },
);
const isMyTurn = computed(
  () => currentPlayer.value?.kind === "human" && currentPlayer.value?.id === myPlayerId.value,
);

/**
 * `true`, если сейчас «активный» ход — то есть есть текущий игрок
 * (неважно, человек или бот) и партия активна. Используется для
 * отправки ВИЗУАЛЬНЫХ подтверждений (`CONFIRM_DICE_ANIMATION`,
 * `CONFIRM_MOVE_ANIMATION`, `CONFIRM_CARD`, `CONFIRM_LANDING`,
 * `CONFIRM_END_TURN`, `CONFIRM_TAX`, `CONFIRM_RENT_PAYMENT`) от
 * любого подключённого клиента — это и есть главная фишка
 * синхронизации анимаций ботов.
 * ЛЮБОЙ подключённый клиент шлёт `CONFIRM_*` за текущего
 * игрока (хоть бота, хоть человека) сразу, как только анимация
 * или модалка завершилась.
 */
const isCurrentPlayerActive = computed(
  () => state.value.status === "active" && !!currentPlayer.value && !currentPlayer.value.isBankrupt,
);

/**
 * Хелпер: отправить `CONFIRM_*` действие для текущей визуальной фазы.
 * Вызывается из watcher'ов и обработчиков модалок, когда
 * `isCurrentPlayerActive === true`. Если фаза уже сменилась
 * (гонка между broadcast'ами) — действие будет отклонено сервером
 * (try/catch) и ничего не произойдёт.
 */
function sendConfirmForCurrentPhase(phase: Phase, action: GameAction) {
  if (!isCurrentPlayerActive.value) return;
  if (state.value.phase !== phase) return;
  game.sendAction(action);
}

// Допустимые кнопки панели действий (ОСНОВНОЙ ЦИКЛ).
// ВАЖНО: правила активности кнопок «Бросить кубики» и «Завершить»
// дублируют логику из `apps/server/src/games/turn-permissions.ts`.
// Это сделано намеренно (server-driven архитектура): UI и FSM
// синхронизируются по одним и тем же бизнес-правилам, без зависимости
// клиентского бандла от server-only кода.
// После выпадения дубля фаза возвращается в `ROLLING` с
// `mustRollAgain=true`. Раньше UI показывал активные ОБЕ кнопки
// (Бросить и Завершить) — игрок мог нажать «Завершить» и ход
// перескакивал к другому игроку, хотя правила требуют повторного
// броска. Теперь:
//   - `canRoll`     активна, если это ход игрока, фаза ROLLING
//                    и он не в тюрьме (бросок ОБЯЗАТЕЛЕН после дубля);
//   - `canEndTurn`  активна, если фаза BUILDING и `mustRollAgain=false`
//                    (завершение хода разрешено).
// В фазе ROLLING кнопка «Завершить» ВСЕГДА неактивна — бросок обязателен.
const canRoll = computed(() => {
  if (!isMyTurn.value) return false;
  if (state.value.phase !== "ROLLING") return false;
  if (currentPlayer.value?.inJail) return false;
  // во время анимации кубиков (DICE_ANIMATION) или движения
  // фишки (MOVE_ANIMATION) кнопка должна быть неактивна. `phase=ROLLING`
  // на сервере держится ~миллисекунду до DICE_ANIMATION, но если в
  // этот промежуток игрок успеет кликнуть — будет дубль броска. Кроме
  // того, после reconnect/reload `diceRolling` синхронизируется из
  // `state.lastDice` (см. game.ts), и без этой проверки кнопка
  // мигала бы активной во время проигрывания анимации.
  if (diceRolling.value) return false;
  return true;
});
/**
 * Можно ли сейчас открыть модалку «Строить».
 *
 * Правила Монополии разрешают строительство / снос в любой «своей»
 * Turn-фазе — точно так же, как и торговлю (см. `canTrade` ниже).
 * Игрок может сразу после приземления на новую клетку открыть меню
 * и построить дом (если это его монополия), не ожидая фазы BUILDING.
 * Сервер уже поддерживает эту логику: в `GamesService.dispatch`
 * `OPEN_BUILDING_PHASE` маршрутизируется ДО switch по фазе.
 *
 * Условия (идентичны `canTrade`, чтобы кнопки СТРОИТЬ и ТОРГОВЛЯ были
 * активны в ОДНИ И ТЕ ЖЕ моменты):
 *  1. Это ход игрока-человека.
 *  2. Игрок не в тюрьме.
 *  3. НЕТ анимации броска/движения.
 *  4. Нет активной другой interrupt-модалки.
 *  5. У игрока есть хотя бы одна клетка, на которой можно построить
 *     или продать дом/отель.
 *
 * ВАЖНО: `mustRollAgain` НЕ блокирует открытие строительной модалки
 * (в отличие от END_TURN). Это согласовано с `canTrade`: после дубля
 * игрок может в любой момент открыть торговлю/строительство, не
 * дожидаясь повторного броска. Если сервер отклонит действие — это
 * уже не его забота, а сервера.
 *
 * ВАЖНО: `useBuildStore()` инстанцируется ВНУТРИ computed, иначе
 * Pinia active-Pinia-проверка при SSR/тестах ругается на
 * «getActivePinia was called with no active Pinia».
 */
const canBuild = computed(() => {
  // ВАЖНО: валидация кнопки «Строить» ПОЛНОСТЬЮ наследует логику
  // кнопки «Торговля» (кнопки активны в одни
  // и те же моменты). В отличие от старой реализации, мы НЕ
  // требуем, чтобы у игрока уже были клетки для строительства
  // или продажи — модалка может открыться и в начале партии, и
  // покажет дружелюбный empty-state «У вас нет участков под
  // застройку» (см. BuildModal.vue). Это симметрично поведению
  // кнопки «Торговля», которая тоже не проверяет наличие
  // объектов обмена.
  if (!canTrade.value) return false;
  // Дополнительно блокируем, если открыта другая interrupt-модалка
  // (уже зашито в canTrade, но дублируем явно для самодокументации).
  if (showAuctionModal.value) return false;
  if (showTradeModal.value) return false;
  return true;
});
const canEndTurn = computed(() => {
  if (!isMyTurn.value) return false;
  // В тюрьме (JAIL_DECISION) единственный способ продолжить — END_TURN.
  // НО! Если игрок ТОЛЬКО ЧТО попал в тюрьму (в ЭТОМ ходу, по карточке
  // или по клетке 30) — `justEnteredJail=true`, и в этом ходу ему
  // разрешено ТОЛЬКО завершить ход. Модалка тюрьмы с тремя способами
  // выхода появится в начале СЛЕДУЮЩЕГО хода. Поэтому и здесь,
  // и в JAIL_DECISION без justEnteredJail кнопка END_TURN активна.
  if (state.value.phase === "JAIL_DECISION") return true;
  // Завершить ход можно ТОЛЬКО в фазе BUILDING (после покупки/события).
  // В фазе ROLLING бросок обязателен — кнопка «Завершить» неактивна
  // даже в начале хода без `mustRollAgain` (бросок всё равно обязателен).
  if (state.value.phase !== "BUILDING") return false;
  if (diceRolling.value) return false;
  // Если после события игрок ОБЯЗАН бросить ещё раз (правило дубля) —
  // `END_TURN` недопустим, сервер сам переключит фазу в ROLLING.
  if (currentPlayer.value?.mustRollAgain) return false;
  return true;
});

// Торговля доступна в любой момент хода активного игрока.
// Запрещаем только во время interrupt-фаз и анимации броска/движения.
// В тюрьме торговля РАЗРЕШЕНА по правилам Монополии (Hasbro):
// игрок может управлять своей недвижимостью, пока отбывает срок.
const canTrade = computed(() => {
  if (!isMyTurn.value) return false;
  // Идёт анимация кубиков/движения — нельзя прерывать.
  if (diceRolling.value) return false;
  if (state.value.moveAnimation) return false;
  // Запрещаем открывать, если активна другая interrupt-фаза (аукцион и т.п.).
  if (showAuctionModal.value) return false;
  if (showTradeModal.value) return false;
  return true;
});
const mustRollAgain = computed(() => currentPlayer.value?.mustRollAgain === true);

// Залог/выкуп по правилам Монополии возможен В ЛЮБОЙ «своей» фазе
// хода — аналогично торговле (см. canTrade). Это удобно: если
// игрок только что приземлился на новую клетку и хочет сразу её
// заложить — он не обязан ждать фазы BUILDING.
//
// ВАЖНО: залог/выкуп РАЗРЕШЕНЫ даже в тюрьме (правила Hasbro):
// заключённый волен управлять своей недвижимостью.
//
// Запрещаем только:
//   - чужой ход;
//   - interrupt-фазы (аукцион, торговля, банкротство, FINISHED, ...);
//   - анимации (бросок, движение фишки).
//
// Дополнительно требуется, чтобы хотя бы одна клетка была доступна
// для операции — иначе модалка будет пустой, и кнопка бесполезна.
const canMortgage = computed(() => {
  if (!isMyTurn.value) return false;
  if (diceRolling.value) return false;
  if (state.value.moveAnimation) return false;
  if (showAuctionModal.value) return false;
  if (showTradeModal.value) return false;
  // Разрешённые фазы — все «свои» фазы хода (тот же список, что и в
  // canTrade на сервере — apps/server/src/games/turn-permissions.ts).
  const phase = state.value.phase;
  const allowed: ReadonlyArray<Phase> = [
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
  if (!allowed.includes(phase)) return false;
  const m = useMortgageStore();
  return m.mortgageableProperties.length + m.unmortgageableProperties.length > 0;
});

// Модалки
const showBuyModal = ref(false);
const showCardModal = ref(false);
const cardText = ref("");
const cardDeck = ref<"chance" | "treasury" | "luxury-tax">("chance");

const showTaxModal = ref(false);
const taxAmount = ref(0);
const taxCellName = ref("");

const showRentModal = ref(false);
const rentAmount = ref(0);
const rentOwnerName = ref("");
const rentCellName = ref("");

// Модальное окно «Вы арестованы! Отправляйтесь в тюрьму.» (фаза JAIL_NOTICE).
// Показывается в двух сценариях:
//   1) игрок приземлился на клетку 30 (GOTO_JAIL) — state.jailNotice.reason="cell";
//   2) игрок выбросил три дубля подряд — state.jailNotice.reason="double".
// После нажатия «ПРИНЯТЬ» (или авто-CONfirm для бота через 2.5с) клиент
// шлёт `CONFIRM_JAIL_NOTICE` — сервер начинает анимацию фишки к клетке 10.
const showJailNoticeModal = ref(false);
const jailNoticeReason = ref<"cell" | "card" | "double">("cell");

// Модалка тюрьмы теперь живёт в `useJailStore` (см. stores/jail.ts).
// Единый источник правды для открытия/закрытия, чтобы не было
// гонок с `state.justEnteredJail` при нескольких игроках в тюрьме.
// `storeToRefs` даёт реактивные ref'ы на свойства стора.
const jailStore = useJailStore();
const { isOpen: showJailModal } = storeToRefs(jailStore);
const showAuctionModal = ref(false);
const showTradeModal = ref(false);

// BANKRUPTCY: модалка ликвидации (фаза BANKRUPTCY_LIQUIDATE).
const showBankruptcyModal = ref(false);
const bankruptcyDebt = ref(0);
const bankruptcyCreditorName = ref<string | null>(null);

// Глобальное уведомление о новом банкротстве (видит ВСЕ клиенты).
const showBankruptNotice = ref(false);
const bankruptNoticePlayer = ref<string | null>(null);
const bankruptNoticeCreditor = ref<string | null>(null);
const seenBankruptIds = ref<Set<string>>(new Set());

function closeBankruptNotice() {
  showBankruptNotice.value = false;
}

// Тултип
const hoveredCell = ref<Cell | null>(null);
const tooltipPos = ref({ x: 0, y: 0 });
const tooltipSide = ref<BoardSide>("bottom");

/**
 * Реф на компонент `<Board>`. Нужен, чтобы достать `boardEl`
 * (корневой DOM-элемент доски) и рассчитывать координаты тултипа
 * относительно реальных размеров доски, а не окна браузера.
 */
const boardRef = ref<InstanceType<typeof Board> | null>(null);

/**
 * Смещение (в пикселях) между «родительской» клеткой и углом тултипа.
 * Используется, чтобы тултип не «лип» вплотную к клетке.
 */
const TOOLTIP_GAP = 8;

const currentCell = computed<Cell | null>(() => game.currentCell);
/**
 * Владелец клетки, на которую сейчас наведён тултип.
 * ВАЖНО: берём `hoveredCell`, а не `currentCell` — иначе при наведении
 * на «чужую» клетку в тултипе всегда будет владелец клетки текущего
 * игрока, что вводит в заблуждение.
 */
const cellOwner = computed(() => players.value.find((p) => p.id === hoveredCell.value?.ownerId));

// BANKRUPTCY: вычисляемые данные для модалки ликвидации
const bankruptcyPlayer = computed(
  () => state.value.players.find((p) => p.id === state.value.bankruptcy?.playerId) ?? null,
);
const bankruptcyMyProperties = computed<Cell[]>(() => {
  const me = bankruptcyPlayer.value;
  if (!me) return [];
  return state.value.board.filter((c) => c.ownerId === me.id);
});
/** Сколько максимум можно выручить, продав ВСЕ дома + заложив ВСЕ клетки. */
const bankruptcyMaxLiquidity = computed<number>(() => {
  const me = bankruptcyPlayer.value;
  if (!me) return 0;
  let total = 0;
  for (const c of state.value.board) {
    if (c.ownerId !== me.id) continue;
    if ((c.houses ?? 0) > 0 && c.housePrice) {
      total += (c.houses ?? 0) * Math.floor(c.housePrice / 2);
    }
    // Клетка: для «потолка ликвидности» берём максимум из залога (50%)
    // и продажи Банку (100%) — пользователь увидит наилучший сценарий.
    let cellLiq = 0;
    if (!c.isMortgaged && (c.mortgageValue ?? 0) > 0) {
      cellLiq = Math.max(cellLiq, c.mortgageValue ?? 0);
    }
    if (!c.isMortgaged && (c.price ?? 0) > 0) {
      cellLiq = Math.max(cellLiq, c.price ?? 0);
    }
    total += cellLiq;
  }
  return total;
});

// Watcher: глобальное уведомление о НОВЫХ банкротах
// Отслеживаем изменение `players` и при появлении нового игрока с
// `isBankrupt = true` (которого мы ещё не видели) показываем модалку.
watch(
  () => state.value.players.map((p) => ({ id: p.id, isBankrupt: p.isBankrupt })),
  (current) => {
    for (const p of current) {
      if (p.isBankrupt && !seenBankruptIds.value.has(p.id)) {
        seenBankruptIds.value.add(p.id);
        const player = state.value.players.find((x) => x.id === p.id);
        if (!player) continue;
        // Находим, кто был кредитором в bankruptcy-контексте,
        // если он там указан (но к моменту срабатывания state.bankruptcy
        // уже очищен, поэтому берём из последней процедуры).
        bankruptNoticePlayer.value = player.displayName ?? player.id;
        bankruptNoticeCreditor.value = null;
        // Ищем creditorId в логе через текущий snapshot: если у других
        // игроков появились НОВЫЕ клетки — значит это был кредитор.
        // Для простоты пока оставляем creditor = null (Банк).
        showBankruptNotice.value = true;
      }
    }
  },
  { deep: false },
);

/**
 * Оптимистичный набор «только что арестованных» игроков.
 *
 * Проблема: сервер присылает `Player.inJail = true` ТОЛЬКО ПОСЛЕ
 * полного цикла `JAIL_NOTICE` (модалка «Вы арестованы! Отправляйтесь
 * в тюрьму!») → `CONFIRM_JAIL_NOTICE` → `MOVE_ANIMATION` к клетке 10
 * → `RESOLVING_LANDING`. Это занимает ~1-2 секунды, в течение которых
 * пользователь НЕ ВИДИТ, что фишка арестована (мигание не работает,
 * потому что `p.inJail` ещё `false`).
 *
 * Решение: в момент входа в фазу `JAIL_NOTICE` мы СРАЗУ добавляем
 * `state.jailNotice.playerId` (имя поля сервера, см. плагин
 * jail-handler.service.ts) в `jailedIds`. Board.vue использует
 * этот набор в дополнение к `p.inJail` для класса `.in-jail` —
 * мигание начинается МГНОВЕННО в момент события.
 *
 * Авто-очистка: когда сервер присылает подтверждение `inJail=true`
 * (т.е. фишка уже на клетке 10 и анимация завершилась), мы
 * убираем id из `jailedIds` — дальше мигание идёт уже от
 * канонического `p.inJail`. Никаких таймеров не нужно, всё
 * реактивно.
 */
const jailedIds = ref<string[]>([]);

watch(
  () => state.value.phase,
  (phase) => {
    if (phase === "JAIL_NOTICE" && state.value.jailNotice?.playerId) {
      const id = state.value.jailNotice.playerId;
      if (!jailedIds.value.includes(id)) {
        jailedIds.value = [...jailedIds.value, id];
      }
    }
    // Когда фаза JAIL_NOTICE заканчивается без подтверждения
    // (например, пользователь закрыл модалку, не дождавшись confirm),
    // оптимистичный флаг снимается — иначе фишка так и будет
    // мигать, хотя `inJail` на сервере не выставился.
    if (phase !== "JAIL_NOTICE" && phase !== "MOVE_ANIMATION") {
      if (jailedIds.value.length > 0) jailedIds.value = [];
    }
  },
);

// Как только сервер прислал `inJail=true` для какого-то игрока,
// убираем его из оптимистичного набора (мигание продолжится уже
// от канонического `p.inJail`). Это защита от «застрявшего» флага
// на случай гонок WS-событий.
watch(
  () => state.value.players.map((p) => ({ id: p.id, inJail: p.inJail })),
  (current) => {
    const stillOptimistic = jailedIds.value.filter((id) => {
      const p = current.find((x) => x.id === id);
      // Оставляем в наборе ТОЛЬКО если сервер ещё НЕ подтвердил
      // inJail=true. Как только подтвердил — флаг больше не нужен.
      return !p?.inJail;
    });
    if (stillOptimistic.length !== jailedIds.value.length) {
      jailedIds.value = stillOptimistic;
    }
  },
  { deep: false },
);

let diceBlinkInterval: number | null = null;
function stopBlink() {
  if (diceBlinkInterval !== null) {
    clearInterval(diceBlinkInterval);
    diceBlinkInterval = null;
  }
}

onMounted(() => {
  const socket = useSocket(auth.token);
  if (!socket) {
    console.warn("No socket — token empty, redirect to /");
    router.push("/");
    return;
  }
  if (typeof route.params.id === "string") {
    game.connectAndJoin(route.params.id);
  }
});

onBeforeUnmount(() => {
  stopBlink();
});

/**
 * Клик по клетке: показываем тултип в «правильном» месте
 */
function onCellClick(payload: { cell: Cell; event: MouseEvent }) {
  hoveredCell.value = payload.cell;
  computeTooltipPosition(payload.cell, payload.event);
}

/**
 * Наведение курсора на клетку.
 * Показываем тултип с учётом того, в каком «секторе» (top/bottom/left/right)
 * находится клетка: тултип ВСЕГДА появляется ВНУТРИ игровой доски,
 * чтобы его нижний край для нижнего ряда касался верхней грани
 * board-center, и т.д. по симметрии для остальных секторов.
 */
function onCellHover(payload: { cell: Cell; event: MouseEvent }) {
  hoveredCell.value = payload.cell;
  computeTooltipPosition(payload.cell, payload.event);
}

/**
 * Уход курсора с клетки. Скрываем тултип, чтобы он не «висел» в
 * пустоте, пока игрок водит мышью по столу / панели.
 */
function onCellLeave() {
  hoveredCell.value = null;
}

/**
 * Рассчитать координаты (x, y) для тултипа с учётом:
 *  1. Стороны клетки (`getCellSide`) — тултип ВСЕГДА внутри доски.
 *  2. Реальных размеров доски (`boardEl.getBoundingClientRect()`),
 *     чтобы тултип не «вылезал» за границы, если у клетки рядом
 *     с углом не хватает места.
 *  3. События мыши (mouse position) — используем как «запасной»
 *     fallback, если DOM-элемент клетки ещё не найден.
 *
 * Логика по секторам:
 *  - bottom (id 0..10): тултип ВЫШЕ клетки (низ тултипа у верхней
 *                      грани клетки, у края board-center снизу).
 *  - top    (id 20..30): тултип НИЖЕ клетки.
 *  - left   (id 11..19): тултип СПРАВА от клетки.
 *  - right  (id 31..39): тултип СЛЕВА от клетки.
 *
 * Реальные размеры тултипа берём ПОСЛЕ рендера (через `nextTick`
 * + чтение `tooltipEl.getBoundingClientRect()`) — см. `nextTick`
 * в вызывающем коде, либо пересчитываем при ресайзе окна.
 */
function computeTooltipPosition(cell: Cell, event: MouseEvent) {
  tooltipSide.value = getCellSide(cell.id);

  const boardEl = boardRef.value?.boardEl ?? null;
  if (!boardEl) {
    // Страховка: если Board ещё не смонтирован, возвращаемся
    // к поведению «за курсором» — это лучше, чем тултип
    // в (0, 0) или невидимость.
    tooltipPos.value = {
      x: event.clientX + 12,
      y: event.clientY + 12,
    };
    return;
  }

  const cellEl = boardEl.querySelector<HTMLElement>(`[data-cell-id="${cell.id}"]`);
  if (!cellEl) {
    tooltipPos.value = {
      x: event.clientX + 12,
      y: event.clientY + 12,
    };
    return;
  }

  const cellRect = cellEl.getBoundingClientRect();
  const boardRect = boardEl.getBoundingClientRect();
  // Примерный размер тултипа — он фиксирован в CSS (max-width 280,
  // min-width 200, padding 12). Этого хватает для clamp'а —
  // после рендера Vue обновит координаты уже по реальным размерам
  // (см. recompute ниже).
  const estW = 240;
  const estH = 220;
  const gap = TOOLTIP_GAP;

  let x = 0;
  let y = 0;
  switch (tooltipSide.value) {
    case "bottom": {
      // Тултип ВЫШЕ клетки: низ тултипа у верха клетки.
      x = cellRect.left + cellRect.width / 2 - estW / 2;
      y = cellRect.top - estH - gap;
      break;
    }
    case "top": {
      // Тултип НИЖЕ клетки: верх тултипа у низа клетки.
      x = cellRect.left + cellRect.width / 2 - estW / 2;
      y = cellRect.bottom + gap;
      break;
    }
    case "left": {
      // Тултип СПРАВА от клетки: левый край тултипа у правой
      // грани клетки.
      x = cellRect.right + gap;
      y = cellRect.top + cellRect.height / 2 - estH / 2;
      break;
    }
    case "right": {
      // Тултип СЛЕВА от клетки: правый край тултипа у левой
      // грани клетки.
      x = cellRect.left - estW - gap;
      y = cellRect.top + cellRect.height / 2 - estH / 2;
      break;
    }
    default: {
      // corner (id 20, парковка) — для неё мы попросили
      // getCellSide вернуть "top" (см. board-layout.ts).
      x = cellRect.left + cellRect.width / 2 - estW / 2;
      y = cellRect.bottom + gap;
    }
  }

  // Clamp по границам доски: тултип должен остаться внутри
  // `boardEl` (с учётом padding'а доски 8px, оставим 6px запаса).
  const PADDING = 6;
  const minX = boardRect.left + PADDING;
  const maxX = boardRect.right - estW - PADDING;
  const minY = boardRect.top + PADDING;
  const maxY = boardRect.bottom - estH - PADDING;
  if (x < minX) x = minX;
  if (x > maxX) x = maxX;
  if (y < minY) y = minY;
  if (y > maxY) y = maxY;

  tooltipPos.value = { x, y };
}

function dispatchAction(action: GameAction) {
  // Передаём прямо в стор — клиент и так подписан на game:state,
  // никакого «in-flight» флага не нужно: сервер всё равно отклонит
  // дубль (фаза уже не та), а UI синхронизируется по game:state.
  game.sendAction(action);
}

// росок кубиков (фаза ROLLING)
function onRoll() {
  if (!canRoll.value) return;
  // Клиент только отправляет ROLL_DICE. Сервер ответит `game:dice`
  // в начале фазы DICE_ANIMATION — store поставит diceRolling=true,
  // Dice.vue запустит 2-сек анимацию и по 'roll-done' вышлем
  // CONFIRM_DICE_ANIMATION.
  stopBlink();
  dispatchAction({ type: "ROLL_DICE" });
}
// Анимация кубиков (фаза DICE_ANIMATION)
// Dice.vue эмитит 'roll-done' ровно через 2 секунды.
// По этому событию шлём CONFIRM_DICE_ANIMATION — сервер переходит
// в MOVE_ANIMATION.
// ВАЖНО: шлём от ЛЮБОГО активного клиента (не только от текущего
// игрока-человека). Если ходит бот, любой подключённый клиент
// (например, наблюдатель-человек) подтвердит, что анимация кубиков
// завершилась. Это и есть синхронизация ботов: сервер не двигает
// фишку, пока не придёт confirm от клиента.
function onDiceRollDone() {
  game.setDiceRolling(false);
  sendConfirmForCurrentPhase("DICE_ANIMATION", { type: "CONFIRM_DICE_ANIMATION" });
}

watch(
  () => diceRolling.value,
  (rolling) => {
    if (!rolling) {
      stopBlink();
    }
  },
);

/**
 * Реакция на смену фазы.
 *
 * Логика для JAIL_DECISION:
 *  - Это режим принятия решения о выходе из тюрьмы (PAY_FINE / USE_CARD / TRY_DOUBLE).
 *  - Показывается ТОЛЬКО когда:
 *      • текущий игрок — это я (`isMyTurn`),
 *      • я реально сижу в тюрьме (`targetPlayer.inJail === true`),
 *      • я НЕ только что туда попал в текущем ходу (just-entered-режим).
 *  - «Только что попал» определяем строго по СВОЕМУ игроку
 *    (`targetPlayer.id === myPlayerId` и `position === 10`),
 *    а не по глобальному `state.justEnteredJail`, который может быть `true`
 *    из-за гонки с предыдущим игроком, севшим в тюрьму ранее в раунде.
 */
function syncJailModal(newPhase: Phase): void {
  if (newPhase !== "JAIL_DECISION") {
    showJailModal.value = false;
    return;
  }
  const targetPlayer = state.value.players[state.value.currentPlayerIndex];
  if (!targetPlayer || !isMyTurn.value || !targetPlayer.inJail) {
    showJailModal.value = false;
    return;
  }
  const isJustEnteredForMe =
    !!state.value.justEnteredJail &&
    targetPlayer.id === myPlayerId.value &&
    targetPlayer.position === 10;
  showJailModal.value = !isJustEnteredForMe;
}

watch(
  () => state.value.phase,
  (newPhase: Phase) => {
    // JAIL_DECISION отменяется как для escape/pay (игрок вышел и движется),
    // так и для stay (фаза переходит в DICE_ANIMATION -> BUILDING).
    // Поэтому в JAIL_DECISION в нашем кейсе модалку открываем только если
    // сейчас наш ход и мы действительно в тюрьме (см. `syncJailModal`).
    syncJailModal(newPhase);
    showBuyModal.value = newPhase === "BUY_DECISION" && isMyTurn.value;
    // Аукцион показываем, если идёт аукцион (любая из 3 фаз) или
    // state.auction ещё не очищен (сразу после SOLD/UNSOLD — короткий
    // момент в фазе AUCTION_FINISHED). Модалку видят ВСЕ клиенты
    // (для прозрачности), а не только участники.
    showAuctionModal.value =
      newPhase === "AUCTION_AWAITING_START" ||
      newPhase === "AUCTION_ACTIVE" ||
      newPhase === "AUCTION_FINISHED" ||
      !!state.value.auction;
    showTradeModal.value =
      (newPhase === "TRADING_NEGOTIATE" || newPhase === "TRADING_CONFIRM") &&
      !!state.value.trade &&
      (state.value.trade.initiatorId === myPlayerId.value ||
        state.value.trade.recipientId === myPlayerId.value);
    // TAX_PAYMENT — Подоходный налог
    // Сервер прислал state.phase = "TAX_PAYMENT" и не менял player.money.
    // Показываем модалку «Заплатите N₽». По ОК шлём CONFIRM_TAX —
    // сервер спишет деньги.
    // ВАЖНО: показываем для ЛЮБОГО текущего игрока (как PAY_RENT).
    // Если ходит бот — через 2 секунды автоматически подтверждаем,
    // иначе сервер будет ждать 60-секундный fallback-таймер
    // (scheduleBotConfirmFallback) и партия «зависнет» на ходу бота.
    if (newPhase === "TAX_PAYMENT" && isCurrentPlayerActive.value) {
      // В TAX_PAYMENT мы только что приземлились — currentPlayer.position
      // уже финален, но в крайнем случае используем moveAnimation.to.
      const pos = currentPlayer.value?.position ?? state.value.moveAnimation?.to ?? -1;
      const cell = state.value.board[pos];
      if (cell && cell.taxAmount) {
        taxAmount.value = cell.taxAmount;
        taxCellName.value = cell.name;
        showTaxModal.value = true;
        // Если ходит бот — авто-CONFIRM_TAX через 2с (как PAY_RENT).
        if (currentPlayer.value?.kind === "bot") {
          setTimeout(() => {
            if (state.value.phase === "TAX_PAYMENT") {
              sendConfirmForCurrentPhase("TAX_PAYMENT", { type: "CONFIRM_TAX" });
            }
          }, 2000);
        }
      }
    }
    if (newPhase !== "TAX_PAYMENT") {
      showTaxModal.value = false;
    }
    // PAY_RENT — аренда чужой собственности.
    // Сервер прислал state.phase = "PAY_RENT" + state.rentContext.
    // Деньги ещё НЕ списаны — показываем модалку «Заплатите N₽ владельцу X».
    // По «Оплатить» шлём CONFIRM_RENT_PAYMENT — сервер списывает деньги
    // и переходит в BUILDING (или ROLLING при mustRollAgain).
    // ВАЖНО: показываем для ЛЮБОГО текущего игрока. Если ходит бот —
    // через 2 секунды автоматически подтверждаем.
    if (newPhase === "PAY_RENT" && isCurrentPlayerActive.value) {
      const ctx = state.value.rentContext;
      if (ctx && ctx.amount > 0) {
        rentAmount.value = ctx.amount;
        rentOwnerName.value = ctx.ownerName ?? "";
        const pos = currentPlayer.value?.position ?? state.value.moveAnimation?.to ?? -1;
        const cell = state.value.board[pos];
        rentCellName.value = cell?.name ?? "";
        showRentModal.value = true;
        // Если ходит бот — авто-CONFIRM_RENT_PAYMENT через 2с.
        if (currentPlayer.value?.kind === "bot") {
          setTimeout(() => {
            if (state.value.phase === "PAY_RENT") {
              sendConfirmForCurrentPhase("PAY_RENT", { type: "CONFIRM_RENT_PAYMENT" });
            }
          }, 2000);
        }
      } else {
        // Страховка: если сервер не положил rentContext (аномалия),
        // не блокируем партию — подтверждаем сразу, деньги не спишутся
        // (handlePayRent в этом случае тоже ничего не делает).
        console.warn("[GameView] PAY_RENT без rentContext — авто-CONFIRM");
        sendConfirmForCurrentPhase("PAY_RENT", { type: "CONFIRM_RENT_PAYMENT" });
      }
    }
    if (newPhase !== "PAY_RENT") {
      showRentModal.value = false;
    }
    // CARD_REVEAL — анализ состояния: гарантируем, что модалка карточки
    // показана. Стор `game.ts` уже вытащил cardContext.card в lastDrawnCard.
    // Если же по какой-то причине lastDrawnCard не пришёл (WS-событие
    // потерялось), пробуем ещё раз взять из state.cardContext.
    // открываем модалку ТОЛЬКО если сервер
    // подтвердил наличие карты в `state.cardContext`. Без этой проверки
    // `lastDrawnCard` мог прийти из предыдущего CARD_REVEAL (например, после
    // reconnect'а или повторного mount), и модалка появлялась повторно.
    if (newPhase === "CARD_REVEAL" && isCurrentPlayerActive.value) {
      if (state.value.cardContext?.card) {
        // Свежая карта с сервера — синхронизируем UI и ��оказываем модалку.
        lastDrawnCard.value = state.value.cardContext.card;
        cardText.value = state.value.cardContext.card.text;
        cardDeck.value =
          (state.value.cardContext.card.deck as "chance" | "treasury" | "luxury-tax") ?? "chance";
        showCardModal.value = true;
        // Если ходит бот — авто-CONFIRM_CARD через 2.5с. Этого времени
        // хватит, чтобы зрители увидели, какая карта выпала, до того как
        // сервер применит её эффект. Раньше confirm слал сервер сам, что
        // вызывало рассинхрон с анимацией у других игроков.
        if (currentPlayer.value?.kind === "bot") {
          setTimeout(() => {
            if (state.value.phase === "CARD_REVEAL") {
              sendConfirmForCurrentPhase("CARD_REVEAL", { type: "CONFIRM_CARD" });
            }
          }, 2500);
        }
      } else {
        // Страховка: если модалку нечем заполнить (или WS-событие
        // `game:card` потерялось и lastDrawnCard остался от прошлого
        // цикла), не блокируем партию — подтверждаем сразу, чтобы
        // сервер не «завис» в CARD_REVEAL.
        console.warn("[GameView] CARD_REVEAL без cardContext — авто-CONFIRM");
        sendConfirmForCurrentPhase("CARD_REVEAL", { type: "CONFIRM_CARD" });
      }
    }
    if (newPhase !== "CARD_REVEAL") {
      showCardModal.value = false;
    }

    // JAIL_NOTICE — модальное окно «Вы арестованы! Отправляйтесь в тюрьму!».
    // Сервер выставляет phase="JAIL_NOTICE" в двух сценариях:
    //   1) попадание на клетку 30 (GOTO_JAIL) — reason="cell";
    //   2) три дубля подряд — reason="double";
    //   3) (резерв) карточка «Отправляйтесь в тюрьму» — reason="card".
    // Сервер НЕ перемещает фишку и НЕ заполняет state.moveAnimation —
    // это делает handleJailNotice на сервере только ПОСЛЕ получения
    // CONFIRM_JAIL_NOTICE. Поэтому модальное окно должно быть
    // обязательно показано (а не «пролистано» автоматически) и
    // закрыто по кнопке «ПРИНЯТЬ» либо авто-таймером для бота.
    // Показываем модалку ВСЕМ клиентам (как PlayerBankruptNoticeModal),
    // чтобы зрители тоже видели, что произошло с игроком.
    if (newPhase === "JAIL_NOTICE" && state.value.jailNotice) {
      const reason = state.value.jailNotice.reason;
      jailNoticeReason.value = reason;
      showJailNoticeModal.value = true;
      // Если ходит бот — авто-CONFIRM_JAIL_NOTICE через 2.5с (как CARD_REVEAL).
      // 2-3с — требование пользователя: дать зрителям увидеть окно.
      if (currentPlayer.value?.kind === "bot") {
        setTimeout(() => {
          if (state.value.phase === "JAIL_NOTICE") {
            sendConfirmForCurrentPhase("JAIL_NOTICE", { type: "CONFIRM_JAIL_NOTICE" });
          }
        }, 2500);
      }
    }
    if (newPhase !== "JAIL_NOTICE") {
      showJailNoticeModal.value = false;
    }

    // MOVE_ANIMATION — запускаем визуальное перемещение фишки.
    // Сервер прислал `state.moveAnimation = { from, to, ... }`. Запускаем
    // animatePlayerTo от `from` к `to`; внутри по завершении отправится
    // CONFIRM_MOVE_ANIMATION.
    // ВАЖНО: срабатывает и для обычного броска кубиков, и для телепорта
    // карточки (move / move-relative) — оба пути теперь заполняют
    // state.moveAnimation в GamesService.
    if (newPhase === "MOVE_ANIMATION" && state.value.moveAnimation) {
      const ma = state.value.moveAnimation;
      animatePlayerTo(ma.playerId, ma.from, ma.to);
    }
    // RESOLVING_LANDING — пауза 400мс, потом авто-CONFIRM_LANDING.
    // ВАЖНО: от ЛЮБОГО текущего игрока (и от бота, и от человека).
    // Раньше здесь стояла проверка `isMyTurn.value` — для бота confirm
    // не отправлялся клиентом, и сервер был вынужден слать его сам по
    // своему таймеру (что приводило к рассинхрону).
    if (newPhase === "RESOLVING_LANDING" && isCurrentPlayerActive.value) {
      setTimeout(() => {
        if (state.value.phase === "RESOLVING_LANDING") {
          sendConfirmForCurrentPhase("RESOLVING_LANDING", { type: "CONFIRM_LANDING" });
        }
      }, 400);
    }
    // END_TURN — пауза 500мс, потом авто-CONFIRM_END_TURN.
    // ВАЖНО: от ЛЮБОГО текущего игрока.
    if (newPhase === "END_TURN" && isCurrentPlayerActive.value) {
      setTimeout(() => {
        if (state.value.phase === "END_TURN") {
          sendConfirmForCurrentPhase("END_TURN", { type: "CONFIRM_END_TURN" });
        }
      }, 500);
    }
    // BANKRUPTCY_LIQUIDATE: открываем модалку ликвидации ТОЛЬКО для
    // текущего игрока-человека. Бот сам решает через BANKRUPTCY_*
    // actions. Сервер присылает state.bankruptcy со всей нужной
    // информацией (debt, creditorId).
    if (newPhase === "BANKRUPTCY_LIQUIDATE" && isCurrentPlayerActive.value) {
      const proc = state.value.bankruptcy;
      if (proc && proc.playerId === myPlayerId.value) {
        // Текущий долг для отображения: берём max(0, -money), чтобы
        // кнопка «Подтвердить» корректно стала активной после ликвидации.
        const me = state.value.players.find((p) => p.id === proc.playerId);
        bankruptcyDebt.value = me ? Math.max(0, -me.money) : proc.debt;
        const creditor = proc.creditorId
          ? state.value.players.find((p) => p.id === proc.creditorId)
          : null;
        bankruptcyCreditorName.value = creditor?.displayName ?? null;
        showBankruptcyModal.value = true;
      }
    }
    if (newPhase !== "BANKRUPTCY_LIQUIDATE") {
      showBankruptcyModal.value = false;
    }
  },
);

// Обработчики модалки тюрьмы. Делегируют в `useJailStore`,
// который, в свою очередь, вызывает `game.sendAction`.
// Закрывать модалку здесь вручную НЕ нужно: сервер пришлёт
// новый `game:state` с другой фазой, и game.ts / useJailStore
// сами закроют её (см. JAIL_DECISION-close-блок в stores/game.ts).
// Оставляем явный `close()` для UX-мгновенного скрытия до ответа
// сервера (без него кнопки выглядят «висящими» 100-300 мс).
function onPayJailFine() {
  jailStore.close();
  jailStore.payFine();
}

function onUseJailCard() {
  jailStore.close();
  jailStore.useCard();
}

function onTryDouble() {
  jailStore.close();
  jailStore.tryDouble();
}

/**
 * Закрытие модалки тюрьмы без отправки действия (кнопка X / backdrop).
 * Делегируем в стор, чтобы был один источник истины.
 */
function onCloseJail() {
  jailStore.close();
}

function onTradeAccept() {
  dispatchAction({ type: "TRADE_ACCEPT" });
}

function onTradeReject() {
  showTradeModal.value = false;
  dispatchAction({ type: "TRADE_REJECT" });
}

function onTradeCounter(_offer: TradeOffer) {
  dispatchAction({ type: "TRADE_COUNTER", offer: _offer });
}

function onTradeCancel() {
  showTradeModal.value = false;
  dispatchAction({ type: "TRADE_CANCEL" });
}

/**
 * Анимация хода фишки (фаза MOVE_ANIMATION).
 *
 * ВАЖНО: на промежуточных клетках НИЧЕГО не срабатывает.
 * Анимация идёт по stepDelay × N шагов.
 * По завершении — отправляем CONFIRM_MOVE_ANIMATION → сервер
 * финально перемещает игрока в handleMoveAnimation, и мы получаем
 * обновлённый state с новой позицией.
 *
 * АНИМАЦИЯ В ТЮРЬМУ (правило 3 дублей): в отличие от старого
 * «мгновенного телепорта», теперь фишка тоже АНИМИРУЕТСЯ к клетке 10
 * (JAIL) через стандартный MOVE_ANIMATION flow. Сервер заполняет
 * `state.moveAnimation` с direction="backward" (или "forward" если
 * from < 10) на стороне `handleDiceAnimation`, и phase-watcher
 * автоматически вызывает `animatePlayerTo` ниже. Никаких
 * дополнительных watcher'ов на `justEnteredJail` / `position` больше
 * НЕ НУЖНО — анимация полностью идёт через стандартный пайплайн.
 *
 * ВАЖНО: watcher на phase регистрируется ВНУТРИ setup как
 * самостоятельный top-level watch — иначе он не будет реактивным
 * (раньше был вложен внутрь phase watcher'а, что приводило к
 * пересозданию и потере срабатывания, а также к TDZ-ошибке из-за
 * `let animTimers` ниже).
 */
const displayPositions = ref<Record<string, number>>({});
let animTimers: Record<string, number> = {};

// Анимация на парковку (id=20) и в тюрьму (id=10) для карточек
//
// Раньше для карточки «Отправляйтесь на парковку» на сервере
// стоял «мгновенный телепорт»: applyCardEffectAndAdvance ставил
// фазу BUILDING, state.moveAnimation = undefined, и
// justArrivedAtParking=true. Здесь был watcher, который ловил
// justArrivedAtParking и мгновенно синхронизировал displayPositions
// с новой позицией игрока (20), отменяя любую активную анимацию.
// Это был «баг»: фишка телепортировалась без анимации, что было
// визуально непоследовательно (другие move-карточки, например
// «Идите на СТАРТ» или «ул. Арбат», АНИМИРОВАЛИСЬ).
//
// Теперь (см. applyCardEffectAndAdvance в games.service.ts) фишка
// на парковку (и в тюрьму по карточке) тоже АНИМИРУЕТСЯ — через
// стандартный MOVE_ANIMATION flow с direction="backward". После
// анимации handleResolvingLanding ставит justArrivedAtParking=true
// и фазу BUILDING, но это уже не «телепорт», а просто «после
// приземления дать игроку BUILDING-фазу». Фишка к этому моменту
// уже стоит на клетке 20 (анимация завершилась).
//
// Флаг state.justArrivedAtParking остаётся — он нужен для
// блокировки canRollDice на сервере (см. turn-permissions.ts).
// Здесь, на клиенте, watcher больше не нужен: анимация
// отрабатывает через стандартный phase-watcher ниже.
// УДАЛЕНО: watcher на state.justArrivedAtParking + подстраховка
// по изменению currentPlayer.position с этим флагом.

/**
 * Следим за появлением/исчезновением игроков: новых — инициализируем
 * их позицией из `state`, удалённых — выбрасываем.
 * ВАЖНО: `displayPositions` НЕ обновляется автоматически по `p.position` —
 * только через `animatePlayerTo(...)`, который вызывается из watcher'а
 * `state.value.phase === "MOVE_ANIMATION"`. Это нужно, чтобы
 * анимация движения срабатывала РОВНО один раз при входе в фазу, а не
 * дублировалась, когда сервер финально обновляет `p.position` в
 * RESOLVING_LANDING (что было главным багом).
 */
watch(
  () => players.value.map((p) => p.id).join("|"),
  (newIds, oldIds) => {
    const prev = new Set((oldIds ?? "").split("|").filter(Boolean));
    const next: Record<string, number> = { ...displayPositions.value };
    for (const p of players.value) {
      if (!prev.has(p.id) || next[p.id] === undefined) {
        next[p.id] = p.position;
      }
    }
    for (const id of Array.from(Object.keys(next))) {
      if (!players.value.some((p) => p.id === id)) delete next[id];
    }
    displayPositions.value = next;
  },
  { immediate: true },
);

/**
 * Анимировать фишку `playerId` от `from` к `to` по клеткам.
 * Используется только в фазе MOVE_ANIMATION. По завершении
 * шлёт CONFIRM_MOVE_ANIMATION.
 * Направление движения берётся из `state.moveAnimation.direction`:
 *  - `"forward"`  (по умолчанию) — фишка идёт по часовой стрелке
 *                   (номер клетки увеличивается с 0 до 39 с оборачиванием);
 *                   это путь обычного броска кубиков и большинства карточек
 *                   Шанс/Казна.
 *  - `"backward"` — фишка идёт ПРОТИВ часовой стрелки (номер клетки
 *                   уменьшается с 39 до 0 с оборачиванием). Это путь
 *                   карточек, предписывающих «вернуться назад» (например,
 *                   «Вернитесь на 3 клетки назад»). Без этой логики фишка
 *                   «пролетала» через всю доску, что было главным багом
 *                   движения по карточкам.
 * Если `direction` не указан (старые снапшоты) — считаем, что `"forward"`.
 */
function animatePlayerTo(playerId: string, from: number, to: number) {
  if (animTimers[playerId]) {
    clearInterval(animTimers[playerId]);
    delete animTimers[playerId];
  }

  // Направление берём из moveAnimation.direction (источник истины — сервер).
  // Если state.moveAnimation ещё не пришёл (теоретически) — форвардим
  // (обратная совместимость со старыми снапшотами).
  const direction: "forward" | "backward" = state.value.moveAnimation?.direction ?? "forward";

  // Шаги анимации ВСЕГДА положительные — это просто количество клеток,
  // через которые пройдёт фишка. Направление определяет знак при
  // вычислении следующей клетки.
  const steps = Math.abs(to - from);
  if (steps === 0) {
    displayPositions.value = { ...displayPositions.value, [playerId]: to };
    return;
  }

  // Защита: для forward ожидаем steps = (to - from + 40) % 40,
  // для backward — steps = (from - to + 40) % 40.
  // Если клиент прислал from/to несовместимые (например, target явно
  // указывает движение через 0 в обратную сторону для forward) —
  // корректируем шаги соответственно направлению.
  let actualSteps: number;
  if (direction === "forward") {
    actualSteps = (to - from + 40) % 40;
  } else {
    actualSteps = (from - to + 40) % 40;
  }
  if (actualSteps === 0) {
    displayPositions.value = { ...displayPositions.value, [playerId]: to };
    return;
  }

  const baseMs = 450;
  const stepDelay = baseMs / Math.max(0.25, settings.animationSpeed);
  let i = 0;
  const id = window.setInterval(() => {
    i += 1;
    // Следующая клетка: +1 для forward, -1 для backward (с wrap по 40).
    const next = direction === "forward" ? (from + i + 40) % 40 : (from - i + 40 * 2) % 40; // +40*2 для гарантии неотрицательного mod
    displayPositions.value = { ...displayPositions.value, [playerId]: next };
    if (i >= actualSteps) {
      clearInterval(id);
      delete animTimers[playerId];
      try {
        sendConfirmForCurrentPhase("MOVE_ANIMATION", { type: "CONFIRM_MOVE_ANIMATION" });
      } catch (e) {
        console.warn("CONFIRM_MOVE_ANIMATION dispatch failed", e);
      }
    }
  }, stepDelay);
  animTimers[playerId] = id;
}

onBeforeUnmount(() => {
  for (const id of Object.values(animTimers)) clearInterval(id);
  animTimers = {};
});

//  Модалка карточки (фаза CARD_REVEAL)
// ранний `watch(() => game.lastDrawnCard)` открывал
// модалку на КАЖДОЕ появление карты — из WS-события `game:card`, из
// `state.cardContext` и из `response.data.card` callback'а `sendAction`.
// Сейчас показом модалки управляет ЕДИНСТВЕННЫЙ phase-watcher
// он использует
// только что полученный с сервера `state.cardContext.card` и не
// полагается на lastDrawnCard. Поэтому отдельный watcher на lastDrawnCard
// был источником двойного открытия и теперь удалён.

function onCloseCard() {
  if (!showCardModal.value) return; // защита от двойного onCloseCard
  showCardModal.value = false;
  // Очищаем lastDrawnCard в сторе, чтобы при следующей карточке watcher
  // в сторе (если он там нужен) сработал корректно. UI-источник истины
  // для модалки — это `state.phase === "CARD_REVEAL"` + `state.cardContext`.
  game.clearLastDrawnCard();
  // Подтверждаем фазу для текущего игрока (включая ботов), чтобы
  // рассинхрона анимации между ботом и человеком не было.
  sendConfirmForCurrentPhase("CARD_REVEAL", { type: "CONFIRM_CARD" });
}

/**
 * Закрытие модалки «Вы арестованы! Отправляйтесь в тюрьму.» (фаза JAIL_NOTICE).
 * Шлёт на сервер CONFIRM_JAIL_NOTICE, после чего сервер (handleJailNotice)
 * построит state.moveAnimation и переключит phase в MOVE_ANIMATION — фишка
 * АНИМИРУЕТСЯ к клетке 10. До этого момента фишка остаётся на прежней
 * клетке (30 при попадании или 30 при трёх дублях).
 */
function onCloseJailNotice() {
  if (!showJailNoticeModal.value) return; // защита от двойного onClose
  showJailNoticeModal.value = false;
  sendConfirmForCurrentPhase("JAIL_NOTICE", { type: "CONFIRM_JAIL_NOTICE" });
}

// Модалка фиксированного налога (фаза TAX_PAYMENT)
function onCloseTax() {
  showTaxModal.value = false;
  sendConfirmForCurrentPhase("TAX_PAYMENT", { type: "CONFIRM_TAX" });
}

// Модалка аренды (фаза PAY_RENT)
function onCloseRent() {
  showRentModal.value = false;
  sendConfirmForCurrentPhase("PAY_RENT", { type: "CONFIRM_RENT_PAYMENT" });
}

function onOpenTrade() {
  if (!canTrade.value) return;
  // Открываем локальный store-экран (экран 1 — выбор партнёра).
  // Если уже идёт активный обмен с сервера, модалка показывается через showTradeModal.
  useTradeStore().openPartnerSelection();
}

function onOpenMortgage() {
  if (!canMortgage.value) return;
  useMortgageStore().open();
}

/**
 * Открыть модалку «Строить».
 *
 * По нажатию кнопки 🏗️ «Строить» в ActionsPanel клиент посылает
 * `OPEN_BUILDING_PHASE` — это переключает сервер в фазу
 * `BUILDING_PHASE` (новая «UX»-фаза, в которой разрешены
 * `BUILD_HOUSE` / `SELL_HOUSE` / `MORTGAGE_PROPERTY` /
 * `UNMORTGAGE_PROPERTY` / `CONFIRM_BUILDING_PHASE`).
 *
 * Модалка открывается АВТОМАТИЧЕСКИ по phase-watcher'у в
 * `stores/game.ts` (как только приходит `state.phase ===
 * "BUILDING_PHASE"`, стор `useBuildStore.open()` вызывается из
 * `socket.on("game:state")`). Это исключает гонку между локальным
 * `open()` и серверным переходом фазы — UI всегда синхронизирован
 * с истиной на сервере.
 */
function onOpenBuild() {
  if (!canBuild.value) return;
  dispatchAction({ type: "OPEN_BUILDING_PHASE" });
}

function onConfirmBuy() {
  showBuyModal.value = false;
  dispatchAction({ type: "BUY_PROPERTY" });
}
function onDeclineBuy() {
  showBuyModal.value = false;
  dispatchAction({ type: "DECLINE_BUY" });
}

function onEndTurn() {
  if (!canEndTurn.value) {
    console.warn("End turn rejected: not my turn or wrong phase");
    return;
  }
  dispatchAction({ type: "END_TURN" });
}

function logout() {
  auth.logout();
  disconnectSocket();
  router.push("/");
}
</script>

<template>
  <div class="game-container">
    <div v-if="!game.isConnected" class="connecting">
      <p>🔄 Подключение к серверу...</p>
    </div>

    <template v-else>
      <!--
        ОСНОВНОЙ UI (доска + панели) рендерится ОДИН раз.
        Во время аукциона весь контейнер .app-locked получает
        атрибут `inert` + CSS-фильтр, а поверх — .app-backdrop.
        Никакого дублирования досок/панелей.
      -->
      <div class="layout" :class="{ 'app-locked': showAuctionModal }" :inert="showAuctionModal">
        <div class="board-area">
          <SettingsPanel />
          <Board
            ref="boardRef"
            :cells="cells"
            :players="boardPlayers"
            :jailed-ids="jailedIds"
            :display-positions="displayPositions"
            :dice-values="diceValues"
            :dice-rolling="diceRolling"
            @cell-click="onCellClick"
            @cell-hover="onCellHover"
            @cell-leave="onCellLeave"
            @dice-roll-done="onDiceRollDone"
          />
        </div>

        <aside class="sidebar">
          <PlayersPanel :players="players" :current-player-id="currentPlayerId" />
          <ActionsPanel
            :can-roll="canRoll && !showAuctionModal"
            :can-build="canBuild && !showAuctionModal"
            :can-end-turn="canEndTurn && !showAuctionModal"
            :can-trade="canTrade && !showAuctionModal"
            :can-mortgage="canMortgage && !showAuctionModal"
            :must-roll-again="mustRollAgain"
            @open-trade="onOpenTrade"
            @open-mortgage="onOpenMortgage"
            @open-build="onOpenBuild"
            @roll="onRoll"
            @end-turn="onEndTurn"
          />
          <LogPanel />
        </aside>
      </div>

      <div v-if="showAuctionModal" class="app-backdrop" aria-hidden="true" />

      <Teleport v-if="showAuctionModal" to="body">
        <AuctionModal />
      </Teleport>

      <BuyModal
        :show="showBuyModal"
        :cell="currentCell"
        :money="currentPlayer?.money ?? 0"
        @close="onDeclineBuy"
        @confirm="onConfirmBuy"
        @decline="onDeclineBuy"
      />

      <CardModal
        :show="showCardModal"
        :card-text="cardText"
        :deck="cardDeck"
        @close="onCloseCard"
      />

      <!--
        Информационная модалка «Вы арестованы! Отправляйтесь в тюрьму.»
        (фаза JAIL_NOTICE). Показывается:
          1) при попадании на клетку 30 (GOTO_JAIL);
          2) при выпадении трёх дублей подряд (правило Монополии).
        Закрывается по кнопке «ПРИНЯТЬ» (отправляется CONFIRM_JAIL_NOTICE);
        бот авто-закрывает через 2.5с (см. phase-watcher выше).
        После закрытия сервер (handleJailNotice) строит state.moveAnimation
        и фишка АНИМИРУЕТСЯ к клетке 10.
      -->
      <JailNoticeModal
        :show="showJailNoticeModal"
        :reason="jailNoticeReason"
        @close="onCloseJailNotice"
      />

      <TaxModal
        :show="showTaxModal"
        :amount="taxAmount"
        :cell-name="taxCellName"
        :money="currentPlayer?.money ?? 0"
        @close="onCloseTax"
      />

      <RentModal
        :show="showRentModal"
        :amount="rentAmount"
        :owner-name="rentOwnerName"
        :cell-name="rentCellName"
        :money="currentPlayer?.money ?? 0"
        @close="onCloseRent"
      />

      <JailModal
        :show="showJailModal"
        :holdable-card-count="Object.keys(currentPlayer?.holdableCards ?? {}).length"
        :money="currentPlayer?.money || 0"
        @pay="onPayJailFine"
        @use-card="onUseJailCard"
        @try-double="onTryDouble"
        @close="onCloseJail"
      />

      <TradeModal />

      <MortgageModal />

      <!--
        Унифицированная модалка «Строить»: build/sell/mortgage/unmortgage.
        Открывается АВТОМАТИЧЕСКИ по phase-watcher'у в `stores/game.ts`
        при `state.phase === "BUILDING_PHASE"`. Закрывается
        (с отправкой `CONFIRM_BUILDING_PHASE` на сервер) по кнопке
        «ПРИНЯТЬ» внутри модалки — см. `BuildModal.vue` и
        `useBuildStore.confirmAndClose()`. Это исключает гонку
        между локальным и серверным состоянием.
      -->
      <BuildModal />

      <BankruptcyModal
        :show="showBankruptcyModal"
        :my-player-id="myPlayerId"
        :debt="bankruptcyDebt"
        :money="bankruptcyPlayer?.money ?? 0"
        :my-properties="bankruptcyMyProperties"
        :creditor-name="bankruptcyCreditorName"
        :max-liquidity="bankruptcyMaxLiquidity"
      />

      <!-- Глобальное уведомление о банкротстве (видят ВСЕ клиенты) -->
      <PlayerBankruptNoticeModal
        :show="showBankruptNotice"
        :player-name="bankruptNoticePlayer ?? ''"
        :creditor-name="bankruptNoticeCreditor"
        @close="closeBankruptNotice"
      />

      <CellTooltip
        :cell="hoveredCell"
        :owner="cellOwner"
        :state="state"
        :x="tooltipPos.x"
        :y="tooltipPos.y"
        :side="tooltipSide"
      />

      <GameOverModal />
    </template>
  </div>
</template>

<style scoped>
.app-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  z-index: 999;
  pointer-events: auto;
}
.app-locked {
  position: relative;
  pointer-events: none;
  user-select: none;
  filter: grayscale(0.2) brightness(0.85);
}
.app-locked[inert] {
  pointer-events: none;
}
</style>
<style scoped>
.game-container {
  display: block;
  padding: 20px;
  max-width: 1560px;
  margin: 0 auto;
}

.layout {
  display: flex;
  flex-direction: row;
  gap: 24px;
  align-items: stretch;
  width: 100%;
  box-sizing: border-box;
}
.board-area {
  flex: 0 0 60%;
  max-width: 60%;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 16px;
  align-items: stretch;
}
.sidebar {
  flex: 1 1 40%;
  max-width: 40%;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 16px;
  align-items: stretch;
}
.sidebar > * {
  width: 100%;
  box-sizing: border-box;
  align-self: stretch;
}
@media (max-width: 1100px) {
  .layout {
    flex-direction: column;
  }
  .board-area,
  .sidebar {
    flex: 1 1 100%;
    max-width: 100%;
  }
}
.connecting {
  flex: 1;
  text-align: center;
  padding: 80px 20px;
  font-size: 18px;
}
</style>
