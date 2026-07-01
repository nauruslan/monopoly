// GameAction — дискриминированное объединение игровых команд,
// которые клиент отправляет на сервер через WebSocket (или REST).
// Сервер (`GamesService.applyAction`) использует поле `type` для
// маршрутизации обработки. Неизвестные `type` отклоняются.

export type GameAction =
  | { type: "ROLL_DICE" }
  | { type: "BUY_PROPERTY" }
  | { type: "DECLINE_BUY" }
  | { type: "END_TURN" }
  | { type: "PAY_JAIL_FINE" }
  | { type: "USE_JAIL_CARD" }
  | { type: "BUILD_HOUSE"; cellId: number };
