/**
 * AuctionEngine — чистая логика аукциона, без таймеров и сети.
 *
 * Контракт: (state, command) -> { state, events } | error
 *  - Без побочных эффектов (не запускает setTimeout, не шлёт эмиты).
 *  - Детерминирована: один и тот же state + command -> один и тот же результат.
 *  - Иммутабельна: возвращает НОВЫЙ объект `state` (с обновлённым `auction`),
 *    не мутируя входной.
 *
 * Правила (новая спека, v2):
 *  1. **Участники:** все живые (не банкроты) игроки, ВКЛЮЧАЯ инициатора.
 *  2. **Стартовый ход:** инициатор. Далее по часовой стрелке по `bidderOrder`.
 *  3. **Лимит ставки:** `Max_Bid = player.money` (наличные, без залога).
 *     Ставка должна быть СТРОГО > `currentBid`.
 *  4. **Нет денег на минимальную ставку → пас.** Клиент просто прячет кнопки
 *     ставок, сервер при попытке выдаст `INSUFFICIENT_FUNDS`.
 *  5. **Пас/таймаут — безвозвратно.** Игрок удаляется из `activeBidders` и
 *     больше в этом аукционе не участвует.
 *  6. **Таймер:** 30 сек на ход. Если время вышло — сервер шлёт `TIMEOUT`
 *     от лица текущего игрока (записывает в лог и сдвигает ход).
 *  7. **Конец:**
 *     - `activeBidders.length === 0` → UNSOLD (клетка остаётся у Банка).
 *     - `activeBidders.length === 1` → SOLD, победитель — этот игрок,
 *       финальная ставка = `currentBid`.
 *  8. **Без понятия «круг».** Просто удаляем пасанувших из массива и идём
 *     по индексу.
 *  9. **Когда аукцион закрыт** (`status === "FINISHED"`), клетка передаётся
 *     победителю (если `SOLD`), деньги списываются.
 *     Передача прав собственности и списание денег выполняются ТОЛЬКО
 *     при `SOLD`. При `UNSOLD` — никаких мутаций `players` / `board`.
 *
 * Команды:
 *  - `placeBid`  — игрок делает ставку (текущий «на часах»).
 *  - `pass`      — игрок пасует (текущий «на часах»).
 *  - `timeout`   — сервер принудительно пасует по таймеру (текущий «на часах»).
 *
 * Коды ошибок:
 *  - `NOT_ACTIVE`         — аукциона нет / он не в фазе `AUCTION_ACTIVE`.
 *  - `NOT_ON_CLOCK`       — игрок не тот, кто сейчас «на часах».
 *  - `BANKRUPT`           — игрок банкрот.
 *  - `BID_TOO_LOW`        — ставка <= текущей (строгое правило).
 *  - `INSUFFICIENT_FUNDS` — у игрока не хватает денег.
 *  - `ALREADY_CLOSED`     — аукцион в фазе `FINISHED`.
 */
import type { AuctionActionLogEntry, GameState, Player } from "@monopoly/shared";

/** Команды движка аукциона (v2). */
export type AuctionCommand =
  | { type: "placeBid"; playerId: string; amount: number }
  | { type: "pass"; playerId: string }
  | { type: "timeout"; playerId: string };

/** Событие движка аукциона (внутреннее, для оркестратора). */
export type AuctionEngineEvent =
  | { type: "BID_PLACED"; playerId: string; amount: number; at: number }
  | { type: "PLAYER_PASSED"; playerId: string; reason: "PASS" | "TIMEOUT"; at: number }
  | { type: "TURN_ADVANCED"; nextPlayerId: string | null; at: number }
  | { type: "AUCTION_SOLD"; playerId: string; amount: number; at: number }
  | { type: "AUCTION_UNSOLD"; at: number };

export type AuctionEngineError =
  | "NOT_ACTIVE"
  | "NOT_ON_CLOCK"
  | "BANKRUPT"
  | "BID_TOO_LOW"
  | "INSUFFICIENT_FUNDS"
  | "ALREADY_CLOSED";

export type AuctionEngineResult =
  | { ok: true; state: GameState; events: AuctionEngineEvent[] }
  | { ok: false; error: AuctionEngineError };

/**
 * Получить ID текущего «на часах» (или `null`, если аукцион не активен /
 * пуст).
 */
export function getOnClock(state: GameState): string | null {
  return state.auction?.currentBidderId ?? null;
}

/**
 * Является ли игрок участником аукциона (инициатор ВКЛЮЧЁН в `bidderOrder`).
 */
export function isParticipant(state: GameState, playerId: string): boolean {
  if (!state.auction) return false;
  return state.auction.bidderOrder.includes(playerId);
}

/**
 * Инициализировать аукцион для клетки.
 *
 * Создаёт `state.auction` со `status = "AWAITING_START"`, заполняет
 * `activeBidders = bidderOrder` (ВСЕ живые игроки, ВКЛЮЧАЯ инициатора),
 * `currentBidderIndex = 0` (инициатор). Если живых игроков нет —
 * возвращает `null` (клетка остаётся у Банка).
 *
 * Сервер вызывает `initAuction` → мутирует state.auction → шлёт
 * `AUCTION_START` (WS) → переводит фазу на `AUCTION_ACTIVE`.
 */
export function initAuction(
  state: GameState,
  cell: { id: number },
  initiator: Player,
  options: {
    turnDurationMs: number;
  },
  now: number = Date.now(),
): GameState | null {
  const alive = state.players.filter((p) => !p.isBankrupt);
  if (alive.length === 0) return null;
  const initiatorIdx = alive.findIndex((p) => p.id === initiator.id);
  const startIdx = initiatorIdx >= 0 ? initiatorIdx : 0;
  // «От инициатора по часовой стрелке».
  const rotated = [...alive.slice(startIdx), ...alive.slice(0, startIdx)];
  const bidderOrder = rotated.map((p) => p.id);
  const firstId = bidderOrder[0]!;

  return {
    ...state,
    auction: {
      id: `auc-${now}-${cell.id}-${Math.floor(Math.random() * 1e6)}`,
      cellId: cell.id,
      initiatorId: initiator.id,
      status: "AWAITING_START",
      currentBid: 0,
      highestBidderId: null,
      bidderOrder,
      activeBidders: [...bidderOrder],
      currentBidderIndex: 0,
      currentBidderId: firstId,
      timerStartedAt: now,
      turnDurationMs: options.turnDurationMs,
      actionLog: [],
      winnerId: null,
      finalBid: 0,
      finishReason: null,
      startedAt: now,
      closedAt: null,
    },
  };
}

/**
 * Перевести `AWAITING_START` → `AUCTION_ACTIVE`. Вызывается оркестратором
 * один раз после broadcast `AUCTION_START`. Без этого `placeBid`/`pass`
 * будут отклоняться (`NOT_ACTIVE`).
 */
export function activateAuction(state: GameState, now: number = Date.now()): GameState {
  if (!state.auction) return state;
  if (state.auction.status !== "AWAITING_START") return state;
  return {
    ...state,
    auction: {
      ...state.auction,
      status: "AUCTION_ACTIVE",
      timerStartedAt: now,
    },
  };
}

/**
 * Применить команду к состоянию и вернуть новое состояние + события.
 * Никогда не мутирует входной `state`.
 *
 * ВАЖНО: при `SOLD` функция также МУТИРУЕТ `state.players` (списывает
 * деньги победителю, добавляет клетку в `properties`) и `state.board`
 * (проставляет `ownerId`). При `UNSOLD` — никаких мутаций.
 */
export function applyAuctionCommand(
  state: GameState,
  cmd: AuctionCommand,
  now: number = Date.now(),
): AuctionEngineResult {
  if (!state.auction) return { ok: false, error: "NOT_ACTIVE" };
  if (state.auction.status === "FINISHED") return { ok: false, error: "ALREADY_CLOSED" };
  if (state.auction.status !== "AUCTION_ACTIVE") return { ok: false, error: "NOT_ACTIVE" };
  if (state.auction.activeBidders.length === 0) {
    // Должно быть уже FINISHED, но на всякий случай.
    return { ok: false, error: "NOT_ACTIVE" };
  }
  const a = state.auction;
  // Проверяем, что currentBidderIndex не вышел за границы (защита).
  if (a.currentBidderIndex < 0 || a.currentBidderIndex >= a.activeBidders.length) {
    return { ok: false, error: "NOT_ACTIVE" };
  }
  const currentId = a.activeBidders[a.currentBidderIndex]!;
  if (cmd.playerId !== currentId) {
    return { ok: false, error: "NOT_ON_CLOCK" };
  }
  const player = state.players.find((p) => p.id === cmd.playerId);
  if (!player || player.isBankrupt) {
    return { ok: false, error: "BANKRUPT" };
  }

  const events: AuctionEngineEvent[] = [];

  switch (cmd.type) {
    case "placeBid": {
      // Валидация суммы.
      if (!Number.isFinite(cmd.amount) || !Number.isInteger(cmd.amount) || cmd.amount <= 0) {
        return { ok: false, error: "BID_TOO_LOW" };
      }
      if (cmd.amount <= a.currentBid) {
        return { ok: false, error: "BID_TOO_LOW" };
      }
      if (cmd.amount > player.money) {
        return { ok: false, error: "INSUFFICIENT_FUNDS" };
      }
      // Применяем ставку + лог + сдвиг хода.
      const logEntry: AuctionActionLogEntry = {
        playerId: cmd.playerId,
        action: "BID",
        amount: cmd.amount,
        at: now,
      };
      const next = advanceAfterBid(state, cmd.playerId, cmd.amount, logEntry, events, now);
      return { ok: true, state: next, events };
    }

    case "pass": {
      const logEntry: AuctionActionLogEntry = {
        playerId: cmd.playerId,
        action: "PASS",
        at: now,
      };
      const next = advanceAfterPass(state, logEntry, events, now);
      return { ok: true, state: next, events };
    }

    case "timeout": {
      const logEntry: AuctionActionLogEntry = {
        playerId: cmd.playerId,
        action: "TIMEOUT",
        at: now,
      };
      const next = advanceAfterPass(state, logEntry, events, now);
      return { ok: true, state: next, events };
    }
  }
}

/**
 * Применить ставку: обновить highestBid/highestBidderId, записать в лог,
 * сдвинуть currentBidderIndex по кругу, сбросить таймер.
 * Если в `activeBidders` остался ровно 1 — закрыть как SOLD.
 */
function advanceAfterBid(
  state: GameState,
  playerId: string,
  amount: number,
  logEntry: AuctionActionLogEntry,
  events: AuctionEngineEvent[],
  now: number,
): GameState {
  const a = state.auction!;
  const newActiveBidders = a.activeBidders.slice();
  // currentBidderIndex остаётся указывать на ТЕКУЩЕГО игрока (того, кто
  // только что походил). После проверки конца аукциона мы сдвинем индекс
  // на следующего непроспавшего.
  events.push({ type: "BID_PLACED", playerId, amount, at: now });

  const updatedAuction = {
    ...a,
    currentBid: amount,
    highestBidderId: playerId,
    actionLog: [...a.actionLog, logEntry],
  };

  // После ставки активные не меняются (только при пасе). Проверяем конец:
  if (newActiveBidders.length === 1) {
    // Один участник → он же победил.
    return finalizeSold(state, updatedAuction, events, now);
  }
  // Иначе сдвигаем ход на следующего непроспавшего.
  const nextIdx = (a.currentBidderIndex + 1) % newActiveBidders.length;
  const nextId = newActiveBidders[nextIdx]!;
  events.push({ type: "TURN_ADVANCED", nextPlayerId: nextId, at: now });
  return {
    ...state,
    auction: {
      ...updatedAuction,
      activeBidders: newActiveBidders,
      currentBidderIndex: nextIdx,
      currentBidderId: nextId,
      timerStartedAt: now,
    },
  };
}

/**
 * Применить пас/таймаут: удалить текущего игрока из activeBidders,
 * записать в лог, сдвинуть ход (или закрыть аукцион).
 *
 *  - Если после удаления массив пуст → UNSOLD.
 *  - Если остался ровно 1 → SOLD (победитель — он, ставка = currentBid).
 *  - Иначе → следующий «на часах» с `(currentBidderIndex) % newLength`.
 *    Так как мы УЖЕ удалили текущего из массива, currentBidderIndex
 *    указывает на СЛЕДУЮЩЕГО непроспавшего (сдвиг индекса не нужен).
 */
function advanceAfterPass(
  state: GameState,
  logEntry: AuctionActionLogEntry,
  events: AuctionEngineEvent[],
  now: number,
): GameState {
  const a = state.auction!;
  const reason: "PASS" | "TIMEOUT" = logEntry.action === "TIMEOUT" ? "TIMEOUT" : "PASS";
  events.push({
    type: "PLAYER_PASSED",
    playerId: logEntry.playerId,
    reason,
    at: now,
  });

  const updatedAuction = {
    ...a,
    actionLog: [...a.actionLog, logEntry],
  };

  const newActiveBidders = a.activeBidders.filter((id) => id !== logEntry.playerId);

  if (newActiveBidders.length === 0) {
    // Ничья: все спасовали (до или после ставок).
    return finalizeUnsold(state, updatedAuction, events, now);
  }
  if (newActiveBidders.length === 1 && updatedAuction.currentBid > 0) {
    // Остался один, и хотя бы одна ставка уже сделана — он победил.
    return finalizeSold(state, updatedAuction, events, now);
  }
  if (newActiveBidders.length === 1) {
    // Остался один, но никто ещё не ставил — продолжаем, чтобы он
    // мог сделать первую ставку (или тоже спа́совать → UNSOLD).
    const nextIdx = a.currentBidderIndex % newActiveBidders.length;
    const nextId = newActiveBidders[nextIdx]!;
    events.push({ type: "TURN_ADVANCED", nextPlayerId: nextId, at: now });
    return {
      ...state,
      auction: {
        ...updatedAuction,
        activeBidders: newActiveBidders,
        currentBidderIndex: nextIdx,
        currentBidderId: nextId,
        timerStartedAt: now,
      },
    };
  }
  // Несколько игроков: сдвигаем индекс. Поскольку currentBidderIndex
  // указывал на удалённого игрока, теперь он указывает на «следующего»
  // по кругу. Но это работает, только если currentBidderIndex < newLength.
  // Безопасный вариант: сдвигаем (currentBidderIndex % newLength).
  const nextIdx = a.currentBidderIndex % newActiveBidders.length;
  const nextId = newActiveBidders[nextIdx]!;
  events.push({ type: "TURN_ADVANCED", nextPlayerId: nextId, at: now });
  return {
    ...state,
    auction: {
      ...updatedAuction,
      activeBidders: newActiveBidders,
      currentBidderIndex: nextIdx,
      currentBidderId: nextId,
      timerStartedAt: now,
    },
  };
}

/**
 * Закрыть аукцион как SOLD: передать клетку победителю, списать деньги,
 * заполнить winnerId/finalBid/finishReason. Деньги списываются
 * ТОЛЬКО при `sold`; при `unsold` — никаких мутаций.
 */
function finalizeSold(
  state: GameState,
  auction: NonNullable<GameState["auction"]>,
  events: AuctionEngineEvent[],
  now: number,
): GameState {
  const winnerId = auction.highestBidderId ?? auction.activeBidders[0] ?? null;
  if (!winnerId) {
    // На всякий случай (теоретически не должно случатьс��) — UNSOLD.
    return finalizeUnsold(state, auction, events, now);
  }
  const amount = auction.currentBid;
  const players = state.players.map((p) => {
    if (p.id !== winnerId) return p;
    return {
      ...p,
      money: Math.max(0, p.money - amount),
      properties: p.properties.includes(auction.cellId)
        ? p.properties
        : [...p.properties, auction.cellId],
    };
  });
  const board = state.board.map((c) => (c.id === auction.cellId ? { ...c, ownerId: winnerId } : c));
  events.push({ type: "AUCTION_SOLD", playerId: winnerId, amount, at: now });
  return {
    ...state,
    players,
    board,
    auction: {
      ...auction,
      status: "FINISHED",
      activeBidders: [],
      currentBidderIndex: -1,
      currentBidderId: null,
      closedAt: now,
      winnerId,
      finalBid: amount,
      finishReason: "SOLD",
    },
  };
}

/**
 * Закрыть аукцион как UNSOLD: клетка остаётся у Банка. НЕ мутируем
 * `state.players` / `state.board` — никаких передач и списаний.
 */
function finalizeUnsold(
  state: GameState,
  auction: NonNullable<GameState["auction"]>,
  events: AuctionEngineEvent[],
  now: number,
): GameState {
  events.push({ type: "AUCTION_UNSOLD", at: now });
  return {
    ...state,
    auction: {
      ...auction,
      status: "FINISHED",
      activeBidders: [],
      currentBidderIndex: -1,
      currentBidderId: null,
      closedAt: now,
      winnerId: null,
      finalBid: 0,
      finishReason: "UNSOLD",
    },
  };
}

/**
 * Хелпер: минимально допустимая следующая ставка. Используется клиентом
 * для UI (`min_next_bid = highest_bid + 1`).
 */
export function minNextBid(state: GameState): number {
  if (!state.auction) return 0;
  return state.auction.currentBid + 1;
}

/**
 * Хелпер: проверить, может ли текущий «на часах» позволить себе
 * минимальную ставку. Если нет — он обязан пасовать (UI прячет кнопки
 * ставок, бот автоматически пасует).
 */
export function canCurrentBidderAffordMinBid(state: GameState): boolean {
  if (!state.auction) return false;
  if (state.auction.status !== "AUCTION_ACTIVE") return false;
  if (!state.auction.currentBidderId) return false;
  const p = state.players.find((x) => x.id === state.auction!.currentBidderId);
  if (!p) return false;
  return p.money > state.auction.currentBid;
}
