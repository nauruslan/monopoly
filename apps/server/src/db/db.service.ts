import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres, { PostgresError } from "postgres";
import * as schema from "./schema";

@Injectable()
export class DbService implements OnModuleDestroy {
  private client: postgres.Sql<Record<string, never>>;
  public db: ReturnType<typeof drizzle<typeof schema>>;

  constructor() {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL не задан в .env");
    }

    this.client = postgres(connectionString, {
      max: 10,
      idle_timeout: 30,
      prepare: false,
    });

    this.db = drizzle(this.client, { schema });
  }

  async onModuleDestroy() {
    await this.client.end();
  }
}