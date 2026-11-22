import { NextResponse } from "next/server";
import { connection } from "next/server";
import { sql } from "drizzle-orm";
import { serviceDb } from "@/lib/db/client";
import { getRedis } from "@/lib/queue/redis";

/** Liveness/readiness probe. Reports dependency status without exposing configuration values. */
export async function GET() {
  await connection();
  const checks: Record<string, { ok: boolean; detail?: string }> = {};
  try {
    await serviceDb().execute(sql`select 1`);
    checks.database = { ok: true };
  } catch (err) {
    checks.database = { ok: false, detail: (err as Error).message.slice(0, 120) };
  }
  const redis = getRedis();
  if (!redis) checks.redis = { ok: false, detail: "not configured" };
  else {
    try {
      await redis.ping();
      const beat = await redis.get("vos:worker:heartbeat");
      checks.redis = { ok: true };
      checks.worker = beat ? { ok: true, detail: `last heartbeat ${beat}` } : { ok: false, detail: "no heartbeat in the last 10 minutes" };
    } catch (err) {
      checks.redis = { ok: false, detail: (err as Error).message.slice(0, 120) };
    }
  }
  const ok = checks.database.ok;
  return NextResponse.json({ ok, checks, time: new Date().toISOString() }, { status: ok ? 200 : 503 });
}
