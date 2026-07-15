import { Injectable, Logger } from "@nestjs/common";
import type { GameState, Player } from "@monopoly/shared";

/**
 * AuctionService — сервис аукциона.
 *
 * Аукцион запускается в `BUY_DECISION` фазе после `DECLINE_BUY`
 * (если `settings.auctionEnabled = true`).
 *
 * Состояние аукциона хранится в `state.auction`:
 *  - `cellId` — какая клетка продаётся;
 *  - `currentBid` — текущая максимальная ставка;
 *  - `highestBidderId` — лидер;
 *  - `bidderOrder` — порядок участников (начиная со следующего после инициатора);
 *  - `currentBidderIndex` — индекс текущего участника;
 *  - `activeBidders` — активные (не выбывшие) участники;
 *  - `bidDeadline` — ISO-время, когда текущий участник должен сделать ставку.
 *
 * Правила:
 *  1. В аукционе участвуют ВСЕ активные (не банкроты) игроки, КРОМЕ инициатора.
 *  2. Минимальная ставка = `currentBid + 1` (или 1, если bid ещё не было).
 *  3. Игрок, у которого недостаточно денег для минимальной ставки, считается
 *     автоматически выбывшим.
 *  4. Аукцион завершается, когда:
 *     - остался один активный участник (он побеждает с текущей ставкой);
 *     - все выбыли (клетка остаётся у Банка).
 */
@Injectable()
export class AuctionService {
  private readonly logger = new Logger(AuctionService.name);

  /**
   * Инициализировать новый аукцион.
   *
   * @param state состояние партии
   * @param cell клетка, которая продаётся
   * @param initiator игрок, отказавшийся от покупки
   */
  startAuction(state: GameState, cell: { id: number }, initiator: Player): void {
    const alive = state.players.filter((p) => !p.isBankrupt && p.id !== initiator.id);
    if (alive.length === 0) {
      // Никто не может участвовать — клетка остаётся у Банка.
      this.logger.debug(`[AuctionService] no participants for cell ${cell.id}`);
      return;
    }

    const ms = state.settings.auctionBidTimeoutMs ?? 15000;
    const deadline = new Date(Date.now() + ms).toISOString();

    state.auction = {
      cellId: cell.id,
      currentBid: 0,
      highestBidderId: null,
      bidderOrder: alive.map((p) => p.id),
      currentBidderIndex: 0,
      activeBidders: alive.map((p) => p.id),
      bidDeadline: deadline,
    };

    this.logger.log(
      `[AuctionService] auction started for cell ${cell.id} with ${alive.length} bidders`,
    );
  }

  /**
   * Завершить аукцион: передать клетку победителю.
   * Если победителя нет (все выбыли) — клетка остаётся у Банка.
   */
  resolveAuction(state: GameState): void {
    if (!state.auction) return;
    const { cellId, currentBid, highestBidderId, activeBidders } = state.auction;

    if (!highestBidderId || activeBidders.length === 0) {
      this.logger.log(`[AuctionService] auction for cell ${cellId} ended with no winner`);
      return;
    }

    const cell = state.board[cellId];
    const winner = state.players.find((p) => p.id === highestBidderId);
    if (!cell || !winner) return;

    // Списываем деньги победителю.
    winner.money = Math.max(0, winner.money - currentBid);
    winner.properties.push(cell.id);
    cell.ownerId = winner.id;

    this.logger.log(
      `[AuctionService] cell ${cellId} sold to ${winner.displayName} for ${currentBid}`,
    );
  }

  /**
   * Проверить, может ли текущий участник сделать минимальную ставку.
   * Если нет — автоматически выбывает.
   */
  isCurrentBidderAffordable(state: GameState): boolean {
    if (!state.auction) return false;
    const bidder = state.players[state.auction.currentBidderIndex];
    if (!bidder) return false;
    return bidder.money >= state.auction.currentBid + 1;
  }
}
