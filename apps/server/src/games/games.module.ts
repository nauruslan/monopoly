import { Module } from "@nestjs/common";
import { GamesService } from "./games.service";
import { GameInitializerService } from "./game-initializer.service";
import { JailHandlerService } from "./handlers/jail-handler.service";
import { CardHandlerService } from "./handlers/card-handler.service";
import { RentCalculator } from "./handlers/rent-calculator";
import { BankruptcyService } from "./handlers/bankruptcy.service";
import { GameGateway } from "../gateways/game.gateway";
import { AuthModule } from "../auth/auth.module";

/**
 * GamesModule — игровое ядро сервера.
 *
 * Регистрирует оркестратор (`GamesService`) и все хендлеры отдельных
 * механик. `GameRepository` и `DbService` НЕ объявляем здесь повторно —
 * они уже зарегистрированы в `AppModule` как глобальные провайдеры
 * (`app.module.ts`).
 *
 * Содержит WebSocket-шлюз `GameGateway`, которому нужны
 * `GamesService` (для применения действий) и `AuthService` (для
 * верификации JWT при подключении). Оба берём через `imports: [AuthModule]`
 * (для `AuthService`) и текущий модуль (для `GamesService`).
 *
 * Экспортируем `GamesService` и `GameGateway`, чтобы другие модули
 * могли ими пользоваться.
 */
@Module({
  imports: [AuthModule],
  providers: [
    GamesService,
    GameInitializerService,
    JailHandlerService,
    CardHandlerService,
    RentCalculator,
    BankruptcyService,
    GameGateway,
  ],
  exports: [
    GamesService,
    GameGateway,
    // handler-ы экспортируем на случай будущих WS-команд (например,
    // "списать ренту" вне хода игрока).
    RentCalculator,
    JailHandlerService,
    CardHandlerService,
    BankruptcyService,
  ],
})
export class GamesModule {}
