/**
 * Фабрики для тестов: детерминированный GameState / Cell / Player
 * без зависимостей от БД и сетевого слоя.
 */
import type { Cell, GameState, Player, PropertyGroup, TradeOffer } from "@monopoly/shared";
import { DEFAULT_SETTINGS } from "@monopoly/shared";

let cellCounter = 0;
let playerCounter = 0;

/**
 * Создать "доску" — массив из `count` клеток.
 * По умолчанию — это PROPERTY с `group = "test"`, чтобы все
 * бот-решения относительно групп работали предсказуемо.
 *
 * `ownerId` по умолчанию НЕ задан (`undefined`), что соответствует
 * `Cell.ownerId: string | undefined`. Если тесту нужно "null" —
 * передавайте явно: `makeCell({ ownerId: null })`.
 */
export function makeCell(overrides: Partial<Cell> = {}): Cell {
  cellCounter += 1;
  const { ownerId, ...rest } = overrides;
  return {
    id: overrides.id ?? cellCounter - 1,
    type: "PROPERTY",
    name: overrides.name ?? `Cell ${cellCounter - 1}`,
    color: overrides.color ?? "#888",
    group: overrides.group ?? ("brown" as PropertyGroup),
    price: overrides.price ?? 200,
    rent: overrides.rent ?? 20,
    isMortgaged: overrides.isMortgaged ?? false,
    houses: overrides.houses ?? 0,
    housePrice: overrides.housePrice ?? 50,
    mortgageValue: overrides.mortgageValue ?? 100,
    ...rest,
    ...(ownerId !== undefined ? { ownerId } : {}),
  } as Cell;
}

/**
 * Создать доску из `count` клеток, все — PROPERTY одной группы.
 * Используется для тестов монополии.
 */
export function makeMonopolyBoard(count = 3, group: PropertyGroup = "brown"): Cell[] {
  return Array.from({ length: count }, () =>
    makeCell({
      type: "PROPERTY",
      group,
      price: 200,
      rent: 20,
      housePrice: 50,
      mortgageValue: 100,
    }),
  );
}

export function makePlayer(overrides: Partial<Player> = {}): Player {
  playerCounter += 1;
  return {
    id: overrides.id ?? `p${playerCounter - 1}`,
    displayName: overrides.displayName ?? `Player ${playerCounter - 1}`,
    color: overrides.color ?? "#3366ff",
    kind: overrides.kind ?? "bot",
    position: overrides.position ?? 0,
    money: overrides.money ?? 1500,
    isBankrupt: overrides.isBankrupt ?? false,
    jailCards: overrides.jailCards ?? 0,
    inJail: overrides.inJail ?? false,
    jailTurns: overrides.jailTurns ?? 0,
    mustRollAgain: overrides.mustRollAgain ?? false,
    properties: overrides.properties ?? [],
    ...overrides,
  } as Player;
}

export function makeState(overrides: Partial<GameState> = {}): GameState {
  const players = overrides.players ?? [
    makePlayer({ id: "p0", kind: "human" }),
    makePlayer({ id: "p1" }),
  ];
  return {
    id: overrides.id ?? "g1",
    version: overrides.version ?? 1,
    status: overrides.status ?? "active",
    currentPlayerIndex: overrides.currentPlayerIndex ?? 0,
    phase: overrides.phase ?? "ROLLING",
    round: overrides.round ?? 1,
    players,
    board: overrides.board ?? makeMonopolyBoard(3),
    settings: { ...DEFAULT_SETTINGS, ...(overrides.settings ?? {}) },
    seed: overrides.seed ?? "test-seed",
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    lastActivityAt: overrides.lastActivityAt ?? new Date().toISOString(),
    ...overrides,
  } as GameState;
}

export function makeTradeOffer(overrides: Partial<TradeOffer> = {}): TradeOffer {
  return {
    fromProperties: overrides.fromProperties ?? [],
    fromCash: overrides.fromCash ?? 0,
    fromJailCards: overrides.fromJailCards ?? 0,
    toProperties: overrides.toProperties ?? [],
    toCash: overrides.toCash ?? 0,
    toJailCards: overrides.toJailCards ?? 0,
  };
}

export function resetCounters(): void {
  cellCounter = 0;
  playerCounter = 0;
}
