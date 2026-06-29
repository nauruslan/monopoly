// Временная точка входа серверной части.
// В следующих шагах сюда добавятся: NestFactory, JWT-аутентификация,
// Drizzle-ORM и WebSocket-гейтвеи для игровой логики.

import { BOARD } from "@monopoly/shared";

function main(): void {
  // eslint-disable-next-line no-console
  console.info(
    `[server] bootstrap ok; board has ${BOARD.length} cells. ` +
      `Real implementation comes in Step 22+.`,
  );
}

main();