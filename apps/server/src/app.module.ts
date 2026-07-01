import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { AuthModule } from "./auth/auth.module";
import { GamesModule } from "./games/games.module";
import { GameRepository } from "./db/repositories/game.repository";
import { DbService } from "./db/db.service";

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
