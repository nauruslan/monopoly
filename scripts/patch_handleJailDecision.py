# -*- coding: utf-8 -*-
"""
Меняет games.service.ts:
  1. handleStartTurn: при начале хода игрока в тюрьме сбрасывает justEnteredJail=false.
  2. handleJailDecision: если state.justEnteredJail === true,
     разрешает только END_TURN / CONFIRM_END_TURN (а потом advanceToNextPlayer).
"""
import re
from pathlib import Path

PATH = Path("apps/server/src/games/games.service.ts")
src = PATH.read_text(encoding="utf-8")

# --- 1) handleStartTurn patch ---
old_start = (
    "    player.mustRollAgain = false;\n"
    "    player.consecutiveDoubles = 0;\n"
    "    if (player.inJail) {\n"
    "      state.phase = \"JAIL_DECISION\";\n"
    "    } else {\n"
    "      state.phase = \"ROLLING\";\n"
    "    }\n"
    "    return {};\n"
    "  }"
)
new_start = (
    "    player.mustRollAgain = false;\n"
    "    player.consecutiveDoubles = 0;\n"
    "    if (player.inJail) {\n"
    "      // Начался СЛЕДУЮЩИЙ ход в тюрьме — теперь игрок может выбирать способ выхода.\n"
    "      // Флаг свежего попадания должен быть сброшен.\n"
    "      state.justEnteredJail = false;\n"
    "      state.phase = \"JAIL_DECISION\";\n"
    "    } else {\n"
    "      state.phase = \"ROLLING\";\n"
    "    }\n"
    "    return {};\n"
    "  }"
)
assert old_start in src, "handleStartTurn pattern not found"
src = src.replace(old_start, new_start, 1)

# --- 2) handleJailDecision patch ---
old_jail = (
    "    if (!player.inJail) {\n"
    "      // Уже вышли — передаём ход.\n"
    "      this.advanceToNextPlayer(state);\n"
    "      state.phase = \"ROLLING\";\n"
    "      return {};\n"
    "    }\n"
    "\n"
    "    if (action.type === \"PAY_JAIL_FINE\") {"
)
new_jail = (
    "    if (!player.inJail) {\n"
    "      // Уже вышли — передаём ход.\n"
    "      this.advanceToNextPlayer(state);\n"
    "      state.phase = \"ROLLING\";\n"
    "      return {};\n"
    "    }\n"
    "\n"
    "    // Свежее попадание в тюрьму (в ЭТОМ ходу): по правилам Монополии\n"
    "    // игрок НЕ принимает решение о выходе в том же ходу — только END_TURN.\n"
    "    // Модалка с тремя способами выхода появится в начале СЛЕДУЮЩЕГО хода.\n"
    "    if (state.justEnteredJail) {\n"
    "      if (action.type === \"END_TURN\" || action.type === \"CONFIRM_END_TURN\") {\n"
    "        this.advanceToNextPlayer(state);\n"
    "        state.phase = \"ROLLING\";\n"
    "        return {};\n"
    "      }\n"
    "      throw new ForbiddenException(\n"
    "        `Только что попал в тюрьму — в этом ходу можно только завершить ход, а не ${action.type}`,\n"
    "      );\n"
    "    }\n"
    "\n"
    "    if (action.type === \"PAY_JAIL_FINE\") {"
)
assert old_jail in src, "handleJailDecision pattern not found"
src = src.replace(old_jail, new_jail, 1)

PATH.write_text(src, encoding="utf-8")
print("OK")
