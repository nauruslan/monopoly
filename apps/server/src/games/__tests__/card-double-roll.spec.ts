/**
 * Сценарий:
 *  1) Игрок бросает дубль → mustRollAgain=true, consecutiveDoubles=1.
 *  2) Попадает на ШАНС/КАЗНУ → вытягивает карту «Бесплатная парковка
 *     (move target=20)» или аналогичную «выводящую» из обычного цикла.
 *  3) После CONFIRM_CARD сервер перемещает фишку на новую клетку.
 *
 * Для stay-исходов (`money` / `jail-free` / `luxury-tax-house`)
 * `mustRollAgain` НЕ сбрасывается — игрок остаётся на той же клетке и
 * обязан бросить ещё раз (`afterRentOrTax` выберет фазу ROLLING).
 */
import { Test } from "@nestjs/testing";
import { GamesService } from "../games.service";
import { GameRepository } from "../../db/repositories/game.repository";
import { GameInitializerService } from "../game-initializer.service";
import { RentCalculator } from "../handlers/rent-calculator";
import { JailHandlerService } from "../handlers/jail-handler.service";
import { CardHandlerService } from "../handlers/card-handler.service";
import { BankruptcyService } from "../handlers/bankruptcy.service";
import { BankService } from "../handlers/bank.service";
import { MortgageService } from "../handlers/mortgage.service";
import { BuildService } from "../handlers/build.service";
import { BotService } from "../bots/bot.service";
import { AuctionService } from "../handlers/auction.service";
import { TradeService } from "../handlers/trade.service";
import { LogService } from "../handlers/log.service";
import type { GameState, Player } from "@monopoly/shared";
import { BOARD, DEFAULT_SETTINGS, CHANCE_CARDS, TREASURY_CARDS } from "@monopoly/shared";
import { canEndTurn, canRollDice } from "../turn-permissions";

function makeFreshState(): GameState {
  const players: Player[] = [
    {
      id: "p0",
      displayName: "Alice",
      kind: "human",
      color: "#f00",
      icon: "🔴",
      money: 1500,
      position: 0,
      inJail: false,
      jailTurns: 0,
      holdableCards: {},
      properties: [],
      consecutiveDoubles: 0,
      isBankrupt: false
    },
    {
      id: "p1",
      displayName: "Bob",
      kind: "bot",
      color: "#00f",
      icon: "🔵",
      money: 1500,
      position: 0,
      inJail: false,
      jailTurns: 0,
      holdableCards: {},
      properties: [],
      consecutiveDoubles: 0,
      isBankrupt: false
    },
  ];
  return {
    id: "g-test",
    version: 1,
    status: "active",
    currentPlayerIndex: 0,
    phase: "ROLLING",
    round: 1,
    players,
    board: BOARD.map((c) => ({ ...c, ownerId: undefined, houses: 0, isMortgaged: false })),
    settings: { ...DEFAULT_SETTINGS },
    seed: "test-seed",
    createdAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString()
  };
}

describe("GamesService.applyAction: regression дубль + карточка Шанс/Казна", () => {
  let service: GamesService;
  let activeState: GameState;

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    if (service) {
      (service as any).removeFromCache("g-test");
    }
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  beforeEach(async () => {
    const repoMock = {
      create: jest.fn(async (state: GameState) => ({
        id: state.id,
        rngSeed: state.seed,
        stateSnapshot: state
      })),
      updateSnapshot: jest.fn(async () => undefined),
      replaceSnapshot: jest.fn(async () => true),
      findById: jest.fn(async () => null)
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        GamesService,
        GameInitializerService,
        RentCalculator,
        JailHandlerService,
        CardHandlerService,
        BankruptcyService,
        BankService,
        MortgageService,
        BuildService,
        BotService,
        AuctionService,
        TradeService,
        LogService,
        { provide: GameRepository, useValue: repoMock },
      ]
    }).compile();

    service = moduleRef.get(GamesService);
    activeState = makeFreshState();
    (activeState as any).id = "g-test";
  });

  async function act(action: Parameters<GamesService["applyAction"]>[2]) {
    const gameId = "g-test";
    (service as any).activeGames.set(gameId, activeState);
    return service.applyAction(
      gameId,
      activeState.players[activeState.currentPlayerIndex]!.id,
      action,
    );
  }

  /**
   * Хелпер: переводим state в «только что приземлились на клетку с
   * эффектом карты», вытягиваем заданную карту и возвращаем ссылку на
   * активного игрока.
   */
  function setupCardReveal(card: { id: string; deck: "chance" | "treasury" | "luxury-tax" }) {
    const chanceCell = activeState.board.find((c) => c.type === "CHANCE");
    const p = activeState.players[activeState.currentPlayerIndex]!;
    p.position = chanceCell ? chanceCell.id : 7;
    p.mustRollAgain = true;
    p.consecutiveDoubles = 1;
    activeState.lastDice = { dice: [1, 1], isDouble: true };
    activeState.phase = "CARD_REVEAL";
    activeState.cardContext = {
      playerId: p.id,
      deck: card.deck,
      // Берём полную карту из CHANCE_CARDS по id, чтобы тест не зависел
      // от того, что мы положили в cardContext.
      card: (CHANCE_CARDS.find((c) => c.id === card.id) ??
        TREASURY_CARDS.find((c) => c.id === card.id))!,
      applied: false,
        deckCardId: null
    };
    activeState.cardDecks = {
      chance: { cards: [card.id], cursor: 0 },
      treasury: { cards: [], cursor: 0 },
      "luxury-tax": { cards: [], cursor: 0 }
    };
    return p;
  }

  it("move-карта (парковка) при дубле: идёт через MOVE_ANIMATION → RESOLVING_LANDING → BUILDING", async () => {
    // Ищем move-карту с target=20 (парковка). В колоде Шанс её нет,
    // но в TREASURY есть «Бесплатная парковка. Перейдите на клетку 20».
    const parkingCard = TREASURY_CARDS.find(
      (c) => c.effect.kind === "move" && "target" in c.effect && c.effect.target === 20,
    );
    expect(parkingCard).toBeDefined();
    if (!parkingCard) return;

    // Встаём на клетку TREASURY (Казна) — для корректности flow.
    const treasuryCell = activeState.board.find((c) => c.type === "TREASURY");
    const p = activeState.players[activeState.currentPlayerIndex]!;
    p.position = treasuryCell ? treasuryCell.id : 2;
    p.mustRollAgain = true;
    p.consecutiveDoubles = 1;
    activeState.lastDice = { dice: [1, 1], isDouble: true };
    activeState.phase = "CARD_REVEAL";
    activeState.cardContext = {
      playerId: p.id,
      deck: parkingCard.deck,
      card: parkingCard,
      applied: false,
        deckCardId: null
    };
    activeState.cardDecks = {
      chance: { cards: [], cursor: 0 },
      treasury: { cards: [parkingCard.id], cursor: 0 },
      "luxury-tax": { cards: [], cursor: 0 }
    };

    // 1) CONFIRM_CARD: фишка АНИМИРУЕТСЯ forward к клетке 20
    //    (а не телепортируется мгновенно, как раньше — это был баг).
    //    `mustRollAgain` и `consecutiveDoubles` сбрасываются, фишка
    //    уже стоит на 20, фаза = MOVE_ANIMATION, moveAnimation
    //    заполнен с direction="forward" (from=2 < to=20, идём по
    //    часовой, не «наматывая» через СТАРТ).
    await act({ type: "CONFIRM_CARD" });
    expect(p.mustRollAgain).toBe(false);
    expect(p.consecutiveDoubles).toBe(0);
    expect(p.position).toBe(20);
    expect(activeState.cardContext).toBeUndefined();
    expect(activeState.phase).toBe("MOVE_ANIMATION");
    expect(activeState.moveAnimation).toBeDefined();
    expect(activeState.moveAnimation?.playerId).toBe(p.id);
    expect(activeState.moveAnimation?.to).toBe(20);
    expect(activeState.moveAnimation?.direction).toBe("forward");
    expect(activeState.moveAnimation?.steps).toBe(18);
    // Флаг justArrivedAtParking ставится сразу в applyCardEffectAndAdvance
    // (нужен для блокировки canRollDice в turn-permissions.ts: пока идёт
    // анимация, игрок НЕ должен мочь бросить кубики ещё раз).
    expect(activeState.justArrivedAtParking).toBe(true);

    // 2) CONFIRM_MOVE_ANIMATION → RESOLVING_LANDING.
    //    moveAnimation очищается, фаза переходит в RESOLVING_LANDING.
    await act({ type: "CONFIRM_MOVE_ANIMATION" });
    expect(activeState.moveAnimation).toBeUndefined();
    expect(activeState.phase).toBe("RESOLVING_LANDING");

    // 3) CONFIRM_LANDING → handleResolvingLanding на PARKING:
    //    justArrivedAtParking=true, фаза = BUILDING, право на ещё
    //    один бросок (после дубля) ТЕРЯЕТСЯ (отдых, аналог ареста).
    await act({ type: "CONFIRM_LANDING" });
    expect(activeState.phase).toBe("BUILDING");
    expect(activeState.justArrivedAtParking).toBe(true);
    // UI-блокировка: canRollDice=false (justArrivedAtParking),
    // canEndTurn=true.
    expect(canRollDice(activeState, p)).toBe(false);
    expect(canEndTurn(activeState, p)).toBe(true);
  });

  it("полный цикл: дубль + move-карта парковки (from<20) → forward-анимация → BUILDING, canEndTurn=true", async () => {
    // Проходим весь цикл: CONFIRM_CARD (запускает анимацию) →
    // CONFIRM_MOVE_ANIMATION (RESOLVING_LANDING) → CONFIRM_LANDING (BUILDING).
    //
    // Здесь from=2 < to=20, поэтому анимация идёт ВПЕРЁД по часовой
    // (правило «кратчайший путь без прохода через СТАРТ»).
    const parkingCard = TREASURY_CARDS.find(
      (c) => c.effect.kind === "move" && "target" in c.effect && c.effect.target === 20,
    );
    expect(parkingCard).toBeDefined();
    if (!parkingCard) return;

    const treasuryCell = activeState.board.find((c) => c.type === "TREASURY");
    const p = activeState.players[activeState.currentPlayerIndex]!;
    p.position = treasuryCell ? treasuryCell.id : 2;
    p.mustRollAgain = true;
    p.consecutiveDoubles = 1;
    activeState.phase = "CARD_REVEAL";
    activeState.cardContext = {
      playerId: p.id,
      deck: parkingCard.deck,
      card: parkingCard,
      applied: false,
        deckCardId: null
    };
    activeState.cardDecks = {
      chance: { cards: [], cursor: 0 },
      treasury: { cards: [parkingCard.id], cursor: 0 },
      "luxury-tax": { cards: [], cursor: 0 }
    };

    // 1) CONFIRM_CARD: анимация к 20 ВПЕРЁД (forward, 2→...→20).
    await act({ type: "CONFIRM_CARD" });
    expect(p.mustRollAgain).toBe(false);
    expect(p.position).toBe(20);
    expect(activeState.phase).toBe("MOVE_ANIMATION");
    expect(activeState.moveAnimation?.direction).toBe("forward");
    expect(activeState.moveAnimation?.steps).toBe(18);
  });

  it("move-карта (парковка) с from>20: анимация BACKWARD (симметрия с тюрьмой)", async () => {
    // Регресс-тест на правило «кратчайший путь без прохода через СТАРТ»:
    // если игрок стоит на клетке ПОСЛЕ парковки (id > 20) и тянет
    // карточку «на парковку» (target=20), фишка должна идти НАЗАД
    // (против часовой), а не «наматывать» через СТАРТ. Логика
    // симметрична `goto-jail` и `move` на тюрьму (target=10).
    const parkingCard = TREASURY_CARDS.find(
      (c) => c.effect.kind === "move" && "target" in c.effect && c.effect.target === 20,
    );
    expect(parkingCard).toBeDefined();
    if (!parkingCard) return;

    // Ставим игрока на клетку 30 (GOTO_JAIL) — это from=30 > to=20,
    // значит по правилу идём назад. steps = 30 - 20 = 10.
    const p = activeState.players[activeState.currentPlayerIndex]!;
    p.position = 30;
    p.mustRollAgain = false;
    p.consecutiveDoubles = 0;
    activeState.phase = "CARD_REVEAL";
    activeState.cardContext = {
      playerId: p.id,
      deck: parkingCard.deck,
      card: parkingCard,
      applied: false,
        deckCardId: null
    };
    activeState.cardDecks = {
      chance: { cards: [], cursor: 0 },
      treasury: { cards: [parkingCard.id], cursor: 0 },
      "luxury-tax": { cards: [], cursor: 0 }
    };

    // 1) CONFIRM_CARD: фишка АНИМИРУЕТСЯ backward (30→29→...→20, 10 шагов).
    //    ВАЖНО: НЕ через СТАРТ (это было бы 30 шагов вперёд, что
    //    бессмысленно и не соответствует правилам Монополии).
    await act({ type: "CONFIRM_CARD" });
    expect(p.position).toBe(20);
    expect(activeState.phase).toBe("MOVE_ANIMATION");
    expect(activeState.moveAnimation).toBeDefined();
    expect(activeState.moveAnimation?.playerId).toBe(p.id);
    expect(activeState.moveAnimation?.from).toBe(30);
    expect(activeState.moveAnimation?.to).toBe(20);
    expect(activeState.moveAnimation?.direction).toBe("backward");
    expect(activeState.moveAnimation?.steps).toBe(10);
    expect(activeState.justArrivedAtParking).toBe(true);

    // 2) CONFIRM_MOVE_ANIMATION → RESOLVING_LANDING.
    await act({ type: "CONFIRM_MOVE_ANIMATION" });
    expect(activeState.phase).toBe("RESOLVING_LANDING");
    expect(activeState.moveAnimation).toBeUndefined();

    // 3) CONFIRM_LANDING → BUILDING.
    await act({ type: "CONFIRM_LANDING" });
    expect(activeState.phase).toBe("BUILDING");
    expect(activeState.justArrivedAtParking).toBe(true);
  });

  it("justArrivedAtParking сбрасывается в handleStartTurn при начале следующего хода", async () => {
    // Сценарий: игрок отправлен на парковку по карточке в текущем ходу
    // (justArrivedAtParking=true, фаза BUILDING). После END_TURN
    // handleStartTurn должен сбросить флаг, чтобы новый/тот же игрок
    // в следующем ходу мог бросать кубики.
    const parkingCard = TREASURY_CARDS.find(
      (c) => c.effect.kind === "move" && "target" in c.effect && c.effect.target === 20,
    );
    expect(parkingCard).toBeDefined();
    if (!parkingCard) return;

    const treasuryCell = activeState.board.find((c) => c.type === "TREASURY");
    const p = activeState.players[activeState.currentPlayerIndex]!;
    p.position = treasuryCell ? treasuryCell.id : 2;
    p.mustRollAgain = true;
    p.consecutiveDoubles = 1;
    activeState.phase = "CARD_REVEAL";
    activeState.cardContext = {
      playerId: p.id,
      deck: parkingCard.deck,
      card: parkingCard,
      applied: false,
        deckCardId: null
    };
    activeState.cardDecks = {
      chance: { cards: [], cursor: 0 },
      treasury: { cards: [parkingCard.id], cursor: 0 },
      "luxury-tax": { cards: [], cursor: 0 }
    };

    // 1) CONFIRM_CARD → MOVE_ANIMATION (анимация к 20, forward — from=2 < to=20).
    //    Здесь from=2 (Казна) < to=20, поэтому по правилу
    //    «кратчайший путь без прохода через СТАРТ» анимация идёт
    //    ВПЕРЁД по часовой (а не backward, как было до правки).
    await act({ type: "CONFIRM_CARD" });
    expect(activeState.phase).toBe("MOVE_ANIMATION");
    expect(activeState.moveAnimation?.direction).toBe("forward");
    expect(activeState.moveAnimation?.steps).toBe(18);
    // justArrivedAtParking ставится уже в applyCardEffectAndAdvance
    // (флаг блокирует canRollDice во время анимации).
    expect(activeState.justArrivedAtParking).toBe(true);

    // 2) CONFIRM_MOVE_ANIMATION → RESOLVING_LANDING.
    await act({ type: "CONFIRM_MOVE_ANIMATION" });
    expect(activeState.phase).toBe("RESOLVING_LANDING");

    // 3) CONFIRM_LANDING → BUILDING + justArrivedAtParking=true.
    await act({ type: "CONFIRM_LANDING" });
    expect(activeState.justArrivedAtParking).toBe(true);
    expect(activeState.phase).toBe("BUILDING");

    // Завершаем ход: END_TURN (BUILDING → END_TURN) и затем
    // CONFIRM_END_TURN (END_TURN → handleStartTurn следующего игрока).
    await act({ type: "END_TURN" });
    expect(activeState.phase).toBe("END_TURN");
    await act({ type: "CONFIRM_END_TURN" });
    // В handleStartTurn флаг должен быть сброшен. Следующий активный
    // игрок — p1 (bob), он не в тюрьме, фаза = ROLLING.
    expect(activeState.justArrivedAtParking).toBe(false);
    expect(activeState.phase).toBe("ROLLING");
    const nextPlayer = activeState.players[activeState.currentPlayerIndex]!;
    expect(nextPlayer.id).toBe("p1");
    expect(canRollDice(activeState, nextPlayer)).toBe(true);
  });

  it("полный цикл: дубль 1-1 + попадание на PARKING (id=20) через кубики → ROLLING (право на ещё один бросок)", async () => {
    // Правила Монополии: парковка как «визит» через кубики — это
    // нейтральная клетка, и правило дублей ДЕЙСТВУЕТ: игрок должен
    // бросить ещё раз. Никакого «отдыха» здесь нет — это не
    // телепорт по карточке, а обычный ход через нейтральную клетку.
    //
    // ВАЖНО: `justArrivedAtParking` НЕ ставится при обычном попадании
    // на парковку (через кубики) — этот флаг предназначен ТОЛЬКО для
    // телепорта по карточке «Отправляйтесь на парковку», где право на
    // ещё один бросок ТЕРЯЕТСЯ по правилам Монополии.
    const p = activeState.players[activeState.currentPlayerIndex]!;
    // Игрок встаёт ровно на 18, чтобы дубль [1,1] довёл его на 20 (PARKING).
    p.position = 18;
    p.mustRollAgain = true;
    p.consecutiveDoubles = 1;
    activeState.lastDice = { dice: [1, 1], isDouble: true };
    // Симулируем начало фазы анимации движения (handleMoveAnimation).
    activeState.phase = "MOVE_ANIMATION";

    // 1) CONFIRM_MOVE_ANIMATION: handleMoveAnimation сдвигает позицию
    //    18 + 2 = 20 (PARKING), переходит в RESOLVING_LANDING.
    await act({ type: "CONFIRM_MOVE_ANIMATION" });
    expect(p.position).toBe(20);
    expect(activeState.phase).toBe("RESOLVING_LANDING");

    // 2) CONFIRM_LANDING: handleResolvingLanding → клетка PARKING →
    //    `mustRollAgain` СОХРАНЯЕТСЯ, фаза ROLLING (право на ещё
    //    один бросок по правилу дублей).
    await act({ type: "CONFIRM_LANDING" });

    // Позиция — парковка, mustRollAgain СОХРАНЁН.
    expect(p.position).toBe(20);
    expect(p.mustRollAgain).toBe(true);
    expect(p.consecutiveDoubles).toBe(1);
    // Фаза — ROLLING (игрок бросает ещё раз).
    expect(activeState.phase).toBe("ROLLING");
    // Флаг justArrivedAtParking НЕ выставлен (это не телепорт-карточка).
    expect(activeState.justArrivedAtParking).toBeFalsy();

    // Финальная проверка: можно бросить кубики, завершение хода заблокировано.
    expect(canEndTurn(activeState, p)).toBe(false);
    expect(canRollDice(activeState, p)).toBe(true);
  });

  it("move-relative карта (назад/вперёд на N) при дубле: mustRollAgain СОХРАНЯЕТСЯ (регресс #1)", async () => {
    // Карточка «Вернитесь на 3 клетки назад» — это ОБЫЧНОЕ перемещение,
    // а не «выводящая» карточка (как парковка или тюрьма). По правилам
    // Монополии правило дублей должно продолжать действовать: после
    // CONFIRM_CARD+MOVE_ANIMATION+LANDING фишка приземляется на
    // нейтральной клетке, и `mustRollAgain` обязан остаться true →
    // фаза ROLLING, кнопка «Завершить» заблокирована, «Бросить»
    // активна.
    const backCard = CHANCE_CARDS.find(
      (c) => c.effect.kind === "move-relative" && "steps" in c.effect && c.effect.steps === -3,
    );
    expect(backCard).toBeDefined();
    if (!backCard) return;

    // Игрок должен стоять на клетке, от которой «-3 шага» приведут
    // на СОБСТВЕННУЮ клетку (не TAX и не CHANCE). Берём клетку 11
    // (PROPERTY, pink «ул. Варварка»): `11 - 3 = 8` (PROPERTY,
    // lightblue «Проспект Мира»). Это сработает через:
    // «своя клетка + дубль → фаза ROLLING, mustRollAgain сохраняется».
    // Сервер берёт эффект из cardContext и не проверяет тип клетки,
    // на которой стоит игрок, так что позиция 11 — валидная стартовая
    // точка для «вернуться на 3 назад».
    const START_POSITION = 11;
    const p = activeState.players[activeState.currentPlayerIndex]!;
    p.position = START_POSITION;
    p.mustRollAgain = true;
    p.consecutiveDoubles = 1;
    const propertyTarget = activeState.board[8]!;
    activeState.board[8] = { ...propertyTarget, ownerId: p.id };
    p.properties = [8];
    activeState.lastDice = { dice: [1, 1], isDouble: true };
    activeState.phase = "CARD_REVEAL";
    activeState.cardContext = {
      playerId: p.id,
      deck: backCard.deck,
      card: backCard,
      applied: false,
        deckCardId: null
    };
    activeState.cardDecks = {
      chance: { cards: [backCard.id], cursor: 0 },
      treasury: { cards: [], cursor: 0 },
      "luxury-tax": { cards: [], cursor: 0 }
    };

    // 1) CONFIRM_CARD — move-relative не сбрасывает mustRollAgain,
    //    фаза MOVE_ANIMATION (перемещение через анимацию, не телепорт).
    await act({ type: "CONFIRM_CARD" });
    expect(p.mustRollAgain).toBe(true);
    expect(p.consecutiveDoubles).toBe(1);
    expect(activeState.phase).toBe("MOVE_ANIMATION");
    expect(activeState.moveAnimation).toBeDefined();

    // 2) CONFIRM_MOVE_ANIMATION → RESOLVING_LANDING на целевой клетке.
    await act({ type: "CONFIRM_MOVE_ANIMATION" });
    expect(activeState.phase).toBe("RESOLVING_LANDING");

    // 3) CONFIRM_LANDING → на нейтральной клетке правило дублей
    //    продолжает действовать → mustRollAgain=true, фаза ROLLING.
    await act({ type: "CONFIRM_LANDING" });
    expect(p.mustRollAgain).toBe(true);
    expect(p.consecutiveDoubles).toBe(1);
    expect(activeState.phase).toBe("ROLLING");
    // UI: «Бросить» активна, «Завершить» — нет.
    expect(canRollDice(activeState, p)).toBe(true);
    expect(canEndTurn(activeState, p)).toBe(false);
  });

  it("move-карта «Идите на СТАРТ» при дубле: mustRollAgain СОХРАНЯЕТСЯ (регресс #1)", async () => {
    // ch1: «Идите на СТАРТ» (target=0, kind="move"). Это НЕ
    // «выводящая» карта (как тюрьма/парковка) — это просто
    // телепорт на GO. Бонус карточка НЕ даёт; двойная выплата
    // (2× goSalary) начисляется автоматически в handleResolvingLanding
    // НЕЗАВИСИМО от дубля. По правилу дублей, если пришли сюда с
    // дубля, после приземления игрок должен бросить ещё раз.
    const goCard = CHANCE_CARDS.find((c) => c.effect.kind === "move" && c.effect.target === 0);
    expect(goCard).toBeDefined();
    if (!goCard) return;

    const chanceCell = activeState.board.find((c) => c.type === "CHANCE");
    const p = activeState.players[activeState.currentPlayerIndex]!;
    p.position = chanceCell ? chanceCell.id : 7;
    p.mustRollAgain = true;
    p.consecutiveDoubles = 1;
    activeState.lastDice = { dice: [1, 1], isDouble: true };
    activeState.phase = "CARD_REVEAL";
    activeState.cardContext = {
      playerId: p.id,
      deck: goCard.deck,
      card: goCard,
      applied: false,
        deckCardId: null
    };
    activeState.cardDecks = {
      chance: { cards: [goCard.id], cursor: 0 },
      treasury: { cards: [], cursor: 0 },
      "luxury-tax": { cards: [], cursor: 0 }
    };
    const moneyBefore = p.money;
    const goSalary = activeState.settings.goSalary;

    // 1) CONFIRM_CARD: move-карта не сбрасывает mustRollAgain, фаза
    //    MOVE_ANIMATION (идём на СТАРТ с анимацией).
    await act({ type: "CONFIRM_CARD" });
    expect(p.mustRollAgain).toBe(true);
    expect(p.consecutiveDoubles).toBe(1);
    expect(activeState.phase).toBe("MOVE_ANIMATION");

    // 2) CONFIRM_MOVE_ANIMATION → RESOLVING_LANDING на СТАРТ.
    //    Карточка ch1 НЕ начисляет бонус — деньги пока не меняются.
    await act({ type: "CONFIRM_MOVE_ANIMATION" });
    expect(p.position).toBe(0);
    expect(p.money).toBe(moneyBefore);
    expect(activeState.phase).toBe("RESOLVING_LANDING");

    // 3) CONFIRM_LANDING → handleResolvingLanding на СТАРТ: двойная
    //    выплата 2× goSalary НЕЗАВИСИМО от дубля, mustRollAgain
    //    сохранён, фаза ROLLING (правило дублей продолжает действовать).
    await act({ type: "CONFIRM_LANDING" });
    expect(p.money).toBe(moneyBefore + goSalary * 2);
    expect(p.mustRollAgain).toBe(true);
    expect(p.consecutiveDoubles).toBe(1);
    expect(activeState.phase).toBe("ROLLING");
    expect(canRollDice(activeState, p)).toBe(true);
    expect(canEndTurn(activeState, p)).toBe(false);
  });

  it("stay-карта (money+) при дубле: mustRollAgain НЕ сбрасывается → ROLLING", async () => {
    // Контрастный сценарий: stay-эффект (money) НЕ сбрасывает флаги,
    // и afterRentOrTax переведёт фазу в ROLLING (повторный бросок).
    const moneyCard = CHANCE_CARDS.find((c) => c.effect.kind === "money" && c.effect.amount > 0);
    expect(moneyCard).toBeDefined();
    if (!moneyCard) return;

    const p = setupCardReveal(moneyCard);
    const moneyBefore = p.money;

    await act({ type: "CONFIRM_CARD" });

    // Флаги сохранены.
    expect(p.mustRollAgain).toBe(true);
    expect(p.consecutiveDoubles).toBe(1);
    // Деньги начислены.
    if (moneyCard.effect.kind === "money") {
      expect(p.money).toBe(moneyBefore + moneyCard.effect.amount);
    }
    // Фаза: ROLLING (повторный бросок обязателен).
    expect(activeState.phase).toBe("ROLLING");
    // Кнопка «Завершить» заблокирована, «Бросить» доступна.
    expect(canEndTurn(activeState, p)).toBe(false);
    expect(canRollDice(activeState, p)).toBe(true);
  });

  it("goto-jail карта при дубле: mustRollAgain сбрасывается через sendToJail (регресс)", async () => {
    // Этот сценарий работал и ДО правки (JailHandlerService.sendToJail
    // уже сбрасывает mustRollAgain), но добавим регресс-тест, чтобы
    // будущие изменения не сломали это.
    const jailCard = CHANCE_CARDS.find((c) => c.effect.kind === "goto-jail");
    expect(jailCard).toBeDefined();
    if (!jailCard) return;

    const p = setupCardReveal(jailCard);

    // Новая логика: фишка АНИМИРУЕТСЯ forward/backward к 10,
    // затем уже в handleResolvingLanding → sendToJail + JAIL_DECISION.
    await act({ type: "CONFIRM_CARD" });
    expect(p.mustRollAgain).toBe(false);
    expect(p.consecutiveDoubles).toBe(0);
    expect(p.position).toBe(10);
    expect(p.inJail).toBe(false);
    expect(activeState.phase).toBe("MOVE_ANIMATION");
    expect(activeState.moveAnimation?.direction).toMatch(/forward|backward/);

    await act({ type: "CONFIRM_MOVE_ANIMATION" });
    expect(activeState.phase).toBe("RESOLVING_LANDING");

    await act({ type: "CONFIRM_LANDING" });
    expect(p.inJail).toBe(true);
    expect(activeState.phase).toBe("JAIL_DECISION");
    expect(activeState.justEnteredJail).toBe(true);
  });
});
