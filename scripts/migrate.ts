/**
 * Applies db/bootstrap.sql (idempotent Supabase-compat objects) and then all
 * Drizzle migrations in db/migrations. Usage: npm run db:migrate
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const client = postgres(url, { max: 1, onnotice: () => {}, prepare: process.env.DATABASE_POOLER !== "true" });
  try {
    const bootstrap = readFileSync(path.join(process.cwd(), "db/bootstrap.sql"), "utf8");
    await client.unsafe(bootstrap);
    console.log("✓ bootstrap applied");
    await migrate(drizzle(client), { migrationsFolder: path.join(process.cwd(), "db/migrations") });
    console.log("✓ migrations applied");
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
