import { Injectable } from "@nestjs/common";
import { randomUUID } from "crypto";
import type { GameState, Player, GameSettings, Cell } from "@monopoly/shared";
import { BOARD, DEFAULT_SETTINGS } from "@monopoly/shared";

/**
 * Сервис инициализации новой партии.
 *
 * Генерирует полностью готовый `GameState` с:
 *   - базовым `seed` (uuid v4) для будущего детерминированного replay;
 *   - игроками, распределёнными по цветам/иконкам;
 *   - доской `BOARD` с очищенными `ownerId` / `houses` / `isMortgaged`;
 *   - настройками по умолчанию (можно переопределить через `customSettings`).
 *
 * Возвращаемый `id` — это локальный uuid, который в `GamesService.createGame`
 * будет заменён на реальный id из БД .
 */
@Injectable()
export class GameInitializerService {
  createInitialState(
    playerNames: string[],
    hostUserId?: string,
    customSettings?: Partial<GameSettings>,
  ): GameState {
    const colors = [
      "#FF4D4D",
      "#4D9EFF",
      "#4CFF4C",
      "#FFD700",
      "#FF8C42",
      "#8152cf",
      "#ab90e3",
      "#22d3ee",
    ];
    const icons = ["🔴", "🔵", "🟢", "🟡", "🟠", "🟣", "🟤", "⚪"];

    // Берём DEFAULT_SETTINGS из shared, разрешаем переопределение
    // на уровне вызова (customSettings).
    const settings: GameSettings = {
      ...DEFAULT_SETTINGS,
      ...customSettings,
    };

    const players: Player[] = playerNames.map((name, i) => ({
      id: randomUUID(),
      displayName: name,
      kind: i === 0 && hostUserId ? "human" : "bot",
      color: colors[i % colors.length]!,
      icon: icons[i % icons.length]!,
      money: settings.startingMoney,
      position: 0,
      inJail: false,
      jailTurns: 0,
      jailCards: 0,
      properties: [],
      consecutiveDoubles: 0,
      isBankrupt: false,
    }));

    return {
      id: randomUUID(),
      version: 1,
      // `seed` здесь — placeholder. Реальный криптостойкий seed
      // генерируется в `GameRepository.create` и переписывается
      // в snapshot уже оттуда.
      seed: randomUUID(),
      status: "waiting",
      currentPlayerIndex: 0,
      phase: "IDLE",
      round: 1,
      players,
      // ВАЖНО: в нашей версии board заполняется ЗДЕСЬ (а не в GamesService.createGame).
      // Это безопаснее — инициализатор возвращает полностью готовый state.
      board: BOARD.map<Cell>((c) => ({
        ...c,
        ownerId: undefined,
        houses: 0,
        isMortgaged: false,
      })),
      settings,
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
    };
  }
}
