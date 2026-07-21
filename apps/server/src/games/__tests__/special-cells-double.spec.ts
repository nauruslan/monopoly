/**
 * Регрессионные тесты для специальных клеток (id=0, 10, 20, 30) при
 * попадании на них через дубль.
 *
 * Контрактные требования (по правилам Монополии):
 *
 *  1. **GO (id=0) — «Вперёд»**:
 *     - Без дубля: обычная goSalary (200₽), фаза BUILDING.
 *     - С дублём: ДВОЙНАЯ goSalary (400₽), `mustRollAgain` СОХРАНЯЕТСЯ,
 *       фаза ROLLING (игрок бросает ещё раз).
 *
 *  2. **JAIL (id=10) — «Тюрьма» (визит)**:
 *     - Без дубля: `mustRollAgain=false`, фаза BUILDING, `inJail=false`.
 *     - С дублём: `mustRollAgain` СОХРАНЯЕТСЯ, фаза ROLLING (правило
 *       дублей действует на любой «нейтральной» клетке, в т.ч. Тюрьма).
 *     - В обоих случаях `inJail` остаётся `false` (это НЕ арест, а
 *       просто посещение).
 *
 *  3. **PARKING (id=20) — «Бесплатная парковка» (визит через кубики)**:
 *     - Без дубля: `mustRollAgain=false`, фаза BUILDING, можно
 *       завершить ход.
 *     - С дублём: `mustRollAgain` СОХРАНЯЕТСЯ, фаза ROLLING (правило
 *       дублей действует).
 *     - Флаг `justArrivedAtParking` НЕ ставится при попадании через
 *       кубики (этот флаг предназначен только для телепорта по
 *       карточке «Отправляйтесь на парковку», где право на ещё один
 *       бросок ТЕРЯЕТСЯ).
 *
 *  4. **GOTO_JAIL (id=30) — «В тюрьму» (и карточка «Отправляйтесь
 *     в тюрьму»)**:
 *     - В ОБОИХ случаях (через клетку 30 или через карточку) — единая
 *       логика «попадание в тюрьму»:
 *         - фишка МГНОВЕННО (телепорт) на клетку 10;
 *         - `inJail=true`, `jailTurns=0`;
 *         - `consecutiveDoubles=0` (правило трёх дублей сбрасывается);
 *         - `mustRollAgain=false` (право на ещё один бросок ТЕРЯЕТСЯ,
 *           даже если попали через дубль);
 *         - `state.justEnteredJail=true` (в этом ходу можно только
 *           «Завершить ход»);
 *         - фаза = JAIL_DECISION.
 */
import { Test } from "@nestjs/testing";
import { GamesService } from "../games.service";
import { GameRepository } from "../../db/repositories/game.repository";
import { GameInitializerService } from "../game-initializer.service";
import { RentCalculator } from "../handlers/rent-calculator";
import { JailHandlerService } from "../handlers/jail-handler.service";
import { CardHandlerService } from "../handlers/card-handler.service";
import { BankruptcyService } from "../handlers/bankruptcy.service";
import { BotService } from "../bots/bot.service";
import { AuctionService } from "../handlers/auction.service";
import { TradeService } from "../handlers/trade.service";
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
      jailCards: 0,
      properties: [],
      consecutiveDoubles: 0,
      isBankrupt: false,
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
      jailCards: 0,
      properties: [],
      consecutiveDoubles: 0,
      isBankrupt: false,
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
    lastActivityAt: new Date().toISOString(),
  };
}

describe("GamesService.applyAction: спецклетки при дубле (GO, JAIL, PARKING, GOTO_JAIL)", () => {
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
        stateSnapshot: state,
      })),
      updateSnapshot: jest.fn(async () => undefined),
      replaceSnapshot: jest.fn(async () => true),
      findById: jest.fn(async () => null),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        GamesService,
        GameInitializerService,
        RentCalculator,
        JailHandlerService,
        CardHandlerService,
        BankruptcyService,
        BotService,
        AuctionService,
        TradeService,
        { provide: GameRepository, useValue: repoMock },
      ],
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

  // 1) GO (id=0) — двойная зарплата при дубле

  it("GO без дубля: обычная goSalary 200₽, фаза BUILDING", async () => {
    const p = activeState.players[activeState.currentPlayerIndex]!;
    // Игрок встаёт ровно на 38, чтобы бросок 2 привёл его на 0 (GO).
    p.position = 38;
    activeState.lastDice = { dice: [1, 1], isDouble: true }; // временно
    activeState.phase = "MOVE_ANIMATION";

    // Передвинем, но это дубль, который сохранится. Проверим, что
    // для случая БЕЗ дубля goSalary начисляется один раз (200₽) и
    // фаза = BUILDING.
    p.mustRollAgain = false;
    p.consecutiveDoubles = 0;
    activeState.lastDice = { dice: [1, 1], isDouble: false };

    const moneyBefore = p.money;
    await act({ type: "CONFIRM_MOVE_ANIMATION" });
    expect(p.position).toBe(0);
    expect(activeState.phase).toBe("RESOLVING_LANDING");
    await act({ type: "CONFIRM_LANDING" });
    // После CONFIRM_LANDING для клетки GO без дубля — обычная goSalary 200₽.
    expect(p.money).toBe(moneyBefore + activeState.settings.goSalary);
    expect(activeState.phase).toBe("BUILDING");
    expect(p.mustRollAgain).toBe(false);
  });

  it("GO с дублём: ДВОЙНАЯ goSalary 400₽, mustRollAgain сохранён, фаза ROLLING", async () => {
    const p = activeState.players[activeState.currentPlayerIndex]!;
    p.position = 38; // дубль [1,1] = 2 → 38+2=40 → 0
    p.mustRollAgain = true;
    p.consecutiveDoubles = 1;
    activeState.lastDice = { dice: [1, 1], isDouble: true };
    activeState.phase = "MOVE_ANIMATION";

    const moneyBefore = p.money;
    const goSalary = activeState.settings.goSalary;
    await act({ type: "CONFIRM_MOVE_ANIMATION" });
    expect(p.position).toBe(0);
    expect(activeState.phase).toBe("RESOLVING_LANDING");
    await act({ type: "CONFIRM_LANDING" });

    // Главная проверка: двойная зарплата, mustRollAgain сохранён,
    // фаза ROLLING (игрок бросает ещё раз).
    expect(p.money).toBe(moneyBefore + goSalary * 2);
    expect(p.mustRollAgain).toBe(true);
    expect(p.consecutiveDoubles).toBe(1);
    expect(activeState.phase).toBe("ROLLING");
    // UI-блокировка: canRoll=true, canEndTurn=false.
    expect(canRollDice(activeState, p)).toBe(true);
    expect(canEndTurn(activeState, p)).toBe(false);
  });

  // 2) JAIL visit (id=10) — mustRollAgain сохраняется при дубле

  it("JAIL visit без дубля: mustRollAgain=false, фаза BUILDING, inJail=false", async () => {
    const p = activeState.players[activeState.currentPlayerIndex]!;
    p.position = 8; // бросок 2 → 8+2=10 (JAIL visit)
    p.mustRollAgain = false;
    p.consecutiveDoubles = 0;
    activeState.lastDice = { dice: [1, 1], isDouble: false };
    activeState.phase = "MOVE_ANIMATION";

    await act({ type: "CONFIRM_MOVE_ANIMATION" });
    expect(p.position).toBe(10);
    expect(activeState.phase).toBe("RESOLVING_LANDING");
    await act({ type: "CONFIRM_LANDING" });

    // Обычный визит, без ареста.
    expect(p.inJail).toBe(false);
    expect(p.mustRollAgain).toBe(false);
    expect(activeState.phase).toBe("BUILDING");
    expect(canEndTurn(activeState, p)).toBe(true);
    expect(canRollDice(activeState, p)).toBe(false);
  });

  it("JAIL visit с дублём: mustRollAgain сохранён, фаза ROLLING (право на ещё один бросок)", async () => {
    const p = activeState.players[activeState.currentPlayerIndex]!;
    p.position = 8; // дубль [1,1] = 2 → 8+2=10 (JAIL visit)
    p.mustRollAgain = true;
    p.consecutiveDoubles = 1;
    activeState.lastDice = { dice: [1, 1], isDouble: true };
    activeState.phase = "MOVE_ANIMATION";

    await act({ type: "CONFIRM_MOVE_ANIMATION" });
    expect(p.position).toBe(10);
    expect(activeState.phase).toBe("RESOLVING_LANDING");
    await act({ type: "CONFIRM_LANDING" });

    // Главная проверка: mustRollAgain сохранён, фаза ROLLING,
    // игрок бросает ещё раз. Визит НЕ считается арестом.
    expect(p.inJail).toBe(false);
    expect(p.mustRollAgain).toBe(true);
    expect(p.consecutiveDoubles).toBe(1);
    expect(activeState.phase).toBe("ROLLING");
    expect(canRollDice(activeState, p)).toBe(true);
    expect(canEndTurn(activeState, p)).toBe(false);
  });

  // 3) PARKING visit (id=20) — mustRollAgain сохраняется при дубле

  it("PARKING visit без дубля: mustRollAgain=false, фаза BUILDING", async () => {
    const p = activeState.players[activeState.currentPlayerIndex]!;
    p.position = 18; // бросок 2 → 18+2=20 (PARKING)
    p.mustRollAgain = false;
    p.consecutiveDoubles = 0;
    activeState.lastDice = { dice: [1, 1], isDouble: false };
    activeState.phase = "MOVE_ANIMATION";

    await act({ type: "CONFIRM_MOVE_ANIMATION" });
    expect(p.position).toBe(20);
    expect(activeState.phase).toBe("RESOLVING_LANDING");
    await act({ type: "CONFIRM_LANDING" });

    // Без дубля: обычный визит, можно завершить ход.
    expect(p.mustRollAgain).toBe(false);
    expect(activeState.phase).toBe("BUILDING");
    // justArrivedAtParking НЕ ставится (это не телепорт по карточке).
    expect(activeState.justArrivedAtParking).toBeFalsy();
    expect(canEndTurn(activeState, p)).toBe(true);
    expect(canRollDice(activeState, p)).toBe(false);
  });

  it("PARKING visit с дублём: mustRollAgain сохранён, фаза ROLLING", async () => {
    const p = activeState.players[activeState.currentPlayerIndex]!;
    p.position = 18; // дубль [1,1] = 2 → 18+2=20 (PARKING)
    p.mustRollAgain = true;
    p.consecutiveDoubles = 1;
    activeState.lastDice = { dice: [1, 1], isDouble: true };
    activeState.phase = "MOVE_ANIMATION";

    await act({ type: "CONFIRM_MOVE_ANIMATION" });
    expect(p.position).toBe(20);
    expect(activeState.phase).toBe("RESOLVING_LANDING");
    await act({ type: "CONFIRM_LANDING" });

    // Главная проверка: mustRollAgain сохранён, фаза ROLLING.
    // Это ОТЛИЧАЕТСЯ от карточки «Отправляйтесь на парковку», где
    // право на ещё один бросок ТЕРЯЕТСЯ.
    expect(p.mustRollAgain).toBe(true);
    expect(p.consecutiveDoubles).toBe(1);
    expect(activeState.phase).toBe("ROLLING");
    expect(activeState.justArrivedAtParking).toBeFalsy();
    expect(canRollDice(activeState, p)).toBe(true);
    expect(canEndTurn(activeState, p)).toBe(false);
  });

  // 4) GOTO_JAIL (id=30) + карточка «Отправляйтесь в тюрьму»

  it("GOTO_JAIL (id=30) без дубля: mustRollAgain сбрасывается, inJail=true, JAIL_DECISION", async () => {
    const p = activeState.players[activeState.currentPlayerIndex]!;
    // Шанс или точное попадание на 30. Например, position=24, бросок 6 → 30.
    p.position = 24;
    p.mustRollAgain = false;
    p.consecutiveDoubles = 0;
    activeState.lastDice = { dice: [3, 3], isDouble: false };
    activeState.phase = "MOVE_ANIMATION";

    await act({ type: "CONFIRM_MOVE_ANIMATION" });
    expect(p.position).toBe(30);
    expect(activeState.phase).toBe("RESOLVING_LANDING");
    await act({ type: "CONFIRM_LANDING" });

    // Попадание на 30: модалка-объявление через CARD_REVEAL.
    expect(activeState.phase).toBe("CARD_REVEAL");
    expect(activeState.cardContext?.card.effect.kind).toBe("goto-jail");
    expect(activeState.cardContext?.applied).toBe(false);
    // ВАЖНО: mustRollAgain уже сброшен ДО показа модалки — иначе
    // был бы конфликт флагов на фазе CARD_REVEAL.
    expect(p.mustRollAgain).toBe(false);
    expect(p.consecutiveDoubles).toBe(0);

    // Подтверждаем карточку: sendToJail + JAIL_DECISION.
    await act({ type: "CONFIRM_CARD" });
    expect(p.position).toBe(10);
    expect(p.inJail).toBe(true);
    expect(p.mustRollAgain).toBe(false);
    expect(activeState.phase).toBe("JAIL_DECISION");
    expect(activeState.justEnteredJail).toBe(true);

    // В этом ходу можно только завершить ход (justEnteredJail=true).
    expect(canEndTurn(activeState, p)).toBe(true);
    expect(canRollDice(activeState, p)).toBe(false);
  });

  it("GOTO_JAIL (id=30) с дублём: mustRollAgain сбрасывается, inJail=true (право на бросок теряется)", async () => {
    const p = activeState.players[activeState.currentPlayerIndex]!;
    // Дубль приводит на 30: например, position=28, дубль [1,1] → 30.
    p.position = 28;
    p.mustRollAgain = true;
    p.consecutiveDoubles = 1;
    activeState.lastDice = { dice: [1, 1], isDouble: true };
    activeState.phase = "MOVE_ANIMATION";

    await act({ type: "CONFIRM_MOVE_ANIMATION" });
    expect(p.position).toBe(30);
    expect(activeState.phase).toBe("RESOLVING_LANDING");
    await act({ type: "CONFIRM_LANDING" });

    // Главная проверка: даже при дубле попадание на 30
    // (GOTO_JAIL) забирает право на ещё один бросок.
    expect(activeState.phase).toBe("CARD_REVEAL");
    expect(activeState.cardContext?.card.effect.kind).toBe("goto-jail");
    expect(p.mustRollAgain).toBe(false);
    expect(p.consecutiveDoubles).toBe(0);

    // Подтверждаем карточку.
    await act({ type: "CONFIRM_CARD" });
    expect(p.position).toBe(10);
    expect(p.inJail).toBe(true);
    expect(p.mustRollAgain).toBe(false);
    expect(p.consecutiveDoubles).toBe(0);
    expect(activeState.phase).toBe("JAIL_DECISION");
    expect(activeState.justEnteredJail).toBe(true);

    // В этом ходу можно только завершить ход.
    expect(canEndTurn(activeState, p)).toBe(true);
    expect(canRollDice(activeState, p)).toBe(false);
  });

  it("Карточка «Отправляйтесь в тюрьму» с дублём: mustRollAgain сбрасывается (регресс)", async () => {
    // Сценарий: игрок бросил дубль и попал на клетку Шанс, откуда
    // вытянул карту «Отправляйтесь в тюрьму». По правилам Монополии
    // право на ещё один бросок ТЕРЯЕТСЯ.
    const jailCard = CHANCE_CARDS.find((c) => c.effect.kind === "goto-jail");
    expect(jailCard).toBeDefined();
    if (!jailCard) return;

    // Встаём на Шанс (id=7), чтобы вытянуть эту карту.
    const chanceCell = activeState.board.find((c) => c.type === "CHANCE");
    const p = activeState.players[activeState.currentPlayerIndex]!;
    p.position = chanceCell ? chanceCell.id : 7;
    p.mustRollAgain = true;
    p.consecutiveDoubles = 1;
    activeState.lastDice = { dice: [1, 1], isDouble: true };
    activeState.phase = "CARD_REVEAL";
    activeState.cardContext = {
      playerId: p.id,
      deck: "chance",
      card: jailCard,
      applied: false,
    };
    activeState.cardDecks = {
      chance: { cards: [jailCard.id], cursor: 0 },
      treasury: { cards: [], cursor: 0 },
      "luxury-tax": { cards: [], cursor: 0 },
    };

    await act({ type: "CONFIRM_CARD" });

    // Главная проверка: даже через карточку при дубле
    // mustRollAgain сбрасывается, фишка на 10, inJail=true.
    expect(p.mustRollAgain).toBe(false);
    expect(p.consecutiveDoubles).toBe(0);
    expect(p.position).toBe(10);
    expect(p.inJail).toBe(true);
    expect(activeState.phase).toBe("JAIL_DECISION");
    expect(activeState.justEnteredJail).toBe(true);
  });

  it("Карточка Казна «Отправляйтесь в тюрьму» с дублём: mustRollAgain сбрасывается (регресс)", async () => {
    // Та же логика для колоды Казна (TREASURY).
    const jailCard = TREASURY_CARDS.find((c) => c.effect.kind === "goto-jail");
    expect(jailCard).toBeDefined();
    if (!jailCard) return;

    const treasuryCell = activeState.board.find((c) => c.type === "TREASURY");
    const p = activeState.players[activeState.currentPlayerIndex]!;
    p.position = treasuryCell ? treasuryCell.id : 2;
    p.mustRollAgain = true;
    p.consecutiveDoubles = 1;
    activeState.lastDice = { dice: [1, 1], isDouble: true };
    activeState.phase = "CARD_REVEAL";
    activeState.cardContext = {
      playerId: p.id,
      deck: "treasury",
      card: jailCard,
      applied: false,
    };
    activeState.cardDecks = {
      chance: { cards: [], cursor: 0 },
      treasury: { cards: [jailCard.id], cursor: 0 },
      "luxury-tax": { cards: [], cursor: 0 },
    };

    await act({ type: "CONFIRM_CARD" });

    expect(p.mustRollAgain).toBe(false);
    expect(p.consecutiveDoubles).toBe(0);
    expect(p.position).toBe(10);
    expect(p.inJail).toBe(true);
    expect(activeState.phase).toBe("JAIL_DECISION");
    expect(activeState.justEnteredJail).toBe(true);
  });

  // 5) PROPERTY (своя клетка) при дубле
  //
  // Сценарий бага: игрок бросает дубль → mustRollAgain=true →
  // попадает на СВОЮ клетку (PROPERTY/RAILROAD/UTILITY). До
  // `handleResolvingLanding` для своей клетки безусловно ставил фазу
  // BUILDING, не учитывая `mustRollAgain`. В результате:
  //   - canRollDice=false (фаза ≠ ROLLING);
  //   - canEndTurn=false (mustRollAgain=true блокирует завершение).
  // Игра зависала: ни «Бросить», ни «Завершить» не активны.
  //
  // Исправление: для нейтральных клеток (своя клетка — это
  // «не событие», а просто приземление) правило дублей должно
  // продолжать действовать. Поэтому фаза = ROLLING, mustRollAgain
  // СОХРАНЯЕТСЯ.

  it("PROPERTY своя при дубле: mustRollAgain сохранён, фаза ROLLING (регресс #2)", async () => {
    const p = activeState.players[activeState.currentPlayerIndex]!;
    // Ищем первую PROPERTY и делаем её своей.
    const propertyCell = activeState.board.find((c) => c.type === "PROPERTY");
    expect(propertyCell).toBeDefined();
    if (!propertyCell) return;
    // Игрок встаёт ровно за N-2 от своей клетки, чтобы дубль [1,1]=2
    // привёл его на неё.
    p.position = (propertyCell.id - 2 + 40) % 40;
    p.mustRollAgain = true;
    p.consecutiveDoubles = 1;
    // Делаем клетку своей.
    activeState.board[propertyCell.id] = { ...propertyCell, ownerId: p.id };
    p.properties = [propertyCell.id];
    activeState.lastDice = { dice: [1, 1], isDouble: true };
    activeState.phase = "MOVE_ANIMATION";

    // 1) CONFIRM_MOVE_ANIMATION: handleMoveAnimation сдвигает на
    //    клетку propertyCell.id, фаза → RESOLVING_LANDING.
    await act({ type: "CONFIRM_MOVE_ANIMATION" });
    expect(p.position).toBe(propertyCell.id);
    expect(activeState.phase).toBe("RESOLVING_LANDING");

    // 2) CONFIRM_LANDING: handleResolvingLanding → cell.type=PROPERTY,
    //    cell.ownerId === p.id → раньше фаза = BUILDING, mustRollAgain
    //    оставался true → зависание. После mustRollAgain
    //    СОХРАНЯЕТСЯ, фаза = ROLLING.
    await act({ type: "CONFIRM_LANDING" });
    expect(p.mustRollAgain).toBe(true);
    expect(p.consecutiveDoubles).toBe(1);
    expect(activeState.phase).toBe("ROLLING");
    // UI-контракт: «Бросить» активна, «Завершить» — нет.
    expect(canRollDice(activeState, p)).toBe(true);
    expect(canEndTurn(activeState, p)).toBe(false);
  });

  it("RAILROAD своя при дубле: mustRollAgain сохранён, фаза ROLLING (регресс #2)", async () => {
    const p = activeState.players[activeState.currentPlayerIndex]!;
    const railroadCell = activeState.board.find((c) => c.type === "RAILROAD");
    expect(railroadCell).toBeDefined();
    if (!railroadCell) return;
    p.position = (railroadCell.id - 2 + 40) % 40;
    p.mustRollAgain = true;
    p.consecutiveDoubles = 1;
    activeState.board[railroadCell.id] = { ...railroadCell, ownerId: p.id };
    p.properties = [railroadCell.id];
    activeState.lastDice = { dice: [1, 1], isDouble: true };
    activeState.phase = "MOVE_ANIMATION";

    await act({ type: "CONFIRM_MOVE_ANIMATION" });
    expect(p.position).toBe(railroadCell.id);
    expect(activeState.phase).toBe("RESOLVING_LANDING");

    await act({ type: "CONFIRM_LANDING" });
    expect(p.mustRollAgain).toBe(true);
    expect(p.consecutiveDoubles).toBe(1);
    expect(activeState.phase).toBe("ROLLING");
    expect(canRollDice(activeState, p)).toBe(true);
    expect(canEndTurn(activeState, p)).toBe(false);
  });

  it("UTILITY своя при дубле: mustRollAgain сохранён, фаза ROLLING (регресс #2)", async () => {
    const p = activeState.players[activeState.currentPlayerIndex]!;
    const utilityCell = activeState.board.find((c) => c.type === "UTILITY");
    expect(utilityCell).toBeDefined();
    if (!utilityCell) return;
    p.position = (utilityCell.id - 2 + 40) % 40;
    p.mustRollAgain = true;
    p.consecutiveDoubles = 1;
    activeState.board[utilityCell.id] = { ...utilityCell, ownerId: p.id };
    p.properties = [utilityCell.id];
    activeState.lastDice = { dice: [1, 1], isDouble: true };
    activeState.phase = "MOVE_ANIMATION";

    await act({ type: "CONFIRM_MOVE_ANIMATION" });
    expect(p.position).toBe(utilityCell.id);
    expect(activeState.phase).toBe("RESOLVING_LANDING");

    await act({ type: "CONFIRM_LANDING" });
    expect(p.mustRollAgain).toBe(true);
    expect(p.consecutiveDoubles).toBe(1);
    expect(activeState.phase).toBe("ROLLING");
    expect(canRollDice(activeState, p)).toBe(true);
    expect(canEndTurn(activeState, p)).toBe(false);
  });
});
