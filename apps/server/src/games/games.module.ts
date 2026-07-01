import { Module } from "@nestjs/common";
import { GamesService } from "./games.service";
import { GameInitializerService } from "./game-initializer.service";
import { JailHandlerService } from "./handlers/jail-handler.service";
import { CardHandlerService } from "./handlers/card-handler.service";
import { RentCalculator } from "./handlers/rent-calculator";
import { BankruptcyService } from "./handlers/bankruptcy.service";

/**
 * GamesModule — игровое ядро сервера.
 *
 * Регистрирует оркестратор (`GamesService`) и все хендлеры отдельных
 * механик. `GameRepository` и `DbService` НЕ объявляем здесь повторно —
 * они уже зарегистрированы в `AppModule` как глобальные провайдеры
 * (см. `app.module.ts`).
 *
 * Экспортируем `GamesService`, чтобы будущий WebSocket Gateway
 * (Шаг 27) мог его инжектить.
 */
@Module({
  providers: [
    GamesService,
    GameInitializerService,
    JailHandlerService,
    CardHandlerService,
    RentCalculator,
    BankruptcyService,
  ],
  exports: [GamesService],
})
export class GamesModule {}
