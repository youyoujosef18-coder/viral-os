/**
 * Pre-deployment diagnostic. Usage:
 *   npm run diagnose              # checks the current environment (.env / process env)
 *   npm run diagnose -- --strict  # treat warnings as failures (use for production gates)
 * Exit code 1 when any FAIL (or WARN in --strict) is found. Never prints secret values.
 */
import "dotenv/config";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import postgres from "postgres";
import IORedis from "ioredis";

const run = promisify(execFile);
type Level = "PASS" | "WARN" | "FAIL";
const results: { level: Level; area: string; message: string }[] = [];
const add = (level: Level, area: string, message: string) => results.push({ level, area, message });
const strict = process.argv.includes("--strict");
const env = process.env;
const isProd = env.NODE_ENV === "production" || strict;

const EXPECTED_TABLES = ["profiles", "local_auth_users", "sessions", "platform_connections", "oauth_states", "media_assets", "content_projects", "project_versions", "scripts", "script_versions", "research_runs", "ideas", "keyword_lists", "keywords", "trend_items", "trend_watchlists", "competitors", "competitor_content", "thumbnails", "video_analyses", "posts", "post_targets", "publish_events", "workflows", "workflow_runs", "agents", "agent_runs", "metric_snapshots", "experiments", "notifications", "activity_log", "clip_jobs", "clips"];

async function checkConfig() {
  const required = ["DATABASE_URL", "APP_URL", "SESSION_SECRET", "TOKEN_ENCRYPTION_KEY"];
  for (const k of required) env[k] ? add("PASS", "config", `${k} is set`) : add("FAIL", "config", `${k} is missing`);
  if (env.TOKEN_ENCRYPTION_KEY) {
    const len = Buffer.from(env.TOKEN_ENCRYPTION_KEY, "base64").length;
    len === 32 ? add("PASS", "config", "TOKEN_ENCRYPTION_KEY decodes to 32 bytes") : add("FAIL", "config", `TOKEN_ENCRYPTION_KEY decodes to ${len} bytes (needs 32)`);
  }
  if (env.SESSION_SECRET && env.SESSION_SECRET.length < 32) add("FAIL", "config", "SESSION_SECRET should be at least 32 characters");
  try {
    const u = new URL(env.APP_URL ?? "");
    if (isProd && u.protocol !== "https:") add("FAIL", "config", "APP_URL must use https in production (OAuth redirect URIs and secure cookies)");
    else add("PASS", "config", `APP_URL origin ${u.origin}`);
    if (isProd && ["localhost", "127.0.0.1"].includes(u.hostname)) add("FAIL", "config", "APP_URL points at localhost in production");
  } catch {
    add("FAIL", "config", "APP_URL is not a valid URL");
  }
  const auth = env.AUTH_PROVIDER ?? "local";
  if (auth === "supabase") {
    env.NEXT_PUBLIC_SUPABASE_URL && env.NEXT_PUBLIC_SUPABASE_ANON_KEY ? add("PASS", "auth", "Supabase Auth configured") : add("FAIL", "auth", "AUTH_PROVIDER=supabase but NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY missing");
  } else {
    add(isProd ? "WARN" : "PASS", "auth", isProd ? "AUTH_PROVIDER=local in production. Supported, but Supabase Auth adds email verification and password reset." : "Local auth provider (development)");
  }
  const storageProvider = env.STORAGE_PROVIDER ?? "local";
  if (storageProvider === "supabase") {
    env.NEXT_PUBLIC_SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY ? add("PASS", "storage", `Supabase Storage bucket "${env.SUPABASE_STORAGE_BUCKET ?? "media"}"`) : add("FAIL", "storage", "STORAGE_PROVIDER=supabase but Supabase URL / service role key missing");
  } else {
    add(isProd ? "WARN" : "PASS", "storage", isProd ? "Local disk storage in production: files are lost on serverless redeploys, and Instagram can't fetch media unless APP_URL is public. Use Supabase Storage." : "Local disk storage (development)");
  }
}

async function checkDatabase() {
  if (!env.DATABASE_URL) return;
  const sql = postgres(env.DATABASE_URL, { max: 1, onnotice: () => {}, prepare: env.DATABASE_POOLER !== "true", connect_timeout: 10 });
  try {
    const [{ v }] = await sql`select current_setting('server_version_num')::int as v`;
    v >= 150000 ? add("PASS", "database", `PostgreSQL ${Math.floor(v / 10000)} reachable`) : add("WARN", "database", `PostgreSQL ${v} is older than 15`);
    const tables = await sql<{ tablename: string; rowsecurity: boolean }[]>`select tablename, rowsecurity from pg_tables where schemaname = 'public'`;
    const missing = EXPECTED_TABLES.filter((t) => !tables.some((x) => x.tablename === t));
    missing.length ? add("FAIL", "database", `Missing tables (run npm run db:migrate): ${missing.join(", ")}`) : add("PASS", "database", `All ${EXPECTED_TABLES.length} tables present`);
    const noRls = EXPECTED_TABLES.filter((t) => tables.find((x) => x.tablename === t && !x.rowsecurity));
    noRls.length ? add("FAIL", "security", `Row Level Security disabled on: ${noRls.join(", ")}`) : add("PASS", "security", "Row Level Security enabled on every table");
    const [{ n }] = await sql`select count(*)::int as n from pg_policies where schemaname = 'public'`;
    n >= EXPECTED_TABLES.length - 2 ? add("PASS", "security", `${n} RLS policies installed`) : add("FAIL", "security", `Only ${n} RLS policies found`);
    const [{ exists }] = await sql`select exists(select 1 from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'auth' and p.proname = 'uid') as exists`;
    exists ? add("PASS", "security", "auth.uid() available") : add("FAIL", "security", "auth.uid() missing (run npm run db:migrate)");
    const [{ role }] = await sql`select exists(select 1 from pg_roles where rolname = 'authenticated') as role`;
    role ? add("PASS", "security", "Role 'authenticated' exists") : add("FAIL", "security", "Role 'authenticated' missing");
    // Prove RLS actually filters: as authenticated with a random sub, no profiles are visible.
    const visible = await sql.begin(async (tx) => {
      await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: "00000000-0000-0000-0000-000000000000", role: "authenticated" })}, true)`;
      await tx`set local role authenticated`;
      const [{ c }] = await tx`select count(*)::int as c from profiles`;
      return c as number;
    });
    visible === 0 ? add("PASS", "security", "RLS live check: a foreign identity sees 0 profiles") : add("FAIL", "security", `RLS live check: foreign identity sees ${visible} profiles`);
    const [{ m }] = await sql`select count(*)::int as m from drizzle.__drizzle_migrations`.catch(() => [{ m: 0 }]);
    add(m >= 2 ? "PASS" : "FAIL", "database", `${m} migrations recorded`);
    const stuck = await sql`select count(*)::int as c from post_targets where status = 'uploading' and locked_at < now() - interval '30 minutes'`;
    stuck[0].c ? add("WARN", "publishing", `${stuck[0].c} uploads stuck for >30 min (is the worker running?)`) : add("PASS", "publishing", "No stuck uploads");
  } catch (err) {
    add("FAIL", "database", `Cannot connect or query: ${(err as Error).message}`);
  } finally {
    await sql.end({ timeout: 2 });
  }
}

async function checkRedis() {
  if (!env.REDIS_URL) {
    add(isProd ? "FAIL" : "WARN", "queue", "REDIS_URL not set: no durable queue (worker falls back to 30s Postgres polling)");
    return;
  }
  const r = new IORedis(env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 5000, retryStrategy: () => null });
  try {
    await r.connect();
    await r.ping();
    const policy = await r.config("GET", "maxmemory-policy").catch(() => null);
    const val = Array.isArray(policy) ? policy[1] : null;
    add("PASS", "queue", "Redis reachable");
    if (val && val !== "noeviction") add("WARN", "queue", `Redis maxmemory-policy is "${val}"; BullMQ requires "noeviction" to avoid losing jobs`);
    const beat = await r.get("vos:worker:heartbeat");
    beat ? add("PASS", "worker", `Worker heartbeat at ${beat}`) : add(isProd ? "FAIL" : "WARN", "worker", "No worker heartbeat in the last 10 minutes. Start it with npm run worker.");
  } catch (err) {
    add("FAIL", "queue", `Redis unreachable: ${(err as Error).message}`);
  } finally {
    r.disconnect();
  }
}

async function checkStorage() {
  try {
    const { storage } = await import("../src/lib/storage");
    const key = `__diagnostics/${Date.now()}.txt`;
    const s = storage();
    await s.put(key, Buffer.from("viral-os"), "text/plain");
    const back = (await s.get(key)).toString();
    await s.remove(key);
    back === "viral-os" ? add("PASS", "storage", "Write/read/delete round-trip succeeded") : add("FAIL", "storage", "Storage round-trip returned different bytes");
  } catch (err) {
    add("FAIL", "storage", `Storage round-trip failed: ${(err as Error).message}`);
  }
}

async function checkTools() {
  try {
    await run(env.FFPROBE_PATH || "ffprobe", ["-version"], { timeout: 5000 });
    add("PASS", "tools", "ffprobe available (measured video analysis enabled)");
  } catch {
    add("WARN", "tools", "ffprobe not found: Video Analyzer skips measured pacing on this host");
  }
}

function checkIntegrations() {
  const ai = (env.AI_PROVIDER === "anthropic" && env.ANTHROPIC_API_KEY) || (env.AI_PROVIDER === "openai" && env.OPENAI_API_KEY);
  ai ? add("PASS", "integrations", `AI provider: ${env.AI_PROVIDER}`) : add("WARN", "integrations", "No AI provider: research, scripts, concepts, analyzer and agents show setup instructions");
  if (env.AI_PROVIDER === "mock") add("FAIL", "integrations", "AI_PROVIDER=mock is for tests only");
  env.YOUTUBE_API_KEY ? add("PASS", "integrations", "YouTube Data API key set") : add("WARN", "integrations", "YOUTUBE_API_KEY missing: Trend Radar, keyword competition and competitor lookups disabled");
  for (const [name, a, b] of [["YouTube OAuth", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"], ["TikTok", "TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET"], ["Instagram", "INSTAGRAM_APP_ID", "INSTAGRAM_APP_SECRET"]]) {
    env[a] && env[b] ? add("PASS", "integrations", `${name} credentials set (redirect: ${env.APP_URL}/api/oauth/${name.split(" ")[0].toLowerCase()}/callback)`) : add("WARN", "integrations", `${name} not configured: users can't connect it yet`);
  }
  if (env.IMAGE_PROVIDER === "openai" && !env.OPENAI_API_KEY) add("FAIL", "integrations", "IMAGE_PROVIDER=openai but OPENAI_API_KEY missing");
}

async function main() {
  await checkConfig();
  await checkDatabase();
  await checkRedis();
  await checkStorage();
  await checkTools();
  checkIntegrations();
  const icon = { PASS: "✓", WARN: "!", FAIL: "✗" };
  for (const r of results) console.log(`${icon[r.level]} [${r.level}] ${r.area.padEnd(12)} ${r.message}`);
  const fails = results.filter((r) => r.level === "FAIL").length;
  const warns = results.filter((r) => r.level === "WARN").length;
  console.log(`\n${results.length} checks: ${results.length - fails - warns} passed, ${warns} warnings, ${fails} failed${strict ? " (strict mode)" : ""}`);
  process.exit(fails > 0 || (strict && warns > 0) ? 1 : 0);
}

main().catch((err) => {
  console.error("Diagnostic crashed:", err);
  process.exit(1);
});
