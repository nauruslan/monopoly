import { Inject, forwardRef } from "@nestjs/common";
import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  ConnectedSocket,
  MessageBody,
} from "@nestjs/websockets";
import { Server, Socket } from "socket.io";
import { Logger, OnModuleInit } from "@nestjs/common";
import { GamesService } from "../games/games.service";
import { AuthService } from "../auth/auth.service";
import type { GameAction, GameState, GameEvent } from "@monopoly/shared";
import type { AuctionEvent } from "../games/handlers/auction.service";

/**
 * GameGateway — WebSocket-шлюз для real-time игры
 *
 * События (Client → Server):
 * - lobby:create — создать партию
 * - lobby:join — присоединиться к партии
 * - lobby:leave — покинуть партию
 * - game:action — действие игрока
 *
 * События (Server → Client):
 * - game:state — полное состояние партии
 * - game:patch — частичное обновление
 * - game:dice — анимация броска кубиков
 * - game:card — вытянутая карточка
 * - game:error — ошибка
 * - lobby:update — обновление списка игроков
 */
@WebSocketGateway({
  cors: {
    origin: process.env.CLIENT_URL || "http://localhost:5173",
    credentials: true,
  },
  // ВАЖНО: в @nestjs/platform-socket.io@11 рекомендуется явно указать websocket
  // transport, иначе клиент получит long-polling handshake.
  transports: ["websocket"],
})
export class GameGateway implements OnGatewayConnection, OnGatewayDisconnect, OnModuleInit {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(GameGateway.name);
  private userSockets = new Map<string, Socket>();
  private callbackRegistered = false;

  constructor(
    @Inject(forwardRef(() => GamesService)) private readonly games: GamesService,
    @Inject(forwardRef(() => AuthService)) private readonly auth: AuthService,
  ) {
    if (!this.auth) {
      console.error("[GameGateway] AuthService не заинжектирован!");
    }
    if (!this.games) {
      console.error("[GameGateway] GamesService не заинжектирован!");
    }
  }

  /**
   * OnModuleInit вызывается ПОСЛЕ того, как все провайдеры модуля
   * инициализированы. Это безопасное место для регистрации callback'а
   * в GamesService — он гарантированно уже сконструирован.
   *
   * ВАЖНО: если оставить регистрацию в конструкторе, при
   * circular dependency между GameGateway и GamesService `this.games`
   * может быть прокси, и присвоение `this.games.onStateChanged = ...`
   * может «потеряться». OnModuleInit решает эту проблему.
   */
  onModuleInit() {
    if (this.callbackRegistered) return;
    this.games.onStateChanged = (gameId, state, event, dice, card) => {
      this.logger.log(
        `[onStateChanged-cb] called gameId=${gameId} phase=${state.phase} dice=${
          dice ? `[${dice[0]},${dice[1]}]` : "—"
        }`,
      );
      this.broadcastState(gameId, state, event, dice, card);
    };
    this.callbackRegistered = true;
    this.logger.log(
      `[GameGateway] onStateChanged callback registered (onModuleInit). isGamesDefined=${!!this.games}`,
    );

    // Регистрируем gateway в GamesService для broadcast-а событий аукциона.
    this.games.setGateway({
      broadcastAuctionEvent: (gameId, ev) => this.broadcastAuctionEvent(gameId, ev),
    });
  }

  /**
   * Broadcast обновления state в комнату `game:<gameId>`.
   * Вызывается из `GamesService.onStateChanged` для ЛЮБЫХ изменений
   * (и от действий игрока, и от ходов ботов).
   */
  private broadcastState(
    gameId: string,
    state: GameState,
    event?: GameEvent,
    dice?: [number, number],
    card?: unknown,
  ) {
    // Логируем сколько сокетов сейчас в комнате — поможет понять,
    // доходит ли broadcast вообще.
    const room = `game:${gameId}`;
    const sockets = this.server.sockets.adapter.rooms.get(room);
    this.logger.log(
      `[broadcastState] gameId=${gameId} phase=${state.phase} dice=${
        dice ? `[${dice[0]},${dice[1]}]` : "—"
      } socketsInRoom=${sockets?.size ?? 0}`,
    );

    this.server.to(room).emit("game:state", state);
    if (event) {
      this.server.to(room).emit("game:event", event);
    }
    // Дополнительно шлём `game:dice` — для анимации кубиков на клиенте.
    if (dice) {
      const isDouble = dice[0] === dice[1];
      this.broadcastDice(gameId, {
        playerId: state.players[state.currentPlayerIndex]?.id ?? "",
        dice,
        isDouble,
      });
    }
    // Рассылаем карточку (Шанс/Казна) если есть
    if (card) {
      this.broadcastCard(gameId, {
        playerId: state.players[state.currentPlayerIndex]?.id ?? "",
        card,
      });
    }
  }

  /**
   * Обработка нового подключения
   */
  async handleConnection(client: Socket) {
    try {
      // Токен передаётся клиентом при подключении
      const token = client.handshake.auth?.token;
      if (!token) {
        client.emit("game:error", {
          code: "NO_TOKEN",
          message: "Требуется токен",
        });
        client.disconnect();
        return;
      }

      // Верифицируем токен
      const payload = await this.auth.verifyToken(token);
      client.data.userId = payload.sub;
      client.data.isGuest = payload.isGuest;
      this.userSockets.set(payload.sub, client);

      this.logger.log(`WS connected: ${payload.sub}`);

      // Восстанавливаем `gameId` для комнаты: клиент мог прислать
      // `lastGameId` в handshake.query (для автоматического реконнекта).
      // Без этого broadcast через `server.to("game:<id>")` не дойдёт
      // до только что пересоединившегося сокета.
      const lastGameId = (client.handshake.query?.lastGameId as string) || "";
      if (lastGameId) {
        client.data.gameId = lastGameId;
        client.join(`game:${lastGameId}`);
        this.logger.log(`WS re-joined room game:${lastGameId} for user ${payload.sub}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Invalid token on WS connect: ${msg}`);
      client.emit("game:error", {
        code: "AUTH_FAILED",
        message: "Невалидный токен",
      });
      client.disconnect();
    }
  }

  /**
   * Обработка отключения
   */
  handleDisconnect(client: Socket) {
    const userId = client.data.userId;
    if (userId) {
      this.userSockets.delete(userId);
      const gameId = client.data.gameId;
      if (gameId) {
        this.server.to(`game:${gameId}`).emit("lobby:update", {
          gameId,
          userId,
          connected: false,
        });
      }
    }
  }

  /**
   * Создание партии
   */
  @SubscribeMessage("lobby:create")
  async onCreate(@ConnectedSocket() client: Socket, @MessageBody() req: { playerNames: string[] }) {
    const userId = client.data.userId as string;
    // ВАЖНО: `userId` нужен и для гостя, и для зарегистрированного —
    // именно по нему `GamesService` строит маппинг `userId → playerId`,
    // чтобы `onAction` мог определить, чьё действие пришло.
    // Гость — это полноценная запись в `users` (AuthService.createGuest),
    // у неё есть валидный uuid, который можно класть в `games.host_id`.
    const result = await this.games.createGame(req.playerNames, userId);

    client.join(`game:${result.gameId}`);
    client.data.gameId = result.gameId;

    this.logger.log(`Game created via WS: ${result.gameId}`);

    // Рассылаем стейт всем в комнате (на будущее — когда другие игроки
    // будут подключаться через lobby:join, они сразу увидят state).
    this.server.to(`game:${result.gameId}`).emit("game:state", result.state);

    return { ok: true, data: result };
  }

  /**
   * Присоединение к партии
   */
  @SubscribeMessage("lobby:join")
  async onJoin(@ConnectedSocket() client: Socket, @MessageBody() p: { gameId: string }) {
    const state = await this.games.getGameState(p.gameId);
    if (!state) {
      return { ok: false, error: "Партия не найдена" };
    }

    client.join(`game:${p.gameId}`);
    client.data.gameId = p.gameId;

    this.server.to(`game:${p.gameId}`).emit("lobby:update", {
      gameId: p.gameId,
      players: state.players.length,
    });

    return { ok: true, data: { state } };
  }

  /**
   * Запрос свежего state при reconnect.
   * Клиент шлёт это после восстановления соединения, чтобы подтянуть
   * изменения, прошедшие за время разрыва.
   */
  @SubscribeMessage("reconnect:request_state")
  async onReconnectRequest(
    @ConnectedSocket() client: Socket,
    @MessageBody() p: { gameId: string },
  ) {
    const state = await this.games.getGameState(p.gameId);
    if (!state) {
      return { ok: false, error: "Партия не найдена" };
    }

    // Если этот сокет ещё не в комнате (новый после реконнекта) — добавляем.
    if (!client.rooms.has(`game:${p.gameId}`)) {
      client.join(`game:${p.gameId}`);
      client.data.gameId = p.gameId;
    }

    return { ok: true, data: { state } };
  }

  /**
   * Действие игрока
   */
  @SubscribeMessage("game:action")
  async onAction(
    @ConnectedSocket() client: Socket,
    @MessageBody() req: { gameId: string; action: GameAction },
  ) {
    try {
      const userId = client.data.userId as string;

      const state = await this.games.getGameState(req.gameId);
      if (!state) return { ok: false, error: "Партия не найдена" };

      // Резолвим `player.id` через маппинг `userId → playerId`, который
      // `GamesService` наполняет в `createGame()`. В shared-типе `Player`
      // нет поля `userId`, поэтому держим маппинг отдельно.
      // это заменится на полноценную таблицу участников.
      const playerId = this.games.resolvePlayerId(req.gameId, userId);
      if (!playerId) {
        return { ok: false, error: "Это не ваш игрок в этой партии" };
      }

      const result = await this.games.applyAction(req.gameId, playerId, req.action);

      // broadcast `game:state` + `game:event` + `game:dice` уже сделан
      // в `GamesService.onStateChanged` (зарегистрирован в конструкторе).
      // Здесь только отдаём синхронный ответ на action callback.
      //
      // Раньше тут был `client.emit("game:state", result.state)` — «страховка»
      // на случай потери broadcast. Но это приводило к ДВОЙНОМУ получению
      // `game:state` на клиенте: один из broadcast, другой из client.emit.
      // Phase-watcher в GameView срабатывал дважды, и в редких случаях
      // (двойной клик, race) модалка карточки/налога показывалась
      // повторно. Удалено: надёжность broadcast обеспечивается комнатой
      // `game:<id>` + `client.join` в `handleConnection` и при reconnect.
      return { ok: true, data: { state: result.state, dice: result.dice, card: result.card } };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Action error: ${message}`);
      return { ok: false, error: message };
    }
  }

  /**
   * Broadcast анимации броска кубиков
   */
  broadcastDice(
    gameId: string,
    payload: { playerId: string; dice: [number, number]; isDouble: boolean },
  ) {
    this.server.to(`game:${gameId}`).emit("game:dice", payload);
  }

  /**
   * Broadcast вытянутой карточки
   */
  broadcastCard(gameId: string, payload: { playerId: string; card: unknown }) {
    this.server.to(`game:${gameId}`).emit("game:card", payload);
  }

  /**
   * Broadcast события аукциона (AUCTION_START, AUCTION_TURN_UPDATE,
   * AUCTION_ACTION, AUCTION_END). Канал: "auction:event".
   * Это ДОПОЛНИТЕЛЬНЫЙ канал к основному broadcast-у `game:state` —
   * он нужен клиенту, чтобы:
   *   - мгновенно показывать таймер/повышение ставки без задержки
   *     `game:state` (атомарный снэпшот всего state);
   *   - корректно анимировать чужой ход в аукционе.
   */
  broadcastAuctionEvent(gameId: string, event: AuctionEvent): void {
    const room = `game:${gameId}`;
    this.server.to(room).emit("auction:event", event);
  }
}
