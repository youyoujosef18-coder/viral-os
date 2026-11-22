import postgres from "postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import * as schema from "./schema";
import { env } from "../env";

export type Database = PostgresJsDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type Executor = Database | Tx;

type Globals = { __viralSql?: ReturnType<typeof postgres>; __viralDb?: Database };
const g = globalThis as unknown as Globals;

function createClient() {
  const e = env();
  const client = postgres(e.DATABASE_URL, {
    max: e.NODE_ENV === "production" ? 10 : 5,
    // Supabase transaction pooler (port 6543) does not support prepared statements.
    prepare: e.DATABASE_POOLER !== "true",
    idle_timeout: 20,
    connect_timeout: 15,
    onnotice: () => {},
  });
  return client;
}

/**
 * Service-level database handle. It bypasses RLS (connection role owns the tables),
 * so it is ONLY used by background workers and auth internals, and every query
 * issued through it must filter by user_id explicitly.
 */
export function serviceDb(): Database {
  if (!g.__viralDb) {
    g.__viralSql = createClient();
    g.__viralDb = drizzle(g.__viralSql, { schema });
  }
  return g.__viralDb;
}

/**
 * Run `fn` inside a transaction as the Postgres role `authenticated` with the
 * Supabase-compatible JWT claims set, so Row Level Security policies
 * (`user_id = auth.uid()`) are enforced by the database itself.
 */
export async function withUser<T>(userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!/^[0-9a-f-]{36}$/i.test(userId)) throw new Error("withUser: invalid user id");
  return serviceDb().transaction(async (tx) => {
    const claims = JSON.stringify({ sub: userId, role: "authenticated" });
    await tx.execute(sql`select set_config('request.jwt.claims', ${claims}, true)`);
    await tx.execute(sql`set local role authenticated`);
    return fn(tx);
  });
}

export async function closeDb() {
  if (g.__viralSql) {
    await g.__viralSql.end({ timeout: 5 });
    g.__viralSql = undefined;
    g.__viralDb = undefined;
  }
}

export { schema };
