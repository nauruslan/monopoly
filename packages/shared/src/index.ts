// Barrel-индекс для shared-пакета.
// Один импорт: import { Player, Cell, BOARD } from "@monopoly/shared";

// Типы: клетки
export type { Cell, CellType, PropertyGroup } from "./types/cell";

// Типы: игроки
export type { Player, PlayerKind } from "./types/player";

// Типы: игра
export type {
  GameState,
  GameSettings,
  Phase,
  TradeOffer,
  CardDeckState,
  AuctionActionLogEntry,
} from "./types/game";
export { DEFAULT_SETTINGS } from "./types/game";

// Типы: действия
export type { GameAction } from "./types/action";

// Типы: события
export type { GameEvent, GameEventKind } from "./types/event";

// Данные: доска
export { BOARD } from "./data/board";

// Данные: карточки
export { CHANCE_CARDS, TREASURY_CARDS, LUXURY_TAX_CARDS, shuffle, drawCard } from "./data/cards";
export type { Card, CardEffect } from "./data/cards";
