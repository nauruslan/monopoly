import { Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "crypto";
import type { GameEvent, GameEventKind, GameState, Player } from "@monopoly/shared";

/**
 * Параметры для формирования события журнала.
 * `LogService` инкапсулирует в себе генерацию uuid, ISO-времени и
 * заполнение дефолтных полей, чтобы вызывающий код (GamesService и
 * другие обработчики) не дублировал эту логику.
 */
export interface LogEventInput {
  kind: GameEventKind;
  /** Кто инициировал событие. Можно опустить (например, для GAME_STARTED). */
  player?: Player | null;
  /** Текст для UI на русском. Может содержать эмодзи. */
  message: string;
  /**
   * Класс подсветки для UI:
   *  "" (по умолчанию) | "move" | "rent" | "chance" | "win" | "buy"
   *  | "auction" | "pass" | "trade" | "tax" | "jail" | "system"
   */
  type?: string;
  /** Доп. данные для UI (например, dice, card, amount, cellId). */
  payload?: GameEvent["payload"];
}

/**
 * Контекст для операций распродажи имущества (BANKRUPTCY_LIQUIDATE).
 * Флаги используются для пометки событий в журнале словом "(распродажа)".
 */
export type OperationContext = "normal" | "liquidation";

/**
 * LogService — централизованный сервис журналирования игровых событий.
 *
 * Назначение:
 *  - Генерирует события в едином формате (`GameEvent` со всеми полями);
 *  - Содержит «справочник» типов событий и человеко-читаемых
 *    сообщений, чтобы UI-текст был консистентным во всей игре;
 *  - Хранит ПОЛНУЮ историю событий в `state.events` (без удаления),
 *    чтобы игроки могли видеть весь ход партии в боковом журнале.
 *
 * ВАЖНО: этот сервис НЕ отправляет события клиентам напрямую.
 * Он возвращает готовый объект `GameEvent`, который GamesService
 * кладёт в `state.events` (для snapshot) и/или эмитит через
 * `onStateChanged` → GameGateway (для broadcast).
 *
 * Это гарантирует, что:
 *  - UI-журнал «LogPanel» получает ВСЕ события партии;
 *  - тексты событий единообразны (раньше каждое место формировало
 *    свой `makeEvent` в GamesService, и они расходились стилистически);
 *  - при reconnect новый клиент получает полную историю из
 *    `state.events`, а не только последние N событий broadcast'а.
 */
@Injectable()
export class LogService {
  private readonly logger = new Logger(LogService.name);

  /**
   * Создать новое событие журнала.
   *
   * Возвращает полностью сформированный `GameEvent` с uuid и
   * текущим ISO-временем. Если передан `state`, событие также
   * добавляется в `state.events`.
   *
   * ВАЖНО: начиная с этой версии журнал хранит ВСЕ события партии —
   * никакой кольцевой обрезки не делается. пользователь должен
   * видеть полную историю за игру, а не последние N событий. Это
   * возможно потому, что:
   *  - на клиенте список журнала виртуализирован (рендерим только
   *    видимые элементы);
   *  - в снапшоте `state.events[]` сохраняется полностью — `state.json`
   *    сериализуется один раз при сохранении, и лишний размер массива
   *    не критичен.
   */
  create(state: GameState | null, input: LogEventInput): GameEvent {
    const ev: GameEvent = {
      id: randomUUID(),
      at: new Date().toISOString(),
      kind: input.kind,
      ...(input.player?.id ? { playerId: input.player.id } : {}),
      message: input.message,
      type: input.type ?? this.defaultTypeForKind(input.kind),
      ...(input.payload ? { payload: input.payload } : {}),
    };

    if (state) {
      if (!Array.isArray(state.events)) state.events = [];
      // Храним ВСЕ события партии без удаления.
      state.events.push(ev);
    }

    return ev;
  }

  /**
   * Удобный алиас: создать событие и НЕ класть его в state.events.
   * Используется, когда событие уже было записано раньше (например,
   * при restore), и нужно просто его «перебросить» через broadcast.
   */
  createWithoutState(input: LogEventInput): GameEvent {
    return this.create(null, input);
  }

  /**
   * Положить уже сформированный `GameEvent` в `state.events` (без
   * пересоздания id/at). Используется в `applyAction`, когда событие
   * уже сконструировано через `makeEvent` и нужно сохранить его в
   * `state.events` для восстановления истории при reconnect.
   *
   * Никакой обрезки не делаем — события хранятся все.
   */
  pushToState(state: GameState, event: GameEvent): void {
    if (!Array.isArray(state.events)) state.events = [];
    state.events.push(event);
  }

  /**
   * Дефолтный CSS-класс подсветки в журнале по типу события.
   * Используется, если вызывающий код не указал `type` явно.
   */
  private defaultTypeForKind(kind: GameEventKind): string {
    switch (kind) {
      case "DICE_ROLLED":
      case "TURN_START":
      case "GO_SALARY_PAID":
        return "move";
      case "RENT_PAID":
        return "rent";
      case "TAX_PAID":
        return "tax";
      case "CARD_DRAWN":
        return "chance";
      case "GAME_OVER":
        return "win";
      case "PROPERTY_BOUGHT":
      case "HOUSE_BUILT":
      case "HOUSE_SOLD":
        return "buy";
      case "PROPERTY_MORTGAGED":
      case "PROPERTY_UNMORTGAGED":
        return "buy";
      case "AUCTION_STARTED":
      case "AUCTION_BID":
      case "AUCTION_WON":
        return "auction";
      case "AUCTION_PASS":
      case "AUCTION_UNSOLD":
        return "pass";
      case "TRADE_STARTED":
      case "TRADE_COUNTER":
      case "TRADE_COMPLETED":
      case "TRADE_REJECTED":
      case "TRADE_CANCELLED":
        return "trade";
      case "JAIL_ENTERED":
      case "JAIL_ESCAPED":
      case "JAIL_TRY_DOUBLE":
        return "jail";
      case "GAME_STARTED":
      case "PROPERTY_DECLINED":
      case "BUILDING_PHASE_OPENED":
      case "BANKRUPTCY_LIQUIDATION":
      case "BANKRUPTCY_DECLARED":
      default:
        return "system";
    }
  }

  // СПРАВОЧНИК ТИПОВЫХ СООБЩЕНИЙ
  //
  // Чтобы тексты в журнале были консистентны между разными местами
  // формирования (dispatch, обработчики ботов, аукцион, торговля и
  // т.д.), все они идут через эти хелперы. Если нужно изменить
  // формулировку — меняем здесь один раз, и все события обновятся.

  logGameStarted(state: GameState, playerNames: string[]): GameEvent {
    return this.create(state, {
      kind: "GAME_STARTED",
      message: `🎮 Игра началась! Участники: ${playerNames.join(", ")}`,
      type: "system",
    });
  }

  logGameOver(state: GameState, winner: Player | null): GameEvent {
    const name = winner?.displayName ?? "?";
    return this.create(state, {
      kind: "GAME_OVER",
      player: winner,
      message: `🏆 Победил ${name}! Поздравляем!`,
      type: "win",
      payload: winner ? { cellId: -1, buildAmount: 0, isHotel: false } : undefined,
    });
  }

  logTurnStart(state: GameState, player: Player, round: number): GameEvent {
    return this.create(state, {
      kind: "TURN_START",
      player,
      message: `➡️ ${player.displayName} — твой ход!`,
      type: "move",
    });
  }

  logDiceRolled(
    state: GameState,
    player: Player,
    dice: [number, number],
    isDouble: boolean,
  ): GameEvent {
    const total = dice[0] + dice[1];
    const doubleNote = isDouble ? " (дубль!)" : "";
    return this.create(state, {
      kind: "DICE_ROLLED",
      player,
      message: `🎲 ${player.displayName} бросил кубики → ${dice[0]}+${dice[1]}=${total}${doubleNote}`,
      type: "move",
      payload: { dice, amount: total },
    });
  }

  logPropertyBought(state: GameState, player: Player, cellName: string, price: number): GameEvent {
    return this.create(state, {
      kind: "PROPERTY_BOUGHT",
      player,
      message: `🏠 ${player.displayName} купил(а) «${cellName}» за $${price}`,
      type: "buy",
      payload: { cellId: -1, amount: price },
    });
  }

  logPropertyDeclined(state: GameState, player: Player, cellName: string): GameEvent {
    return this.create(state, {
      kind: "PROPERTY_DECLINED",
      player,
      message: `❌ ${player.displayName} отказался(лась) от покупки «${cellName}»`,
      type: "system",
    });
  }

  /**
   * Оплата ренты. Используется и для обычной ренты, и для ренты во
   * время банкротства (если нужно — можно пометить `liquidation: true`
   * через дополнительные аргументы payload).
   */
  logRentPaid(
    state: GameState,
    payer: Player,
    owner: Player,
    cellName: string,
    amount: number,
  ): GameEvent {
    return this.create(state, {
      kind: "RENT_PAID",
      player: payer,
      message: `💸 ${payer.displayName} заплатил ${amount}₽ аренды игроку ${owner.displayName} за «${cellName}»`,
      type: "rent",
      payload: { cellId: -1, amount },
    });
  }

  /**
   * Оплата Подоходного налога (id=4, сумма фиксированная).
   * «Игрок заплатил подоходный налог 200₽».
   */
  logIncomeTaxPaid(state: GameState, player: Player, amount: number): GameEvent {
    return this.create(state, {
      kind: "TAX_PAID",
      player,
      message: `💰 ${player.displayName} заплатил(а) подоходный налог $${amount}`,
      type: "tax",
      payload: { cellId: 4, amount },
    });
  }

  /**
   * Оплата Роскошного налога (id=38) — формула по участкам/домам/отелям.
   * «Игрок заплатил Роскошный налог — сумма».
   */
  logLuxuryTaxPaid(
    state: GameState,
    player: Player,
    amount: number,
    houses: number,
    hotels: number,
    properties: number,
  ): GameEvent {
    const breakdown = `(${properties} уч. + ${houses} дом. + ${hotels} отелей)`;
    return this.create(state, {
      kind: "TAX_PAID",
      player,
      message: `💎 ${player.displayName} заплатил(а) Роскошный налог $${amount} ${breakdown}`,
      type: "tax",
      payload: { cellId: 38, amount },
    });
  }

  /**
   * Вытянутая карточка из колоды Шанс / Казна / Роскошный налог.
   * в журнале должно быть видно, КАКАЯ карточка вытянута.
   */
  logCardDrawn(
    state: GameState,
    player: Player,
    deck: "chance" | "treasury" | "luxury-tax",
    cardText: string,
  ): GameEvent {
    const deckLabel =
      deck === "chance" ? "Шанс" : deck === "treasury" ? "Общ. казна" : "Роскошный налог";
    return this.create(state, {
      kind: "CARD_DRAWN",
      player,
      message: `🃏 ${player.displayName} вытянул(а) карту «${deckLabel}»: ${cardText}`,
      type: "chance",
    });
  }

  /**
   * Универсальное сообщение о попадании в тюрьму.
   * Конкретная причина (клетка / карточка / 3-й дубль) намеренно
   * не указывается — читатель узнает её из предыдущих событий
   * (вытянутая карточка, серия дублей и т.п.).
   *
   * Параметр `reason` сохранён для payload и для возможных будущих
   * фильтров в UI.
   */
  logJailEntered(
    state: GameState,
    player: Player,
    reason: "cell" | "card" | "double" | "other",
  ): GameEvent {
    return this.create(state, {
      kind: "JAIL_ENTERED",
      player,
      message: `⛓️ ${player.displayName} попал в тюрьму`,
      type: "jail",
      payload: { reason },
    });
  }

  /**
   * Журнал: игрок выкинул три дубля подряд и попал в тюрьму.
   *
   * Текст ОТЛИЧАЕТСЯ от обычного «попал в тюрьму» (см. `logJailEntered`):
   * здесь явно указывается ПРИЧИНА ареста — правило трёх дублей
   * (специальное правило Монополии). Это помогает игрокам
   * восстановить логику события при чтении журнала.
   *
   * Вызывается ПЕРЕД показом информационного модального окна
   * «Вы арестованы!» (`JAIL_NOTICE`), чтобы запись в журнале
   * появилась одновременно с появлением окна.
   */
  logJailEnteredByTriples(state: GameState, player: Player): GameEvent {
    return this.create(state, {
      kind: "JAIL_ENTERED",
      player,
      message: `⛓️ ${player.displayName} выкинул три дубля подряд и попал в тюрьму`,
      type: "jail",
      payload: { reason: "double" },
    });
  }

  /**
   * Журнал: игрок пытается выбросить дубль, чтобы выйти из тюрьмы.
   * Зовётся при обработке TRY_DOUBLE (ДО броска кубиков).
   */
  logJailTryDouble(
    state: GameState,
    player: Player,
    attempt: number,
    attemptMax: number,
  ): GameEvent {
    return this.create(state, {
      kind: "JAIL_TRY_DOUBLE",
      player,
      message: `🎲 ${player.displayName} пытается бросить дубль для выхода из тюрьмы (попытка ${attempt} из ${attemptMax})`,
      type: "jail",
      payload: { attempt },
    });
  }

  /**
   * Универсальное сообщение о выходе из тюрьмы.
   * Используется единый текст «Игрок вышел из тюрьмы», способ выхода
   * (оплата / карточка / бросок дубля) передаётся в скобках.
   *
   * Благодаря единому тексту журнал при 3-й неудачной попытке НЕ
   * получает двух сообщений подряд — сперва tryDouble, потом
   * единственный лог оплаты штрафа.
   *
   * `method`:
   *  - "pay"    — игрок заплатил 50₽ штрафа;
   *  - "card"   — игрок использовал карточку «Выход бесплатно»;
   *  - "double" — игрок выбросил дубль (вышел бесплатно).
   */
  logJailEscaped(state: GameState, player: Player, method: "double" | "card" | "pay"): GameEvent {
    const reasonText =
      method === "pay" ? "заплатил штраф" : method === "card" ? "карта выхода" : "бросок дубля";
    return this.create(state, {
      kind: "JAIL_ESCAPED",
      player,
      message: `🚪 ${player.displayName} вышел из тюрьмы (${reasonText})`,
      type: "jail",
      payload: { reason: method },
    });
  }

  /**
   * Примечание: отдельный лог «Игрок покрыл долг перед банком/игроком»
   * в журнал НЕ пишется — он избыточен: читатель сам видит, что после
   * серии «заложил»/«продал» баланс игрока стал неотрицательным.
   * Если в будущем понадобится явно подсветить этот момент — лучше
   * делать это в state.events (отдельным флагом), а не журналом.
   */

  /**
   * Проход через клетку «СТАРТ» (GO) — фишка пересекла клетку 0
   * (wrap по полю). Игрок получает 200₽ — фиксированная сумма.
   * Сообщение журнала: «Игрок получил 200₽ за проход через СТАРТ».
   */
  logGoSalaryPassed(state: GameState, player: Player, amount: number): GameEvent {
    return this.create(state, {
      kind: "GO_SALARY_PAID",
      player,
      message: `💰 ${player.displayName} получил(а) $${amount} за проход через СТАРТ`,
      type: "move",
      payload: { cellId: 0, amount, dice: [0, 0] },
    });
  }

  /**
   * Приземление ровно на клетку «СТАРТ» (GO) — фишка остановилась
   * на клетке 0 (после броска, карточки «Идите на СТАРТ» и т.п.).
   * Игрок получает 400₽ (2× goSalary) — повышенная выплата за
   * приземление на СТАРТ.
   * Сообщение журнала: «Игрок получил 400₽ за остановку на СТАРТ».
   */
  logGoSalaryLanded(state: GameState, player: Player, amount: number): GameEvent {
    return this.create(state, {
      kind: "GO_SALARY_PAID",
      player,
      message: `💰 ${player.displayName} получил(а) $${amount} за остановку на СТАРТ`,
      type: "move",
      payload: { cellId: 0, amount, dice: [0, 0] },
    });
  }

  /**
   * Строительство дома/отеля. Поддерживает пометку `liquidation=true`
   * — в этом случае сообщение содержит префикс «(распродажа)».
   */
  logHouseBuilt(
    state: GameState,
    player: Player,
    cellName: string,
    _noun: string,
    buildAmount: number,
    housesAfter: number,
    isHotel: boolean,
    context: OperationContext = "normal",
  ): GameEvent {
    // Универсальное сообщение: «построил дом». Правила Монополии
    // позволяют строить строго по одному дому за ход, поэтому
    // слово «дома» (мн. ч.) тут избыточно — формулировка «построил
    // дом» подходит и для первого дома, и для второго/третьего/четвёртого.
    // Для отеля (5) тоже используется «построил дом» — это сознательно,
    // журнал фиксирует ФАКТ строительства, а не нюанс «отель».
    const prefix = context === "liquidation" ? "🏦 (распродажа) " : "🏗️ ";
    return this.create(state, {
      kind: "HOUSE_BUILT",
      player,
      message: `${prefix}${player.displayName} построил дом на «${cellName}» за $${buildAmount}`,
      type: "buy",
      payload: {
        cellId: -1,
        buildAmount,
        housesAfter,
        isHotel,
        liquidation: context === "liquidation" || undefined,
      },
    });
  }

  /**
   * Продажа дома/отеля. Поддерживает оба режима:
   *  - "normal"      — обычная продажа в фазе BUILDING / BUILDING_PHASE;
   *  - "liquidation" — продажа в фазе BANKRUPTCY_LIQUIDATE
   *                    (формулировка «распродажа»).
   */
  logHouseSold(
    state: GameState,
    player: Player,
    cellName: string,
    noun: string,
    refund: number,
    housesAfter: number,
    isHotel: boolean,
    context: OperationContext = "normal",
  ): GameEvent {
    const prefix = context === "liquidation" ? "🏦 (распродажа) " : "🏠 ";
    return this.create(state, {
      kind: "HOUSE_SOLD",
      player,
      message: `${prefix}${player.displayName} продал(а) ${noun} на «${cellName}» за $${refund}`,
      type: "buy",
      payload: {
        cellId: -1,
        buildAmount: refund,
        housesAfter,
        isHotel,
        liquidation: context === "liquidation" || undefined,
      },
    });
  }

  /**
   * Залог клетки (PROPERTY / RAILROAD / UTILITY).
   * Поддерживает пометку (распродажа).
   */
  logPropertyMortgaged(
    state: GameState,
    player: Player,
    cellName: string,
    mortgageAmount: number,
    context: OperationContext = "normal",
  ): GameEvent {
    const prefix = context === "liquidation" ? "🏦 (распродажа) " : "🏦 ";
    return this.create(state, {
      kind: "PROPERTY_MORTGAGED",
      player,
      message: `${prefix}${player.displayName} заложил(а) «${cellName}» и получил(а) $${mortgageAmount}`,
      type: "buy",
      payload: { cellId: -1, mortgageAmount, liquidation: context === "liquidation" || undefined },
    });
  }

  /**
   * Выкуп клетки из залога (mortgageValue × 1.1).
   */
  logPropertyUnmortgaged(
    state: GameState,
    player: Player,
    cellName: string,
    unmortgageAmount: number,
  ): GameEvent {
    return this.create(state, {
      kind: "PROPERTY_UNMORTGAGED",
      player,
      message: `💰 ${player.displayName} выкупил(а) «${cellName}» за $${unmortgageAmount}`,
      type: "buy",
      payload: { cellId: -1, mortgageAmount: unmortgageAmount },
    });
  }

  /**
   * Продажа клетки Банку за 100% номинала (только в фазе
   * BANKRUPTCY_LIQUIDATE). Использует контекст "liquidation".
   */
  logPropertySoldToBank(
    state: GameState,
    player: Player,
    cellName: string,
    amount: number,
  ): GameEvent {
    return this.create(state, {
      kind: "BANKRUPTCY_LIQUIDATION",
      player,
      message: `🏦 (распродажа) ${player.displayName} продал(а) «${cellName}» банку за $${amount}`,
      type: "system",
      payload: { cellId: -1, amount, liquidation: true },
    });
  }

  // АУКЦИОН

  logAuctionStarted(state: GameState, player: Player, cellId: number, cellName: string): GameEvent {
    return this.create(state, {
      kind: "AUCTION_STARTED",
      player,
      message: `🔨 ${player.displayName} начал(а) аукцион по «${cellName}» (клетка #${cellId})`,
      type: "auction",
      payload: { cellId },
    });
  }

  logAuctionBid(
    state: GameState,
    player: Player,
    cellId: number,
    cellName: string,
    amount: number,
  ): GameEvent {
    return this.create(state, {
      kind: "AUCTION_BID",
      player,
      message: `💰 ${player.displayName} поставил(а) $${amount} за «${cellName}»`,
      type: "auction",
      payload: { cellId, amount },
    });
  }

  logAuctionPass(
    state: GameState,
    player: Player,
    cellId: number,
    cellName: string,
    viaTimeout: boolean,
  ): GameEvent {
    const note = viaTimeout ? " (по таймауту)" : "";
    return this.create(state, {
      kind: "AUCTION_PASS",
      player,
      message: `⏭️ ${player.displayName} спасовал(а) в аукционе по «${cellName}»${note}`,
      type: "pass",
      payload: { cellId, timeout: viaTimeout },
    });
  }

  /**
   * Журнал: аукцион выигран.
   */
  logAuctionWon(state: GameState, winner: Player, cellId: number, finalBid: number): GameEvent {
    const cellName = state.board[cellId]?.name ?? `#${cellId}`;
    return this.create(state, {
      kind: "AUCTION_WON",
      player: winner,
      message: `🏆 ${winner.displayName} выиграл(а) аукцион за $${finalBid} («${cellName}»)`,
      type: "auction",
      payload: { cellId, amount: finalBid },
    });
  }

  /**
   * Журнал: аукцион не состоялся (никто не сделал ставку).
   */
  logAuctionUnsold(state: GameState, cellId: number): GameEvent {
    const cellName = state.board[cellId]?.name ?? `#${cellId}`;
    return this.create(state, {
      kind: "AUCTION_UNSOLD",
      message: `⛔ Аукцион по «${cellName}» не состоялся (ставок не было)`,
      type: "auction",
      payload: { cellId },
    });
  }

  // ТОРГОВЛЯ

  /**
   * Журнал: игрок предложил обмен другому игроку.
   * `counterparty` — второй участник (получатель оффера).
   */
  logTradeStarted(state: GameState, player: Player, counterparty: Player): GameEvent {
    return this.create(state, {
      kind: "TRADE_STARTED",
      player,
      message: `🤝 ${player.displayName} предлагает обмен игроку ${counterparty.displayName}`,
      type: "trade",
      payload: { otherPlayerId: counterparty.id },
    });
  }

  /**
   * Журнал: встречное предложение (counter-offer).
   */
  logTradeCounter(state: GameState, player: Player, counterparty: Player): GameEvent {
    return this.create(state, {
      kind: "TRADE_COUNTER",
      player,
      message: `↩️ ${player.displayName} сделал(а) встречное предложение игроку ${counterparty.displayName}`,
      type: "trade",
      payload: { otherPlayerId: counterparty.id },
    });
  }

  /**
   * Журнал: сделка состоялась. `acceptor` — игрок, который принял
   * оффер (и им может быть любая из сторон).
   */
  logTradeCompleted(state: GameState, acceptor: Player, counterparty: Player): GameEvent {
    return this.create(state, {
      kind: "TRADE_COMPLETED",
      player: acceptor,
      message: `✅ ${acceptor.displayName} и ${counterparty.displayName} завершили обмен`,
      type: "trade",
      payload: { otherPlayerId: counterparty.id },
    });
  }

  logTradeRejected(state: GameState, acceptor: Player, counterparty: Player): GameEvent {
    return this.create(state, {
      kind: "TRADE_REJECTED",
      player: acceptor,
      message: `❌ ${acceptor.displayName} отклонил(а) обмен от ${counterparty.displayName}`,
      type: "trade",
      payload: { otherPlayerId: counterparty.id },
    });
  }

  logTradeCancelled(state: GameState, initiator: Player, counterparty: Player): GameEvent {
    return this.create(state, {
      kind: "TRADE_CANCELLED",
      player: initiator,
      message: `🚫 ${initiator.displayName} отменил(а) обмен с ${counterparty.displayName}`,
      type: "trade",
      payload: { otherPlayerId: counterparty.id },
    });
  }

  // БАНКРОТСТВО

  /**
   * Журнал: старт процедуры распродажи имущества (фаза BANKRUPTCY_LIQUIDATE).
   * `creditorName` — человек-читаемое имя кредитора (имя игрока или "Банк").
   */
  logBankruptcyLiquidationStarted(
    state: GameState,
    player: Player,
    creditorName: string,
    debt: number,
  ): GameEvent {
    return this.create(state, {
      kind: "BANKRUPTCY_LIQUIDATION",
      player,
      message: `💼 ${player.displayName} распродаёт имущество (долг ${debt}₽ перед ${creditorName})`,
      type: "system",
      payload: { amount: debt, liquidation: true },
    });
  }

  /**
   * Журнал: продажа дома в фазе распродажи. Аналог `logHouseSold`,
   * но автоматически с `context = "liquidation"`.
   */
  logBankruptcyHouseSold(
    state: GameState,
    player: Player,
    cellName: string,
    noun: string,
    refund: number,
    housesAfter: number,
    isHotel: boolean,
  ): GameEvent {
    return this.logHouseSold(
      state,
      player,
      cellName,
      noun,
      refund,
      housesAfter,
      isHotel,
      "liquidation",
    );
  }

  /**
   * Журнал: залог клетки в фазе распродажи.
   */
  logBankruptcyMortgage(
    state: GameState,
    player: Player,
    cellName: string,
    mortgageAmount: number,
  ): GameEvent {
    return this.logPropertyMortgaged(state, player, cellName, mortgageAmount, "liquidation");
  }

  /**
   * Журнал: финальное объявление банкротства. `creditorName` —
   * человек-читаемое имя кредитора (имя игрока или "Банк").
   */
  logBankruptcyDeclared(state: GameState, player: Player, creditorName: string): GameEvent {
    return this.create(state, {
      kind: "BANKRUPTCY_DECLARED",
      player,
      message: `💀 ${player.displayName} объявил(а) банкротство (долг перед ${creditorName})`,
      type: "system",
    });
  }
}
