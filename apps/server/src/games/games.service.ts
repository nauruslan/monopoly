import { Injectable, Logger, ForbiddenException, NotFoundException } from "@nestjs/common";
import type { GameState, GameAction } from "@monopoly/shared";
import { GameRepository } from "../db/repositories/game.repository";
import { GameInitializerService } from "./game-initializer.service";

/**
 * Главный оркестратор партий.
 *
 * Ответственности:
 *  - Создание новой партии (`createGame`).
 *  - Доступ к текущему `GameState` с in-memory кешем (`getGameState`).
 *  - Применение действий игрока с валидацией (`applyAction`):
 *      * проверка, что это ход именно текущего игрока;
 *      * проверка, что игрок не обанкротился;
 *      * инкремент `version` (используется для оптимистической блокировки
 *        в `GameRepository.updateSnapshot`).
 *  - Сохранение snapshot в БД после каждого действия.
 *
 * Кеш `activeGames` — простой `Map` в памяти процесса. При перезапуске
 * сервера он восстанавливается через `getGameState` (lazy load из БД).
 * Если в будущем переедем на Redis — заменим на `cache-manager-redis-yet@^5`,
 * совместимый с `@nestjs/common@11` из коробки.
 */
@Injectable()
export class GamesService {
  private readonly logger = new Logger(GamesService.name);
  private activeGames = new Map<string, GameState>();

  constructor(
    private readonly repo: GameRepository,
    private readonly initializer: GameInitializerService,
  ) {}

  /**
   * Создать новую партию.
   * Возвращает реальный `gameId` (uuid из БД) и финальный `GameState`.
   */
  async createGame(
    playerNames: string[],
    hostUserId?: string,
  ): Promise<{ gameId: string; state: GameState }> {
    // Шаг 1: инициализация в памяти (id-плейсхолдер, доска заполнена).
    const state = this.initializer.createInitialState(playerNames, hostUserId);

    // Шаг 2: переводим партию в активное состояние.
    state.status = "active";
    state.phase = "ROLLING";

    // Шаг 3: пишем в БД. `repo.create` сам генерирует криптостойкий seed,
    // сохраняет `rng_seed` и возвращает строку с реальным `id` (uuid).
    const dbGame = await this.repo.create(state, hostUserId, state.seed);

    // Шаг 4: подменяем id в snapshot на боевой (тот, что в БД).
    state.id = dbGame.id;
    state.seed = dbGame.rngSeed;

    this.activeGames.set(dbGame.id, state);
    this.logger.log(`Game created: ${dbGame.id}`);

    return { gameId: dbGame.id, state };
  }

  /**
   * Получить текущее состояние партии.
   * Сначала ищем в кеше, иначе — lazy load из БД и кладём в кеш.
   */
  async getGameState(gameId: string): Promise<GameState | null> {
    if (this.activeGames.has(gameId)) {
      return this.activeGames.get(gameId)!;
    }
    const game = await this.repo.findById(gameId);
    if (!game) return null;
    const state = game.stateSnapshot as GameState;
    this.activeGames.set(gameId, state);
    return state;
  }

  /**
   * Применить действие игрока.
   *
   * Контракт:
   *  - `gameId` — партия;
   *  - `playerId` — кто запрашивает действие (должен совпадать с текущим);
   *  - `action` — команда из дискриминированного union `GameAction`.
   *
   * На каждый вызов:
   *  - подгружается state (из кеша или из БД);
   *  - проверяется право хода;
   *  - мутируется state;
   *  - инкрементируется `version`;
   *  - snapshot сохраняется в БД с оптимистической блокировкой.
   */
  async applyAction(
    gameId: string,
    playerId: string,
    action: GameAction,
  ): Promise<{ state: GameState }> {
    let state = this.activeGames.get(gameId);
    if (!state) {
      const loaded = await this.getGameState(gameId);
      if (!loaded) throw new NotFoundException("Партия не найдена");
      state = loaded;
    }

    const currentPlayer = state.players[state.currentPlayerIndex];
    if (!currentPlayer) {
      throw new ForbiddenException("В партии нет игроков");
    }
    if (currentPlayer.id !== playerId) {
      throw new ForbiddenException("Сейчас не ваш ход");
    }
    // Защита: обанкротившийся игрок не может совершать действия.
    if (currentPlayer.isBankrupt) {
      throw new ForbiddenException("Игрок обанкротился");
    }

    this.logger.debug(`Action: ${action.type} by ${playerId}`);

    switch (action.type) {
      case "ROLL_DICE":
        // TODO (Шаг 27/28): бросок кубиков + анимированное движение.
        break;
      case "BUY_PROPERTY":
        // TODO: логика покупки.
        break;
      case "DECLINE_BUY":
        // TODO: переход в аукцион/следующую фазу.
        break;
      case "PAY_JAIL_FINE":
        // TODO: списание 50 и выход из тюрьмы.
        break;
      case "USE_JAIL_CARD":
        // TODO: использование карточки выхода из тюрьмы.
        break;
      case "BUILD_HOUSE":
        // TODO: проверка правил строительства.
        break;
      case "END_TURN":
        // Пропускаем обанкротившихся игроков (ВАЖНО: не удаляем из массива,
        // чтобы не сдвигать currentPlayerIndex — см. `BankruptcyService`).
        do {
          state.currentPlayerIndex = (state.currentPlayerIndex + 1) % state.players.length;
        } while (state.players[state.currentPlayerIndex]?.isBankrupt);
        if (state.currentPlayerIndex === 0) state.round++;
        state.phase = "ROLLING";
        break;
    }

    state.version++;
    state.lastActivityAt = new Date().toISOString();

    // Сохраняем новую версию. `expectedVersion` = state.version - 1
    // — это та версия, на которой мы читали state.
    await this.repo.updateSnapshot(gameId, state, state.version - 1);

    return { state };
  }

  /**
   * Удалить партию из in-memory кеша (например, при завершении или
   * ручном сбросе). Полезно для тестов и для будущего WebSocket Gateway,
   * который будет вызывать это при отключении всех клиентов.
   */
  removeFromCache(gameId: string) {
    this.activeGames.delete(gameId);
  }
}
