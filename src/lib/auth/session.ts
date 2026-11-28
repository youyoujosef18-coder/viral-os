import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { and, eq, gt } from "drizzle-orm";
import { env } from "../env";
import { serviceDb, schema } from "../db/client";
import { hashPassword, randomToken, sha256, verifyPassword } from "../crypto";
import { attachInviteUser, audit, checkSignupAllowed, consumeInvite, isOwnerEmail } from "../services/admin";
import { logger } from "../logger";

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

const SEEN_EVERY_MS = 5 * 60_000;

/** Record activity for the owner console at most every few minutes per user. */
async function touchLastSeen(userId: string, lastSeenAt: Date | null) {
  if (lastSeenAt && Date.now() - lastSeenAt.getTime() < SEEN_EVERY_MS) return;
  try {
    await serviceDb().update(schema.profiles).set({ lastSeenAt: new Date() }).where(eq(schema.profiles.id, userId));
  } catch (err) {
    logger.warn("last-seen update failed", { err: (err as Error).message });
  }
}

/** Resolve the signed-in user from the request cookies, or null. Disabled accounts count as signed out. */
export async function getSessionUser(): Promise<SessionUser | null> {
  if (env().AUTH_PROVIDER === "supabase") {
    const supabase = await supabaseServer();
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) return null;
    const [p] = await serviceDb().select({ disabledAt: schema.profiles.disabledAt, lastSeenAt: schema.profiles.lastSeenAt }).from(schema.profiles).where(eq(schema.profiles.id, data.user.id));
    if (p?.disabledAt) return null;
    if (p) await touchLastSeen(data.user.id, p.lastSeenAt);
    return { id: data.user.id, email: data.user.email ?? "" };
  }
  const token = (await cookies()).get(LOCAL_SESSION_COOKIE)?.value;
  if (!token) return null;
  const db = serviceDb();
  const rows = await db
    .select({ userId: schema.sessions.userId, email: schema.profiles.email, disabledAt: schema.profiles.disabledAt, lastSeenAt: schema.profiles.lastSeenAt })
    .from(schema.sessions)
    .innerJoin(schema.profiles, eq(schema.profiles.id, schema.sessions.userId))
    .where(and(eq(schema.sessions.tokenHash, sha256(token)), gt(schema.sessions.expiresAt, new Date())))
    .limit(1);
  const row = rows[0];
  if (!row || row.disabledAt) return null;
  await touchLastSeen(row.userId, row.lastSeenAt);
  return { id: row.userId, email: row.email };
}

const DISABLED_MESSAGE = "This account has been disabled. Contact the workspace owner.";

export async function requireUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) throw new AuthError("Authentication required");
  return user;
}

/**
 * Create the profile on first sign-in, enforce the sign-up mode for accounts created outside our sign-up
 * route (e.g. directly against Supabase), promote OWNER_EMAIL accounts, and refuse disabled accounts.
 */
async function ensureProfile(user: SessionUser, opts: { displayName?: string; timezone?: string; viaSignup?: boolean } = {}) {
  const db = serviceDb();
  const [existing] = await db.select({ role: schema.profiles.role, disabledAt: schema.profiles.disabledAt }).from(schema.profiles).where(eq(schema.profiles.id, user.id));
  const owner = isOwnerEmail(user.email);
  if (!existing) {
    if (!opts.viaSignup) await checkSignupAllowed(user.email, null);
    await db
      .insert(schema.profiles)
      .values({ id: user.id, email: user.email, displayName: opts.displayName ?? user.email.split("@")[0], timezone: opts.timezone ?? "UTC", role: owner ? "owner" : "user" })
      .onConflictDoNothing();
    if (owner) await audit(user.id, "owner_granted", user.id, { email: user.email, via: "OWNER_EMAIL" });
    return;
  }
  if (existing.disabledAt) throw new AuthError(DISABLED_MESSAGE, 403);
  if (owner && existing.role !== "owner") {
    await db.update(schema.profiles).set({ role: "owner" }).where(eq(schema.profiles.id, user.id));
    await audit(user.id, "owner_granted", user.id, { email: user.email, via: "OWNER_EMAIL" });
  }
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

export async function signUp(input: { email: string; password: string; displayName?: string; timezone?: string; userAgent?: string; inviteToken?: string | null }) {
  const email = input.email.trim().toLowerCase();
  const { invite } = await checkSignupAllowed(email, input.inviteToken);
  const claimInvite = async () => {
    if (invite && !(await consumeInvite(invite.id))) throw new AuthError("This invite link was just used by someone else. Ask the owner for a new one.", 403);
  };
  if (env().AUTH_PROVIDER === "supabase") {
    await claimInvite();
    const supabase = await supabaseServer();
    const { data, error } = await supabase.auth.signUp({
      email,
      password: input.password,
      options: { emailRedirectTo: `${env().APP_URL}/auth/callback` },
    });
    if (error) throw new AuthError(error.message, 400);
    if (data.user) {
      await ensureProfile({ id: data.user.id, email }, { displayName: input.displayName, timezone: input.timezone, viaSignup: true });
      if (invite) await attachInviteUser(invite.id, data.user.id);
    }
    return { requiresEmailConfirmation: !data.session };
  }
  const db = serviceDb();
  const existing = await db.select().from(schema.localAuthUsers).where(eq(schema.localAuthUsers.email, email)).limit(1);
  if (existing.length) throw new AuthError("An account with this email already exists", 409);
  await claimInvite();
  const [created] = await db
    .insert(schema.localAuthUsers)
    .values({ email, passwordHash: await hashPassword(input.password) })
    .returning({ id: schema.localAuthUsers.id });
  await ensureProfile({ id: created.id, email }, { displayName: input.displayName, timezone: input.timezone, viaSignup: true });
  if (invite) await attachInviteUser(invite.id, created.id);
  await startLocalSession(created.id, input.userAgent);
  return { requiresEmailConfirmation: false };
}

export async function signIn(input: { email: string; password: string; userAgent?: string }) {
  const email = input.email.trim().toLowerCase();
  if (env().AUTH_PROVIDER === "supabase") {
    const supabase = await supabaseServer();
    const { data, error } = await supabase.auth.signInWithPassword({ email, password: input.password });
    if (error || !data.user) throw new AuthError("Invalid email or password", 401);
    try {
      await ensureProfile({ id: data.user.id, email });
    } catch (err) {
      await supabase.auth.signOut();
      throw err;
    }
    return;
  }
  const rows = await serviceDb().select().from(schema.localAuthUsers).where(eq(schema.localAuthUsers.email, email)).limit(1);
  const user = rows[0];
  // Constant-ish time: always run a hash verification.
  const ok = await verifyPassword(input.password, user?.passwordHash ?? "scrypt$AAAA$AAAA");
  if (!user || !ok) throw new AuthError("Invalid email or password", 401);
  await ensureProfile({ id: user.id, email }); // throws for disabled accounts
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
  try {
    await ensureProfile({ id: data.user.id, email: data.user.email ?? "" });
  } catch (err) {
    await supabase.auth.signOut();
    throw err;
  }
}
