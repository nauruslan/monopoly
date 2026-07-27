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

// Данные: раскладка клеток на сетке 11x11 и сектор клетки
// (используется для grid-позиционирования в Board.vue и для расчёта
// позиции всплывающих подсказок CellTooltip с учётом границ доски).
export { getCellGridPos, getCellSide } from "./data/board-layout";
export type { BoardSide, GridPos } from "./data/board-layout";

// Данные: таблицы ренты (RAILROAD, UTILITY, ставка выкупа)
export {
  RAILROAD_RENT_BY_COUNT,
  UTILITY_MULTIPLIER_BY_COUNT,
  UNMORTGAGE_INTEREST_RATE,
} from "./data/rent-tables";

// Данные: карточки
export { CHANCE_CARDS, TREASURY_CARDS, LUXURY_TAX_CARDS, shuffle, drawCard } from "./data/cards";
export type { Card, CardEffect } from "./data/cards";
