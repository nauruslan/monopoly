import { Injectable } from "@nestjs/common";
import { randomUUID } from "crypto";
import seedrandom from "seedrandom";
import type { GameState, Player, GameSettings, Cell, CardDeckState } from "@monopoly/shared";
import {
  BOARD,
  DEFAULT_SETTINGS,
  CHANCE_CARDS,
  TREASURY_CARDS,
  LUXURY_TAX_CARDS,
  shuffle,
} from "@monopoly/shared";

/**
 * Сервис инициализации новой партии.
 *
 * Генерирует полностью готовый `GameState` с:
 *   - базовым `seed` (uuid v4) для будущего детерминированного replay;
 *   - игроками, распределёнными по цветам/иконкам;
 *   - доской `BOARD` с очищенными `ownerId` / `houses` / `isMortgaged`;
 *   - настройками по умолчанию (можно переопределить через `customSettings`);
 *   - **перемешанными колодами карточек** (Шанс, Общественная казна,
 *     Роскошный налог) с курсором 0.
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

    // Колоды карточек (детерминированный shuffle по seed)
    // ВАЖНО: `seed` ниже — placeholder. Реальный seed
    // придёт из БД в GamesService.createGame, и тогда колоды будут
    // Перемешаны заново. Здесь же используем
    // временный seed, чтобы инициализатор оставался детерминированным и
    // юнит-тестируемым без обращения к БД.
    const tempSeed = randomUUID();
    const cardDecks = this.buildShuffledDecks(tempSeed);

    return {
      id: randomUUID(),
      version: 1,
      // `seed` здесь — placeholder. Реальный криптостойкий seed
      // генерируется в `GameRepository.create` и переписывается
      // в snapshot уже оттуда.
      seed: tempSeed,
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
      cardDecks,
    };
  }

  /**
   * Создаёт перемешанные колоды (Шанс / Казна / Роскошный налог)
   * на основе `seed`. Возвращаемый объект кладётся в `state.cardDecks`.
   *
   * Карты в колодах хранятся как массив `id`-шников; на сервере при
   * `drawFromDeck` мы ищем полный `Card` по id в соответствующей
   * константе из shared.
   */
  buildShuffledDecks(seed: string): GameState["cardDecks"] {
    const rngChance = seedrandom(`${seed}:deck:chance`);
    const rngTreasury = seedrandom(`${seed}:deck:treasury`);
    const rngLuxury = seedrandom(`${seed}:deck:luxury-tax`);

    const makeDeck = (cards: readonly { id: string }[], rng: () => number): CardDeckState => ({
      cards: shuffle(cards, rng).map((c) => c.id),
      cursor: 0,
    });

    return {
      chance: makeDeck(CHANCE_CARDS, rngChance),
      treasury: makeDeck(TREASURY_CARDS, rngTreasury),
      "luxury-tax": makeDeck(LUXURY_TAX_CARDS, rngLuxury),
    };
  }

  /**
   * Перетасовать колоды заново с использованием АКТУАЛЬНОГО `state.seed`.
   * Вызывается из `GamesService.createGame` сразу после того, как БД
   * вернула настоящий seed (или из `loadSnapshot` если колоды пустые).
   */
  reShuffleDecks(state: GameState): void {
    state.cardDecks = this.buildShuffledDecks(state.seed);
  }
}
