import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url:
      process.env.DATABASE_URL || "postgresql://monopoly:monopoly_dev_pwd@localhost:5432/monopoly",
  },
  casing: "snake_case",
});
