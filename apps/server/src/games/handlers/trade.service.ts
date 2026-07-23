import { Injectable, Logger } from "@nestjs/common";
import type { Cell, GameState, Player, TradeOffer } from "@monopoly/shared";

/**
 * TradeService — сервис обмена собственностью, деньгами и карточками
 * выхода из тюрьмы между игроками.
 *
 * Состояние торговли хранится в `state.trade`:
 *  - `initiatorId`   — кто начал торги;
 *  - `recipientId`   — с кем торгуются;
 *  - `currentPartyId`— кто сейчас должен ответить;
 *  - `offer`         — текущее активное предложение;
 *  - `counterCount`  — сколько counter-offer'ов уже было.
 *
 * Правила (house rules v2):
 *  1. Торговля доступна в фазе `BUILDING`.
 *  2. Counter-offer ограничен `settings.tradingMaxCounterOffers` (по умолчанию 3).
 *  3. При `TRADE_ACCEPT` — активы меняются местами (атомарно, с учётом
 *     автоматического погашения долга получателя).
 *  4. При `TRADE_REJECT` или `TRADE_CANCEL` — торги завершаются без обмена.
 *  5. В оффер можно включать ТОЛЬКО клетки без зданий (`houses === 0`).
 *     Заложенные клетки передавать МОЖНО — получатель принимает их со
 *     статусом `isMortgaged = true`.
 *  6. Карточки выхода из тюрьмы передаются как количество (`jailCards`).
 *  7. Блокировка: если `recipient.blockedPlayers.includes(initiator.id)` —
 *     сервер отклоняет `TRADE_OFFER` с ошибкой «Торговля заблокирована».
 *  8. Пустые сделки (всё по нулям) недопустимы.
 */
@Injectable()
export class TradeService {
  private readonly logger = new Logger(TradeService.name);

  /**
   * Инициализировать новую торговлю.
   *
   * Серверная валидация:
   *  - recipient существует, не банкрот;
   *  - initiator ≠ recipient;
   *  - получатель НЕ заблокировал инициатора;
   *  - клетки `fromProperties` принадлежат инициатору;
   *  - клетки `toProperties` принадлежат получателю;
   *  - ни одна из клеток не имеет зданий (`houses === 0`);
   *  - денег и карточек тюрьмы инициатора достаточно;
   *  - оффер не пустой (хотя бы один актив > 0).
   *
   * После валидации `state.trade` инициализируется и UI обеих сторон
   * переходит в `TRADING_NEGOTIATE`.
   *
   * @param preTradePhase Фаза, в которой находилась партия ДО начала торговли.
   *   Сохраняется в `state.trade.preTradePhase`, чтобы после accept/reject/cancel
   *   корректно восстановить фазу (например, ROLLING → после торговли снова ROLLING,
   *   чтобы игрок мог бросить кубики).
   */
  startTrade(
    state: GameState,
    initiator: Player,
    recipientId: string,
    offer: TradeOffer,
    preTradePhase?: GameState["phase"],
  ): void {
    const recipient = state.players.find((p) => p.id === recipientId);
    if (!recipient) {
      throw new Error("Получатель не найден");
    }
    if (recipient.isBankrupt) {
      throw new Error("Нельзя торговать с обанкротившимся игроком");
    }
    if (initiator.id === recipientId) {
      throw new Error("Нельзя торговать с самим собой");
    }
    if (recipient.blockedPlayers?.includes(initiator.id)) {
      throw new Error("Торговля с этим игроком заблокирована");
    }

    this.validateOfferAssets(state, initiator, recipient, offer);

    state.trade = {
      initiatorId: initiator.id,
      recipientId,
      currentPartyId: recipientId,
      offer,
      counterCount: 0,
      preTradePhase,
    };

    this.logger.log(
      `[TradeService] trade started: ${initiator.displayName} → ${recipient.displayName} (prePhase=${preTradePhase ?? "?"})`,
    );
  }

  /**
   * Валидация оффера: клетки, деньги, карточки тюрьмы.
   * Бросает Error с человеко-читаемым сообщением при нарушении.
   */
  private validateOfferAssets(
    state: GameState,
    initiator: Player,
    recipient: Player,
    offer: TradeOffer,
  ): void {
    if (
      offer.fromProperties.length === 0 &&
      offer.toProperties.length === 0 &&
      offer.fromCash <= 0 &&
      offer.toCash <= 0 &&
      offer.fromJailCards <= 0 &&
      offer.toJailCards <= 0
    ) {
      throw new Error("Сделка не может быть пустой");
    }

    // Клетки инициатора: принадлежат ему + не имеют зданий.
    for (const cellId of offer.fromProperties) {
      const cell = state.board[cellId];
      if (!cell) {
        throw new Error(`Клетка ${cellId} не найдена на доске`);
      }
      if (!initiator.properties.includes(cellId)) {
        throw new Error(`Клетка ${cellId} не принадлежит инициатору`);
      }
      if (cell.houses > 0) {
        throw new Error(
          `Нельзя передать «${cell.name}»: на ней ${cell.houses === 5 ? "отель" : `${cell.houses} дом.`}. Сначала продайте здания банку`,
        );
      }
    }
    // Клетки получателя: принадлежат ему + не имеют зданий.
    for (const cellId of offer.toProperties) {
      const cell = state.board[cellId];
      if (!cell) {
        throw new Error(`Клетка ${cellId} не найдена на доске`);
      }
      if (!recipient.properties.includes(cellId)) {
        throw new Error(`Клетка ${cellId} не принадлежит получателю`);
      }
      if (cell.houses > 0) {
        throw new Error(
          `Нельзя запросить «${cell.name}»: на ней ${cell.houses === 5 ? "отель" : `${cell.houses} дом.`}`,
        );
      }
    }
    if (offer.fromCash < 0 || offer.toCash < 0) {
      throw new Error("Суммы денег не могут быть отрицательными");
    }
    if (offer.fromJailCards < 0 || offer.toJailCards < 0) {
      throw new Error("Количество карточек не может быть отрицательным");
    }
    if (offer.fromCash > 0 && initiator.money < offer.fromCash) {
      throw new Error("Недостаточно денег у инициатора");
    }
    if (offer.fromJailCards > 0 && initiator.jailCards < offer.fromJailCards) {
      throw new Error("У инициатора нет столько карточек выхода");
    }
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
    const newRecipient = state.players.find((p) => p.id === newRecipientId);
    if (!newInitiator || !newRecipient) return;

    // Валидация относительно новых сторон.
    this.validateOfferAssets(state, newInitiator, newRecipient, newOffer);

    // ВАЖНО: сохраняем preTradePhase из предыдущего state.trade,
    // иначе после reject/cancel/accept сервер не сможет корректно
    // восстановить фазу (например, ROLLING → counter → reject → должен быть ROLLING,
    // чтобы игрок мог бросить кубики).
    state.trade = {
      initiatorId: newInitiatorId,
      recipientId: newRecipientId,
      currentPartyId: newRecipientId,
      offer: newOffer,
      counterCount: state.trade.counterCount + 1,
      preTradePhase: state.trade.preTradePhase,
    };

    this.logger.log(
      `[TradeService] counter-offer #${state.trade.counterCount} from ${newInitiator.displayName} (prePhase=${state.trade.preTradePhase ?? "?"})`,
    );
  }

  /**
   * Единый шлюз для зачисления денег игроку с АВТОМАТИЧЕСКИМ
   * погашением текущего долга (house rule).
   *
   * Логика:
   *  1) Начисляем деньги на `cash`.
   *  2) Если `currentDebt > 0`, списываем минимум(`cash`, `debt`):
   *     - эту сумму получатель НЕ забирает — она идёт кредитору;
   *     - `cash -= debtPayment`; `currentDebt -= debtPayment`.
   *  3) Возвращаем `{ cashAdded, debtCovered }` для логов/UI.
   */
  static addCashToPlayer(player: Player, amount: number): { debtCovered: number } {
    if (amount <= 0) return { debtCovered: 0 };
    let debtCovered = 0;
    // Деньги в первую очередь идут на погашение долга (если он есть).
    if (player.currentDebt && player.currentDebt > 0) {
      debtCovered = Math.min(amount, player.currentDebt);
      player.currentDebt -= debtCovered;
      if (player.currentDebt === 0) {
        player.creditorId = null;
      }
    }
    player.money += amount - debtCovered;
    return { debtCovered };
  }

  /**
   * Выполнить обмен: передать клетки, деньги и карточки тюрьмы
   * между сторонами с атомарной логикой погашения долга.
   *
   * ПОРЯДОК ВАЖЕН: сначала списываем с отправителя (инициатор платит
   * fromCash, отдаёт fromJailCards), потом зачисляем получателю (через
   * `addCashToPlayer` для авто-погашения его долга).
   */
  executeTrade(
    state: GameState,
  ): { initiatorId: string; recipientId: string; totalDebtCovered: number } | null {
    if (!state.trade) return null;
    const { initiatorId, recipientId, offer } = state.trade;
    const initiator = state.players.find((p) => p.id === initiatorId);
    const recipient = state.players.find((p) => p.id === recipientId);
    if (!initiator || !recipient) return null;

    // 1) Клетки: initiator → recipient.
    for (const cellId of offer.fromProperties) {
      const cell = state.board[cellId];
      if (!cell) continue;
      cell.ownerId = recipient.id;
      recipient.properties.push(cellId);
      const idx = initiator.properties.indexOf(cellId);
      if (idx >= 0) initiator.properties.splice(idx, 1);
    }
    // 2) Клетки: recipient → initiator.
    for (const cellId of offer.toProperties) {
      const cell = state.board[cellId];
      if (!cell) continue;
      cell.ownerId = initiator.id;
      initiator.properties.push(cellId);
      const idx = recipient.properties.indexOf(cellId);
      if (idx >= 0) recipient.properties.splice(idx, 1);
    }

    // 3) Деньги: initiator отдаёт fromCash, recipient отдаёт toCash.
    //    Обе стороны получают деньги через addCashToPlayer для авто-погашения долга.
    if (offer.fromCash > 0) {
      initiator.money -= offer.fromCash;
    }
    if (offer.toCash > 0) {
      recipient.money -= offer.toCash;
    }
    // 4) Инициатор получает toCash (для авто-погашения своего долга).
    if (offer.toCash > 0) {
      TradeService.addCashToPlayer(initiator, offer.toCash);
    }
    // 5) Получатель получает fromCash (для авто-погашения своего долга).
    if (offer.fromCash > 0) {
      TradeService.addCashToPlayer(recipient, offer.fromCash);
    }

    // 6) Карточки выхода: initiator отдаёт fromJailCards,
    //    recipient получает toJailCards.
    if (offer.fromJailCards > 0) {
      initiator.jailCards -= offer.fromJailCards;
      recipient.jailCards += offer.fromJailCards;
    }
    if (offer.toJailCards > 0) {
      recipient.jailCards -= offer.toJailCards;
      initiator.jailCards += offer.toJailCards;
    }

    this.logger.log(
      `[TradeService] trade executed: ${initiator.displayName} ↔ ${recipient.displayName} (props: ${offer.fromProperties.length}+${offer.toProperties.length}, cash: ${offer.fromCash}+${offer.toCash}, jailCards: ${offer.fromJailCards}+${offer.toJailCards})`,
    );
    return { initiatorId, recipientId, totalDebtCovered: 0 };
  }

  /**
   * Переключить блокировку торговли с конкретным игроком.
   * Если target уже в `blocked_players` — он удаляется, иначе добавляется.
   * Возвращает новое состояние (`true` = заблокирован, `false` = разблокирован).
   */
  toggleBlock(state: GameState, player: Player, targetId: string): boolean {
    if (player.id === targetId) {
      throw new Error("Нельзя заблокировать самого себя");
    }
    const target = state.players.find((p) => p.id === targetId);
    if (!target) {
      throw new Error("Игрок не найден");
    }
    if (!player.blockedPlayers) {
      player.blockedPlayers = [];
    }
    const idx = player.blockedPlayers.indexOf(targetId);
    if (idx >= 0) {
      player.blockedPlayers.splice(idx, 1);
      return false;
    }
    player.blockedPlayers.push(targetId);
    return true;
  }

  /**
   * Хелпер: вернуть список ID клеток, которые `player` МОЖЕТ предложить
   * для торговли (без зданий). Используется ботом и UI.
   */
  getTradableProperties(player: Player, state: GameState): number[] {
    return state.board.filter((c) => c.ownerId === player.id && c.houses === 0).map((c) => c.id);
  }
}
