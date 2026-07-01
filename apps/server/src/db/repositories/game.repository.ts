import { Injectable, BadRequestException, ConflictException } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { eq, and, desc } from "drizzle-orm";
import { DbService } from "../db.service";
import { games, gamePlayers } from "../schema";
import type { GameState } from "@monopoly/shared";

/**
 * Сгенерировать криптослучайный seed для RNG.
 */
function generateSeed(): string {
  return randomBytes(16).toString("hex");
}

@Injectable()
export class GameRepository {
  constructor(private readonly dbService: DbService) {}

  private get db() {
    return this.dbService.db;
  }
  /**
   * Создать новую партию.
   * - Если в `state.seed` пришёл валидный seed от клиента/инициатора — используем его.
   * - Иначе (или если это placeholder вроде "client-init") — генерируем свой.
   * Сгенерированный seed также записываем в stateSnapshot.seed,
   * чтобы клиент мог его использовать для воспроизведения/синхронизации.
   */
  async create(state: GameState, hostId?: string, rngSeed?: string) {
    const incomingSeed = state.seed?.trim();
    const finalSeed =
      rngSeed?.trim() ||
      (incomingSeed && incomingSeed.length >= 8 ? incomingSeed : null) ||
      generateSeed();

    const stateWithSeed: GameState = { ...state, seed: finalSeed };

    const [game] = await this.db
      .insert(games)
      .values({
        stateSnapshot: stateWithSeed,
        rngSeed: finalSeed,
        status: "waiting",
        hostId,
      })
      .returning();
    return game;
  }

  async findById(id: string) {
    const [game] = await this.db.select().from(games).where(eq(games.id, id));
    return game;
  }

  async findActive() {
    return this.db
      .select()
      .from(games)
      .where(eq(games.status, "waiting"))
      .orderBy(desc(games.createdAt))
      .limit(50);
  }

  async updateSnapshot(id: string, snapshot: GameState, expectedVersion: number) {
    // Оптимистическая блокировка: апдейтим только если текущая версия в БД
    // совпадает с expectedVersion. Если параллельная транзакция успела
    // обновить игру раньше нас — UPDATE не найдёт ни одной строки и
    // мы выбросим ConflictException. Это защищает от race condition
    // при одновременных обновлениях одного и того же стейта.
    const [game] = await this.db
      .update(games)
      .set({
        stateSnapshot: snapshot,
        version: expectedVersion + 1,
        lastActivityAt: new Date(),
      })
      .where(and(eq(games.id, id), eq(games.version, expectedVersion)))
      .returning();

    if (!game) {
      // Либо игры вообще нет, либо версия не совпала.
      const exists = await this.findById(id);
      if (!exists) {
        throw new BadRequestException("Игра не найдена");
      }
      throw new ConflictException(
        `Конфликт версий: игра была обновлена другим запросом (текущая версия ${exists.version}, ожидалась ${expectedVersion})`,
      );
    }
    return game;
  }

  async addPlayer(gameId: string, playerId: string, seat: number, isBot = false) {
    const [player] = await this.db
      .insert(gamePlayers)
      .values({
        gameId,
        playerId,
        seat,
        isBot,
      })
      .returning();
    return player;
  }
}
