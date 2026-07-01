import { Global, Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { AuthModule } from "./auth/auth.module";
import { GamesModule } from "./games/games.module";
import { GameRepository } from "./db/repositories/game.repository";
import { DbService } from "./db/db.service";

/**
 * Корневой модуль приложения.
 *
 * Помечен `@Global()`, чтобы `DbService` и `GameRepository` были доступны
 * во всех feature-модулях (`AuthModule`, `GamesModule`, ...) без явного
 * импорта. Это намеренное архитектурное решение — общие репозитории
 * инфраструктуры живут здесь и не должны дублироваться.
 */
@Global()
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ["../../.env", ".env"],
    }),
    AuthModule,
    GamesModule,
  ],
  providers: [DbService, GameRepository],
  exports: [DbService, GameRepository],
})
export class AppModule {}
