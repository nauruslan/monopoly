import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { AuthModule } from "./auth/auth.module";
import { GamesModule } from "./games/games.module";
import { GameRepository } from "./db/repositories/game.repository";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ["../../.env", ".env"],
    }),
    AuthModule,
    GamesModule,
  ],
  providers: [GameRepository],
  exports: [GameRepository],
})
export class AppModule {}
