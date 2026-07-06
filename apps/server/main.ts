import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ValidationPipe, Logger } from "@nestjs/common";
import { AppModule } from "./app.module";

async function bootstrap() {
  const logger = new Logger("Bootstrap");
  const app = await NestFactory.create(AppModule);

  // CORS — позволяет фронтенду на http://localhost:5173 обращаться к API
  app.enableCors({
    origin: process.env.CLIENT_URL || "http://localhost:5173",
    credentials: true,
  });

  // Глобальный ValidationPipe — валидирует все DTO
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const port = parseInt(process.env.PORT || "3000", 10);
  await app.listen(port);
  logger.log(`🚀 Сервер запущен на http://localhost:${port}`);
}

bootstrap().catch((err) => {
  console.error("❌ Ошибка запуска:", err);
  process.exit(1);
});
