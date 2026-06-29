import type { Player } from "../types/player";
import type { GameState } from "../types/game";

export type BotAction = "ROLL" | "BUY" | "END_TURN";

export function decideBotAction(player: Player, state: GameState): BotAction {
  const cell = state.board[player.position];
  if (!cell) return "END_TURN";

  if (
    (cell.type === "PROPERTY" || cell.type === "RAILROAD" || cell.type === "UTILITY") &&
    !cell.ownerId &&
    cell.price !== undefined &&
    player.money >= cell.price + 200
  ) {
    return "BUY";
  }

  return "END_TURN";
}
