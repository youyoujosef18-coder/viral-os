import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { and, eq, gt } from "drizzle-orm";
import { env } from "../env";
import { serviceDb, schema } from "../db/client";
import { hashPassword, randomToken, sha256, verifyPassword } from "../crypto";

export const LOCAL_SESSION_COOKIE = "vos_session";
const SESSION_TTL_DAYS = 30;

export type SessionUser = { id: string; email: string };

export class AuthError extends Error {
  constructor(message: string, public status = 401) {
    super(message);
  }
}

async function supabaseServer() {
  const e = env();
  if (!e.NEXT_PUBLIC_SUPABASE_URL || !e.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    throw new AuthError("Supabase Auth is selected but NEXT_PUBLIC_SUPABASE_URL / ANON_KEY are missing", 500);
  }
  const store = await cookies();
  return createServerClient(e.NEXT_PUBLIC_SUPABASE_URL, e.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        for (const c of list) store.set(c.name, c.value, c.options);
      },
    },
  });
}

/** Resolve the signed-in user from the request cookies, or null. */
export async function getSessionUser(): Promise<SessionUser | null> {
  if (env().AUTH_PROVIDER === "supabase") {
    const supabase = await supabaseServer();
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) return null;
    return { id: data.user.id, email: data.user.email ?? "" };
  }
  const token = (await cookies()).get(LOCAL_SESSION_COOKIE)?.value;
  if (!token) return null;
  const db = serviceDb();
  const rows = await db
    .select({ userId: schema.sessions.userId, email: schema.profiles.email })
    .from(schema.sessions)
    .innerJoin(schema.profiles, eq(schema.profiles.id, schema.sessions.userId))
    .where(and(eq(schema.sessions.tokenHash, sha256(token)), gt(schema.sessions.expiresAt, new Date())))
    .limit(1);
  const row = rows[0];
  return row ? { id: row.userId, email: row.email } : null;
}

export async function requireUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) throw new AuthError("Authentication required");
  return user;
}

async function ensureProfile(user: SessionUser, displayName?: string, timezone?: string) {
  await serviceDb()
    .insert(schema.profiles)
    .values({ id: user.id, email: user.email, displayName: displayName ?? user.email.split("@")[0], timezone: timezone ?? "UTC" })
    .onConflictDoNothing();
}

async function startLocalSession(userId: string, userAgent?: string) {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 86400_000);
  await serviceDb().insert(schema.sessions).values({ tokenHash: sha256(token), userId, expiresAt, userAgent });
  (await cookies()).set(LOCAL_SESSION_COOKIE, token, {
    httpOnly: true,
    secure: env().NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

export async function signUp(input: { email: string; password: string; displayName?: string; timezone?: string; userAgent?: string }) {
  const email = input.email.trim().toLowerCase();
  if (env().AUTH_PROVIDER === "supabase") {
    const supabase = await supabaseServer();
    const { data, error } = await supabase.auth.signUp({
      email,
      password: input.password,
      options: { emailRedirectTo: `${env().APP_URL}/auth/callback` },
    });
    if (error) throw new AuthError(error.message, 400);
    if (data.user) await ensureProfile({ id: data.user.id, email }, input.displayName, input.timezone);
    return { requiresEmailConfirmation: !data.session };
  }
  const db = serviceDb();
  const existing = await db.select().from(schema.localAuthUsers).where(eq(schema.localAuthUsers.email, email)).limit(1);
  if (existing.length) throw new AuthError("An account with this email already exists", 409);
  const [created] = await db
    .insert(schema.localAuthUsers)
    .values({ email, passwordHash: await hashPassword(input.password) })
    .returning({ id: schema.localAuthUsers.id });
  await ensureProfile({ id: created.id, email }, input.displayName, input.timezone);
  await startLocalSession(created.id, input.userAgent);
  return { requiresEmailConfirmation: false };
}

export async function signIn(input: { email: string; password: string; userAgent?: string }) {
  const email = input.email.trim().toLowerCase();
  if (env().AUTH_PROVIDER === "supabase") {
    const supabase = await supabaseServer();
    const { data, error } = await supabase.auth.signInWithPassword({ email, password: input.password });
    if (error || !data.user) throw new AuthError("Invalid email or password", 401);
    await ensureProfile({ id: data.user.id, email });
    return;
  }
  const rows = await serviceDb().select().from(schema.localAuthUsers).where(eq(schema.localAuthUsers.email, email)).limit(1);
  const user = rows[0];
  // Constant-ish time: always run a hash verification.
  const ok = await verifyPassword(input.password, user?.passwordHash ?? "scrypt$AAAA$AAAA");
  if (!user || !ok) throw new AuthError("Invalid email or password", 401);
  await ensureProfile({ id: user.id, email });
  await startLocalSession(user.id, input.userAgent);
}

export async function signOut() {
  if (env().AUTH_PROVIDER === "supabase") {
    const supabase = await supabaseServer();
    await supabase.auth.signOut();
    return;
  }
  const store = await cookies();
  const token = store.get(LOCAL_SESSION_COOKIE)?.value;
  if (token) await serviceDb().delete(schema.sessions).where(eq(schema.sessions.tokenHash, sha256(token)));
  store.delete(LOCAL_SESSION_COOKIE);
}

export async function exchangeSupabaseCode(code: string) {
  const supabase = await supabaseServer();
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);
  if (error || !data.user) throw new AuthError("Could not verify sign-in link", 400);
  await ensureProfile({ id: data.user.id, email: data.user.email ?? "" });
}
