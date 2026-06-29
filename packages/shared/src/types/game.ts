import type { Player } from "./player";
import type { Cell } from "./cell";

/**
 * Phase — перечисление всех фаз игрового цикла
 */
export type Phase =
  | "IDLE"
  | "ROLLING"
  | "MOVING"
  | "BUY_DECISION"
  | "BUILDING"
  | "JAIL_DECISION"
  | "CARD_ACTION"
  | "END_TURN"
  | "FINISHED";

/**
 * GameSettings — настройки партии
 */
export interface GameSettings {
  startingMoney: number;
  goSalary: number;
  housingLimit: "limited" | "unlimited";
  auctionEnabled: boolean;
  turnTimeoutMs: number;
  freeParkingVariant: "classic" | "tax-pot";
}

/**
 * GameState — главный объект состояния игры
 */
export interface GameState {
  id: string;
  version: number;
  status: "waiting" | "active" | "paused" | "finished";
  currentPlayerIndex: number;
  phase: Phase;
  round: number;
  players: Player[];
  board: Cell[];
  winnerId?: string;
  createdAt: string;
  lastActivityAt: string;
}

export const DEFAULT_SETTINGS: GameSettings = {
  startingMoney: 1500,
  goSalary: 200,
  housingLimit: "limited",
  auctionEnabled: true,
  turnTimeoutMs: 120000,
  freeParkingVariant: "classic",
};
