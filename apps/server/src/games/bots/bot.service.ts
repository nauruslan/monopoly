import { Injectable } from "@nestjs/common";
import type { Cell, GameState, Player, TradeOffer } from "@monopoly/shared";
import { BOARD } from "@monopoly/shared";

/**
 * Решения бота.
 *
 * Простые решения — строки. Решения с параметром клетки — объекты.
 * `null` означает «бот не знает, что делать» — в таком случае
 * `GamesService` сам завершит ход (для фаз BUILDING, END_TURN) или
 * таймер сработает на AUCTION_PASS / TRADE_REJECT.
 *
 * Покрывает:
 *  - Бросок костей (ROLLING)
 *  - Покупку клетки (BUY_DECISION)
 *  - Завершение хода (BUILDING)
 *  - Решения в тюрьме (JAIL_DECISION)
 *  - Ставки на аукционе (AUCTION_BIDDING)
 *  - Ответы на обмен (TRADING_NEGOTIATE, TRADING_CONFIRM)
 *  - Банкротство: приоритет — продать дома / заложить, потом объявить
 *
 * ВАЖНО (после рефакторинга FSM):
 *  - Визуальные фазы (`DICE_ANIMATION`, `MOVE_ANIMATION`, `CARD_REVEAL`,
 *    `RESOLVING_LANDING`, `END_TURN`, `CARD_EFFECT`) НЕ обрабатываются здесь.
 *    Сервер сам шлёт соответствующие CONFIRM_* по таймеру.
 *  - Бот отвечает только на фазы, где нужен выбор: ROLLING, BUY_DECISION,
 *    BUILDING, JAIL_DECISION, AUCTION_BIDDING, TRADING_*, BANKRUPTCY_LIQUIDATE.
 */
export type BotDecision =
  | "ROLL"
  | "BUY"
  | "END_TURN"
  | "PAY_FINE"
  | "USE_CARD"
  | "TRY_DOUBLE"
  | "AUCTION_BID"
  | "AUCTION_PASS"
  | "TRADE_ACCEPT"
  | "TRADE_REJECT"
  | { kind: "BUILD_HOUSE"; cellId: number }
  | { kind: "SELL_HOUSE"; cellId: number }
  | { kind: "MORTGAGE"; cellId: number }
  | { kind: "UNMORTGAGE"; cellId: number }
  | "DECLARE_BANKRUPTCY"
  | { kind: "LIQUIDATE_HOUSES"; cellId: number }
  | { kind: "MORTGAGE_FOR_BANKRUPTCY"; cellId: number };

/**
 * BotService — мозг ботов на сервере.
 *
 * Боты живут ТОЛЬКО здесь (раньше логика была в
 * `apps/client/src/composables/botAI.ts`, что не работало в мультиплеере).
 *
 * После рефакторинга (FSM) бот использует тот же путь принятия решений,
 * что и человек — единый dispatch() в GamesService. Разница только в
 * том, что вместо UI-ввода решение формирует `decide()`.
 */
@Injectable()
export class BotService {
  /**
   * Решить, что делать боту в текущей фазе.
   * Возвращает `null`, если бот не должен действовать.
   *
   * ВАЖНО: для визуальных фаз (DICE_ANIMATION, MOVE_ANIMATION, CARD_REVEAL,
   * RESOLVING_LANDING, END_TURN, CARD_EFFECT) возвращаем null —
   * сервер сам отправит CONFIRM_* по таймеру.
   */
  decide(player: Player, state: GameState): BotDecision | null {
    const cell = state.board[player.position];

    switch (state.phase) {
      // ──────── Стандартные фазы хода ────────
      case "ROLLING":
        // Если игрок в тюрьме — сначала надо выйти (использовать карточку
        // или попробовать дубль), а не бросать кубики. Решение об оплате
        // штрафа и логика tryDouble vs payFine — в JAIL_DECISION, куда
        // GamesService переведёт фазу после нашего действия.
        if (player.inJail) {
          if (player.jailCards > 0) return "USE_CARD";
          return "TRY_DOUBLE";
        }
        // В ROLLING бот кидает кубики (потом сервер сам переходит в
        // DICE_ANIMATION и по таймеру двигает дальше).
        return "ROLL";

      case "BUY_DECISION":
        return this.decideBuy(player, cell);

      case "BUILDING":
        return this.decideBuild(player, state);

      // ──────── Тюрьма ────────
      case "JAIL_DECISION":
        // Svezhee popadanie v tyurmu (v ETOM khodu) — po pravilam Monopolii
        // igrok ne prinimaet reshenie o vykhode v tom zhe khodu: tolko END_TURN.
        // Modalnaya okna s tremya sposobami vykhoda poyavitsya v SLEDUYUSHEM khodu.
        if (state.justEnteredJail) return "END_TURN";
        if (player.jailCards > 0) return "USE_CARD";
        if (player.money >= 50) return "PAY_FINE";
        return "TRY_DOUBLE";
      // ──────── Прерывания: аукцион ────────
      case "AUCTION_BIDDING":
        return this.decideAuctionBid(player, state);

      // ──────── Прерывания: обмен ────────
      case "TRADING_NEGOTIATE":
      case "TRADING_CONFIRM":
        return this.decideTrade(player, state);

      // ──────── Прерывания: банкротство ────────
      case "BANKRUPTCY_LIQUIDATE":
        return this.decideBankruptcy(player, state);

      // ──────── Визуальные/автоматические фазы (бот не действует) ────────
      case "START_TURN":
      case "DICE_ANIMATION":
      case "MOVE_ANIMATION":
      case "RESOLVING_LANDING":
      case "CARD_REVEAL":
      case "CARD_EFFECT":
      case "PAY_RENT":
      case "END_TURN":
      case "AUCTION_RESOLVE":
      case "BANKRUPTCY_TRANSFER":
      case "IDLE":
      case "LOBBY":
      case "FINISHED":
      case "BOT_THINKING":
      default:
        return null;
    }
  }

  // ────────────────────────────────────────────
  // Решения для конкретных фаз
  // ────────────────────────────────────────────

  /**
   * Покупаем, если у бота останется запас минимум 200₽. Иначе отказываемся.
   */
  private decideBuy(player: Player, cell: Cell | undefined): BotDecision {
    if (!cell || cell.ownerId || cell.price === undefined) return "END_TURN";
    if (player.money >= cell.price + 200) return "BUY";
    return "END_TURN";
  }

  /**
   * Стратегия строительства:
   *  1. Если есть полная монополия и деньги — строим дом.
   *  2. Иначе пробуем раскредитовать (unmortgage) заложенное в монополии.
   *  3. Иначе END_TURN.
   */
  private decideBuild(player: Player, state: GameState): BotDecision {
    const houseId = this.findBuildHouseTarget(player, state);
    if (houseId !== null) return { kind: "BUILD_HOUSE", cellId: houseId };
    const unmortgageId = this.findUnmortgageTarget(player, state);
    if (unmortgageId !== null) return { kind: "UNMORTGAGE", cellId: unmortgageId };
    return "END_TURN";
  }

  /**
   * Возвращает cellId для постройки дома или null, если строить нечего.
   */
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

  /**
   * Возвращает cellId для раскредитования или null.
   */
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
   * Иначе — пас.
   */
  private decideAuctionBid(player: Player, state: GameState): BotDecision {
    const auction = state.auction;
    if (!auction) return "AUCTION_PASS";

    const cell = state.board[auction.cellId];
    if (!cell) return "AUCTION_PASS";

    if (auction.highestBidderId === player.id) return "AUCTION_PASS";

    const minIncrement = Math.max(10, Math.floor((cell.price ?? 0) * 0.05));
    const nextBid = (auction.currentBid ?? 0) + minIncrement;

    const maxBid = Math.floor((cell.price ?? 0) * 0.8);
    if (nextBid > maxBid) return "AUCTION_PASS";
    if (player.money < nextBid + 100) return "AUCTION_PASS";

    if (this.auctionWorthBidding(player, cell, nextBid, state)) {
      return "AUCTION_BID";
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
   * Трейд: простая эвристика — оцениваем стоимость того, что получаем
   * (деньги считаем 1:1, клетки — по `price`), и сравниваем с тем, что
   * отдаём. Если получаем ≥ 90% — ACCEPT, иначе REJECT.
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

    const { value, cost } = this.evaluateTradeOffer(player, offer, isInitiator);
    if (value >= cost * 0.9) return "TRADE_ACCEPT";
    return "TRADE_REJECT";
  }

  private evaluateTradeOffer(
    player: Player,
    offer: TradeOffer,
    isInitiator: boolean,
  ): { value: number; cost: number } {
    const priceOf = (id: number): number => {
      const c = BOARD[id];
      return c?.price ?? 0;
    };

    const counterpartGives = isInitiator ? offer.toProperties : offer.fromProperties;
    const counterpartCash = isInitiator ? offer.toCash : offer.fromCash;
    const playerGives = isInitiator ? offer.fromProperties : offer.toProperties;
    const playerCash = isInitiator ? offer.fromCash : offer.toCash;

    const value = counterpartGives.reduce((s, id) => s + priceOf(id), 0) + counterpartCash;
    const cost = playerGives.reduce((s, id) => s + priceOf(id), 0) + playerCash;
    return { value, cost };
  }

  /**
   * Банкротство: бот пробует расплатиться, продавая дома и закладывая
   * имущество. Если и этого мало — объявляет банкротство.
   */
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
