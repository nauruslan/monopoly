import { Injectable, Logger } from "@nestjs/common";
import type {
  AuctionActionLogEntry,
  GameState,
  Player,
} from "@monopoly/shared";
import {
  applyAuctionCommand,
  initAuction as initAuctionEngine,
  activateAuction as activateAuctionEngine,
  type AuctionCommand,
  type AuctionEngineError,
  type AuctionEngineResult,
} from "./auction.engine";

/**
 * WebSocket-события, которые `AuctionService` шлёт клиенту через
 * callback `onAuctionEvent`, зарегистрированный в `GamesService`.
 *
 * Все события рассылаются ВСЕМ клиентам в комнате `game:<id>` —
 * клиент не должен знать о серверной логике ботов, он только рендерит
 * то, что пришло.
 *
 * Формат payload (см. тип `AuctionEvent` ниже) — единый объект
 * с полями `type` и дополнительными данными.
 */
export type AuctionEvent =
  | {
      type: "AUCTION_START";
      propertyId: number;
      initiatorId: string;
      firstBidderId: string;
      participants: string[];
      turnDurationMs: number;
      timerStartedAt: number;
    }
  | {
      type: "AUCTION_TURN_UPDATE";
      activeBidderId: string | null;
      currentBid: number;
      highestBidderId: string | null;
      timeLeft: number;
      activeBidders: string[];
    }
  | {
      type: "AUCTION_ACTION";
      playerId: string;
      action: "BID" | "PASS" | "TIMEOUT";
      amount?: number;
      // Доп. контекст: ID нового активного после действия (для UI).
      nextBidderId: string | null;
      // Обновлённый список активных (для UI-синхронизации).
      activeBidders: string[];
    }
  | {
      type: "AUCTION_END";
      winnerId: string | null;
      finalBid: number;
      propertyId: number;
      status: "SOLD" | "UNSOLD";
    };

/**
 * Callback-интерфейс для отправки WS-событий.
 * `GamesService` подключает его в конструкторе: `this.auction.onAuctionEvent = (...) => this.gateway.emit(...)`.
 */
export type AuctionEventCallback = (gameId: string, event: AuctionEvent) => void;

/**
 * AuctionService — оркестратор аукциона (тонкая обёртка вокруг чистого
 * `AuctionEngine`).
 *
 * Что делает:
 *  - инициализирует `state.auction` (вызывает `initAuction` из движка);
 *  - применяет команды (`AUCTION_MAKE_BID` / `AUCTION_PASS`);
 *  - управляет таймером (30 сек на ход, по таймауту — авто-пас);
 *  - шлёт WS-события через callback `onAuctionEvent`.
 *
 * Сетевая часть (`Socket.IO`, `gateway.to(...).emit(...)`) — снаружи;
 * сервис лишь дёргает callback с готовым payload. Это позволяет
 * тестировать логику без поднятия сокет-сервера.
 *
 * Правила (синхронизированы со спекой v2):
 *  1. Участники: все живые игроки, ВКЛЮЧАЯ инициатора.
 *  2. Первый «на часах» — инициатор; далее по кругу `bidderOrder`.
 *  3. Лимит ставки: `Max_Bid = player.money` (наличные, без залога).
 *  4. Ставка должна быть СТРОГО > `currentBid`.
 *  5. Если время вышло — сервер шлёт `TIMEOUT` от лица текущего.
 *  6. Пас/таймаут — игрок НАВСЕГДА выбывает из текущего аукциона.
 *  7. Аукцион закрывается:
 *     - `activeBidders.length === 1` → SOLD;
 *     - `activeBidders.length === 0` → UNSOLD.
 *  8. Клиент не должен знать о логике ботов — сервер сам решает, когда
 *     бот торгуется, и присылает `AUCTION_ACTION` после задержки.
 */
@Injectable()
export class AuctionService {
  private readonly logger = new Logger(AuctionService.name);

  /** Дефолтная длительность хода в аукционе (мс). */
  static readonly DEFAULT_TURN_DURATION_MS = 30_000;

  /**
   * Callback для отправки WS-событий. Устанавливается извне
   * (`GamesService` в конструкторе).
   */
  onAuctionEvent: AuctionEventCallback | null = null;

  /**
   * Инициализировать новый аукцион. Возвращает `false`, если нет
   * активных участников — клетка остаётся у банка, никаких торгов.
   *
   * После успешного `initAuction` сервис шлёт WS-событие `AUCTION_START`
   * и переводит state в `AUCTION_ACTIVE`. Никаких таймеров здесь не
   * запускается — это делает `GamesService` (он знает gameId для
   * отправки событий).
   */
  startAuction(
    gameId: string,
    state: GameState,
    cell: { id: number },
    initiator: Player,
    now: number = Date.now(),
  ): boolean {
    const turnDurationMs =
      state.settings.auctionBidTimeoutMs ?? AuctionService.DEFAULT_TURN_DURATION_MS;
    const next = initAuctionEngine(state, cell, initiator, { turnDurationMs }, now);
    if (!next || !next.auction) {
      this.logger.debug(`[AuctionService] no participants for cell ${cell.id}`);
      return false;
    }
    // Мутируем state.in place (GamesService хранит state по ссылке).
    state.auction = next.auction;

    // Сразу активируем (AWAITING_START → AUCTION_ACTIVE) и шлём AUCTION_START.
    const active = activateAuctionEngine(state, now);
    state.auction = active.auction!;

    this.logger.log(
      `[AuctionService] auction started for cell ${cell.id} with ${state.auction.bidderOrder.length} bidders`,
    );

    // Шлём broadcast: AUCTION_START (один раз в начале).
    this.emit(gameId, {
      type: "AUCTION_START",
      propertyId: cell.id,
      initiatorId: initiator.id,
      firstBidderId: state.auction.currentBidderId!,
      participants: state.auction.bidderOrder,
      turnDurationMs,
      timerStartedAt: state.auction.timerStartedAt,
    });

    // И сразу TURN_UPDATE с timeLeft = turnDurationMs.
    this.emit(gameId, {
      type: "AUCTION_TURN_UPDATE",
      activeBidderId: state.auction.currentBidderId,
      currentBid: state.auction.currentBid,
      highestBidderId: state.auction.highestBidderId,
      timeLeft: turnDurationMs,
      activeBidders: state.auction.activeBidders,
    });
    return true;
  }

  /**
   * Применить команду (`AUCTION_MAKE_BID` / `AUCTION_PASS`).
   *
   * ВАЖНО: метод МУТИРУЕТ `state.auction` (in place, как ожидает
   * `GamesService`). На успех шлёт:
   *  - `AUCTION_ACTION`  — с действием текущего игрока;
   *  - `AUCTION_TURN_UPDATE` — если аукцион продолжается;
   *  - `AUCTION_END`     — если аукцион закрылся (SOLD/UNSOLD).
   *
   * На ошибку возвращает `{ ok: false, error }`, и `GamesService`
   * бросает `ForbiddenException` (на старом `auction.service.ts`
   * для этого был `auctionErrorMessage`).
   */
  applyCommand(
    gameId: string,
    state: GameState,
    cmd: AuctionCommand,
    now: number = Date.now(),
  ): AuctionEngineResult {
    const result = applyAuctionCommand(state, cmd, now);
    if (!result.ok) return result;
    // Копируем свежие поля (state.auction и, при sold, players/board)
    // — `applyAuctionCommand` возвращает НОВЫЙ state, но в этой обёртке
    // мы работаем по ссылке (GamesService так делает для скорости).
    state.auction = result.state.auction;
    if (result.state.auction?.status === "FINISHED") {
      state.players = result.state.players;
      state.board = result.state.board;
    }
    // Шлём broadcast-события.
    this.broadcastAfterCommand(gameId, state, result.events, now);
    return result;
  }

  /**
   * Зарегистрировать авто-пас по таймеру (вызывается из `GamesService`).
   * Возвращает объект с `cancel()` для отмены (например, при новом ходе).
   *
   * Сервер сам вызовет `applyCommand` с `type: "timeout"`, имитируя
   * `AUCTION_PASS` от текущего «на часах» с `reason: "TIMEOUT"`.
   */
  scheduleTimeout(
    gameId: string,
    state: GameState,
    onTimeout: (playerId: string) => Promise<void>,
  ): { cancel: () => void } {
    const a = state.auction;
    if (!a || a.status !== "AUCTION_ACTIVE" || !a.currentBidderId) {
      return { cancel: () => undefined };
    }
    const expectedActiveAtStart = a.currentBidderId;
    const expectedStartedAt = a.timerStartedAt;
    const turnDurationMs = a.turnDurationMs;
    const remaining = Math.max(0, expectedStartedAt + turnDurationMs - Date.now());
    const timer = setTimeout(() => {
      const cur = state.auction;
      if (!cur || cur.status !== "AUCTION_ACTIVE") return;
      if (cur.currentBidderId !== expectedActiveAtStart) return;
      if (cur.timerStartedAt !== expectedStartedAt) return;
      const player = state.players.find((p) => p.id === expectedActiveAtStart);
      if (!player || player.isBankrupt) return;
      void onTimeout(expectedActiveAtStart);
    }, remaining);
    return {
      cancel: () => clearTimeout(timer),
    };
  }

  /**
   * Рассылка событий по результатам команды. Вызывается из `applyCommand`
   * (или напрямую из `GamesService` при таймауте).
   */
  private broadcastAfterCommand(
    gameId: string,
    state: GameState,
    events: ReturnType<typeof applyAuctionCommand> extends infer R
      ? R extends { ok: true; events: infer E }
        ? E
        : never
      : never,
    now: number,
  ): void {
    if (!state.auction) return;
    for (const ev of events) {
      switch (ev.type) {
        case "BID_PLACED": {
          this.emit(gameId, {
            type: "AUCTION_ACTION",
            playerId: ev.playerId,
            action: "BID",
            amount: ev.amount,
            nextBidderId: state.auction.currentBidderId,
            activeBidders: state.auction.activeBidders,
          });
          break;
        }
        case "PLAYER_PASSED": {
          this.emit(gameId, {
            type: "AUCTION_ACTION",
            playerId: ev.playerId,
            action: ev.reason,
            nextBidderId: state.auction.currentBidderId,
            activeBidders: state.auction.activeBidders,
          });
          break;
        }
        case "TURN_ADVANCED": {
          this.emit(gameId, {
            type: "AUCTION_TURN_UPDATE",
            activeBidderId: ev.nextPlayerId,
            currentBid: state.auction.currentBid,
            highestBidderId: state.auction.highestBidderId,
            timeLeft: state.auction.turnDurationMs,
            activeBidders: state.auction.activeBidders,
          });
          break;
        }
        case "AUCTION_SOLD": {
          this.emit(gameId, {
            type: "AUCTION_END",
            winnerId: ev.playerId,
            finalBid: ev.amount,
            propertyId: state.auction.cellId,
            status: "SOLD",
          });
          break;
        }
        case "AUCTION_UNSOLD": {
          this.emit(gameId, {
            type: "AUCTION_END",
            winnerId: null,
            finalBid: 0,
            propertyId: state.auction.cellId,
            status: "UNSOLD",
          });
          break;
        }
      }
    }
    // Подавляем unused
    void now;
  }

  /**
   * Хелпер: безопасный emit через callback.
   */
  private emit(gameId: string, event: AuctionEvent): void {
    if (!this.onAuctionEvent) {
      this.logger.debug(
        `[AuctionService] onAuctionEvent not registered; skipping ${event.type}`,
      );
      return;
    }
    try {
      this.onAuctionEvent(gameId, event);
    } catch (err) {
      this.logger.error(
        `onAuctionEvent callback failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Очистить `state.auction` после `AUCTION_FINISHED` (вызывается
   * из `GamesService` при переходе фазы).
   */
  finalize(state: GameState): void {
    if (!state.auction) return;
    const { cellId, winnerId, finalBid, finishReason } = state.auction;
    if (state.auction.status === "FINISHED" && finishReason === "SOLD" && winnerId) {
      this.logger.log(
        `[AuctionService] finalized: cell ${cellId} → ${winnerId} for ${finalBid}`,
      );
    } else if (state.auction.status === "FINISHED" && finishReason === "UNSOLD") {
      this.logger.log(`[AuctionService] finalized: cell ${cellId} unsold`);
    }
    // НЕ очищаем state.auction сразу — клиенту нужно увидеть
    // AUCTION_END и отрендерить финальный экран. GamesService сам
    // вызовет `clearAuction(state)` через ~2 сек.
  }

  /**
   * Полностью убрать `state.auction` (после AUCTION_FINISHED-экрана).
   * Вызывается из `GamesService` через 2 сек после AUCTION_END.
   */
  clearAuction(state: GameState): void {
    state.auction = undefined;
  }

  /**
   * Преобразовать код ошибки движка в человеко-читаемое сообщение.
   */
  describeError(err: AuctionEngineError): string {
    switch (err) {
      case "NOT_ON_CLOCK":
        return "Сейчас не ваша очередь ставить";
      case "BANKRUPT":
        return "Игрок не участвует в аукционе";
      case "BID_TOO_LOW":
        return "Ставка должна быть строго больше текущей";
      case "INSUFFICIENT_FUNDS":
        return "Недостаточно денег";
      case "ALREADY_CLOSED":
        return "Аукцион уже завершён";
      case "NOT_ACTIVE":
      default:
        return "Аукцион не активен";
    }
  }
}
