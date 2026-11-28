import { NextResponse, connection, type NextRequest } from "next/server";
import { unstable_rethrow } from "next/navigation";
import { ZodError, type z } from "zod";
import { ApiError } from "./errors";
import { AuthError, requireUser, type SessionUser } from "../auth/session";
import { env } from "../env";
import { rateLimit } from "./rate-limit";
import { logger } from "../logger";
import { runAsUser } from "../usage";

type Ctx<P> = { req: NextRequest; user: SessionUser; params: P };
type Options = { rateLimit?: { limit: number; windowSeconds: number; bucket: string } };

function sameOrigin(req: NextRequest): boolean {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return true;
  const origin = req.headers.get("origin");
  if (!origin) return req.headers.get("sec-fetch-site") === "same-origin" || env().NODE_ENV === "test";
  try {
    const o = new URL(origin);
    const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
    return o.host === host || o.origin === new URL(env().APP_URL).origin;
  } catch {
    return false;
  }
}

/** SQLSTATE of a Postgres error, whether thrown directly or wrapped by Drizzle. */
function pgCode(err: unknown): string | null {
  for (let e: unknown = err, i = 0; e && i < 3; e = (e as { cause?: unknown }).cause, i++) {
    const c = (e as { code?: unknown }).code;
    if (typeof c === "string" && /^[0-9A-Z]{5}$/.test(c)) return c;
  }
  return null;
}

/** For PATCH routes: an update with no fields would be an invalid SQL statement. */
export function requireChanges<T extends Record<string, unknown>>(body: T): T {
  if (!Object.values(body).some((v) => v !== undefined)) throw new ApiError(400, "Send at least one field to change.", "bad_request");
  return body;
}

export function errorResponse(err: unknown) {
  if (err instanceof ApiError) {
    return NextResponse.json({ error: { message: err.message, code: err.code, details: err.details } }, { status: err.status });
  }
  if (err instanceof AuthError) {
    return NextResponse.json({ error: { message: err.message, code: "unauthorized" } }, { status: err.status });
  }
  if (err instanceof ZodError) {
    return NextResponse.json(
      { error: { message: "Validation failed", code: "validation", details: err.issues } },
      { status: 422 },
    );
  }
  // Postgres rejecting a client-supplied value is the client's error, not a server crash.
  const code = pgCode(err);
  if (code?.startsWith("22")) return NextResponse.json({ error: { message: "One of the values sent isn't valid.", code: "invalid_value" } }, { status: 400 });
  if (code === "23503") return NextResponse.json({ error: { message: "That refers to something that doesn't exist (it may have been deleted).", code: "not_found" } }, { status: 404 });
  if (code === "23505") return NextResponse.json({ error: { message: "That already exists.", code: "conflict" } }, { status: 409 });
  if (code === "23502" || code === "23514") return NextResponse.json({ error: { message: "A required value is missing or out of range.", code: "invalid_value" } }, { status: 400 });
  logger.error("Unhandled API error", { err: err instanceof Error ? err.stack : String(err) });
  return NextResponse.json({ error: { message: "Internal server error", code: "internal" } }, { status: 500 });
}

/** Authenticated route handler wrapper: auth, CSRF origin check, rate limiting, error mapping. */
export function route<P extends Record<string, string> = Record<string, string>>(
  handler: (ctx: Ctx<P>) => Promise<unknown>,
  options: Options = {},
) {
  return async (req: NextRequest, context: { params: Promise<P> }) => {
    try {
      // Authenticated handlers are always request-time; never let the build try to prerender them.
      await connection();
      if (!sameOrigin(req)) throw new ApiError(403, "Cross-origin request rejected", "forbidden");
      const user = await requireUser();
      if (options.rateLimit) {
        const rl = await rateLimit(`${options.rateLimit.bucket}:${user.id}`, options.rateLimit.limit, options.rateLimit.windowSeconds);
        if (!rl.ok) throw new ApiError(429, "Too many requests. Please slow down and try again shortly.", "rate_limited");
      }
      const params = (context?.params ? await context.params : {}) as P;
      // Record ids are UUIDs: anything else can't exist, so answer 404 instead of letting Postgres reject it.
      for (const [k, v] of Object.entries(params)) {
        if ((k === "id" || k.endsWith("Id")) && !UUID_RE.test(String(v))) throw new ApiError(404, "Not found", "not_found");
      }
      // Everything metered during this request (AI calls, YouTube quota) is attributed to this user.
      const result = await runAsUser(user.id, () => handler({ req, user, params }));
      if (result instanceof Response) return result;
      return NextResponse.json(result ?? { ok: true });
    } catch (err) {
      unstable_rethrow(err); // let Next.js control-flow errors (prerender bailout, redirects) propagate
      return errorResponse(err);
    }
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Read a JSON request body; a missing or malformed body is the client's error (400), not a crash. */
export async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new ApiError(400, "Request body must be valid JSON", "bad_request");
  }
}

export async function parseBody<S extends z.ZodType>(req: NextRequest, schema: S): Promise<z.infer<S>> {
  return schema.parse(await readJson(req));
}

/**
 * Parse a PATCH body. Zod 4 applies `.default()` values even inside `.partial()`, which would
 * silently reset fields the client didn't send. Only keys present in the request are kept.
 */
export function pickProvided<T extends Record<string, unknown>>(raw: unknown, parsed: T): Partial<T> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const sent = new Set(Object.keys(raw));
  return Object.fromEntries(Object.entries(parsed).filter(([k]) => sent.has(k))) as Partial<T>;
}

export async function parsePatch<S extends z.ZodObject>(req: NextRequest, schema: S): Promise<Partial<z.infer<S>>> {
  const json = await readJson(req);
  return pickProvided(json, schema.partial().parse(json) as Record<string, unknown>) as Partial<z.infer<S>>;
}

export function parseQuery<S extends z.ZodType>(req: NextRequest, schema: S): z.infer<S> {
  return schema.parse(Object.fromEntries(req.nextUrl.searchParams.entries()));
}
