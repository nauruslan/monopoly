import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
  ForbiddenException,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import type { Request } from "express";
import { GamesService } from "./games.service";
import { GameRepository } from "../db/repositories/game.repository";
import type { GameState } from "@monopoly/shared";

/**
 * REST-эндпоинты ручного сохранения / загрузки партий.
 *
 * В отличие от auto-snapshot (который пишется после каждого действия),
 * это управляется пользователем:
 *  - GET  /games/:id/save  — скачать текущий state как JSON
 *  - POST /games/:id/load  — загрузить ранее сохранённый state
 *
 * Авторизация: только участник партии может её сохранить/загрузить.
 * На текущем этапе считаем, что хост (userId из JWT) — единственный участник
 */
@Controller("games")
@UseGuards(AuthGuard("jwt"))
export class GamesSaveController {
  constructor(
    private readonly games: GamesService,
    private readonly repo: GameRepository,
  ) {}

  /**
   * GET /games/:id/save
   * Возвращает полный `stateSnapshot` партии в виде JSON.
   */
  @Get(":id/save")
  async save(@Param("id") gameId: string, @Req() req: Request) {
    const userId = (req.user as { sub: string })?.sub;
    if (!userId) throw new ForbiddenException("Не авторизован");

    const state = await this.games.getGameState(gameId);
    if (!state) throw new NotFoundException("Партия не найдена");

    // Проверка: сохранять может только участник партии.
    const playerId = this.games.resolvePlayerId(gameId, userId);
    if (!playerId) {
      throw new ForbiddenException("Нет доступа к партии");
    }

    return {
      ok: true,
      data: {
        savedAt: new Date().toISOString(),
        gameId,
        state,
      },
    };
  }

  /**
   * POST /games/:id/load
   * Восстанавливает партию из ранее сохранённого `state`.
   * Body: { state: GameState }.
   *
   * load работает только для партий в статусе "active" и только для
   * участника. После load партия продолжается с того же `state.version`.
   */
  @Post(":id/load")
  async load(@Param("id") gameId: string, @Req() req: Request, @Body() body: { state: GameState }) {
    const userId = (req.user as { sub: string })?.sub;
    if (!userId) throw new ForbiddenException("Не авторизован");

    const current = await this.games.getGameState(gameId);
    if (!current) throw new NotFoundException("Партия не найдена");

    // Проверка: загрузить может только участник.
    const playerId = this.games.resolvePlayerId(gameId, userId);
    if (!playerId) {
      throw new ForbiddenException("Нет доступа к партии");
    }

    const incoming = body?.state as { version?: number } | undefined;
    if (!incoming || typeof incoming.version !== "number") {
      throw new ForbiddenException("Некорректный state");
    }

    // Перезаписываем snapshot
    const ok = await this.games.loadSnapshot(gameId, body.state, incoming.version);
    if (!ok) {
      throw new ForbiddenException("Не удалось загрузить (конфликт версий)");
    }

    const state = await this.games.getGameState(gameId);
    return { ok: true, data: { state } };
  }
}
