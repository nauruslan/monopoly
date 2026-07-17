/**
 * Регрессионные тесты: «дубль + карточка Шанс/Казна».
 *
 * Сценарий бага (описан пользователем):
 *  1) Игрок бросает дубль → mustRollAgain=true, consecutiveDoubles=1.
 *  2) Попадает на ШАНС/КАЗНУ → вытягивает карту «Бесплатная парковка
 *     (move target=20)» или аналогичную «выводящую» из обычного цикла.
 *  3) После CONFIRM_CARD сервер перемещает фишку на новую клетку.
 *  4) ДО ИСПРАВЛЕНИЯ: mustRollAgain оставался true, и в финальной фазе
 *     (BUILDING для парковки) кнопка «Завершить» была заблокирована
 *     (canEndTurn=false из-за mustRollAgain=true), а «Бросить» тоже
 *     (фаза ≠ ROLLING). Игра зависала.
 *
 * ИСПРАВЛЕНИЕ: `applyCardEffectAndAdvance` в GamesService сбрасывает
 * `mustRollAgain=false` и `consecutiveDoubles=0` для исходов
 * `move` / `move-relative` / `go-salary` — цепочка «бросок → движение →
 * эффект» обрывается, и игрок должен завершить ход (или попасть в
 * тюрьму, или взаимодействовать с новой клеткой).
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
        stateSnapshot: state,
      })),
      updateSnapshot: jest.fn(async () => undefined),
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
    };
    activeState.cardDecks = {
      chance: { cards: [card.id], cursor: 0 },
      treasury: { cards: [], cursor: 0 },
      "luxury-tax": { cards: [], cursor: 0 },
    };
    return p;
  }

  it("move-карта (парковка) при дубле: сбрасывает mustRollAgain и consecutiveDoubles", async () => {
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
    };
    activeState.cardDecks = {
      chance: { cards: [], cursor: 0 },
      treasury: { cards: [parkingCard.id], cursor: 0 },
      "luxury-tax": { cards: [], cursor: 0 },
    };

    await act({ type: "CONFIRM_CARD" });

    // Главная проверка bugfix: флаги сброшены сервером.
    expect(p.mustRollAgain).toBe(false);
    expect(p.consecutiveDoubles).toBe(0);
    // И фишка уже перемещена на 20 (move-эффект выполнился).
    expect(p.position).toBe(20);
    // Карточка применена, контекст очищен.
    expect(activeState.cardContext).toBeUndefined();
    // ─── Спецлогика «отправляйтесь на парковку» по карточке ─────
    // Парковка (id=20) трактуется как «отдых» (аналог ареста): фишка
    // телепортируется мгновенно, без MOVE_ANIMATION, право на ещё
    // один бросок (после дубля) ТЕРЯЕТСЯ. Поэтому фаза сразу
    // BUILDING и выставлен флаг justArrivedAtParking.
    expect(activeState.phase).toBe("BUILDING");
    expect(activeState.justArrivedAtParking).toBe(true);
    expect(activeState.moveAnimation).toBeUndefined();
    // UI-блокировка: canRollDice=false, но canEndTurn=true
    // (игрок может только завершить ход).
    expect(canRollDice(activeState, p)).toBe(false);
    expect(canEndTurn(activeState, p)).toBe(true);
  });

  it("полный цикл: дубль + move-карта → BUILDING, canEndTurn=true", async () => {
    // Проходим весь цикл: CONFIRM_CARD (применяет move) →
    // CONFIRM_MOVE_ANIMATION (RESOLVING_LANDING) → CONFIRM_LANDING (BUILDING).
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
    };
    activeState.cardDecks = {
      chance: { cards: [], cursor: 0 },
      treasury: { cards: [parkingCard.id], cursor: 0 },
      "luxury-tax": { cards: [], cursor: 0 },
    };

    // 1) CONFIRM_CARD: применяет move → мгновенный переход на 20,
    //    фаза BUILDING (без MOVE_ANIMATION/RESOLVING_LANDING/CONFIRM_LANDING).
    await act({ type: "CONFIRM_CARD" });
    expect(p.mustRollAgain).toBe(false);
    expect(p.position).toBe(20);
    expect(activeState.phase).toBe("BUILDING");
    expect(activeState.justArrivedAtParking).toBe(true);

    // Финальная проверка bugfix: можно завершить ход, бросок заблокирован.
    expect(canEndTurn(activeState, p)).toBe(true);
    expect(canRollDice(activeState, p)).toBe(false);
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
    };
    activeState.cardDecks = {
      chance: { cards: [], cursor: 0 },
      treasury: { cards: [parkingCard.id], cursor: 0 },
      "luxury-tax": { cards: [], cursor: 0 },
    };

    await act({ type: "CONFIRM_CARD" });
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

  it("move-relative карта (назад/вперёд на N) при дубле: тоже сбрасывает mustRollAgain", async () => {
    // Карточка «Вернитесь на 3 клетки назад» — должна работать так же.
    const backCard = CHANCE_CARDS.find(
      (c) => c.effect.kind === "move-relative" && "steps" in c.effect && c.effect.steps === -3,
    );
    expect(backCard).toBeDefined();
    if (!backCard) return;

    const p = setupCardReveal(backCard);

    await act({ type: "CONFIRM_CARD" });

    // Главная проверка: mustRollAgain сброшен.
    expect(p.mustRollAgain).toBe(false);
    expect(p.consecutiveDoubles).toBe(0);
    // Фаза — MOVE_ANIMATION (move-relative-исход).
    expect(activeState.phase).toBe("MOVE_ANIMATION");
  });

  it("go-salary карта при дубле: mustRollAgain сбрасывается, начисляется goSalary", async () => {
    // «Отправляйтесь на Вперёд. Получите 200₽» — это go-salary.
    const goCard = CHANCE_CARDS.find((c) => c.effect.kind === "go-salary");
    expect(goCard).toBeDefined();
    if (!goCard) return;

    const p = setupCardReveal(goCard);
    const moneyBefore = p.money;
    const goSalary = activeState.settings.goSalary;

    await act({ type: "CONFIRM_CARD" });

    // Флаги сброшены.
    expect(p.mustRollAgain).toBe(false);
    expect(p.consecutiveDoubles).toBe(0);
    // Зарплата начислена.
    expect(p.money).toBe(moneyBefore + goSalary);
    // Позиция = 0.
    expect(p.position).toBe(0);
    // Фаза — MOVE_ANIMATION.
    expect(activeState.phase).toBe("MOVE_ANIMATION");
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

    await act({ type: "CONFIRM_CARD" });

    expect(p.mustRollAgain).toBe(false);
    expect(p.consecutiveDoubles).toBe(0);
    expect(p.inJail).toBe(true);
    expect(p.position).toBe(10);
    expect(activeState.phase).toBe("JAIL_DECISION");
    expect(activeState.justEnteredJail).toBe(true);
  });
});
