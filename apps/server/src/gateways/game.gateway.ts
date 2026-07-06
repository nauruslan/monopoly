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
import { Logger } from "@nestjs/common";
import { GamesService } from "../games/games.service";
import { AuthService } from "../auth/auth.service";
import type { GameAction } from "@monopoly/shared";

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
export class GameGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(GameGateway.name);
  private userSockets = new Map<string, Socket>();

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

      this.server.to(`game:${req.gameId}`).emit("game:state", result.state);

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
}
