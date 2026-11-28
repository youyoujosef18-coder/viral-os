import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { serviceDb, schema, withUser } from "../db/client";
import { storage } from "../storage";
import { getAdapter } from "../providers/platforms";
import { ProviderError } from "../providers/http";
import type { MediaSource, Platform, PublishInput, PublishOutcome } from "../providers/platforms/types";
import { getValidAccessToken, markConnectionError } from "./connections";
import { enqueuePublish } from "../queue/queues";
import { notify } from "./notifications";
import { logActivity } from "./activity";
import { emitAutomationEvent } from "./automation";
import { ApiError, badRequest, notFound } from "../api/errors";
import { logger } from "../logger";
import { meteredFor } from "../usage";
import { assertOwnedIn } from "./ownership";

type Target = typeof schema.postTargets.$inferSelect;
type Status = Target["status"];

export const MAX_ATTEMPTS = 5;
const STALE_LOCK_MINUTES = 15;

/** Exponential backoff with jitter: 30s, 60s, 120s ... capped at 1h, randomized to 50–100%. */
export function backoffMs(attempt: number, random = Math.random) {
  const base = Math.min(3600_000, 30_000 * 2 ** Math.max(0, attempt - 1));
  return Math.round(base / 2 + random() * (base / 2));
}

const CANCELLABLE: Status[] = ["draft", "needs_review", "ready", "scheduled", "queued", "failed", "requires_user_action", "platform_approval_required"];
const RETRYABLE: Status[] = ["failed", "requires_user_action", "platform_approval_required", "cancelled"];
const EDITABLE: Status[] = ["draft", "needs_review", "ready", "scheduled", "failed", "requires_user_action", "platform_approval_required", "cancelled"];

export const targetInputSchema = z.object({
  connectionId: z.string().uuid(),
  title: z.string().max(200).nullable().optional(),
  caption: z.string().max(5000).default(""),
  hashtags: z.array(z.string().max(100)).max(30).default([]),
  privacy: z.string().min(1).max(40),
  options: z.record(z.string(), z.unknown()).default({}),
  thumbnailAssetId: z.string().uuid().nullable().optional(),
});

export const postInputSchema = z.object({
  title: z.string().trim().min(1, "Title is required").max(200),
  baseCaption: z.string().max(5000).default(""),
  projectId: z.string().uuid().nullable().optional(),
  mediaAssetId: z.string().uuid().nullable().optional(),
  thumbnailAssetId: z.string().uuid().nullable().optional(),
  timezone: z.string().refine(isValidTimeZone, "Unknown timezone").default("UTC"),
  status: z.enum(["draft", "needs_review", "ready"]).default("draft"),
  targets: z.array(targetInputSchema).max(10).default([]),
});

export type PostInput = z.infer<typeof postInputSchema>;

function isValidTimeZone(tz: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Aggregate a post's status from its targets. */
export function aggregateStatus(statuses: Status[], fallback: Status): Status {
  if (statuses.length === 0) return fallback;
  const has = (s: Status) => statuses.includes(s);
  if (statuses.every((s) => s === "published")) return "published";
  if (statuses.every((s) => s === "cancelled")) return "cancelled";
  if (has("uploading")) return "uploading";
  if (has("processing")) return "processing";
  if (has("queued")) return "queued";
  if (has("failed")) return "failed";
  if (has("requires_user_action")) return "requires_user_action";
  if (has("platform_approval_required")) return "platform_approval_required";
  if (has("scheduled")) return "scheduled";
  if (statuses.some((s) => s === "published")) return "published";
  return statuses[0];
}

async function refreshPostStatus(postId: string) {
  const db = serviceDb();
  const [post] = await db.select().from(schema.posts).where(eq(schema.posts.id, postId));
  if (!post) return;
  const targets = await db.select({ status: schema.postTargets.status }).from(schema.postTargets).where(eq(schema.postTargets.postId, postId));
  const status = aggregateStatus(targets.map((t) => t.status), post.status);
  if (status !== post.status) await db.update(schema.posts).set({ status, updatedAt: new Date() }).where(eq(schema.posts.id, postId));
}

async function recordEvent(t: Pick<Target, "id" | "userId">, status: Status, message: string, detail?: Record<string, unknown>) {
  await serviceDb().insert(schema.publishEvents).values({ targetId: t.id, userId: t.userId, status, message, detail });
}

// ------------------------------------------------------------------ validation

async function validateTargets(userId: string, input: PostInput): Promise<string[]> {
  if (input.targets.length === 0) return [];
  return withUser(userId, async (tx) => {
    const problems: string[] = [];
    const media = input.mediaAssetId ? (await tx.select().from(schema.mediaAssets).where(eq(schema.mediaAssets.id, input.mediaAssetId)))[0] : undefined;
    const ids = input.targets.map((t) => t.connectionId);
    const conns = await tx.select().from(schema.platformConnections).where(inArray(schema.platformConnections.id, ids));
    for (const t of input.targets) {
      const conn = conns.find((c) => c.id === t.connectionId);
      if (!conn) {
        problems.push(`Connected account ${t.connectionId} was not found.`);
        continue;
      }
      const adapter = getAdapter(conn.platform);
      if (!media) {
        problems.push(`${adapter.displayName}: attach a media file before publishing.`);
        continue;
      }
      for (const p of adapter.validate({
        media: { mimeType: media.mimeType, sizeBytes: media.sizeBytes, kind: media.kind, durationSeconds: media.durationSeconds },
        title: t.title ?? input.title,
        caption: t.caption || input.baseCaption,
        privacy: t.privacy,
      })) {
        problems.push(`${adapter.displayName} (${conn.accountName ?? conn.accountHandle ?? "account"}): ${p}`);
      }
    }
    return problems;
  });
}

// ------------------------------------------------------------------ CRUD

export async function createPost(userId: string, raw: unknown) {
  const input = postInputSchema.parse(raw);
  return withUser(userId, async (tx) => {
    await assertOwnedIn(tx, { mediaAssets: [input.mediaAssetId, input.thumbnailAssetId, ...input.targets.map((t) => t.thumbnailAssetId)], projects: [input.projectId] });
    const [post] = await tx
      .insert(schema.posts)
      .values({
        userId,
        title: input.title,
        baseCaption: input.baseCaption,
        projectId: input.projectId ?? null,
        mediaAssetId: input.mediaAssetId ?? null,
        thumbnailAssetId: input.thumbnailAssetId ?? null,
        timezone: input.timezone,
        status: input.status,
      })
      .returning();
    await insertTargets(tx, userId, post.id, input);
    return post;
  });
}

async function insertTargets(tx: Parameters<Parameters<typeof withUser>[1]>[0], userId: string, postId: string, input: PostInput) {
  if (input.targets.length === 0) return;
  const conns = await tx.select().from(schema.platformConnections).where(inArray(schema.platformConnections.id, input.targets.map((t) => t.connectionId)));
  const seen = new Set<string>();
  for (const t of input.targets) {
    const conn = conns.find((c) => c.id === t.connectionId);
    if (!conn) throw badRequest("One of the selected accounts is not connected.");
    if (seen.has(conn.id)) throw badRequest("Each account can only be selected once per post.");
    seen.add(conn.id);
    await tx.insert(schema.postTargets).values({
      userId,
      postId,
      connectionId: conn.id,
      platform: conn.platform,
      title: t.title ?? null,
      caption: t.caption,
      hashtags: t.hashtags.map((h) => h.replace(/^#+/, "").trim()).filter(Boolean),
      privacy: t.privacy,
      options: t.options,
      thumbnailAssetId: t.thumbnailAssetId ?? null,
      status: input.status,
      // One target per (post, account): the database rejects duplicates, so a post can never be sent twice to the same account.
      idempotencyKey: `${postId}:${conn.id}`,
    });
  }
}

export async function updatePost(userId: string, postId: string, raw: unknown) {
  const input = postInputSchema.parse(raw);
  return withUser(userId, async (tx) => {
    const [post] = await tx.select().from(schema.posts).where(eq(schema.posts.id, postId)).for("update");
    if (!post) throw notFound("Post");
    // Lock the targets so the worker can't start publishing one between this check and the rewrite.
    const targets = await tx.select().from(schema.postTargets).where(eq(schema.postTargets.postId, postId)).for("update");
    if (targets.some((t) => !EDITABLE.includes(t.status))) {
      throw new ApiError(409, "This post is being published or is already live on a platform and can no longer be edited. Duplicate it instead.", "locked");
    }
    await assertOwnedIn(tx, { mediaAssets: [input.mediaAssetId, input.thumbnailAssetId, ...input.targets.map((t) => t.thumbnailAssetId)], projects: [input.projectId] });
    const [updated] = await tx
      .update(schema.posts)
      .set({
        title: input.title,
        baseCaption: input.baseCaption,
        projectId: input.projectId ?? null,
        mediaAssetId: input.mediaAssetId ?? null,
        thumbnailAssetId: input.thumbnailAssetId ?? null,
        timezone: input.timezone,
        status: input.status,
        scheduledAt: null,
        updatedAt: new Date(),
      })
      .where(eq(schema.posts.id, postId))
      .returning();
    await tx.delete(schema.postTargets).where(eq(schema.postTargets.postId, postId));
    await insertTargets(tx, userId, postId, input);
    return updated;
  });
}

export async function duplicatePost(userId: string, postId: string) {
  return withUser(userId, async (tx) => {
    const [post] = await tx.select().from(schema.posts).where(eq(schema.posts.id, postId));
    if (!post) throw notFound("Post");
    const targets = await tx.select().from(schema.postTargets).where(eq(schema.postTargets.postId, postId));
    const [copy] = await tx
      .insert(schema.posts)
      .values({ userId, title: `${post.title} (copy)`, baseCaption: post.baseCaption, projectId: post.projectId, mediaAssetId: post.mediaAssetId, thumbnailAssetId: post.thumbnailAssetId, timezone: post.timezone, status: "draft", duplicatedFrom: post.id })
      .returning();
    for (const t of targets) {
      await tx.insert(schema.postTargets).values({
        userId,
        postId: copy.id,
        connectionId: t.connectionId,
        platform: t.platform,
        title: t.title,
        caption: t.caption,
        hashtags: t.hashtags,
        privacy: t.privacy,
        options: t.options,
        thumbnailAssetId: t.thumbnailAssetId,
        status: "draft",
        idempotencyKey: `${copy.id}:${t.connectionId ?? t.id}`,
      });
    }
    return copy;
  });
}

export async function deletePost(userId: string, postId: string) {
  return withUser(userId, async (tx) => {
    // Lock the targets so a worker can't claim one between this check and the delete.
    const targets = await tx.select().from(schema.postTargets).where(eq(schema.postTargets.postId, postId)).for("update");
    if (targets.some((t) => t.status === "uploading" || t.status === "processing")) {
      throw new ApiError(409, "Cannot delete a post while it is uploading or processing.", "locked");
    }
    const deleted = await tx.delete(schema.posts).where(eq(schema.posts.id, postId)).returning({ id: schema.posts.id });
    if (!deleted.length) throw notFound("Post");
  });
}

// ------------------------------------------------------------------ state transitions

/** Publish now or schedule. scheduledAt is an absolute instant (client converts from the chosen timezone). */
export async function queuePost(userId: string, postId: string, opts: { scheduledAt?: Date | null }) {
  const post = await withUser(userId, async (tx) => (await tx.select().from(schema.posts).where(eq(schema.posts.id, postId)))[0]);
  if (!post) throw notFound("Post");
  const targets = await withUser(userId, (tx) => tx.select().from(schema.postTargets).where(eq(schema.postTargets.postId, postId)));
  if (targets.length === 0) throw badRequest("Select at least one connected account.");
  const input: PostInput = {
    title: post.title,
    baseCaption: post.baseCaption,
    mediaAssetId: post.mediaAssetId,
    thumbnailAssetId: post.thumbnailAssetId,
    timezone: post.timezone,
    status: "ready",
    targets: targets.map((t) => ({ connectionId: t.connectionId!, title: t.title, caption: t.caption, hashtags: t.hashtags, privacy: t.privacy, options: t.options, thumbnailAssetId: t.thumbnailAssetId })),
  };
  const problems = await validateTargets(userId, input);
  if (problems.length) throw new ApiError(422, "Fix these issues before publishing.", "publish_validation", problems);
  const pending = targets.filter((t) => EDITABLE.includes(t.status) && t.status !== "cancelled");
  if (pending.length === 0) throw new ApiError(409, "Nothing to publish: every target is already queued, publishing or published.", "nothing_to_publish");

  const scheduledAt = opts.scheduledAt ?? null;
  if (scheduledAt && scheduledAt.getTime() < Date.now() - 60_000) throw badRequest("The scheduled time is in the past.");
  const status: Status = scheduledAt ? "scheduled" : "queued";
  const now = new Date();
  await withUser(userId, async (tx) => {
    await tx
      .update(schema.postTargets)
      .set({ status, scheduledAt, nextAttemptAt: scheduledAt ?? now, attempts: 0, lastError: null, lastErrorCode: null, lockedAt: null, updatedAt: now })
      .where(inArray(schema.postTargets.id, pending.map((t) => t.id)));
    await tx.update(schema.posts).set({ status, scheduledAt, updatedAt: now }).where(eq(schema.posts.id, postId));
  });
  for (const t of pending) {
    await recordEvent(t, status, scheduledAt ? `Scheduled for ${scheduledAt.toISOString()}` : "Queued for publishing");
    await enqueuePublish({ targetId: t.id, mode: "publish" }, scheduledAt ? scheduledAt.getTime() - Date.now() : 0);
  }
  await logActivity(userId, { action: scheduledAt ? "post.scheduled" : "post.queued", entityType: "post", entityId: postId, summary: `${scheduledAt ? "Scheduled" : "Queued"} "${post.title}" to ${pending.length} account(s)` });
  return { status, targets: pending.length };
}

export async function cancelTarget(userId: string, targetId: string) {
  return withUser(userId, async (tx) => {
    const [t] = await tx.select().from(schema.postTargets).where(eq(schema.postTargets.id, targetId));
    if (!t) throw notFound("Publishing target");
    if (!CANCELLABLE.includes(t.status)) throw new ApiError(409, `Cannot cancel a target that is ${t.status.replace(/_/g, " ")}.`, "not_cancellable");
    // Conditional update: if a worker claimed the target after the read above, Postgres re-checks the
    // status on the newest row version and nothing is cancelled (no overwriting "uploading").
    const done = await tx
      .update(schema.postTargets)
      .set({ status: "cancelled", lockedAt: null, updatedAt: new Date() })
      .where(and(eq(schema.postTargets.id, targetId), inArray(schema.postTargets.status, CANCELLABLE)))
      .returning({ id: schema.postTargets.id });
    if (!done.length) throw new ApiError(409, "This target started publishing a moment ago and can no longer be cancelled.", "not_cancellable");
    return t;
  }).then(async (t) => {
    await recordEvent(t, "cancelled", "Cancelled by user");
    await refreshPostStatus(t.postId);
  });
}

export async function cancelPost(userId: string, postId: string) {
  const targets = await withUser(userId, (tx) => tx.select().from(schema.postTargets).where(eq(schema.postTargets.postId, postId)));
  if (!targets.length) {
    const [p] = await withUser(userId, (tx) => tx.update(schema.posts).set({ status: "cancelled" }).where(eq(schema.posts.id, postId)).returning());
    if (!p) throw notFound("Post");
    return;
  }
  for (const t of targets.filter((t) => CANCELLABLE.includes(t.status))) await cancelTarget(userId, t.id);
}

export async function retryTarget(userId: string, targetId: string) {
  const t = await withUser(userId, async (tx) => (await tx.select().from(schema.postTargets).where(eq(schema.postTargets.id, targetId)))[0]);
  if (!t) throw notFound("Publishing target");
  if (!RETRYABLE.includes(t.status)) throw new ApiError(409, `Only failed or cancelled targets can be retried (current: ${t.status}).`, "not_retryable");
  await withUser(userId, (tx) =>
    tx.update(schema.postTargets).set({ status: "queued", attempts: 0, nextAttemptAt: new Date(), lockedAt: null, lastError: null, lastErrorCode: null, updatedAt: new Date() }).where(eq(schema.postTargets.id, targetId)),
  );
  await recordEvent(t, "queued", "Retry requested by user");
  await refreshPostStatus(t.postId);
  await enqueuePublish({ targetId, mode: "publish" });
}

// ------------------------------------------------------------------ worker execution

async function mediaSource(userId: string, assetId: string | null): Promise<MediaSource | null> {
  if (!assetId) return null;
  const [asset] = await serviceDb()
    .select()
    .from(schema.mediaAssets)
    .where(and(eq(schema.mediaAssets.id, assetId), eq(schema.mediaAssets.userId, userId)));
  if (!asset) return null;
  const s = storage();
  return {
    mimeType: asset.mimeType,
    sizeBytes: asset.sizeBytes,
    kind: asset.kind,
    readRange: (start, end) => s.getRange(asset.storageKey, start, end),
    readAll: () => s.get(asset.storageKey),
    publicUrl: (ttl) => s.publicUrl(asset.storageKey, ttl),
  };
}

/**
 * Atomically claim a target so concurrent workers can never process it twice.
 * publish mode: queued/scheduled targets that are due, or uploads whose worker died (stale lock).
 * poll mode: processing targets whose next check is due.
 */
async function claim(targetId: string, mode: "publish" | "poll"): Promise<Target | null> {
  const db = serviceDb();
  const stale = sql`now() - (${STALE_LOCK_MINUTES} || ' minutes')::interval`;
  const due = sql`coalesce(${schema.postTargets.nextAttemptAt}, ${schema.postTargets.scheduledAt}, now()) <= now()`;
  const where =
    mode === "publish"
      ? sql`${schema.postTargets.id} = ${targetId} and ((${schema.postTargets.status} in ('queued','scheduled') and ${due}) or (${schema.postTargets.status} = 'uploading' and ${schema.postTargets.lockedAt} < ${stale}))`
      : sql`${schema.postTargets.id} = ${targetId} and ${schema.postTargets.status} = 'processing' and ${due} and (${schema.postTargets.lockedAt} is null or ${schema.postTargets.lockedAt} < ${stale})`;
  const rows = await db
    .update(schema.postTargets)
    .set(
      mode === "publish"
        ? { status: "uploading", lockedAt: sql`now()`, attempts: sql`${schema.postTargets.attempts} + 1`, updatedAt: sql`now()` }
        : { lockedAt: sql`now()`, updatedAt: sql`now()` },
    )
    .where(where)
    .returning();
  return rows[0] ?? null;
}

export type ProcessResult = { outcome: "skipped" | "published" | "processing" | "retry" | "failed"; detail?: string };

async function processTargetUnmetered(targetId: string, mode: "publish" | "poll" = "publish"): Promise<ProcessResult> {
  const t = await claim(targetId, mode);
  if (!t) return { outcome: "skipped", detail: "not due, already claimed, or in a terminal state" };
  const db = serviceDb();
  await refreshPostStatus(t.postId);
  if (mode === "publish") await recordEvent(t, "uploading", t.attempts > 1 ? `Attempt ${t.attempts} started` : "Upload started");

  try {
    if (!t.connectionId) throw new ProviderError("The connected account for this target was removed.", { userAction: true });
    const [conn] = await db.select().from(schema.platformConnections).where(eq(schema.platformConnections.id, t.connectionId));
    if (!conn) throw new ProviderError("The connected account for this target was removed.", { userAction: true });
    const [post] = await db.select().from(schema.posts).where(eq(schema.posts.id, t.postId));
    const media = await mediaSource(t.userId, post?.mediaAssetId ?? null);
    if (!media) throw new ProviderError("The media file for this post is missing.", { userAction: true });
    const thumbnail = await mediaSource(t.userId, t.thumbnailAssetId ?? post?.thumbnailAssetId ?? null);
    const accessToken = await getValidAccessToken(conn);
    const adapter = getAdapter(t.platform as Platform);

    let currentRef = t.providerUploadRef ?? null;
    const input: PublishInput = {
      accessToken,
      account: { externalAccountId: conn.externalAccountId, metadata: conn.metadata },
      title: t.title ?? post?.title ?? null,
      caption: t.caption || post?.baseCaption || "",
      hashtags: t.hashtags,
      privacy: t.privacy,
      options: t.options,
      media,
      thumbnail,
      uploadRef: currentRef,
      saveUploadRef: async (ref) => {
        currentRef = ref;
        await db.update(schema.postTargets).set({ providerUploadRef: ref, lockedAt: sql`now()`, updatedAt: sql`now()` }).where(eq(schema.postTargets.id, t.id));
      },
    };

    const outcome: PublishOutcome = mode === "poll" ? await adapter.checkStatus(input) : await adapter.publish(input);
    return await applyOutcome(t, outcome, post?.title ?? "Post");
  } catch (err) {
    return await applyFailure(t, err);
  }
}

async function applyOutcome(t: Target, outcome: PublishOutcome, postTitle: string): Promise<ProcessResult> {
  const db = serviceDb();
  if (outcome.state === "processing") {
    const next = new Date(Date.now() + outcome.pollAfterMs);
    await db.update(schema.postTargets).set({ status: "processing", providerUploadRef: outcome.uploadRef, nextAttemptAt: next, lockedAt: null, updatedAt: new Date() }).where(eq(schema.postTargets.id, t.id));
    if (t.status !== "processing") await recordEvent(t, "processing", outcome.message);
    await refreshPostStatus(t.postId);
    await enqueuePublish({ targetId: t.id, mode: "poll" }, outcome.pollAfterMs);
    return { outcome: "processing", detail: outcome.message };
  }
  // Only reached when the platform API confirmed publication.
  await db
    .update(schema.postTargets)
    .set({ status: "published", providerPostId: outcome.providerPostId, publicationUrl: outcome.url, providerUploadRef: outcome.uploadRef, publishedAt: new Date(), lockedAt: null, lastError: null, lastErrorCode: null, updatedAt: new Date() })
    .where(eq(schema.postTargets.id, t.id));
  await recordEvent(t, "published", outcome.url ? `Published: ${outcome.url}` : "Published (confirmed by platform)", { providerPostId: outcome.providerPostId, warnings: outcome.warnings });
  await refreshPostStatus(t.postId);
  const name = getAdapter(t.platform as Platform).displayName;
  await notify(t.userId, { type: "success", title: `Published to ${name}`, body: `"${postTitle}" is live.${outcome.warnings?.length ? ` Note: ${outcome.warnings.join(" ")}` : ""}`, link: `/publishing?post=${t.postId}` });
  await logActivity(t.userId, { action: "post.published", entityType: "post", entityId: t.postId, summary: `Published "${postTitle}" to ${name}` });
  await emitAutomationEvent(t.userId, { type: "post_published", platform: t.platform });
  return { outcome: "published" };
}

async function applyFailure(t: Target, err: unknown): Promise<ProcessResult> {
  const db = serviceDb();
  const pe = err instanceof ProviderError ? err : null;
  const message = (err as Error).message ?? "Unknown error";
  if (!pe) logger.error("Unexpected publishing error", { targetId: t.id, err: (err as Error).stack });
  if (pe?.opts.reauth && t.connectionId) await markConnectionError(t.connectionId, err);

  // Unknown (non-provider) errors are retried: they're typically infrastructure hiccups.
  const retryable = pe ? !!pe.opts.retryable : true;
  if (retryable && t.attempts < MAX_ATTEMPTS) {
    const delay = backoffMs(t.attempts);
    const next = new Date(Date.now() + delay);
    // Processing targets keep polling; upload targets go back to the queue and resume from the saved upload state.
    const status: Status = t.status === "processing" ? "processing" : "queued";
    await db.update(schema.postTargets).set({ status, nextAttemptAt: next, lockedAt: null, lastError: message.slice(0, 2000), lastErrorCode: pe?.opts.code ?? null, updatedAt: new Date() }).where(eq(schema.postTargets.id, t.id));
    await recordEvent(t, status, `Attempt ${t.attempts} failed, retrying in ${Math.round(delay / 1000)}s: ${message}`, { code: pe?.opts.code, status: pe?.opts.status });
    await refreshPostStatus(t.postId);
    await enqueuePublish({ targetId: t.id, mode: status === "processing" ? "poll" : "publish" }, delay);
    return { outcome: "retry", detail: message };
  }

  const status: Status = pe?.opts.approvalRequired ? "platform_approval_required" : pe?.opts.userAction || pe?.opts.reauth ? "requires_user_action" : "failed";
  await db.update(schema.postTargets).set({ status, lockedAt: null, lastError: message.slice(0, 2000), lastErrorCode: pe?.opts.code ?? null, updatedAt: new Date() }).where(eq(schema.postTargets.id, t.id));
  await recordEvent(t, status, message, { code: pe?.opts.code, status: pe?.opts.status, attempts: t.attempts });
  await refreshPostStatus(t.postId);
  const name = getAdapter(t.platform as Platform).displayName;
  await notify(t.userId, { type: "error", title: `${name} publishing ${status === "failed" ? "failed" : "needs your attention"}`, body: message, link: `/publishing?post=${t.postId}` });
  await emitAutomationEvent(t.userId, { type: "post_failed", platform: t.platform });
  return { outcome: "failed", detail: message };
}

/** Durable reconciliation: find due work in Postgres regardless of the Redis queue state. */
export async function findDueTargets(limit = 50) {
  const db = serviceDb();
  const stale = sql`now() - (${STALE_LOCK_MINUTES} || ' minutes')::interval`;
  return db
    .select({ id: schema.postTargets.id, status: schema.postTargets.status })
    .from(schema.postTargets)
    .where(
      sql`((${schema.postTargets.status} in ('queued','scheduled') and coalesce(${schema.postTargets.nextAttemptAt}, ${schema.postTargets.scheduledAt}, now()) <= now())
        or (${schema.postTargets.status} = 'uploading' and ${schema.postTargets.lockedAt} < ${stale})
        or (${schema.postTargets.status} = 'processing' and coalesce(${schema.postTargets.nextAttemptAt}, now()) <= now() and (${schema.postTargets.lockedAt} is null or ${schema.postTargets.lockedAt} < ${stale})))`,
    )
    .orderBy(asc(schema.postTargets.nextAttemptAt))
    .limit(limit);
}

// ------------------------------------------------------------------ queries

export async function listPosts(userId: string, filter: { status?: string; from?: Date; to?: Date; limit?: number }) {
  return withUser(userId, async (tx) => {
    const conds = [];
    if (filter.status) conds.push(eq(schema.posts.status, filter.status as Status));
    // Raw SQL params are untyped: pass ISO strings with an explicit cast (the driver can't serialize Date here).
    if (filter.from) conds.push(sql`coalesce(${schema.posts.scheduledAt}, ${schema.posts.createdAt}) >= ${filter.from.toISOString()}::timestamptz`);
    if (filter.to) conds.push(sql`coalesce(${schema.posts.scheduledAt}, ${schema.posts.createdAt}) < ${filter.to.toISOString()}::timestamptz`);
    const posts = await tx
      .select()
      .from(schema.posts)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(schema.posts.updatedAt))
      .limit(filter.limit ?? 200);
    const targets = posts.length ? await tx.select().from(schema.postTargets).where(inArray(schema.postTargets.postId, posts.map((p) => p.id))) : [];
    return posts.map((p) => ({ ...p, targets: targets.filter((t) => t.postId === p.id).map(publicTarget) }));
  });
}

export function publicTarget(t: Target) {
  const { providerUploadRef, lockedAt, ...rest } = t;
  void lockedAt;
  // Never expose resumable session URLs (they act as bearer credentials).
  return { ...rest, providerUploadRef: providerUploadRef ? { state: (providerUploadRef as Record<string, unknown>).platformStatus ?? (providerUploadRef as Record<string, unknown>).uploadStatus ?? null } : null };
}

export async function getPostDetail(userId: string, postId: string) {
  return withUser(userId, async (tx) => {
    const [post] = await tx.select().from(schema.posts).where(eq(schema.posts.id, postId));
    if (!post) throw notFound("Post");
    const targets = await tx.select().from(schema.postTargets).where(eq(schema.postTargets.postId, postId));
    const events = targets.length
      ? await tx.select().from(schema.publishEvents).where(inArray(schema.publishEvents.targetId, targets.map((t) => t.id))).orderBy(desc(schema.publishEvents.createdAt)).limit(200)
      : [];
    return { ...post, targets: targets.map(publicTarget), events };
  });
}

/** Publish or poll one target; YouTube quota it uses is attributed to the post's owner. */
export function processTarget(targetId: string, mode: "publish" | "poll" = "publish"): Promise<ProcessResult> {
  return meteredFor("post_targets", targetId, () => processTargetUnmetered(targetId, mode));
}
