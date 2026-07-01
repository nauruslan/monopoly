import { Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { DbService } from "../db.service";
import { users, type DbUser } from "../schema";

@Injectable()
export class UserRepository {
  constructor(private readonly dbService: DbService) {}

  private get db() {
    return this.dbService.db;
  }

  async create(data: Partial<DbUser>): Promise<DbUser> {
    const [user] = await this.db
      .insert(users)
      .values(data as any)
      .returning();
    return user;
  }

  async findByEmail(email: string): Promise<DbUser | undefined> {
    const [user] = await this.db.select().from(users).where(eq(users.email, email));
    return user;
  }

  async findById(id: string): Promise<DbUser | undefined> {
    const [user] = await this.db.select().from(users).where(eq(users.id, id));
    return user;
  }

  async findByGuestId(guestId: string): Promise<DbUser | undefined> {
    const [user] = await this.db.select().from(users).where(eq(users.guestId, guestId));
    return user;
  }
}
