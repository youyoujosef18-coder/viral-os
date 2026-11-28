import { and, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { serviceDb, schema } from "../db/client";
import { env } from "../env";
import { ApiError, badRequest, notFound } from "../api/errors";
import { randomToken, sha256 } from "../crypto";
import { storage } from "../storage";
import { logger } from "../logger";

/**
 * Owner console. Every function here runs on the service connection (bypassing RLS), so each exported
 * entry point used by an API route must be reached through requireOwner(). Nothing in this file is
 * reachable by a normal user: the routes are wrapped by ownerRoute() and the tables have no grants.
 */

export const SIGNUP_MODES = ["open", "invite", "closed"] as const;
export type SignupMode = (typeof SIGNUP_MODES)[number];

// ------------------------------------------------------------------ owner identity

/** Emails in OWNER_EMAIL (comma-separated) become owners when they sign up or sign in. */
export function ownerEmails(): string[] {
  return (env().OWNER_EMAIL ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export const isOwnerEmail = (email: string) => ownerEmails().includes(email.trim().toLowerCase());

export async function requireOwner(userId: string) {
  const [p] = await serviceDb().select({ role: schema.profiles.role, disabledAt: schema.profiles.disabledAt }).from(schema.profiles).where(eq(schema.profiles.id, userId));
  if (!p || p.role !== "owner" || p.disabledAt) throw new ApiError(403, "Only the workspace owner can do this.", "owner_only");
}

export async function audit(actorId: string, action: string, targetUserId: string | null, detail: Record<string, unknown> = {}) {
  // Keep the account's email in the entry itself, so the log still says who it was about after a deletion.
  if (targetUserId && typeof detail.email !== "string") {
    const [p] = await serviceDb().select({ email: schema.profiles.email }).from(schema.profiles).where(eq(schema.profiles.id, targetUserId));
    if (p) detail = { ...detail, email: p.email };
  }
  await serviceDb().insert(schema.adminAuditLog).values({ actorId, action, targetUserId, detail });
}

// ------------------------------------------------------------------ sign-up control

export async function getSignupMode(): Promise<SignupMode> {
  const [row] = await serviceDb().select().from(schema.appSettings).where(eq(schema.appSettings.key, "signup_mode"));
  const v = row?.value;
  return SIGNUP_MODES.includes(v as SignupMode) ? (v as SignupMode) : "open";
}

export async function setSignupMode(actorId: string, mode: SignupMode) {
  if (!SIGNUP_MODES.includes(mode)) throw badRequest("Unknown sign-up mode");
  const previous = await getSignupMode();
  await serviceDb()
    .insert(schema.appSettings)
    .values({ key: "signup_mode", value: mode, updatedBy: actorId })
    .onConflictDoUpdate({ target: schema.appSettings.key, set: { value: mode, updatedBy: actorId, updatedAt: new Date() } });
  await audit(actorId, "signup_mode_changed", null, { from: previous, to: mode });
  return { mode };
}

type InviteRow = typeof schema.invites.$inferSelect;

async function findUsableInvite(token: string): Promise<InviteRow | null> {
  const [inv] = await serviceDb()
    .select()
    .from(schema.invites)
    .where(and(eq(schema.invites.tokenHash, sha256(token)), isNull(schema.invites.usedAt), isNull(schema.invites.revokedAt), gt(schema.invites.expiresAt, new Date())));
  return inv ?? null;
}

/** Public check used by the sign-up page to tell the visitor whether their invite link still works. */
export async function describeInvite(token: string) {
  const inv = await findUsableInvite(token);
  return inv ? { valid: true as const, email: inv.email } : { valid: false as const, email: null };
}

/**
 * Decide whether `email` may create an account. Owner emails are always allowed (so the owner can't
 * lock themselves out). Returns the invite to consume, if one was needed.
 */
export async function checkSignupAllowed(email: string, inviteToken?: string | null): Promise<{ invite: InviteRow | null }> {
  if (isOwnerEmail(email)) return { invite: null };
  const mode = await getSignupMode();
  if (mode === "open") return { invite: null };
  if (mode === "closed") throw new ApiError(403, "Sign-up is closed. Ask the workspace owner for access.", "signup_closed");
  if (!inviteToken) throw new ApiError(403, "Sign-up is by invitation only. Use the invite link you were sent.", "invite_required");
  const invite = await findUsableInvite(inviteToken);
  if (!invite) throw new ApiError(403, "This invite link is invalid, expired or already used. Ask the owner for a new one.", "invite_invalid");
  if (invite.email && invite.email !== email.trim().toLowerCase()) throw new ApiError(403, "This invite is for a different email address.", "invite_email_mismatch");
  return { invite };
}

/** Atomically mark an invite used. Returns false if another sign-up used it first. */
export async function consumeInvite(inviteId: string) {
  const rows = await serviceDb()
    .update(schema.invites)
    .set({ usedAt: new Date() })
    .where(and(eq(schema.invites.id, inviteId), isNull(schema.invites.usedAt), isNull(schema.invites.revokedAt), gt(schema.invites.expiresAt, new Date())))
    .returning({ id: schema.invites.id });
  return rows.length === 1;
}

export async function attachInviteUser(inviteId: string, userId: string) {
  await serviceDb().update(schema.invites).set({ usedBy: userId }).where(eq(schema.invites.id, inviteId));
}

export const createInviteSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email").optional().or(z.literal("").transform(() => undefined)),
  note: z.string().trim().max(200).optional(),
  expiresInDays: z.number().int().min(1).max(90).default(7),
});

export async function createInvite(actorId: string, raw: unknown) {
  const input = createInviteSchema.parse(raw);
  const token = randomToken(24);
  const [row] = await serviceDb()
    .insert(schema.invites)
    .values({ tokenHash: sha256(token), email: input.email ?? null, note: input.note || null, createdBy: actorId, expiresAt: new Date(Date.now() + input.expiresInDays * 86400_000) })
    .returning();
  await audit(actorId, "invite_created", null, { inviteId: row.id, email: row.email, expiresAt: row.expiresAt });
  // The token is returned exactly once; only its hash is stored.
  return { ...publicInvite(row), url: `${env().APP_URL}/signup?invite=${token}` };
}

function publicInvite(r: InviteRow) {
  const status = r.revokedAt ? "revoked" : r.usedAt ? "used" : r.expiresAt < new Date() ? "expired" : "active";
  return { id: r.id, email: r.email, note: r.note, createdAt: r.createdAt, expiresAt: r.expiresAt, usedAt: r.usedAt, usedBy: r.usedBy, revokedAt: r.revokedAt, status };
}

export async function listInvites() {
  const rows = await serviceDb().select().from(schema.invites).orderBy(desc(schema.invites.createdAt)).limit(200);
  const userIds = [...new Set(rows.map((r) => r.usedBy).filter((v): v is string => !!v))];
  const users = userIds.length ? await serviceDb().select({ id: schema.profiles.id, email: schema.profiles.email }).from(schema.profiles).where(inArray(schema.profiles.id, userIds)) : [];
  return rows.map((r) => ({ ...publicInvite(r), usedByEmail: users.find((u) => u.id === r.usedBy)?.email ?? null }));
}

export async function revokeInvite(actorId: string, inviteId: string) {
  const rows = await serviceDb()
    .update(schema.invites)
    .set({ revokedAt: new Date() })
    .where(and(eq(schema.invites.id, inviteId), isNull(schema.invites.usedAt), isNull(schema.invites.revokedAt)))
    .returning({ id: schema.invites.id });
  if (!rows.length) throw new ApiError(409, "Only unused invites can be revoked.", "conflict");
  await audit(actorId, "invite_revoked", null, { inviteId });
  return { ok: true };
}

// ------------------------------------------------------------------ users and usage

/** Per-user counts. Usage covers the last 30 days; everything else is all-time. No content is read. */
const usageColumns = sql`
  (select count(*)::int from posts x where x.user_id = p.id) as posts,
  (select count(*)::int from post_targets x where x.user_id = p.id and x.status = 'published') as published,
  (select count(*)::int from clip_jobs x where x.user_id = p.id) as clip_jobs,
  (select count(*)::int from clips x where x.user_id = p.id and x.status = 'ready') as clips_rendered,
  (select count(*)::int from media_assets x where x.user_id = p.id) as media_count,
  (select coalesce(sum(x.size_bytes), 0)::bigint from media_assets x where x.user_id = p.id) as media_bytes,
  (select count(*)::int from platform_connections x where x.user_id = p.id) as connections,
  (select count(*)::int from usage_events x where x.user_id = p.id and x.kind = 'ai_call' and x.created_at > now() - interval '30 days') as ai_calls_30d,
  (select coalesce(sum(coalesce(x.input_tokens, 0) + coalesce(x.output_tokens, 0)), 0)::bigint from usage_events x where x.user_id = p.id and x.kind = 'ai_call' and x.created_at > now() - interval '30 days') as ai_tokens_30d,
  (select coalesce(sum(x.units), 0)::int from usage_events x where x.user_id = p.id and x.kind = 'youtube_units' and x.created_at > now() - interval '30 days' and x.detail->>'bucket' = 'daily_units') as youtube_units_30d`;

type UsageRow = {
  id: string;
  email: string;
  display_name: string | null;
  role: string;
  disabled_at: Date | string | null;
  last_seen_at: Date | string | null;
  created_at: Date | string;
  posts: number;
  published: number;
  clip_jobs: number;
  clips_rendered: number;
  media_count: number;
  media_bytes: string | number;
  connections: number;
  ai_calls_30d: number;
  ai_tokens_30d: string | number;
  youtube_units_30d: number;
};

function shapeUser(r: UsageRow) {
  const iso = (d: Date | string | null) => (d === null ? null : new Date(d).toISOString());
  return {
    id: r.id,
    email: r.email,
    displayName: r.display_name,
    role: r.role,
    disabledAt: iso(r.disabled_at),
    lastSeenAt: iso(r.last_seen_at),
    createdAt: iso(r.created_at)!,
    usage: {
      posts: r.posts,
      published: r.published,
      clipJobs: r.clip_jobs,
      clipsRendered: r.clips_rendered,
      mediaCount: r.media_count,
      mediaBytes: Number(r.media_bytes),
      connections: r.connections,
      aiCalls30d: r.ai_calls_30d,
      aiTokens30d: Number(r.ai_tokens_30d),
      youtubeUnits30d: r.youtube_units_30d,
    },
  };
}

export async function listUsers(q?: string) {
  const term = q?.trim();
  const where = term ? sql`where p.email ilike ${`%${term}%`} or p.display_name ilike ${`%${term}%`}` : sql``;
  const res = await serviceDb().execute(sql`select p.id, p.email, p.display_name, p.role, p.disabled_at, p.last_seen_at, p.created_at, ${usageColumns} from profiles p ${where} order by p.created_at desc limit 500`);
  return { items: (res as unknown as UsageRow[]).map(shapeUser), signupMode: await getSignupMode() };
}

async function loadUser(userId: string) {
  const res = await serviceDb().execute(sql`select p.id, p.email, p.display_name, p.role, p.disabled_at, p.last_seen_at, p.created_at, ${usageColumns} from profiles p where p.id = ${userId}`);
  const row = (res as unknown as UsageRow[])[0];
  if (!row) throw notFound("User");
  return shapeUser(row);
}

export async function getUser(actorId: string, userId: string) {
  const user = await loadUser(userId);
  const db = serviceDb();
  const [postsByStatus, connections, aiByDay, ytByBucket] = await Promise.all([
    db.select({ status: schema.posts.status, n: sql<number>`count(*)::int` }).from(schema.posts).where(eq(schema.posts.userId, userId)).groupBy(schema.posts.status),
    db.select({ platform: schema.platformConnections.platform, accountName: schema.platformConnections.accountName, status: schema.platformConnections.status, createdAt: schema.platformConnections.createdAt }).from(schema.platformConnections).where(eq(schema.platformConnections.userId, userId)),
    db.execute(sql`select to_char(date_trunc('day', created_at), 'YYYY-MM-DD') as day, count(*)::int as calls, coalesce(sum(coalesce(input_tokens,0)+coalesce(output_tokens,0)),0)::bigint as tokens from usage_events where user_id = ${userId} and kind = 'ai_call' and created_at > now() - interval '30 days' group by 1 order by 1`),
    db.execute(sql`select detail->>'bucket' as bucket, coalesce(sum(units),0)::int as units, count(*)::int as calls from usage_events where user_id = ${userId} and kind = 'youtube_units' and created_at > now() - interval '30 days' group by 1`),
  ]);
  await audit(actorId, "user_viewed", userId);
  return {
    ...user,
    postsByStatus,
    connections,
    aiByDay: (aiByDay as unknown as { day: string; calls: number; tokens: string | number }[]).map((r) => ({ day: r.day, calls: r.calls, tokens: Number(r.tokens) })),
    youtubeByBucket: ytByBucket as unknown as { bucket: string; units: number; calls: number }[],
  };
}

async function guardTarget(actorId: string, userId: string) {
  if (actorId === userId) throw badRequest("You can't do this to your own account.");
  const [p] = await serviceDb().select({ role: schema.profiles.role, email: schema.profiles.email }).from(schema.profiles).where(eq(schema.profiles.id, userId));
  if (!p) throw notFound("User");
  if (p.role === "owner") throw new ApiError(409, "Owner accounts can only be changed with the make-owner script on the server.", "conflict");
  return p;
}

export async function setDisabled(actorId: string, userId: string, disabled: boolean) {
  const p = await guardTarget(actorId, userId);
  await serviceDb().update(schema.profiles).set({ disabledAt: disabled ? new Date() : null }).where(eq(schema.profiles.id, userId));
  // Signing out everywhere: local sessions are deleted; Supabase sessions are refused by getSessionUser.
  if (disabled) await serviceDb().delete(schema.sessions).where(eq(schema.sessions.userId, userId));
  await audit(actorId, disabled ? "user_disabled" : "user_enabled", userId, { email: p.email });
  return loadUser(userId);
}

/** Every table holding a user's rows, children before parents. */
const DELETE_ORDER = [
  "publish_events",
  "post_targets",
  "posts",
  "clips",
  "clip_jobs",
  "agent_runs",
  "agents",
  "workflow_runs",
  "workflows",
  "experiments",
  "metric_snapshots",
  "competitor_content",
  "competitors",
  "trend_items",
  "trend_watchlists",
  "keywords",
  "keyword_lists",
  "ideas",
  "research_runs",
  "script_versions",
  "scripts",
  "project_versions",
  "thumbnails",
  "video_analyses",
  "content_projects",
  "media_assets",
  "oauth_states",
  "platform_connections",
  "notifications",
  "activity_log",
  "usage_events",
  "sessions",
] as const;

export async function deleteUser(actorId: string, userId: string, confirmEmail: string) {
  const p = await guardTarget(actorId, userId);
  if (confirmEmail.trim().toLowerCase() !== p.email.toLowerCase()) throw badRequest("Type the account's email address exactly to confirm.");
  const db = serviceDb();
  const keys = (await db.select({ key: schema.mediaAssets.storageKey }).from(schema.mediaAssets).where(eq(schema.mediaAssets.userId, userId))).map((r) => r.key);
  await db.transaction(async (tx) => {
    for (const table of DELETE_ORDER) await tx.execute(sql`delete from ${sql.identifier(table)} where user_id = ${userId}`);
    await tx.delete(schema.profiles).where(eq(schema.profiles.id, userId));
    await tx.delete(schema.localAuthUsers).where(eq(schema.localAuthUsers.id, userId));
  });
  // Files are removed after the rows are gone; a file that fails to delete is logged, never left referenced.
  let filesRemoved = 0;
  for (const key of keys) {
    try {
      await storage().remove(key);
      filesRemoved++;
    } catch (err) {
      logger.warn("user delete: file removal failed", { key, err: (err as Error).message });
    }
  }
  const authRemoved = await deleteSupabaseAuthUser(userId);
  await audit(actorId, "user_deleted", userId, { email: p.email, files: keys.length, filesRemoved, authRemoved });
  return { ok: true, filesRemoved, files: keys.length };
}

async function deleteSupabaseAuthUser(userId: string) {
  const e = env();
  if (e.AUTH_PROVIDER !== "supabase" || !e.NEXT_PUBLIC_SUPABASE_URL || !e.SUPABASE_SERVICE_ROLE_KEY) return false;
  const res = await fetch(`${e.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
    method: "DELETE",
    headers: { apikey: e.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${e.SUPABASE_SERVICE_ROLE_KEY}` },
  });
  if (!res.ok && res.status !== 404) logger.warn("user delete: Supabase auth user not removed", { userId, status: res.status });
  return res.ok;
}

// ------------------------------------------------------------------ viewing a user's content (audited)

export const CONTENT_TYPES = ["posts", "clips", "media"] as const;
export type ContentType = (typeof CONTENT_TYPES)[number];

export async function userContent(actorId: string, userId: string, type: ContentType) {
  await loadUser(userId);
  const db = serviceDb();
  let items: unknown[];
  if (type === "posts") {
    const posts = await db.select().from(schema.posts).where(eq(schema.posts.userId, userId)).orderBy(desc(schema.posts.createdAt)).limit(200);
    const targets = posts.length ? await db.select().from(schema.postTargets).where(inArray(schema.postTargets.postId, posts.map((p) => p.id))) : [];
    items = posts.map((p) => ({
      id: p.id,
      title: p.title,
      caption: p.baseCaption,
      status: p.status,
      mediaAssetId: p.mediaAssetId,
      scheduledAt: p.scheduledAt,
      createdAt: p.createdAt,
      targets: targets.filter((t) => t.postId === p.id).map((t) => ({ id: t.id, platform: t.platform, status: t.status, publicationUrl: t.publicationUrl, lastError: t.lastError })),
    }));
  } else if (type === "clips") {
    const jobs = await db.select().from(schema.clipJobs).where(eq(schema.clipJobs.userId, userId)).orderBy(desc(schema.clipJobs.createdAt)).limit(100);
    const clips = jobs.length ? await db.select().from(schema.clips).where(inArray(schema.clips.jobId, jobs.map((j) => j.id))).orderBy(schema.clips.rank) : [];
    items = jobs.map((j) => ({
      id: j.id,
      sourceType: j.sourceType,
      title: (j.source as { title?: string; filename?: string } | null)?.title ?? (j.source as { filename?: string } | null)?.filename ?? "Clip job",
      youtubeVideoId: j.youtubeVideoId,
      status: j.status,
      createdAt: j.createdAt,
      clips: clips.filter((c) => c.jobId === j.id).map((c) => ({ id: c.id, rank: c.rank, title: c.title, startSec: c.startSec, endSec: c.endSec, status: c.status, assetId: c.assetId })),
    }));
  } else {
    items = await db
      .select({ id: schema.mediaAssets.id, filename: schema.mediaAssets.filename, kind: schema.mediaAssets.kind, mimeType: schema.mediaAssets.mimeType, sizeBytes: schema.mediaAssets.sizeBytes, folder: schema.mediaAssets.folder, createdAt: schema.mediaAssets.createdAt })
      .from(schema.mediaAssets)
      .where(eq(schema.mediaAssets.userId, userId))
      .orderBy(desc(schema.mediaAssets.createdAt))
      .limit(500);
  }
  await audit(actorId, "content_viewed", userId, { type, count: items.length });
  return { type, items };
}

/** Look up any user's media file for the owner's read-only viewer. */
export async function ownerMediaAsset(assetId: string) {
  const [asset] = await serviceDb().select().from(schema.mediaAssets).where(eq(schema.mediaAssets.id, assetId));
  if (!asset) throw notFound("Media asset");
  return asset;
}

export async function listAudit(limit = 200, targetUserId?: string) {
  const db = serviceDb();
  const rows = await db
    .select()
    .from(schema.adminAuditLog)
    .where(targetUserId ? eq(schema.adminAuditLog.targetUserId, targetUserId) : undefined)
    .orderBy(desc(schema.adminAuditLog.createdAt))
    .limit(Math.min(limit, 500));
  const ids = [...new Set(rows.flatMap((r) => [r.actorId, r.targetUserId]).filter((v): v is string => !!v))];
  const people = ids.length ? await db.select({ id: schema.profiles.id, email: schema.profiles.email }).from(schema.profiles).where(inArray(schema.profiles.id, ids)) : [];
  const email = (id: string | null) => (id ? people.find((p) => p.id === id)?.email ?? (null as string | null) : null);
  return rows.map((r) => ({ ...r, actorEmail: email(r.actorId), targetEmail: email(r.targetUserId) ?? ((r.detail as { email?: string }).email ?? null) }));
}

