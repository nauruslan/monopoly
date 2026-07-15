import { Injectable, Logger } from "@nestjs/common";
import type { GameState, Player, TradeOffer } from "@monopoly/shared";

/**
 * TradeService — сервис обмена собственностью и деньгами между игроками.
 *
 * Состояние торговли хранится в `state.trade` :
 *  - `initiatorId` — кто начал торги;
 *  - `recipientId` — с кем торгуются;
 *  - `currentPartyId` — кто сейчас должен ответить;
 *  - `offer` — текущее активное предложение;
 *  - `counterCount` — сколько counter-offer'ов уже было.
 *
 * Правила:
 *  1. Торговля доступна в фазе `BUILDING` (POST_TURN_ACTIONS).
 *  2. Counter-offer ограничен `settings.tradingMaxCounterOffers` (по умолчанию 3).
 *  3. При `TRADE_ACCEPT` — активы меняются местами.
 *  4. При `TRADE_REJECT` или `TRADE_CANCEL` — торги завершаются без обмена.
 *
 * ВАЖНО: торги — interrupt-фаза. Они приостанавливают обычный ход.
 * После завершения (любой исход) — игрок возвращается в BUILDING.
 */
@Injectable()
export class TradeService {
  private readonly logger = new Logger(TradeService.name);

  /**
   * Инициализировать новую торговлю.
   */
  startTrade(state: GameState, initiator: Player, recipientId: string, offer: TradeOffer): void {
    const recipient = state.players.find((p) => p.id === recipientId);
    if (!recipient) {
      throw new Error(`Recipient ${recipientId} not found`);
    }
    if (recipient.isBankrupt) {
      throw new Error("Нельзя торговать с обанкротившимся игроком");
    }
    if (initiator.id === recipientId) {
      throw new Error("Нельзя торговать с самим собой");
    }

    // Валидация: initiator должен владеть всеми клетками в fromProperties.
    for (const cellId of offer.fromProperties) {
      if (!initiator.properties.includes(cellId)) {
        throw new Error(`Клетка ${cellId} не принадлежит инициатору`);
      }
    }
    for (const cellId of offer.toProperties) {
      if (!recipient.properties.includes(cellId)) {
        throw new Error(`Клетка ${cellId} не принадлежит получателю`);
      }
    }
    // Деньги: проверяем, что инициатор может заплатить fromCash (если > 0).
    if (offer.fromCash > 0 && initiator.money < offer.fromCash) {
      throw new Error("Недостаточно денег у инициатора");
    }

    state.trade = {
      initiatorId: initiator.id,
      recipientId,
      currentPartyId: recipientId,
      offer,
      counterCount: 0,
    };

    this.logger.log(
      `[TradeService] trade started: ${initiator.displayName} → ${recipient.displayName}`,
    );
  }

  /**
   * Сделать встречное предложение (counter-offer).
   * Стороны меняются местами: текущий получатель становится инициатором.
   */
  makeCounterOffer(state: GameState, newOffer: TradeOffer): void {
    if (!state.trade) return;
    const { initiatorId, recipientId, currentPartyId } = state.trade;

    // Меняем стороны: тот, кто отвечал, теперь предлагает.
    const newInitiatorId = currentPartyId;
    const newRecipientId = currentPartyId === initiatorId ? recipientId : initiatorId;

    const newInitiator = state.players.find((p) => p.id === newInitiatorId);
    if (!newInitiator) return;

    state.trade = {
      initiatorId: newInitiatorId,
      recipientId: newRecipientId,
      currentPartyId: newRecipientId,
      offer: newOffer,
      counterCount: state.trade.counterCount + 1,
    };

    this.logger.log(
      `[TradeService] counter-offer #${state.trade.counterCount} from ${newInitiator.displayName}`,
    );
  }

  /**
   * Выполнить обмен: передать клетки и деньги.
   */
  executeTrade(state: GameState): void {
    if (!state.trade) return;
    const { initiatorId, recipientId, offer } = state.trade;
    const initiator = state.players.find((p) => p.id === initiatorId);
    const recipient = state.players.find((p) => p.id === recipientId);
    if (!initiator || !recipient) return;

    // Передаём клетки: initiator → recipient.
    for (const cellId of offer.fromProperties) {
      const cell = state.board[cellId];
      if (!cell) continue;
      cell.ownerId = recipient.id;
      recipient.properties.push(cellId);
      const idx = initiator.properties.indexOf(cellId);
      if (idx >= 0) initiator.properties.splice(idx, 1);
    }

    // Передаём клетки: recipient → initiator.
    for (const cellId of offer.toProperties) {
      const cell = state.board[cellId];
      if (!cell) continue;
      cell.ownerId = initiator.id;
      initiator.properties.push(cellId);
      const idx = recipient.properties.indexOf(cellId);
      if (idx >= 0) recipient.properties.splice(idx, 1);
    }

    // Деньги: initiator платит fromCash, получает toCash.
    initiator.money -= offer.fromCash;
    initiator.money += offer.toCash;
    recipient.money -= offer.toCash;
    recipient.money += offer.fromCash;

    this.logger.log(
      `[TradeService] trade executed: ${initiator.displayName} ↔ ${recipient.displayName}`,
    );
  }
}
