import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  jsonb,
  integer,
  boolean,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const createdAt = () =>
  timestamp("created_at", { mode: "date", withTimezone: true }).notNull().defaultNow();

/**
 * users — таблица пользователей
 */
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: varchar("email", { length: 255 }).unique(),
    displayName: varchar("display_name", { length: 64 }).notNull(),
    passwordHash: varchar("password_hash", { length: 255 }),
    isGuest: boolean("is_guest").notNull().default(false),
    guestId: uuid("guest_id").unique(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("users_guest_id_idx").on(t.guestId)],
);

/**
 * games — таблица партий
 */
export const games = pgTable(
  "games",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    hostId: uuid("host_id").references(() => users.id),
    status: varchar("status", { length: 16 }).notNull().default("waiting"),
    stateSnapshot: jsonb("state_snapshot").notNull(),
    rngSeed: varchar("rng_seed", { length: 64 }).notNull(),
    rngCursor: integer("rng_cursor").notNull().default(0),
    version: integer("version").notNull().default(1),
    winnerId: uuid("winner_id").references(() => users.id),
    createdAt: createdAt(),
    lastActivityAt: timestamp("last_activity_at", {
      mode: "date",
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", {
      mode: "date",
      withTimezone: true,
    }),
  },
  (t) => [index("games_status_idx").on(t.status), index("games_activity_idx").on(t.lastActivityAt)],
);

/**
 * gamePlayers — связь между играми и игроками
 */
export const gamePlayers = pgTable(
  "game_players",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    gameId: uuid("game_id")
      .notNull()
      .references(() => games.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id),
    playerId: varchar("player_id", { length: 64 }).notNull(),
    seat: integer("seat").notNull(),
    isBot: boolean("is_bot").notNull().default(false),
    botLevel: varchar("bot_level", { length: 16 }),
  },
  (t) => [
    index("gp_game_seat_idx").on(t.gameId, t.seat),
    // Уникальный (game_id, seat) — гарантирует, что в одной партии
    // на одном месте сидит максимум один игрок. Защита от race condition
    // при одновременной посадке двух клиентов на один seat.
    uniqueIndex("gp_game_seat_unique_idx").on(t.gameId, t.seat),
  ],
);

/**
 * gameEvents — лог событий (для replay)
 */
export const gameEvents = pgTable(
  "game_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    gameId: uuid("game_id")
      .notNull()
      .references(() => games.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    type: varchar("type", { length: 64 }).notNull(),
    payload: jsonb("payload").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("ge_game_seq_idx").on(t.gameId, t.seq)],
);

/**
 * refreshTokens — для refresh JWT
 */
export const refreshTokens = pgTable("refresh_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  tokenHash: varchar("token_hash", { length: 255 }).notNull(),
  expiresAt: timestamp("expires_at", {
    mode: "date",
    withTimezone: true,
  }).notNull(),
  createdAt: createdAt(),
});

export type DbUser = typeof users.$inferSelect;
export type DbGame = typeof games.$inferSelect;
export type DbGamePlayer = typeof gamePlayers.$inferSelect;
export type DbGameEvent = typeof gameEvents.$inferSelect;
export type DbRefreshToken = typeof refreshTokens.$inferSelect;
