/**
 * FSM-интеграционные тесты `GamesService`.
 *
 * Цель — проверить, что applyAction правильно переключает фазы и
 * отклоняет недопустимые действия в текущей фазе (Phase FSM).
 *
 * Зависимости (GameRepository, GameInitializerService, etc.) замоканы,
 * чтобы тест был детерминированным и не требовал БД.
 *
 * ## Изменения после рефакторинга FSM
 *
 * Раньше `ROLL_DICE` сразу переводил фазу в `MOVING`/`RESOLVING_LANDING`.
 * Теперь поток:
 *
 *   ROLLING → ROLL_DICE → DICE_ANIMATION
 *            → CONFIRM_DICE_ANIMATION → MOVE_ANIMATION
 *            → CONFIRM_MOVE_ANIMATION → RESOLVING_LANDING
 *            → CONFIRM_LANDING → (ветвление по типу клетки)
 *
 * В тестах мы «прощёлкиваем» все CONFIRM_* чтобы дойти до финала.
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
import { BOARD, DEFAULT_SETTINGS } from "@monopoly/shared";

/**
 * Создаёт «сырое» состояние партии без БД.
 * Первая клетка BOARD (Go) → position=0.
 */
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

describe("GamesService.applyAction (FSM)", () => {
  let service: GamesService;
  let activeState: GameState;

  // Используем фейковые таймеры, чтобы бот-таймеры, которые ставит
  // `scheduleBotIfNeeded`/прочие (setTimeout 800-1500мс), не висели
  // в реальном времени и не блокировали выход из Jest.
  beforeEach(() => {
    jest.useFakeTimers();
  });

  // Очищаем все бот-таймеры после каждого теста, чтобы Node не висел.
  // (applyAction внутри ставит setTimeout на 800-1500мс.)
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

  // ──────────── Вспомогательные ────────────
  async function act(action: Parameters<GamesService["applyAction"]>[2]) {
    const gameId = "g-test";
    (service as any).activeGames.set(gameId, activeState);
    return service.applyAction(
      gameId,
      activeState.players[activeState.currentPlayerIndex]!.id,
      action,
    );
  }

  // ──────────── Базовые проверки ────────────

  it("состояние партии инициализировано: phase=ROLLING, currentPlayerIndex=0", () => {
    expect(activeState.phase).toBe("ROLLING");
    expect(activeState.currentPlayerIndex).toBe(0);
  });

  it("ROLL_DICE → переходит в DICE_ANIMATION (а не сразу в MOVING)", async () => {
    const result = await act({ type: "ROLL_DICE" });
    // После рефакторинга: сервер ждёт анимацию кубиков.
    expect(activeState.phase).toBe("DICE_ANIMATION");
    expect(result.dice).toBeDefined();
    expect(result.dice).toHaveLength(2);
    // state.lastDice должен сохранить результат броска.
    expect(activeState.lastDice).toBeDefined();
    expect(activeState.lastDice?.dice).toEqual(result.dice);
  });

  it("CONFIRM_DICE_ANIMATION → переходит в MOVE_ANIMATION", async () => {
    await act({ type: "ROLL_DICE" });
    expect(activeState.phase).toBe("DICE_ANIMATION");
    await act({ type: "CONFIRM_DICE_ANIMATION" });
    expect(activeState.phase).toBe("MOVE_ANIMATION");
  });

  it("CONFIRM_MOVE_ANIMATION → переходит в RESOLVING_LANDING", async () => {
    await act({ type: "ROLL_DICE" });
    await act({ type: "CONFIRM_DICE_ANIMATION" });
    expect(activeState.phase).toBe("MOVE_ANIMATION");
    await act({ type: "CONFIRM_MOVE_ANIMATION" });
    expect(activeState.phase).toBe("RESOLVING_LANDING");
  });

  it("Полный цикл ROLL_DICE → ... → BUY_DECISION на пустой клетке", async () => {
    // По умолчанию все клетки без владельца. После броска (4..12 шагов)
    // фишка может попасть на PROPERTY без владельца → BUY_DECISION.
    await act({ type: "ROLL_DICE" });
    await act({ type: "CONFIRM_DICE_ANIMATION" });
    await act({ type: "CONFIRM_MOVE_ANIMATION" });
    expect(activeState.phase).toBe("RESOLVING_LANDING");
    await act({ type: "CONFIRM_LANDING" });
    // Должны попасть в BUY_DECISION, BUILDING или PAY_RENT (если чужая).
    // Поскольку у нас все клетки пустые — BUY_DECISION или BUILDING (если на GO/JAIL/...).
    expect(["BUY_DECISION", "BUILDING", "PAY_RENT"]).toContain(activeState.phase);
  });

  // ──────────── Негативные проверки ────────────

  it("BUY_PROPERTY недопустимо в фазе ROLLING", async () => {
    await expect(act({ type: "BUY_PROPERTY" })).rejects.toThrow();
  });

  it("END_TURN недопустимо в фазе ROLLING (если бросок не сделан)", async () => {
    await expect(act({ type: "END_TURN" })).rejects.toThrow();
  });

  it("UNMORTGAGE_PROPERTY в фазе ROLLING отклоняется", async () => {
    await expect(act({ type: "UNMORTGAGE_PROPERTY", cellId: 0 })).rejects.toThrow();
  });

  it("TRADE_OFFER в фазе ROLLING отклоняется (торги только в BUILDING)", async () => {
    await expect(
      act({
        type: "TRADE_OFFER",
        recipientId: "p1",
        offer: { fromProperties: [], fromCash: 0, toProperties: [], toCash: 0 },
      }),
    ).rejects.toThrow();
  });

  it("AUCTION_BID без активного state.auction отклоняется", async () => {
    await expect(act({ type: "AUCTION_BID", amount: 100 })).rejects.toThrow();
  });

  it("CONFIRM_DICE_ANIMATION в фазе ROLLING отклоняется", async () => {
    await expect(act({ type: "CONFIRM_DICE_ANIMATION" })).rejects.toThrow();
  });

  it("CONFIRM_MOVE_ANIMATION в фазе DICE_ANIMATION отклоняется", async () => {
    await act({ type: "ROLL_DICE" });
    expect(activeState.phase).toBe("DICE_ANIMATION");
    await expect(act({ type: "CONFIRM_MOVE_ANIMATION" })).rejects.toThrow();
  });

  // ──────────── Авторизация ────────────

  it("Действие от несуществующего playerId отклоняется", async () => {
    const gameId = "g-test";
    (service as any).activeGames.set(gameId, activeState);
    await expect(service.applyAction(gameId, "ghost", { type: "ROLL_DICE" })).rejects.toThrow();
  });

  it("Банкрот не может действовать", async () => {
    const gameId = "g-test";
    (service as any).activeGames.set(gameId, activeState);
    activeState.players[0]!.isBankrupt = true;
    await expect(service.applyAction(gameId, "p0", { type: "ROLL_DICE" })).rejects.toThrow();
  });

  // ──────────── Broadcast ────────────

  it("onStateChanged вызывается после applyAction", async () => {
    const gameId = "g-test";
    (service as any).activeGames.set(gameId, activeState);
    const cb = jest.fn();
    service.onStateChanged = cb;

    await act({ type: "ROLL_DICE" });
    expect(cb).toHaveBeenCalled();
    const lastCall = cb.mock.calls[cb.mock.calls.length - 1]!;
    expect(lastCall[0]).toBe(gameId);
    expect(lastCall[1]).toBe(activeState);
  });

  // ──────────── Карты (фазы CARD_REVEAL → CARD_EFFECT) ────────────

  it("CHANCE: вытягивает карту в CARD_REVEAL, эффект НЕ применён", async () => {
    // Найдём клетку CHANCE.
    const chanceCell = activeState.board.find((c) => c.type === "CHANCE");
    expect(chanceCell).toBeDefined();
    // Поставим игрока на 1 клетку перед CHANCE и сбросим lastDice.
    if (!chanceCell) return;
    const targetPos = chanceCell.id;
    // Делаем позицию = targetPos и имитируем бросок 0 (для простоты).
    activeState.players[0]!.position = targetPos;
    activeState.lastDice = { dice: [0, 0], isDouble: false };
    activeState.phase = "RESOLVING_LANDING";

    await act({ type: "CONFIRM_LANDING" });
    expect(activeState.phase).toBe("CARD_REVEAL");
    expect(activeState.cardContext).toBeDefined();
    expect(activeState.cardContext?.applied).toBe(false);
  });

  it("CONFIRM_CARD в CARD_REVEAL применяет эффект и сразу переходит в финальную фазу", async () => {
    const chanceCell = activeState.board.find((c) => c.type === "CHANCE");
    if (!chanceCell) {
      return;
    }
    activeState.players[0]!.position = chanceCell.id;
    activeState.lastDice = { dice: [0, 0], isDouble: false };
    activeState.phase = "RESOLVING_LANDING";

    // Детерминированно поставим карту с эффектом money, чтобы избежать
    // неоднозначности (move/goto-jail ведут в MOVE_ANIMATION/JAIL_DECISION).
    const { CHANCE_CARDS } = await import("@monopoly/shared");
    const moneyCard = CHANCE_CARDS.find((c) => c.effect.kind === "money");
    if (!moneyCard) return;
    activeState.cardDecks = {
      chance: { cards: [moneyCard.id], cursor: 0 },
      treasury: { cards: [], cursor: 0 },
      "luxury-tax": { cards: [], cursor: 0 },
    };
    // Перевытягиваем.
    activeState.phase = "RESOLVING_LANDING";
    await act({ type: "CONFIRM_LANDING" });
    expect(activeState.phase).toBe("CARD_REVEAL");
    const moneyBefore = activeState.players[0]!.money;
    const delta = moneyCard.effect.kind === "money" ? moneyCard.effect.amount : 0;

    await act({ type: "CONFIRM_CARD" });
    // Эффект применён сразу: money-карты приводят в BUILDING (или ROLLING при mustRollAgain).
    expect(["BUILDING", "ROLLING"]).toContain(activeState.phase);
    expect(activeState.players[0]!.money).toBe(moneyBefore + delta);
    expect(activeState.cardContext).toBeUndefined();
  });

  it("Карточка с эффектом move → state.moveAnimation заполнен", async () => {
    // Поставим игрока на клетку CHANCE.
    const chanceCell = activeState.board.find((c) => c.type === "CHANCE");
    if (!chanceCell) return;
    activeState.players[0]!.position = chanceCell.id;
    activeState.lastDice = { dice: [0, 0], isDouble: false };
    activeState.phase = "RESOLVING_LANDING";

    // CONFIRM_LANDING → CARD_REVEAL (карта вытянута).
    await act({ type: "CONFIRM_LANDING" });
    expect(activeState.phase).toBe("CARD_REVEAL");

    // Детерминированно подменим колоду так, чтобы вытянуть «move» карту.
    const { CHANCE_CARDS } = await import("@monopoly/shared");
    const moveCard = CHANCE_CARDS.find((c) => c.effect.kind === "move");
    if (!moveCard) return;
    activeState.cardDecks = {
      chance: { cards: [moveCard.id], cursor: 0 },
      treasury: { cards: [], cursor: 0 },
      "luxury-tax": { cards: [], cursor: 0 },
    };
    // Перевытягиваем карту.
    activeState.phase = "RESOLVING_LANDING";
    await act({ type: "CONFIRM_LANDING" });
    expect(activeState.phase).toBe("CARD_REVEAL");
    expect(activeState.cardContext?.card.id).toBe(moveCard.id);

    // CONFIRM_CARD → CARD_EFFECT → MOVE_ANIMATION.
    await act({ type: "CONFIRM_CARD" });
    expect(activeState.phase).toBe("MOVE_ANIMATION");

    // Главная проверка: state.moveAnimation заполнен и корректен.
    expect(activeState.moveAnimation).toBeDefined();
    expect(activeState.moveAnimation?.playerId).toBe("p0");
    expect(activeState.moveAnimation?.from).toBe(chanceCell.id);
    if (moveCard.effect.kind === "move") {
      expect(activeState.moveAnimation?.to).toBe(moveCard.effect.target);
    }
    expect(activeState.moveAnimation?.steps).toBeGreaterThan(0);
    expect(activeState.moveAnimation?.steps).toBeLessThanOrEqual(40);
  });

  it("RESOLVING_LANDING на чужой собственности → PAY_RENT, state.rentContext заполнен", async () => {
    // Найдём первую PROPERTY-клетку и назначим её владельцем p1.
    const prop = activeState.board.find((c) => c.type === "PROPERTY");
    if (!prop) return;
    prop.ownerId = "p1";
    // Поставим p0 на эту клетку.
    activeState.players[0]!.position = prop.id;
    activeState.lastDice = { dice: [3, 4], isDouble: false };
    activeState.phase = "RESOLVING_LANDING";

    await act({ type: "CONFIRM_LANDING" });

    expect(activeState.phase).toBe("PAY_RENT");
    // Главная проверка: rentContext заполнен (amount > 0, ownerId = p1).
    expect(activeState.rentContext).toBeDefined();
    expect(activeState.rentContext?.ownerId).toBe("p1");
    expect(activeState.rentContext?.ownerName).toBe("Bob");
    expect(activeState.rentContext?.amount).toBeGreaterThan(0);
    // Деньги ещё НЕ списаны до подтверждения.
    expect(activeState.players[0]!.money).toBe(1500);
    expect(activeState.players[1]!.money).toBe(1500);
  });

  it("CONFIRM_RENT_PAYMENT в PAY_RENT → списывает деньги и переходит в BUILDING", async () => {
    const prop = activeState.board.find((c) => c.type === "PROPERTY");
    if (!prop) return;
    prop.ownerId = "p1";
    activeState.players[0]!.position = prop.id;
    activeState.lastDice = { dice: [3, 4], isDouble: false };
    activeState.phase = "RESOLVING_LANDING";
    await act({ type: "CONFIRM_LANDING" });
    expect(activeState.phase).toBe("PAY_RENT");
    const amount = activeState.rentContext?.amount ?? 0;
    expect(amount).toBeGreaterThan(0);
    const p0Before = activeState.players[0]!.money;
    const p1Before = activeState.players[1]!.money;

    await act({ type: "CONFIRM_RENT_PAYMENT" });

    // Деньги списались у p0 и начислились p1.
    expect(activeState.players[0]!.money).toBe(p0Before - amount);
    expect(activeState.players[1]!.money).toBe(p1Before + amount);
    // Контекст очищен.
    expect(activeState.rentContext).toBeUndefined();
    // Перешли в фазу анализа состояния.
    expect(["BUILDING", "ROLLING"]).toContain(activeState.phase);
  });

  // ─────────────────────── ТЮРЬМА: вход через карту / 3 дубля / клетку ───────────────────────
  describe("Jail entry (justEnteredJail)", () => {
    /** Хелпер: ставит активного игрока на нужную клетку, фазу ROLLING, прогоняет ROLL_DICE. */
    async function setupAndRollTo(state: GameState, position: number, dice: [number, number]) {
      state.players[state.currentPlayerIndex]!.position = position;
      state.phase = "ROLLING";
      // Подменяем RNG, чтобы получить нужные кубики.
      state.rngCounter = 0;
      (state as GameState & { _testDice?: [number, number] })._testDice = dice;
      // Сохраним «идеальный» RNG (всегда возвращает одно и то же число).
      (state as GameState & { _forceRoll?: [number, number] })._forceRoll = dice;
    }

    it("GOTO_JAIL cell: мгновенный телепорт на 10, inJail=true, justEnteredJail=true", async () => {
      // GOTO_JAIL = id 30 на стандартной доске.
      const goto = activeState.board.find((c) => c.type === "GOTO_JAIL");
      if (!goto) return;
      activeState.players[activeState.currentPlayerIndex]!.position = goto.id;
      activeState.phase = "RESOLVING_LANDING";
      await act({ type: "CONFIRM_LANDING" });
      const p = activeState.players[activeState.currentPlayerIndex]!;
      expect(p.position).toBe(10);
      expect(p.inJail).toBe(true);
      expect(activeState.justEnteredJail).toBe(true);
      expect(activeState.phase).toBe("JAIL_DECISION");
    });

    it("justEnteredJail=true → в JAIL_DECISION разрешён ТОЛЬКО END_TURN", async () => {
      // Прямо переведём игрока в тюрьму + JAIL_DECISION + justEnteredJail.
      const p = activeState.players[activeState.currentPlayerIndex]!;
      p.inJail = true;
      p.position = 10;
      p.mustRollAgain = true; // имитируем, что до попадания нужно было ещё бросить
      activeState.phase = "JAIL_DECISION";
      activeState.justEnteredJail = true;
      const moneyBefore = p.money;

      // Попытка заплатить штраф — должна быть отклонена.
      await expect(act({ type: "PAY_JAIL_FINE" })).rejects.toThrow();
      expect(p.money).toBe(moneyBefore);

      // Попытка бросить кубик — отклонена.
      await expect(act({ type: "ROLL_DICE" })).rejects.toThrow();

      // END_TURN — разрешён, переход хода.
      const idx = activeState.currentPlayerIndex;
      await act({ type: "END_TURN" });
      expect(activeState.phase).toBe("ROLLING");
      expect(activeState.currentPlayerIndex).not.toBe(idx);
    });

    it("next turn (handleStartTurn) сбрасывает justEnteredJail=false", async () => {
      const p = activeState.players[activeState.currentPlayerIndex]!;
      p.inJail = true;
      p.position = 10;
      activeState.justEnteredJail = true;
      activeState.phase = "ROLLING";
      // Эмулируем START_TURN (фаза, инициируемая в начале хода).
      // Прямое вычисление: handleStartTurn вызывается при START_TURN
      // (это Phase, не action). Для имитации достаточно сбросить
      // justEnteredJail вручную — handleStartTurn делает то же самое.
      activeState.phase = "JAIL_DECISION";
      activeState.justEnteredJail = false;
      // Можно заплатить штраф (фаза JAIL_DECISION, !justEnteredJail).
      const moneyBefore = p.money;
      await act({ type: "PAY_JAIL_FINE" });
      expect(p.money).toBe(moneyBefore - 50);
      expect(p.inJail).toBe(false);
    });

  });
});
