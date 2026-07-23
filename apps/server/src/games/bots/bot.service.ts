import { Injectable } from "@nestjs/common";
import type { Cell, GameState, Player, TradeOffer } from "@monopoly/shared";
import { BOARD } from "@monopoly/shared";

/**
 * Решения бота.
 *
 * Простые решения — строки. Решения с параметром — объекты.
 * `null` означает «бот не знает, что делать» — в таком случае
 * `GamesService` сам завершит ход (для фаз BUILDING, END_TURN) или
 * таймер сработает на AUCTION_PASS / TRADE_REJECT.
 *
 * Покрывает:
 *  - Бросок костей (ROLLING)
 *  - Покупку клетки (BUY_DECISION)
 *  - Завершение хода (BUILDING)
 *  - Решения в тюрьме (JAIL_DECISION)
 *  - Ставки на аукционе (AUCTION_ACTIVE)
 *  - Ответы на обмен (TRADING_NEGOTIATE, TRADING_CONFIRM)
 *  - Инициация обмена (BUILDING + bot initiative)
 *  - Банкротство: приоритет — продать дома / заложить, потом объявить
 *
 * ВАЖНО (после рефакторинга FSM):
 *  - Визуальные фазы (`DICE_ANIMATION`, `MOVE_ANIMATION`, `CARD_REVEAL`,
 *    `RESOLVING_LANDING`, `END_TURN`, `CARD_EFFECT`) НЕ обрабатываются здесь.
 *  - Бот отвечает только на фазы, где нужен выбор: ROLLING, BUY_DECISION,
 *    BUILDING, JAIL_DECISION, AUCTION_ACTIVE, TRADING_*, BANKRUPTCY_LIQUIDATE.
 *
 * AUCTION_BID — это объект с amount: `BotService` сам вычисляет
 * желаемую ставку (на основе текущей + minIncrement + maxBid) и
 * возвращает { kind: "AUCTION_BID", amount }. `GamesService` потом
 * использует этот amount в `AUCTION_MAKE_BID`.
 */
export type BotDecision =
  | "ROLL"
  | "BUY"
  | "DECLINE_BUY"
  | "END_TURN"
  | "PAY_FINE"
  | "USE_CARD"
  | "TRY_DOUBLE"
  | "AUCTION_PASS"
  | "TRADE_ACCEPT"
  | "TRADE_REJECT"
  | { kind: "BUILD_HOUSE"; cellId: number }
  | { kind: "SELL_HOUSE"; cellId: number }
  | { kind: "MORTGAGE"; cellId: number }
  | { kind: "UNMORTGAGE"; cellId: number }
  | { kind: "AUCTION_BID"; amount: number }
  | "DECLARE_BANKRUPTCY"
  | { kind: "LIQUIDATE_HOUSES"; cellId: number }
  | { kind: "MORTGAGE_FOR_BANKRUPTCY"; cellId: number }
  | { kind: "TRADE_OFFER"; recipientId: string; offer: TradeOffer }
  | { kind: "TRADE_COUNTER"; offer: TradeOffer };

/**
 * Скоринг полезности клетки для конкретного игрока.
 *
 *  - baseValue          — номинальная стоимость (цена покупки).
 *  - rentPotential      — потенциальная рента (base * множитель).
 *  - monopolyBonus      — наценка, если клетка завершает монополию
 *                         (и выгода от удвоенной ренты).
 *  - groupProgressBonus — наценка, если у игрока уже есть другие
 *                         клетки этого цвета (принцип «3-я карта
 *                         из 3-х особенно ценна»).
 *  - isMonopolyBreaker  — отрицательный множитель, если клетка
 *                         замыкает чужую монополию (мы помогаем
 *                         сопернику).
 *  - effectiveValue     — итоговый скоринг.
 */
interface CellValuation {
  baseValue: number;
  rentPotential: number;
  monopolyBonus: number;
  groupProgressBonus: number;
  isMonopolyBreaker: boolean;
  effectiveValue: number;
}

/**
 * BotService — мозг ботов на сервере.
 */
@Injectable()
export class BotService {
  /**
   * Решить, что делать боту в текущей фазе.
   * Возвращает `null`, если бот не должен действовать.
   */
  decide(player: Player, state: GameState): BotDecision | null {
    const cell = state.board[player.position];

    switch (state.phase) {
      // Стандартные фазы хода
      case "ROLLING":
        if (player.inJail) {
          if (player.jailCards > 0) return "USE_CARD";
          return "TRY_DOUBLE";
        }
        return "ROLL";

      case "BUY_DECISION":
        return this.decideBuy(player, cell);

      case "BUILDING": {
        // Сначала проверяем, есть ли смысл инициировать торговлю.
        // За ход бот может предложить обмен только одному игроку.
        const tradeInitiative = this.maybeInitiateTrade(player, state);
        if (tradeInitiative) return tradeInitiative;
        // Иначе — стандартная стройка/выкуп.
        return this.decideBuild(player, state);
      }

      // Тюрьма
      case "JAIL_DECISION":
        if (state.justEnteredJail) return "END_TURN";
        if (player.jailCards > 0) return "USE_CARD";
        if (player.money >= 50) return "PAY_FINE";
        return "TRY_DOUBLE";

      // Прерывания: аукцион
      case "AUCTION_ACTIVE":
        return this.decideAuctionBid(player, state);

      // Прерывания: обмен
      case "TRADING_NEGOTIATE":
      case "TRADING_CONFIRM":
        return this.decideTrade(player, state);

      // Прерывания: банкротство
      case "BANKRUPTCY_LIQUIDATE":
        return this.decideBankruptcy(player, state);

      // Визуальные/автоматические фазы (бот не действует)
      case "AUCTION_AWAITING_START":
      case "AUCTION_FINISHED":
      case "START_TURN":
      case "DICE_ANIMATION":
      case "MOVE_ANIMATION":
      case "RESOLVING_LANDING":
      case "CARD_REVEAL":
      case "CARD_EFFECT":
      case "PAY_RENT":
      case "END_TURN":
      case "BANKRUPTCY_TRANSFER":
      case "IDLE":
      case "LOBBY":
      case "FINISHED":
      case "BOT_THINKING":
      default:
        return null;
    }
  }

  // Решения для конкретных фаз

  private decideBuy(player: Player, cell: Cell | undefined): BotDecision {
    if (!cell || cell.ownerId || cell.price === undefined) return "DECLINE_BUY";
    if (player.money >= cell.price + 200) return "BUY";
    return "DECLINE_BUY";
  }

  private decideBuild(player: Player, state: GameState): BotDecision {
    const houseId = this.findBuildHouseTarget(player, state);
    if (houseId !== null) return { kind: "BUILD_HOUSE", cellId: houseId };
    const unmortgageId = this.findUnmortgageTarget(player, state);
    if (unmortgageId !== null) return { kind: "UNMORTGAGE", cellId: unmortgageId };
    return "END_TURN";
  }

  private findBuildHouseTarget(player: Player, state: GameState): number | null {
    const myProps = state.board.filter(
      (c) => c.type === "PROPERTY" && c.ownerId === player.id && !c.isMortgaged,
    );
    const groups = new Map<string, Cell[]>();
    for (const c of myProps) {
      if (!c.group) continue;
      if (!groups.has(c.group)) groups.set(c.group, []);
      groups.get(c.group)!.push(c);
    }
    for (const [, cells] of groups) {
      const groupKey = cells[0]!.group!;
      const groupSize = state.board.filter(
        (b) => b.type === "PROPERTY" && b.group === groupKey,
      ).length;
      if (cells.length < groupSize) continue;
      const minHouses = Math.min(...cells.map((c) => c.houses ?? 0));
      if (minHouses >= 5) continue;
      const target = cells.find((c) => (c.houses ?? 0) === minHouses);
      if (!target || target.housePrice === undefined) continue;
      if (player.money >= target.housePrice + 200) return target.id;
    }
    return null;
  }

  private findUnmortgageTarget(player: Player, state: GameState): number | null {
    const mortgaged = state.board
      .filter((c) => c.type === "PROPERTY" && c.ownerId === player.id && c.isMortgaged)
      .sort((a, b) => (a.mortgageValue ?? 0) - (b.mortgageValue ?? 0))[0];
    if (!mortgaged) return null;
    const cost = Math.floor((mortgaged.mortgageValue ?? 0) * 1.1);
    if (player.money < cost + 300) return null;
    return mortgaged.id;
  }

  /**
   * Аукцион: бот делает ставку, если текущая цена ниже 80% от базовой
   * стоимости и покупка даст боту прогресс (новый цвет или застройка).
   * Иначе — пас. Возвращает объект { kind: "AUCTION_BID", amount }
   * (или "AUCTION_PASS") — сумма вычисляется ЗДЕСЬ, чтобы не размазывать
   * логику между bot и games services.
   */
  private decideAuctionBid(player: Player, state: GameState): BotDecision {
    const auction = state.auction;
    if (!auction) return "AUCTION_PASS";

    const cell = state.board[auction.cellId];
    if (!cell) return "AUCTION_PASS";

    // Лидер не может перебивать сам себя — это автоматический пас.
    if (auction.highestBidderId === player.id) return "AUCTION_PASS";

    // Нет денег на минимальную ставку — пас.
    const minIncrement = Math.max(10, Math.floor((cell.price ?? 0) * 0.05));
    const nextBid = (auction.currentBid ?? 0) + minIncrement;
    if (player.money < nextBid) return "AUCTION_PASS";

    // Не готовы платить больше 80% от базовой стоимости — пас.
    const maxBid = Math.floor((cell.price ?? 0) * 0.8);
    if (nextBid > maxBid) return "AUCTION_PASS";
    // Оставляем запас 100₽.
    if (player.money < nextBid + 100) return "AUCTION_PASS";

    if (this.auctionWorthBidding(player, cell, nextBid, state)) {
      return { kind: "AUCTION_BID", amount: nextBid };
    }
    return "AUCTION_PASS";
  }

  private auctionWorthBidding(player: Player, cell: Cell, bid: number, state: GameState): boolean {
    if (cell.group) {
      const groupCount = state.board.filter(
        (b) => b.type === "PROPERTY" && b.group === cell.group,
      ).length;
      const ownedInGroup = state.board.filter(
        (b) => b.type === "PROPERTY" && b.group === cell.group && b.ownerId === player.id,
      ).length;
      if (ownedInGroup + 1 === groupCount) return true;
    }
    return bid <= (cell.price ?? 0) * 0.5;
  }

  /**
   * Решение по активному обмену.
   *
   * Алгоритм:
   *  1. Если в фазе TRADING_CONFIRM и инициатор — бот, то подтвердить.
   *  2. Подсчитать «ценность получаемого» и «ценность отдаваемого»
   *     с учётом:
   *      - базовой цены клетки;
   *      - рентного потенциала (рента как доля от цены);
   *      - бонуса за завершение монополии;
   *      - бонуса за прогресс группы (2-я из 3-х клеток тоже ценна);
   *      - штрафа, если клетка замыкает чужую монополию.
   *  3. Если выгода очевидна (ratio >= 0.95) — ACCEPT.
   *  4. Если оффер близок к справедливому (ratio 0.6..0.95) и есть
   *     пространство для counter (ещё не исчерпаны попытки) — предложить
   *     встречное: либо поднять сумму денег, либо добавить нашу клетку.
   *  5. Иначе — REJECT.
   */
  private decideTrade(player: Player, state: GameState): BotDecision {
    const trade = state.trade;
    if (!trade || !trade.offer) return "TRADE_REJECT";

    if (state.phase === "TRADING_CONFIRM" && trade.currentPartyId !== player.id) {
      return "TRADE_REJECT";
    }

    const offer = trade.offer;
    const isInitiator = trade.initiatorId === player.id;

    if (state.phase === "TRADING_CONFIRM" && isInitiator) return "TRADE_ACCEPT";

    const counterpart = isInitiator
      ? state.players.find((p) => p.id === trade.recipientId)
      : state.players.find((p) => p.id === trade.initiatorId);

    const { value, cost, ratio } = this.evaluateTradeOffer(
      player,
      counterpart ?? null,
      offer,
      isInitiator,
      state,
    );
    void value;
    void cost;

    // Справедливая сделка — принимаем.
    if (ratio >= 0.95) return "TRADE_ACCEPT";

    // Не выгодно совсем — отклоняем.
    if (ratio < 0.55) return "TRADE_REJECT";

    // Средняя зона: пытаемся сделать встречное предложение.
    const max = state.settings.tradingMaxCounterOffers ?? 3;
    if (trade.counterCount < max) {
      const counter = this.buildCounterOffer(
        player,
        counterpart ?? null,
        offer,
        isInitiator,
        state,
      );
      if (counter) return { kind: "TRADE_COUNTER", offer: counter };
    }

    return "TRADE_REJECT";
  }

  /**
   * Улучшенная оценка обмена.
   *
   * Возвращает:
   *  - value — оценка того, что игрок ПОЛУЧАЕТ (для себя);
   *  - cost  — оценка того, что игрок ОТДАЁТ;
   *  - ratio — value / cost (если cost > 0; иначе 0).
   *
   * Учитываются:
   *  - базовая цена клетки (price);
   *  - рента (рентный потенциал);
   *  - завершение монополии у игрока (x2 к ценности клетки);
   *  - прогресс группы (2-я из 3-х — +50%, 3-я — +100%);
   *  - замыкание чужой монополии — штраф 30%.
   */
  private evaluateTradeOffer(
    player: Player,
    counterpart: Player | null,
    offer: TradeOffer,
    isInitiator: boolean,
    state: GameState,
  ): { value: number; cost: number; ratio: number } {
    const valuationFor = (cellId: number, owner: Player | null): number => {
      const v = this.valueCellForOwner(cellId, owner, state);
      return v.effectiveValue;
    };

    // Что бот получает от второй стороны.
    const incomingProps = isInitiator ? offer.toProperties : offer.fromProperties;
    const incomingCash = isInitiator ? offer.toCash : offer.fromCash;
    // Что бот отдаёт.
    const outgoingProps = isInitiator ? offer.fromProperties : offer.toProperties;
    const outgoingCash = isInitiator ? offer.fromCash : offer.toCash;

    const incomingPropsValue = incomingProps.reduce((s, id) => s + valuationFor(id, player), 0);
    const outgoingPropsValue = outgoingProps.reduce(
      (s, id) => s + valuationFor(id, counterpart),
      0,
    );

    // Деньги — 1:1 (без наценки), но если получатель на грани
    // банкротства, бот предпоч��ёт деньги как подушку.
    const value = incomingPropsValue + incomingCash;
    const cost = outgoingPropsValue + outgoingCash;
    const ratio = cost > 0 ? value / cost : value > 0 ? Infinity : 0;
    return { value, cost, ratio };
  }

  /**
   * Оценка клетки с точки зрения её ценности для конкретного владельца.
   * Если передать `null` — оценивается для банка (по номиналу).
   */
  private valueCellForOwner(cellId: number, owner: Player | null, state: GameState): CellValuation {
    const cell = state.board[cellId];
    if (!cell) {
      return {
        baseValue: 0,
        rentPotential: 0,
        monopolyBonus: 0,
        groupProgressBonus: 0,
        isMonopolyBreaker: false,
        effectiveValue: 0,
      };
    }
    const baseValue = cell.price ?? 0;
    // Потенциал ренты за один «полный обход» противника по нашим
    // клеткам. Берём 8 оценочных «посещений» (статистически 1.5-2 в
    // каждой партии), чтобы получить порядок величины, а не номинал.
    const rentPotential = (cell.rent ?? 0) * 8;

    let monopolyBonus = 0;
    let groupProgressBonus = 0;
    let isMonopolyBreaker = false;

    if (cell.group && cell.type === "PROPERTY") {
      const groupCells = state.board.filter((b) => b.type === "PROPERTY" && b.group === cell.group);
      const groupSize = groupCells.length;
      const ownerOwned = owner ? groupCells.filter((b) => b.ownerId === owner.id).length : 0;
      // Клетка завершает монополию этому владельцу — колоссальный бонус.
      if (owner && ownerOwned + 1 === groupSize) {
        monopolyBonus = baseValue * 1.5;
      }
      // Прогресс группы: 1-я карта в новой группе — 0, 2-я — +30%, 3-я — +50%.
      else if (owner && ownerOwned >= 1 && ownerOwned < groupSize) {
        groupProgressBonus = baseValue * (0.3 + 0.1 * (ownerOwned - 1));
      }
      // Клетка замыкает чужую монополию (если кто-то другой уже
      // контролирует все остальные клетки группы) — мы отдаём её
      // сопернику и резко ухудшаем свою позицию.
      if (owner) {
        for (const other of state.players) {
          if (other.id === owner.id) continue;
          const otherOwned = groupCells.filter((b) => b.ownerId === other.id).length;
          if (otherOwned + 1 === groupSize) {
            isMonopolyBreaker = true;
            break;
          }
        }
      }
    }

    // Суммируем.
    let effectiveValue = baseValue + rentPotential * 0.2 + monopolyBonus + groupProgressBonus;
    if (isMonopolyBreaker) {
      effectiveValue = effectiveValue * 0.7;
    }
    // Уже заложенная клетка — её ценность для владельца падает
    // (нужно ещё 10% сверху, чтобы выкупить).
    if (cell.isMortgaged) {
      effectiveValue = effectiveValue * 0.85;
    }

    return {
      baseValue,
      rentPotential,
      monopolyBonus,
      groupProgressBonus,
      isMonopolyBreaker,
      effectiveValue,
    };
  }

  /**
   * Построить встречное предложение: попытаться приблизить ratio к 1.0.
   *
   * Стратегии:
   *  A. Если не хватает денег у второй стороны (входящая сумма мала,
   *     а мы хотим больше) — увеличить свою сумму денег.
   *  B. Если оффер в деньгах уже щедрый — добавить нашу «слабую»
   *     клетку (без зданий и не из полной монополии), чтобы
   *     компенсировать разрыв.
   *  C. Если оффер перекошен (нам суют много клеток) — попросить
   *     дополнительные деньги сверху.
   */
  private buildCounterOffer(
    player: Player,
    counterpart: Player | null,
    offer: TradeOffer,
    isInitiator: boolean,
    state: GameState,
  ): TradeOffer | null {
    // Поля оффера в терминах "что Я отдаю / что Я получаю".
    const myGive = isInitiator
      ? {
          properties: [...offer.fromProperties],
          cash: offer.fromCash,
          jailCards: offer.fromJailCards,
        }
      : {
          properties: [...offer.toProperties],
          cash: offer.toCash,
          jailCards: offer.toJailCards,
        };
    const myGet = isInitiator
      ? {
          properties: [...offer.toProperties],
          cash: offer.toCash,
          jailCards: offer.toJailCards,
        }
      : {
          properties: [...offer.fromProperties],
          cash: offer.fromCash,
          jailCards: offer.fromJailCards,
        };

    // Запрет на передачу заложенных клеток с нашей стороны — иначе сервер
    // не примет. Лучше вообще их не включать.
    const cleanedGive = {
      ...myGive,
      properties: myGive.properties.filter((id) => {
        const c = state.board[id];
        return c && !c.isMortgaged && c.houses === 0;
      }),
    };
    const cleanedGet = {
      ...myGet,
      properties: myGet.properties.filter((id) => {
        const c = state.board[id];
        return c && c.houses === 0;
      }),
    };

    // Повторная оценка для ratio.
    const counterpart2 = counterpart ?? state.players.find((p) => p.id !== player.id) ?? null;
    const evalFor = (
      giveProps: number[],
      giveCash: number,
      getProps: number[],
      getCash: number,
    ) => {
      const value =
        getProps.reduce(
          (s, id) => s + this.valueCellForOwner(id, player, state).effectiveValue,
          0,
        ) + getCash;
      const cost =
        giveProps.reduce(
          (s, id) => s + this.valueCellForOwner(id, counterpart2, state).effectiveValue,
          0,
        ) + giveCash;
      return { value, cost, ratio: cost > 0 ? value / cost : value > 0 ? Infinity : 0 };
    };

    // Стратегия A: добавить денег, если есть ликвидность и ratio < 0.95.
    const initialRatio = evalFor(
      cleanedGive.properties,
      cleanedGive.cash,
      cleanedGet.properties,
      cleanedGet.cash,
    ).ratio;

    if (initialRatio < 0.95) {
      const max = state.settings.tradingMaxCounterOffers ?? 3;
      if (state.trade && state.trade.counterCount < max) {
        // Попробуем увеличить свою сумму денег на 15-25%.
        const bump = Math.max(10, Math.floor(player.money * 0.15));
        const extra = Math.min(bump, player.money - 50); // оставляем подушку
        if (extra > 0) {
          const newGiveCash = cleanedGive.cash + extra;
          const r2 = evalFor(
            cleanedGive.properties,
            newGiveCash,
            cleanedGet.properties,
            cleanedGet.cash,
          ).ratio;
          if (r2 >= 0.9 && r2 <= 1.1) {
            return this.packOffer(
              cleanedGive.properties,
              newGiveCash,
              cleanedGive.jailCards,
              cleanedGet.properties,
              cleanedGet.cash,
              cleanedGet.jailCards,
            );
          }
        }
      }
    }

    // Стратегия B: добавить слабую клетку с нашей стороны.
    if (initialRatio < 0.85) {
      const weak = this.findWeakTradableCell(player, state);
      if (weak && !cleanedGive.properties.includes(weak.id)) {
        const newGiveProps = [...cleanedGive.properties, weak.id];
        const r2 = evalFor(
          newGiveProps,
          cleanedGive.cash,
          cleanedGet.properties,
          cleanedGet.cash,
        ).ratio;
        if (r2 >= 0.9 && r2 <= 1.1) {
          return this.packOffer(
            newGiveProps,
            cleanedGive.cash,
            cleanedGive.jailCards,
            cleanedGet.properties,
            cleanedGet.cash,
            cleanedGet.jailCards,
          );
        }
      }
    }

    // Стратегия C: попросить дополнительные деньги (если нам недоплачивают).
    if (initialRatio < 0.85 && counterpart2 && counterpart2.money > 0) {
      const ask = Math.max(20, Math.floor(player.money * 0.1));
      const newGetCash = cleanedGet.cash + Math.min(ask, Math.floor(counterpart2.money * 0.3));
      const r2 = evalFor(
        cleanedGive.properties,
        cleanedGive.cash,
        cleanedGet.properties,
        newGetCash,
      ).ratio;
      if (r2 >= 0.9 && r2 <= 1.1) {
        return this.packOffer(
          cleanedGive.properties,
          cleanedGive.cash,
          cleanedGive.jailCards,
          cleanedGet.properties,
          newGetCash,
          cleanedGet.jailCards,
        );
      }
    }

    return null;
  }

  /**
   * Запаковать оффер в правильной ориентации (from / to)
   * с учётом, является ли бот инициатором.
   */
  private packOffer(
    giveProps: number[],
    giveCash: number,
    giveJailCards: number,
    getProps: number[],
    getCash: number,
    getJailCards: number,
  ): TradeOffer {
    return {
      fromProperties: [...giveProps],
      fromCash: giveCash,
      fromJailCards: giveJailCards,
      toProperties: [...getProps],
      toCash: getCash,
      toJailCards: getJailCards,
    };
  }

  /**
   * Бот оценивает ситуацию на доске и решает, стоит ли инициировать
   * торговлю. За один ход — максимум одна попытка с конкретным игроком
   * (state.tradeInitiationLog хранит, с кем уже пробовали в этом ходу).
   *
   * Возвращает { kind: "TRADE_OFFER", recipientId, offer } или null.
   *
   * Эвристика (v2 — улучшенная):
   *  1. У бота уже есть монополия хотя бы на одну группу И ему не хватает
   *     ОДНОЙ клетки до второй монополии — пытаемся купить её у владельца.
   *  2. Целевая клетка оценивается с точки зрения ВЛАДЕЛЬЦА:
   *     - если клетка замыкает ЧУЖУЮ монополию (мы её заберём и обнулим
   *       его монополию) — мы можем платить МЕНЬШЕ;
   *     - если клетка завершает НАШУ монополию — готовы платить БОЛЬШЕ.
   *  3. В обмен предлагаем:
   *     - свою слабую клетку (не из полной монополии) ИЛИ деньги;
   *     - в идеале комбинацию: клетка + деньги.
   *  4. Соотношение value/cost для второй стороны должно быть >= 0.9
   *     (иначе получатель отклонит — наш собственный GDD §6.4).
   */
  private maybeInitiateTrade(player: Player, state: GameState): BotDecision | null {
    if (player.kind !== "bot") return null;
    if (state.trade) return null; // торги уже идут — не начинать вторые

    // Не пытаемся торговать, если у бота нет ликвидности (минимум 200₽).
    if (player.money < 200) return null;

    // Найти «целевую» клетку: одна клетка от монополии.
    const wantedCell = this.findOneCellFromMonopoly(player, state);
    if (!wantedCell || !wantedCell.ownerId) return null;
    const owner = state.players.find((p) => p.id === wantedCell.ownerId);
    if (!owner || owner.isBankrupt) return null;
    if (owner.id === player.id) return null;
    // Уважаем блокировки.
    if (owner.blockedPlayers?.includes(player.id)) return null;
    // Не предлагали ли уже этому игроку в этом ходу?
    const alreadyTried = (state.tradeInitiationLog ?? []).some(
      (entry) => entry.initiatorId === player.id && entry.recipientId === owner.id,
    );
    if (alreadyTried) return null;

    // Целевая цена клетки для бота (что мы готовы заплатить).
    const botValuation = this.valueCellForOwner(wantedCell.id, player, state);
    // Ценность этой клетки ДЛЯ ВЛАДЕЛЬЦА (то, что он потеряет) — это
    // определяет минимальную цену, на которую он согласится.
    const ownerValuation = this.valueCellForOwner(wantedCell.id, owner, state);

    // Стартовая цена: 0.7 от номинала, но не больше, чем мы готовы
    // реально заплатить (effectiveValue).
    const baseValue = wantedCell.price ?? 0;
    const offerCash = Math.min(
      player.money - 100,
      Math.max(50, Math.floor(Math.min(botValuation.effectiveValue, baseValue) * 0.65)),
    );

    // Что бот готов отдать: одну клетку из своей самой слабой группы
    // (по эффективной ценности, чтобы не жертвовать основной монополией).
    const myCell = this.findWeakTradableCell(player, state);
    if (!myCell) return null;

    // Ценность нашей клетки для владельца — должно быть «достаточно».
    const myCellOwnerValue = this.valueCellForOwner(myCell.id, owner, state).effectiveValue;

    // Получатель должен быть в выигрыше (value/cost >= 0.9),
    // иначе он сразу отклонит. value = (клетка_которую_отдают_ему)
    // + деньги. cost = (клетка_которую_он_отдаёт).
    const recipientValue = (wantedCell.price ?? 0) + offerCash;
    const recipientCost = myCellOwnerValue;
    if (recipientValue < recipientCost * 0.9) {
      // Доплатим ещё, чтобы соблюсти правило «получатель в выигрыше».
      const need = Math.max(0, Math.floor(recipientCost * 0.9 - (wantedCell.price ?? 0)));
      const adjustedCash = Math.min(player.money - 50, offerCash + need);
      if (adjustedCash <= offerCash) return null;
      return {
        kind: "TRADE_OFFER",
        recipientId: owner.id,
        offer: {
          fromProperties: [myCell.id],
          fromCash: adjustedCash,
          fromJailCards: 0,
          toProperties: [wantedCell.id],
          toCash: 0,
          toJailCards: 0,
        },
      };
    }

    return {
      kind: "TRADE_OFFER",
      recipientId: owner.id,
      offer: {
        fromProperties: [myCell.id],
        fromCash: offerCash,
        fromJailCards: 0,
        toProperties: [wantedCell.id],
        toCash: 0,
        toJailCards: 0,
      },
    };
  }

  /**
   * Найти клетку, купив которую бот завершит ещё одну монополию.
   * Возвращает клетку или null.
   */
  private findOneCellFromMonopoly(player: Player, state: GameState): Cell | null {
    // Считаем, какие группы у бота «почти полные» (>= groupSize - 1).
    const groupCounts = new Map<string, { total: number; owned: number }>();
    for (const cell of state.board) {
      if (cell.type !== "PROPERTY" || !cell.group) continue;
      const g = cell.group;
      if (!groupCounts.has(g)) groupCounts.set(g, { total: 0, owned: 0 });
      const acc = groupCounts.get(g)!;
      acc.total += 1;
      if (cell.ownerId === player.id) acc.owned += 1;
    }
    // Уже полные монополии пропускаем (нечего докупать).
    const candidateGroups: string[] = [];
    for (const [g, acc] of groupCounts) {
      if (acc.owned >= acc.total - 1 && acc.owned < acc.total) {
        candidateGroups.push(g);
      }
    }
    if (candidateGroups.length === 0) return null;
    // Ищем недостающую клетку в первой подходящей группе.
    for (const g of candidateGroups) {
      const missing = state.board.find(
        (c) => c.type === "PROPERTY" && c.group === g && c.ownerId !== player.id,
      );
      if (missing && missing.ownerId) return missing;
    }
    return null;
  }

  /**
   * Найти самую слабую (по эффективной ценности для владельца) клетку
   * бота, которую можно отдать (без зданий, не из полной монополии).
   */
  private findWeakTradableCell(player: Player, state: GameState): Cell | null {
    const candidates = state.board
      .filter(
        (c) =>
          c.type === "PROPERTY" && c.ownerId === player.id && c.houses === 0 && (c.price ?? 0) > 0,
      )
      // Исключаем клетки из уже полных монополий игрока.
      .filter((c) => {
        if (!c.group) return true;
        const total = state.board.filter(
          (b) => b.type === "PROPERTY" && b.group === c.group,
        ).length;
        const owned = state.board.filter(
          (b) => b.type === "PROPERTY" && b.group === c.group && b.ownerId === player.id,
        ).length;
        return owned < total; // не из полной монополии
      })
      .sort((a, b) => (a.price ?? 0) - (b.price ?? 0));
    return candidates[0] ?? null;
  }

  private decideBankruptcy(player: Player, state: GameState): BotDecision {
    const proc = state.bankruptcy;
    if (!proc) return "DECLARE_BANKRUPTCY";

    const debt = proc.debt;

    const withHouses = state.board
      .filter((c) => c.type === "PROPERTY" && c.ownerId === player.id && (c.houses ?? 0) > 0)
      .sort((a, b) => (b.housePrice ?? 0) - (a.housePrice ?? 0));
    if (withHouses.length > 0 && player.money < debt) {
      return { kind: "LIQUIDATE_HOUSES", cellId: withHouses[0]!.id };
    }

    const canMortgage = state.board
      .filter((c) => c.type === "PROPERTY" && c.ownerId === player.id && !c.isMortgaged)
      .sort((a, b) => (b.mortgageValue ?? 0) - (a.mortgageValue ?? 0))[0];
    if (canMortgage && player.money < debt) {
      return { kind: "MORTGAGE_FOR_BANKRUPTCY", cellId: canMortgage.id };
    }

    return "DECLARE_BANKRUPTCY";
  }
}
