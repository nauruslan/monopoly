import { Test } from "@nestjs/testing";
import { BotService, type BotDecision } from "../bots/bot.service";
import { BankruptcyService } from "../handlers/bankruptcy.service";
import { makeCell, makeMonopolyBoard, makePlayer, makeState, resetCounters } from "./factories";
import type { GameState, Player } from "@monopoly/shared";

describe("BotService.decide", () => {
  let bot: BotService;

  beforeEach(async () => {
    resetCounters();
    const moduleRef = await Test.createTestingModule({
      providers: [BotService, BankruptcyService],
    }).compile();
    bot = moduleRef.get(BotService);
  });

  // ─────────────────────── ROLLING ───────────────────────
  describe("ROLLING phase", () => {
    it("ROLL, если игрок не в тюрьме и не имеет карточек", () => {
      const player = makePlayer({ inJail: false, holdableCards: {} });
      const state = makeState({ phase: "ROLLING", players: [player] });
      expect(bot.decide(player, state)).toBe("ROLL");
    });

    it("USE_CARD, если в тюрьме и есть карточка", () => {
      const player = makePlayer({
        inJail: true,
        holdableCards: {
          test: { templateId: "ch7", drawnAt: new Date().toISOString(), originDeckId: "d1" },
        },
      });
      const state = makeState({ phase: "ROLLING", players: [player] });
      expect(bot.decide(player, state)).toBe("USE_CARD");
    });

    it("TRY_DOUBLE, если в тюрьме без карточки", () => {
      const player = makePlayer({ inJail: true, holdableCards: {} });
      const state = makeState({ phase: "ROLLING", players: [player] });
      expect(bot.decide(player, state)).toBe("TRY_DOUBLE");
    });
  });

  // ─────────────────────── BUY_DECISION ───────────────────────
  describe("BUY_DECISION phase", () => {
    it("BUY, если хватает денег с запасом 200₽", () => {
      const cell = makeCell({ price: 200 });
      const player = makePlayer({ position: 0, money: 1500 });
      player.properties = [];
      const board = makeMonopolyBoard(3);
      board[0] = cell;
      const state = makeState({
        phase: "BUY_DECISION",
        players: [player],
        board,
      });
      expect(bot.decide(player, state)).toBe("BUY");
    });

    it("DECLINE_BUY (отказ), если денег впритык", () => {
      const cell = makeCell({ price: 200 });
      const player = makePlayer({ position: 0, money: 200 }); // ровно впритык
      const board = makeMonopolyBoard(3);
      board[0] = cell;
      const state = makeState({
        phase: "BUY_DECISION",
        players: [player],
        board,
      });
      // Раньше возвращался "END_TURN", что приводило к ForbiddenException
      // (END_TURN недопустим в BUY_DECISION) и зависанию бота после дубля +
      // карточки move-relative (бот терял право на ещё один бросок).
      // Корректно: фаза BUY_DECISION принимает только BUY_PROPERTY/DECLINE_BUY.
      expect(bot.decide(player, state)).toBe("DECLINE_BUY");
    });

    it("DECLINE_BUY, если у клетки уже есть владелец", () => {
      const cell = makeCell({ price: 200, ownerId: "another" });
      const player = makePlayer({ position: 0, money: 1500 });
      const board = makeMonopolyBoard(3);
      board[0] = cell;
      const state = makeState({
        phase: "BUY_DECISION",
        players: [player],
        board,
      });
      expect(bot.decide(player, state)).toBe("DECLINE_BUY");
    });
  });

  // ─────────────────────── JAIL_DECISION ───────────────────────
  describe("JAIL_DECISION phase", () => {
    it("USE_CARD имеет приоритет над штрафом", () => {
      const player = makePlayer({
        holdableCards: {
          test: { templateId: "ch7", drawnAt: new Date().toISOString(), originDeckId: "d1" },
        },
        money: 1500,
      });
      const state = makeState({ phase: "JAIL_DECISION", players: [player] });
      expect(bot.decide(player, state)).toBe("USE_CARD");
    });

    it("PAY_FINE, если денег достаточно и нет карточки", () => {
      const player = makePlayer({ holdableCards: {}, money: 100 });
      const state = makeState({ phase: "JAIL_DECISION", players: [player] });
      expect(bot.decide(player, state)).toBe("PAY_FINE");
    });

    it("TRY_DOUBLE, если нечем платить и нет карточки", () => {
      const player = makePlayer({ holdableCards: {}, money: 10 });
      const state = makeState({ phase: "JAIL_DECISION", players: [player] });
      expect(bot.decide(player, state)).toBe("TRY_DOUBLE");
    });
  });

  // ─────────────────────── BUILDING ───────────────────────
  describe("BUILDING phase", () => {
    it("OPEN_BUILDING_PHASE, если есть монополия и деньги (бот открывает фазу строительства)", () => {
      const board = makeMonopolyBoard(3);
      const player = makePlayer({ money: 1500, properties: [0, 1, 2] });
      board[0].ownerId = player.id;
      board[1].ownerId = player.id;
      board[2].ownerId = player.id;
      const state = makeState({
        phase: "BUILDING",
        players: [player],
        board,
      });
      // В фазе BUILDING бот сначала открывает под-фазу строительства,
      // а конкретные действия (BUILD_HOUSE/UNMORTGAGE) выполняет уже в BUILDING_PHASE.
      expect(bot.decide(player, state)).toBe("OPEN_BUILDING_PHASE");
    });

    it("OPEN_BUILDING_PHASE, если монополия есть, но дома все по 5, и есть заложенное", () => {
      const board = makeMonopolyBoard(3);
      const player = makePlayer({ money: 1500, properties: [0, 1, 2] });
      board[0].ownerId = player.id;
      board[1].ownerId = player.id;
      board[2].ownerId = player.id;
      board[0].houses = 5;
      board[1].houses = 5;
      board[2].houses = 5;
      // Сделаем одну клетку заложенной, чтобы был кандидат на unmortgage.
      board[1].isMortgaged = true;
      const state = makeState({
        phase: "BUILDING",
        players: [player],
        board,
      });
      expect(bot.decide(player, state)).toBe("OPEN_BUILDING_PHASE");
    });

    it("END_TURN, если строить нечего", () => {
      const board = makeMonopolyBoard(3);
      const player = makePlayer({ money: 1500, properties: [] });
      const state = makeState({
        phase: "BUILDING",
        players: [player],
        board,
      });
      expect(bot.decide(player, state)).toBe("END_TURN");
    });
  });

  // ─────────────────────── AUCTION ───────────────────────
  describe("AUCTION_ACTIVE phase", () => {
    /**
     * Фабрика состояния «активный аукцион» v2.
     * По умолчанию:
     *  - 2 игрока: me (id="me"), other (id="other");
     *  - cellId=0 (моно-доска makeMonopolyBoard(3), базовая цена 200₽);
     *  - me — текущий «на часах» (currentBidderId="me");
     *  - currentBid=0, highestBidderId=null;
     *  - оба участника активны.
     */
    function makeAuctionState(
      overrides: Partial<{
        currentBid: number;
        highestBidderId: string | null;
        activeBidders: string[];
        currentBidderId: string | null;
        meMoney: number;
      }> = {},
    ): GameState {
      const me = makePlayer({ id: "me", money: overrides.meMoney ?? 1500 });
      const other = makePlayer({ id: "other", money: 1500 });
      const board = makeMonopolyBoard(3);
      const activeBidders = overrides.activeBidders ?? [me.id, other.id];
      const currentBidderId = overrides.currentBidderId ?? me.id;
      const currentBidderIndex = Math.max(0, activeBidders.indexOf(currentBidderId));
      return makeState({
        phase: "AUCTION_ACTIVE",
        currentPlayerIndex: 0,
        players: [me, other],
        board,
        auction: {
          id: "auc1",
          cellId: 0,
          initiatorId: "other",
          status: "AUCTION_ACTIVE",
          currentBid: overrides.currentBid ?? 0,
          highestBidderId: overrides.highestBidderId ?? null,
          bidderOrder: [me.id, other.id],
          activeBidders,
          currentBidderIndex,
          currentBidderId,
          timerStartedAt: Date.now(),
          turnDurationMs: 30000,
          actionLog: [],
          winnerId: null,
          finalBid: 0,
          finishReason: null,
          startedAt: Date.now(),
          closedAt: null,
        },
      });
    }

    it("PASS, если бот уже лидирует (не перебивает сам себя)", () => {
      const state = makeAuctionState({ currentBid: 50, highestBidderId: "me" });
      const me = state.players[0]!;
      expect(bot.decide(me, state)).toBe("AUCTION_PASS");
    });

    it("BID c amount=10, если цена ниже 80% от базовой (на пустой клетке)", () => {
      // cellId=0, price=200, 80% = 160. currentBid=0, nextBid = 10.
      // 10 <= 160, и auctionWorthBidding (без группы → 10 <= 100) →
      // возвращаем объект с amount=10.
      const state = makeAuctionState({ currentBid: 0, highestBidderId: null });
      const me = state.players[0]!;
      const decision = bot.decide(me, state) as Extract<BotDecision, { kind: "AUCTION_BID" }>;
      expect(decision).toEqual({ kind: "AUCTION_BID", amount: 10 });
    });

    it("PASS, если минимальная ставка выше 80% от базовой", () => {
      // currentBid=170, инкремент = max(10, 200*0.05) = 10 → nextBid=180.
      // 180 > 160 (80% от 200) → PASS.
      const state = makeAuctionState({ currentBid: 170, highestBidderId: "other" });
      const me = state.players[0]!;
      expect(bot.decide(me, state)).toBe("AUCTION_PASS");
    });

    it("PASS, если денег впритык (нет запаса 100₽)", () => {
      // currentBid=0 → nextBid=10. Запас в боте = +100, нужно >= 110.
      const state = makeAuctionState({
        currentBid: 0,
        highestBidderId: null,
        meMoney: 100,
      });
      const me = state.players[0]!;
      expect(bot.decide(me, state)).toBe("AUCTION_PASS");
    });
  });
  // ─────────────────────── TRADE ───────────────────────
  describe("TRADING_NEGOTIATE / TRADING_CONFIRM phase", () => {
    it("REJECT, если нет state.trade", () => {
      const me = makePlayer();
      const state = makeState({ phase: "TRADING_NEGOTIATE", players: [me] });
      expect(bot.decide(me, state)).toBe("TRADE_REJECT");
    });

    it("REJECT, если value < 90% от cost", () => {
      const board = makeMonopolyBoard(3);
      // С точки зрения other (recipient, currentPartyId):
      // он отдаёт toProperties=[] (0₽) + toCash=50,
      // получает fromProperties=[0] (200₽) + fromCash=0.
      // value=200, cost=50, 200/50 = 4.0 ≥ 0.9 → ACCEPT. Тест наоборот!
      // Сделаем наоборот: other отдаёт дорогое, получает мало.
      const me = makePlayer({ id: "me", properties: [0] });
      const other = makePlayer({ id: "other", properties: [1] });
      board[0].ownerId = "me";
      board[1].ownerId = "other";
      // me (initiator) отдаёт 200 (cell 0), просит 50₽.
      // other отдаёт 50₽, получает cell 0 (200₽). value=50, cost=200.
      // 50/200 = 0.25 < 0.9 → REJECT.
      const state = makeState({
        phase: "TRADING_NEGOTIATE",
        players: [me, other],
        board,
        trade: {
          initiatorId: "me",
          recipientId: "other",
          currentPartyId: "other",
          offer: {
            fromProperties: [0],
            fromCash: 0,
            fromHoldableCardCount: 0,
            toProperties: [],
            toCash: 50,
            toHoldableCardCount: 0,
          },
          counterCount: 0,
        },
      });
      // Чтобы other получал МАЛО и отдавал МНОГО — перевернём стороны:
      // Сейчас other получает cell 0 (200₽) и отдаёт 50₽ → ACCEPT.
      // Для REJECT нужна обратная картина: other отдаёт дорогое.
      // other отдаёт cell 1 (200₽) + 0₽, получает 50₽. value=50, cost=200.
      state.trade!.offer = {
        fromProperties: [], // me отдаёт 0
        fromCash: 50, // me даёт 50₽
        fromHoldableCardCount: 0,
        toProperties: [1], // me просит cell 1 (200₽)
        toCash: 0,
        toHoldableCardCount: 0,
      };
      // Пересчёт: other (recipient) получает fromProperties=[] (0) + fromCash=50 = 50.
      // other отдаёт toProperties=[1] (200) + toCash=0 = 200. 50/200 = 0.25 < 0.9 → REJECT.
      expect(bot.decide(other, state)).toBe("TRADE_REJECT");
    });

    it("ACCEPT, если value >= 90% от cost", () => {
      const board = makeMonopolyBoard(3);
      // Я получаю клетку 0 (price=200) + 100₽ = 300.
      // Отдаю клетку 1 (price=200) = 200. value/cost = 300/200 = 1.5 → ACCEPT.
      const me = makePlayer({ id: "me", properties: [1] });
      const other = makePlayer({ id: "other", properties: [0] });
      board[0].ownerId = "other";
      board[1].ownerId = "me";
      const state = makeState({
        phase: "TRADING_NEGOTIATE",
        players: [me, other],
        board,
        trade: {
          initiatorId: "other",
          recipientId: "me",
          currentPartyId: "me",
          offer: {
            fromProperties: [0],
            fromCash: 100,
            fromHoldableCardCount: 0,
            toProperties: [1],
            toCash: 0,
            toHoldableCardCount: 0,
          },
          counterCount: 0,
        },
      });
      expect(bot.decide(me, state)).toBe("TRADE_ACCEPT");
    });

    it("ACCEPT в TRADING_CONFIRM, если инициатор подтверждает", () => {
      const me = makePlayer({ id: "me" });
      const other = makePlayer({ id: "other" });
      const state = makeState({
        phase: "TRADING_CONFIRM",
        players: [me, other],
        trade: {
          initiatorId: "me",
          recipientId: "other",
          currentPartyId: "me",
          offer: {
            fromProperties: [],
            fromCash: 0,
            fromHoldableCardCount: 0,
            toProperties: [],
            toCash: 0,
            toHoldableCardCount: 0,
          },
          counterCount: 1,
        },
      });
      expect(bot.decide(me, state)).toBe("TRADE_ACCEPT");
    });
  });

  // ─────────────────────���─ BANKRUPTCY ───────────────────────
  describe("BANKRUPTCY_LIQUIDATE phase", () => {
    function makeBkState(overrides: {
      debt: number;
      money: number;
      propsWithHouses?: number[];
      propsToMortgage?: number[];
    }): {
      state: GameState;
      player: Player;
    } {
      const me = makePlayer({
        id: "me",
        money: overrides.money,
        properties: [...(overrides.propsWithHouses ?? []), ...(overrides.propsToMortgage ?? [])],
      });
      // Используем доску 6 клеток: первые 3 — brown (с домами), последние 3 —
      // lightblue (можно заложить). Так propsWithHouses и propsToMortgage
      // оказываются в РАЗНЫХ группах, и бот может выполнить залог клетки
      // из lightblue, не нарушая правило лесенки для brown.
      const board = makeMonopolyBoard(3, "brown").concat(makeMonopolyBoard(3, "lightblue"));
      for (const id of overrides.propsWithHouses ?? []) {
        board[id].ownerId = "me";
        board[id].houses = 2;
        board[id].housePrice = 100;
      }
      for (const id of overrides.propsToMortgage ?? []) {
        board[id].ownerId = "me";
        board[id].isMortgaged = false;
        board[id].mortgageValue = 150;
      }
      return {
        player: me,
        state: makeState({
          phase: "BANKRUPTCY_LIQUIDATE",
          players: [me],
          board,
          bankruptcy: { playerId: "me", creditorId: null, debt: overrides.debt, stage: 2 },
        }),
      };
    }

    // Контракт переработанного decideBankruptcy:
    //   Приоритеты выстроены от мягких к жестким шагам.
    //   Каждый вызов возвращает РОВНО ОДНО действие — сервер
    //   пересчитывает баланс после каждого действия и снова
    //   вызывает bot.decide(), так что цикл «проверить баланс ->
    //   выбрать действие» повторяется с актуальным state.
    //
    //     1. money >= 0         -> CONFIRM_BANKRUPTCY (долг покрыт).
    //     2. есть незаложенная  -> MORTGAGE_FOR_BANKRUPTCY (самый
    //        клетка без домов       мягкий шаг: клетка остается у игрока).
    //     3. есть заложенная    -> SELL_MORTGAGED_PROPERTY_FOR_BANKRUPTCY
    //        клетка без домов       (допродажа заложенного, +50%).
    //     4. есть дома          -> LIQUIDATE_HOUSES (правило лесенки).
    //     5. есть незаложенная  -> SELL_PROPERTY_FOR_BANKRUPTCY (100%).
    //        клетка без домов
    //     6. иначе              -> DECLARE_BANKRUPTCY.
    it("CONFIRM_BANKRUPTCY, если баланс уже неотрицательный (ликвидация завершена)", () => {
      const { state, player } = makeBkState({ debt: 1000, money: 0, propsWithHouses: [0] });
      expect(bot.decide(player, state)).toBe("CONFIRM_BANKRUPTCY");
    });

    it("MORTGAGE важнее LIQUIDATE_HOUSES: при наличии обоих — сначала залог", () => {
      // propsWithHouses=[0] (brown, с домами) — нельзя заложить (лесенка).
      // propsToMortgage=[3] (lightblue, без домов) — можно заложить.
      // Бот должен сначала заложить клетку 3, а не сносить дома.
      const { state, player } = makeBkState({
        debt: 1000,
        money: -100,
        propsWithHouses: [0],
        propsToMortgage: [3],
      });
      const d = bot.decide(player, state);
      expect(d).toMatchObject({ kind: "MORTGAGE_FOR_BANKRUPTCY", cellId: 3 });
    });

    it("MORTGAGE_FOR_BANKRUPTCY, если денег < 0, домов нет, но есть незаложенная клетка", () => {
      const { state, player } = makeBkState({ debt: 1000, money: -100, propsToMortgage: [1] });
      const d = bot.decide(player, state);
      expect(d).toMatchObject({ kind: "MORTGAGE_FOR_BANKRUPTCY", cellId: 1 });
    });

    it("SELL_MORTGAGED_PROPERTY_FOR_BANKRUPTCY, если нет незаложенных, но есть заложенные клетки", () => {
      // Все незаложенные клетки с домами (заложить нельзя из-за лесенки),
      // но есть заложенная клетка без домов -> допродаём её Банку.
      const me = makePlayer({ id: "me", money: -100, properties: [3] });
      const board = makeMonopolyBoard(4);
      board[3].ownerId = "me";
      board[3].isMortgaged = true;
      board[3].mortgageValue = 150;
      const state = makeState({
        phase: "BANKRUPTCY_LIQUIDATE",
        players: [me],
        board,
        bankruptcy: { playerId: "me", creditorId: null, debt: 100, stage: 2 },
      });
      const d = bot.decide(me, state);
      expect(d).toMatchObject({ kind: "SELL_MORTGAGED_PROPERTY_FOR_BANKRUPTCY", cellId: 3 });
    });

    it("LIQUIDATE_HOUSES через правило лесенки: сносится передовая клетка", () => {
      const me = makePlayer({ id: "me", money: -100, properties: [0, 1] });
      const board = makeMonopolyBoard(2);
      board[0].ownerId = "me";
      board[0].isMortgaged = false;
      board[0].houses = 2;
      board[0].housePrice = 100;
      board[0].mortgageValue = 150;
      board[1].ownerId = "me";
      board[1].isMortgaged = false;
      board[1].houses = 3;
      board[1].housePrice = 100;
      board[1].mortgageValue = 150;
      const state = makeState({
        phase: "BANKRUPTCY_LIQUIDATE",
        players: [me],
        board,
        bankruptcy: { playerId: "me", creditorId: null, debt: 100, stage: 2 },
      });
      const d = bot.decide(me, state);
      // Передовая клетка (houses=3) -> именно её сносим.
      expect(d).toMatchObject({ kind: "LIQUIDATE_HOUSES", cellId: 1 });
    });

    it("LIQUIDATE_HOUSES, если деньги < 0 и единственный актив — дома", () => {
      const { state, player } = makeBkState({
        debt: 1000,
        money: -100,
        propsWithHouses: [0],
      });
      const d = bot.decide(player, state);
      expect(d).toMatchObject({ kind: "LIQUIDATE_HOUSES", cellId: 0 });
    });

    it("SELL_PROPERTY_FOR_BANKRUPTCY: после исчерпания залогов, допродаж и домов", () => {
      // 2 клетки одной группы brown, обе принадлежат боту, у одной
      // (cellId=1) есть дома. Бот не может заложить (лесенка), но
      // МОЖЕТ снести 1 дом (лесенка разрешает снос с передовой клетки).
      // Поэтому приоритет LIQUIDATE_HOUSES идёт раньше SELL_PROPERTY.
      const me = makePlayer({ id: "me", money: -100, properties: [0, 1] });
      const board = makeMonopolyBoard(2, "brown");
      board[0].ownerId = "me";
      board[0].isMortgaged = false;
      board[0].houses = 0;
      board[0].mortgageValue = 150;
      board[0].price = 300;
      board[1].ownerId = "me";
      board[1].isMortgaged = false;
      board[1].houses = 2;
      board[1].housePrice = 100;
      board[1].mortgageValue = 150;
      const state = makeState({
        phase: "BANKRUPTCY_LIQUIDATE",
        players: [me],
        board,
        bankruptcy: { playerId: "me", creditorId: null, debt: 100, stage: 2 },
      });
      // Передовая клетка (houses=2) — единственная с домами.
      const d = bot.decide(me, state);
      expect(d).toMatchObject({ kind: "LIQUIDATE_HOUSES", cellId: 1 });
    });

    // КЕЙС ИЗ ЗАДАЧИ:
    //   Долг бота = 535р. Бот продал два участка за 220 и 160
    //   (SELL_PROPERTY_FOR_BANKRUPTCY), стало -155р. Ещё 2 клетки
    //   монополии с домами (по 2 дома на каждой, итого 4 дома по
    //   100р = 400р), а также 2 незаложенные клетки без домов.
    //   Главное: НЕ объявлять банкротство, пока есть чем покрыть
    //   долг. Бот должен сначала заложить незаложенные клетки без
    //   домов и выйти в 0+. Допродажа заложенного и снос домов
    //   выполняются ПОСЛЕ, когда залога уже не хватает.
    it("КЕЙС ИЗ ЗАДАЧИ: долг 535р -> сначала 2 залога, потом снос домов (лесенка)", () => {
      // Ситуация: бот уже продал 2 клетки (220 + 160) и его баланс
      // ушёл в -535р. Осталось имущество:
      //   - 2 клетки lightblue (id 10, 11) — незаложенные, без домов
      //   - 3 клетки yellow (id 18, 20, 21) — у 20 и 21 по 2 дома,
      //     у 18 — 1 дом (лесенка требует равномерности).
      // Приоритет: сначала залог (не снос домов!), потом снос домов.
      // В нашем контракте каждый вызов bot.decide возвращает ОДНО
      // действие; сервер пересчитывает баланс и снова вызывает бота.
      const me = makePlayer({
        id: "me",
        money: -535,
        properties: [10, 11, 18, 20, 21],
      });
      // 40 «пустых» клеток-заглушек (группа brown — не используется ботом
      // напрямую, нужно только чтобы board имел 40 ячеек как настоящая доска).
      const board = Array.from({ length: 40 }, () =>
        makeCell({
          type: "PROPERTY",
          group: "brown",
          price: 200,
          rent: 20,
          housePrice: 100,
          mortgageValue: 100,
        }),
      );
      // Незаложенные клетки без домов (группа "lightblue" — все 3 клетки
      // принадлежат боту, но мы используем только 2 из них; иначе правило
      // лесенки блокировало бы залог).
      board[10] = makeCell({ id: 10, group: "lightblue", price: 350, mortgageValue: 175 });
      board[11] = makeCell({ id: 11, group: "lightblue", price: 400, mortgageValue: 200 });
      // Клетки с домами (группа "yellow" — все 3 клетки принадлежат боту,
      // иначе правило лесенки не разрешило бы ни продать дома, ни заложить).
      board[12] = makeCell({ id: 12, group: "lightblue", price: 300, mortgageValue: 150 });
      board[18] = makeCell({ id: 18, group: "yellow", price: 200, mortgageValue: 100, houses: 1 });
      board[20] = makeCell({
        id: 20,
        group: "yellow",
        price: 200,
        housePrice: 100,
        mortgageValue: 100,
        houses: 2,
      });
      board[21] = makeCell({
        id: 21,
        group: "yellow",
        price: 200,
        housePrice: 100,
        mortgageValue: 100,
        houses: 2,
      });
      for (const id of [10, 11, 18, 20, 21]) {
        board[id].ownerId = "me";
        board[id].isMortgaged = false;
      }
      const state = makeState({
        phase: "BANKRUPTCY_LIQUIDATE",
        players: [me],
        board,
        bankruptcy: { playerId: "me", creditorId: null, debt: 535, stage: 2 },
      });

      // Шаг 1: бот видит незаложенные клетки без домов -> MORTGAGE
      // самой ликвидной из группы lightblue (id 11, mortgageValue=200).
      // Важно: сортировка mortgageValue desc, идем сначала туда, где больше
      // денег. id 11 даёт 200, id 10 даёт 175.
      const d1 = bot.decide(me, state);
      expect(d1).toMatchObject({ kind: "MORTGAGE_FOR_BANKRUPTCY", cellId: 11 });

      // Имитируем применение залога.
      board[11].isMortgaged = true;
      me.money += board[11].mortgageValue ?? 0;
      // -535 + 200 = -335, ещё < 0.

      // Шаг 2: бот закладывает вторую клетку (id 10, mortgageValue=175).
      const d2 = bot.decide(me, state);
      expect(d2).toMatchObject({ kind: "MORTGAGE_FOR_BANKRUPTCY", cellId: 10 });
      board[10].isMortgaged = true;
      me.money += board[10].mortgageValue ?? 0;
      // -335 + 175 = -160, ещё < 0.

      // Шаг 3: незаложенных клеток без домов больше нет (12 не принадлежит
      // боту), НО появились заложенные клетки (10, 11). По нашему приоритету
      // п.3 SELL_MORTGAGED_PROPERTY идёт раньше п.4 LIQUIDATE_HOUSES.
      // Бот допродаёт заложенную клетку с максимальным mortgageValue.
      // 10 даёт +175, 11 даёт +200. Выбираем 11 (больше денег сразу).
      const d3 = bot.decide(me, state);
      expect(d3).toMatchObject({ kind: "SELL_MORTGAGED_PROPERTY_FOR_BANKRUPTCY", cellId: 11 });
    });

    it("DECLARE_BANKRUPTCY, если деньги < 0 и нечего продавать/закладывать", () => {
      const { state, player } = makeBkState({ debt: 1000, money: -100 });
      expect(bot.decide(player, state)).toBe("DECLARE_BANKRUPTCY");
    });

    // КЕЙС ИЗ РЕАЛЬНОЙ ИГРЫ: бот имеет 3 клетки red с 3 домами на каждой
    // (монополия) и 4 mortgageable клетки в других группах. Долг 710₽.
    // Сумма 4 mortgageable + 4 sell_mortgaged = 700₽ (не хватает 10₽).
    // Бот должен сначала заложить, допродать заложенные, и только потом
    // перейти к продаже домов (LIQUIDATE_HOUSES). НЕЛЬЗЯ сразу после
    // 4 sell_mortgaged объявлять банкротство.
    it("после 4 залогов и 4 допродаж бот доходит до LIQUIDATE_HOUSES (монополия red с домами)", () => {
      const me = makePlayer({ id: "me", money: -710, properties: [8, 9, 14, 21, 23, 24, 34] });
      const board = Array.from({ length: 40 }, () =>
        makeCell({ type: "PROPERTY", group: "brown", price: 200, rent: 20, mortgageValue: 100 }),
      );
      // 4 mortgageable клетки (группы lightblue/pink/green, без домов)
      board[8] = makeCell({
        id: 8,
        name: "Проспект Мира",
        group: "lightblue",
        price: 100,
        rent: 6,
        housePrice: 50,
        mortgageValue: 50,
      });
      board[9] = makeCell({
        id: 9,
        name: "Площадь Ногина",
        group: "lightblue",
        price: 120,
        rent: 8,
        housePrice: 50,
        mortgageValue: 60,
      });
      board[14] = makeCell({
        id: 14,
        name: "Ростовская наб.",
        group: "pink",
        price: 160,
        rent: 12,
        housePrice: 100,
        mortgageValue: 80,
      });
      // 3 клетки red с домами (монополия)
      board[21] = makeCell({
        id: 21,
        name: "Грузинский вал",
        group: "red",
        price: 220,
        rent: 18,
        housePrice: 150,
        mortgageValue: 110,
        houses: 3,
      });
      board[23] = makeCell({
        id: 23,
        name: "Новинский бульв.",
        group: "red",
        price: 220,
        rent: 18,
        housePrice: 150,
        mortgageValue: 110,
        houses: 3,
      });
      board[24] = makeCell({
        id: 24,
        name: "Смоленская пл.",
        group: "red",
        price: 220,
        rent: 18,
        housePrice: 150,
        mortgageValue: 110,
        houses: 3,
      });
      board[34] = makeCell({
        id: 34,
        name: "Проспект Вернадского",
        group: "green",
        price: 320,
        rent: 28,
        mortgageValue: 160,
      });
      for (const id of [8, 9, 14, 21, 23, 24, 34]) {
        board[id].ownerId = "me";
        board[id].isMortgaged = false;
      }
      const state = makeState({
        phase: "BANKRUPTCY_LIQUIDATE",
        players: [me],
        board,
        bankruptcy: { playerId: "me", creditorId: null, debt: 710, stage: 2 },
      });
      // Прогоняем цикл: применяем каждое действие бота локально (как это
      // делает сервер) и снова зовём decide. Останавливаемся на
      // CONFIRM_BANKRUPTCY или DECLARE_BANKRUPTCY.
      let outcome: string | null = null;
      for (let i = 0; i < 30; i++) {
        const d = bot.decide(me, state);
        if (d === null) {
          outcome = "NULL";
          break;
        }
        if (typeof d === "string") {
          outcome = d;
          break;
        }
        if (!("cellId" in d)) {
          outcome = d.kind;
          break;
        }
        if (d.kind === "MORTGAGE_FOR_BANKRUPTCY") {
          const c = board[d.cellId];
          c.isMortgaged = true;
          me.money += c.mortgageValue ?? 0;
        } else if (d.kind === "SELL_MORTGAGED_PROPERTY_FOR_BANKRUPTCY") {
          const c = board[d.cellId];
          me.money += c.mortgageValue ?? 0;
          c.ownerId = undefined;
          c.isMortgaged = false;
        } else if (d.kind === "LIQUIDATE_HOUSES") {
          const c = board[d.cellId];
          me.money += Math.floor((c.housePrice ?? 0) / 2);
          c.houses = (c.houses === 5 ? 4 : c.houses - 1) as 0 | 1 | 2 | 3 | 4 | 5;
        } else if (d.kind === "SELL_PROPERTY_FOR_BANKRUPTCY") {
          const c = board[d.cellId];
          me.money += c.price ?? 0;
          c.ownerId = undefined;
        }
      }
      // Ожидаем: бот закрывает долг через продажу домов и выходит в
      // CONFIRM_BANKRUPTCY. Если он сразу объявляет банкротство после
      // 4 залогов и 4 допродаж (не дойдя до LIQUIDATE_HOUSES) — тест
      // провалится, и это будет регрессия.
      expect(outcome).toBe("CONFIRM_BANKRUPTCY");
    });
  });

  // ─────────────────────── UNKNOWN PHASE ───────────────────────
  it("null для незнакомой фазы", () => {
    const me = makePlayer();
    const state = makeState({ phase: "IDLE", players: [me] });
    expect(bot.decide(me, state)).toBeNull();
  });

  // TRADE INITIATIVE (bot)
  describe("Bot: инициация торговли (BUILDING)", () => {
    it("не пытается инициировать, если игрок — человек", () => {
      const me = makePlayer({ kind: "human", money: 1500 });
      const state = makeState({ phase: "BUILDING", players: [me] });
      const d = bot.decide(me, state);
      expect(d).not.toEqual(expect.objectContaining({ kind: "TRADE_OFFER" }));
    });

    it("не пытается, если у бота мало денег (<200)", () => {
      const me = makePlayer({ kind: "bot", money: 100 });
      const state = makeState({ phase: "BUILDING", players: [me] });
      const d = bot.decide(me, state);
      expect(d).not.toEqual(expect.objectContaining({ kind: "TRADE_OFFER" }));
    });

    it("не пытается, если нет возможной цели", () => {
      const me = makePlayer({ kind: "bot", money: 1500, properties: [] });
      const other = makePlayer({ id: "other", properties: [] });
      const state = makeState({ phase: "BUILDING", players: [me, other] });
      const d = bot.decide(me, state);
      expect(d).not.toEqual(expect.objectContaining({ kind: "TRADE_OFFER" }));
    });

    it("пытается купить клетку до монополии (TRADE_OFFER)", () => {
      const board = makeMonopolyBoard(3, "brown");
      const me = makePlayer({ id: "me-bot", kind: "bot", money: 1500 });
      me.properties = [0, 1];
      const other = makePlayer({ id: "other", money: 1500 });
      other.properties = [2];
      board[0].ownerId = "me-bot";
      board[1].ownerId = "me-bot";
      board[2].ownerId = "other";
      const state = makeState({ phase: "BUILDING", players: [me, other], board });
      const d = bot.decide(me, state) as Extract<BotDecision, { kind: "TRADE_OFFER" }>;
      expect(d).toMatchObject({ kind: "TRADE_OFFER" });
      expect(d.recipientId).toBe("other");
      expect(d.offer.toProperties).toContain(2);
    });

    it("не пытается в одну и ту же группу игроку дважды за ход (tradeInitiationLog)", () => {
      const board = makeMonopolyBoard(3, "brown");
      const me = makePlayer({ id: "me-bot", kind: "bot", money: 1500 });
      me.properties = [0, 1];
      const other = makePlayer({ id: "other", money: 1500 });
      other.properties = [2];
      board[0].ownerId = "me-bot";
      board[1].ownerId = "me-bot";
      board[2].ownerId = "other";
      const state = makeState({
        phase: "BUILDING",
        players: [me, other],
        board,
        tradeInitiationLog: [{ initiatorId: "me-bot", recipientId: "other", at: Date.now() }],
      });
      const d = bot.decide(me, state);
      expect(d).not.toEqual(expect.objectContaining({ kind: "TRADE_OFFER" }));
    });

    it("уважает блокировку партнёра", () => {
      const board = makeMonopolyBoard(3, "brown");
      const me = makePlayer({ id: "me-bot", kind: "bot", money: 1500 });
      me.properties = [0, 1];
      const other = makePlayer({
        id: "other",
        money: 1500,
        blockedPlayers: ["me-bot"],
      });
      other.properties = [2];
      board[0].ownerId = "me-bot";
      board[1].ownerId = "me-bot";
      board[2].ownerId = "other";
      const state = makeState({ phase: "BUILDING", players: [me, other], board });
      const d = bot.decide(me, state);
      expect(d).not.toEqual(expect.objectContaining({ kind: "TRADE_OFFER" }));
    });
  });
});
