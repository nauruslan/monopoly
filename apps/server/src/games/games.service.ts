import {
  Injectable,
  Logger,
  ForbiddenException,
  NotFoundException,
  BadRequestException,
  Inject,
  forwardRef,
} from "@nestjs/common";
import seedrandom from "seedrandom";
import type { GameState, GameAction, Player } from "@monopoly/shared";
import { GameRepository } from "../db/repositories/game.repository";
import { GameInitializerService } from "./game-initializer.service";
import { RentCalculator } from "./handlers/rent-calculator";
import { JailHandlerService } from "./handlers/jail-handler.service";
import { CardHandlerService } from "./handlers/card-handler.service";
import { BankruptcyService } from "./handlers/bankruptcy.service";

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
 */
@Injectable()
export class GamesService {
  private readonly logger = new Logger(GamesService.name);
  private activeGames = new Map<string, GameState>();
  /**
   * Маппинг `gameId → (userId → playerId)`. Нужен, потому что в
   * `Player` нет поля `userId` (это shared-тип), а `GameGateway.onAction`
   * получает только `userId` из JWT и должен понять, какой именно
   * `player.id` этому пользователю принадлежит в конкретной партии.
   *
   * ВНИМАНИЕ: в текущей версии маппинг хранит только host-игрока
   * (того, кто вызвал `lobby:create`). Другие игроки подключаются
   * как боты до реализации `lobby:join`.
   */
  private userToPlayer = new Map<string, Map<string, string>>();

  constructor(
    @Inject(forwardRef(() => GameRepository)) private readonly repo: GameRepository,
    @Inject(forwardRef(() => GameInitializerService))
    private readonly initializer: GameInitializerService,
    @Inject(forwardRef(() => RentCalculator))
    private readonly rentCalc: RentCalculator,
    @Inject(forwardRef(() => JailHandlerService))
    private readonly jail: JailHandlerService,
    @Inject(forwardRef(() => CardHandlerService))
    private readonly cards: CardHandlerService,
    @Inject(forwardRef(() => BankruptcyService))
    private readonly bankruptcy: BankruptcyService,
  ) {
    if (!this.rentCalc) console.error("[GamesService] RentCalculator не заинжектирован!");
    if (!this.jail) console.error("[GamesService] JailHandlerService не заинжектирован!");
    if (!this.cards) console.error("[GamesService] CardHandlerService не заинжектирован!");
    if (!this.bankruptcy) console.error("[GamesService] BankruptcyService не заинжектирован!");
    if (!this.initializer) {
      console.error("[GamesService] GameInitializerService не заинжектирован!");
    }
    if (!this.repo) {
      console.error("[GamesService] GameRepository не заинжектирован!");
    }
  }

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

    // Заполняем маппинг `userId → playerId` для хоста, чтобы
    // `GameGateway.onAction` мог резолвить `playerId` по `userId` из JWT.
    // Без этого `resolvePlayerId()` вернёт `null` и `onAction` отклонит
    // любое действие с ошибкой «Это не ваш игрок в этой партии».
    if (hostUserId) {
      const host = state.players[0];
      if (host) {
        const map = new Map<string, string>();
        map.set(hostUserId, host.id);
        this.userToPlayer.set(dbGame.id, map);
      }
    }

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

    // Восстанавливаем маппинг `userId → playerId` из БД, чтобы после
    // рестарта сервера `onAction` мог резолвить host-игрока.
    if (game.hostId && state.players[0] && !this.userToPlayer.has(gameId)) {
      const map = new Map<string, string>();
      map.set(game.hostId, state.players[0].id);
      this.userToPlayer.set(gameId, map);
    }

    return state;
  }

  /**
   * Резолвит `playerId` для конкретного `userId` в конкретной партии.
   * Используется `GameGateway.onAction`, чтобы понять, кто из игроков
   * отправил действие. В shared-типе `Player` нет поля `userId`, поэтому
   * храним маппинг отдельно (наполняется в `createGame`).
   *
   * Это заменится на полноценную таблицу участников
   * с поддержкой `lobby:join` для нескольких human-игроков.
   */
  resolvePlayerId(gameId: string, userId: string): string | null {
    return this.userToPlayer.get(gameId)?.get(userId) ?? null;
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
  ): Promise<{ state: GameState; dice?: [number, number]; card?: unknown }> {
    // 1) Загрузить state (из кеша или БД).
    let state = this.activeGames.get(gameId);
    if (!state) {
      const loaded = await this.getGameState(gameId);
      if (!loaded) throw new NotFoundException("Партия не найдена");
      state = loaded;
    }

    // 2) Найти игрока.
    const player = state.players.find((p) => p.id === playerId);
    if (!player) throw new NotFoundException("Игрок не найден в партии");
    this.assertCanAct(state, player);

    // 3) Проверить, что ход именно этого игрока.
    const currentPlayer = state.players[state.currentPlayerIndex];
    if (currentPlayer.id !== player.id) {
      throw new ForbiddenException("Сейчас не ваш ход");
    }

    this.logger.debug(`Action: ${action.type} by ${playerId}`);

    let dice: [number, number] | undefined;
    let drawnCard: unknown;

    switch (action.type) {
      case "ROLL_DICE": {
        if (state.phase !== "ROLLING") {
          throw new ForbiddenException(`Нельзя бросить кости в фазе ${state.phase}`);
        }

        // Спец-логика для тюрьмы.
        if (player.inJail) {
          dice = this.roll(state);
          const outcome = this.jail.tryDoubleOrPay(player, dice);
          if (outcome === "escape" || outcome === "pay") {
            player.inJail = false;
          } else {
            // "stay" — остаётся в тюрьме, передаём ход.
            this.nextPlayer(state);
            state.phase = "ROLLING";
            break;
          }
        } else {
          dice = this.roll(state);
        }

        // Правило 3 дублей.
        if (dice[0] === dice[1]) {
          player.consecutiveDoubles += 1;
          if (player.consecutiveDoubles >= 3) {
            this.jail.sendToJail(player);
            player.consecutiveDoubles = 0;
            state.phase = "JAIL_DECISION";
            break;
          }
        } else {
          player.consecutiveDoubles = 0;
        }

        // Движение по доске.
        const steps = dice[0] + dice[1];
        const oldPos = player.position;
        const newPos = (oldPos + steps) % 40;

        // Анимация: для server-side state не нужна, просто сразу перемещаем.
        player.position = newPos;

        // Прохождение GO → зарплата.
        if (newPos < oldPos || oldPos + steps >= 40) {
          player.money += state.settings.goSalary;
        }

        // Обработка клетки, на которую встали.
        const cell = state.board[newPos];
        if (!cell) break;

        // Налоги.
        if (cell.type === "TAX" && cell.taxAmount) {
          player.money = Math.max(0, player.money - cell.taxAmount);
          if (player.money === 0) {
            this.bankruptcy.handle(state, player, null);
          }
          state.phase = "ROLLING";
          this.nextPlayerIfBankrupt(state);
          break;
        }

        // GOTO_JAIL.
        if (cell.type === "GOTO_JAIL") {
          this.jail.sendToJail(player);
          state.phase = "JAIL_DECISION";
          break;
        }

        // CHANCE / TREASURY.
        if (cell.type === "CHANCE" || cell.type === "TREASURY") {
          drawnCard = this.cards.draw(
            cell.type === "CHANCE" ? "chance" : "treasury",
            player,
            state,
          );
          state.phase = "BUILDING";
          break;
        }

        // JAIL (клетка-просто-visit, не GOTO_JAIL) — ничего не делаем.
        if (cell.type === "JAIL") {
          state.phase = "ROLLING";
          break;
        }

        // PROPERTY / RAILROAD / UTILITY.
        if (cell.type === "PROPERTY" || cell.type === "RAILROAD" || cell.type === "UTILITY") {
          if (!cell.ownerId) {
            // Ничья — переходим в фазу решения о покупке.
            state.phase = "BUY_DECISION";
          } else if (cell.ownerId === player.id) {
            // Своя клетка — можно строить.
            state.phase = "BUILDING";
          } else {
            // Чужая — платим ренту.
            const rent = this.rentCalc.calculate(cell, state, dice);
            if (rent > 0) {
              const owner = state.players.find((p) => p.id === cell.ownerId);
              if (owner) {
                player.money = Math.max(0, player.money - rent);
                owner.money += rent;
                if (player.money === 0) {
                  this.bankruptcy.handle(state, player, owner);
                }
              }
            }
            state.phase = "ROLLING";
            this.nextPlayerIfBankrupt(state);
          }
          break;
        }

        // GO / FREE_PARKING — ничего.
        state.phase = "ROLLING";
        break;
      }

      case "BUY_PROPERTY": {
        if (state.phase !== "BUY_DECISION") {
          throw new ForbiddenException(`Сейчас нельзя покупать (фаза ${state.phase})`);
        }
        const cell = state.board[player.position];
        if (!cell) throw new NotFoundException("Клетка не найдена");
        if (cell.ownerId) throw new ForbiddenException("Клетка уже куплена");
        if (cell.price === undefined) throw new BadRequestException("Клетка не продаётся");
        if (player.money < cell.price) {
          throw new ForbiddenException("Недостаточно денег");
        }
        player.money -= cell.price;
        player.properties.push(cell.id);
        cell.ownerId = player.id;
        state.phase = "BUILDING";
        break;
      }

      case "DECLINE_BUY": {
        if (state.phase !== "BUY_DECISION") {
          throw new ForbiddenException(`Сейчас нельзя отказаться от покупки (фаза ${state.phase})`);
        }
        // TODO (Step28.2): если settings.auctionEnabled — запуск аукциона.
        // Сейчас просто переходим к следующей фазе.
        state.phase = "ROLLING";
        this.nextPlayerIfBankrupt(state);
        break;
      }

      case "PAY_JAIL_FINE": {
        if (!player.inJail) throw new ForbiddenException("Игрок не в тюрьме");
        if (player.money < 50) throw new ForbiddenException("Недостаточно денег");
        player.money -= 50;
        player.inJail = false;
        player.jailTurns = 0;
        state.phase = "ROLLING";
        break;
      }

      case "USE_JAIL_CARD": {
        if (!player.inJail) throw new ForbiddenException("Игрок не в тюрьме");
        if (player.jailCards === 0) throw new ForbiddenException("Нет карточек выхода");
        player.jailCards -= 1;
        player.inJail = false;
        player.jailTurns = 0;
        state.phase = "ROLLING";
        break;
      }

      case "BUILD_HOUSE": {
        const cell = state.board[action.cellId];
        if (!cell) throw new NotFoundException("Клетка не найдена");
        if (cell.ownerId !== player.id) throw new ForbiddenException("Это не ваша клетка");
        if (cell.type !== "PROPERTY")
          throw new BadRequestException("На этой клетке нельзя строить");
        if (!this.rentCalc.ownsMonopoly(cell, player, state)) {
          throw new ForbiddenException("Нет монополии");
        }
        if (cell.houses >= 5) throw new ForbiddenException("Уже отель");
        if (cell.housePrice === undefined) throw new BadRequestException("Нет цены дома");
        if (player.money < cell.housePrice) throw new ForbiddenException("Недостаточно денег");

        // Правило равномерной застройки: houses не могут отличаться > 1.
        if (cell.group) {
          const groupCells = state.board.filter((c) => c.group === cell.group);
          const minHouses = Math.min(...groupCells.map((c) => c.houses));
          if (cell.houses > minHouses) {
            throw new ForbiddenException("Сначала постройте дома на других клетках группы");
          }
        }

        player.money -= cell.housePrice;
        cell.houses = (cell.houses + 1) as 0 | 1 | 2 | 3 | 4 | 5;
        state.phase = "BUILDING";
        break;
      }

      case "END_TURN": {
        // Пропускаем обанкротившихся игроков (ВАЖНО: не удаляем из массива,
        // чтобы не сдвигать currentPlayerIndex — см. `BankruptcyService`).
        this.nextPlayerIfBankrupt(state);
        state.phase = "ROLLING";
        break;
      }

      default: {
        // exhaustive check
        const _exhaustive: never = action;
        throw new BadRequestException(`Unknown action: ${JSON.stringify(_exhaustive)}`);
      }
    }

    state.version++;
    state.lastActivityAt = new Date().toISOString();

    // Сохраняем новую версию. `expectedVersion` = state.version - 1
    // — это та версия, на которой мы читали state.
    await this.repo.updateSnapshot(gameId, state, state.version - 1);

    return { state, dice, card: drawnCard };
  }

  /** Детерминированный RNG на основе state.seed. */
  private rng(state: GameState) {
    return seedrandom(state.seed);
  }

  /** Бросить 2 кости через seeded RNG. */
  private roll(state: GameState): [number, number] {
    const r = this.rng(state);
    const d1 = Math.floor(r() * 6) + 1;
    const d2 = Math.floor(r() * 6) + 1;
    return [d1, d2];
  }

  /** Проверить, что player может действовать (не обанкротился, партия активна). */
  private assertCanAct(state: GameState, player: Player) {
    if (state.status !== "active") {
      throw new ForbiddenException("Партия не активна");
    }
    if (player.isBankrupt) {
      throw new ForbiddenException("Игрок обанкротился");
    }
  }

  /** Передать ход следующему живому игроку. */
  private nextPlayer(state: GameState) {
    do {
      state.currentPlayerIndex = (state.currentPlayerIndex + 1) % state.players.length;
    } while (state.players[state.currentPlayerIndex]?.isBankrupt);
    if (state.currentPlayerIndex === 0) state.round++;
  }

  /** nextPlayer + обновление winnerId, если остался 1 игрок. */
  private nextPlayerIfBankrupt(state: GameState) {
    this.nextPlayer(state);
    const alive = state.players.filter((p) => !p.isBankrupt);
    if (alive.length === 1 && state.status === "active") {
      state.status = "finished";
      state.winnerId = alive[0]!.id;
    }
  }

  /**
   * Удалить партию из in-memory кеша (например, при завершении или
   * ручном сбросе). Полезно для тестов и для будущего WebSocket Gateway,
   * который будет вызывать это при отключении всех клиентов.
   */
  removeFromCache(gameId: string) {
    this.activeGames.delete(gameId);
    this.userToPlayer.delete(gameId);
  }
}
