import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema, serviceDb, withUser } from "@/lib/db/client";
import { setAdapterForTests } from "@/lib/providers/platforms";
import { ProviderError } from "@/lib/providers/http";
import { createPost, listPosts, queuePost, processTarget, retryTarget, cancelTarget, duplicatePost, findDueTargets, getPostDetail, MAX_ATTEMPTS } from "@/lib/services/publishing";
import { saveUpload } from "@/lib/services/media";
import { createUser, createConnection, scriptedAdapter } from "../helpers";

const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypmp42"), Buffer.alloc(2048, 1)]);

async function setup(platform: "youtube" | "tiktok" | "instagram" = "youtube") {
  const user = await createUser();
  const conn = await createConnection(user.id, platform);
  const asset = await saveUpload(user.id, { name: "clip.mp4", type: "video/mp4", buffer: MP4 });
  const post = await createPost(user.id, {
    title: "My video",
    baseCaption: "Caption",
    mediaAssetId: asset.id,
    targets: [{ connectionId: conn.id, title: "My video", caption: "Hello", hashtags: ["#test", "creator"], privacy: platform === "tiktok" ? "SELF_ONLY" : "private" }],
  });
  const [target] = await serviceDb().select().from(schema.postTargets).where(eq(schema.postTargets.postId, post.id));
  return { user, conn, asset, post, target };
}

const targetById = async (id: string) => (await serviceDb().select().from(schema.postTargets).where(eq(schema.postTargets.id, id)))[0];
const makeDue = (id: string) => serviceDb().update(schema.postTargets).set({ nextAttemptAt: new Date(Date.now() - 1000) }).where(eq(schema.postTargets.id, id));

afterEach(() => setAdapterForTests("youtube", null));

describe("publishing pipeline", () => {
  it("normalizes hashtags and derives the idempotency key from post + account", async () => {
    const { target, post, conn } = await setup();
    expect(target.hashtags).toEqual(["test", "creator"]);
    expect(target.idempotencyKey).toBe(`${post.id}:${conn.id}`);
  });

  it("goes queued → uploading → processing → published only after platform confirmation", async () => {
    const { user, post, target } = await setup();
    const adapter = scriptedAdapter("youtube", [
      { state: "processing", uploadRef: { videoId: "abc" }, message: "processing", pollAfterMs: 1000 },
      { state: "processing", uploadRef: { videoId: "abc" }, message: "still processing", pollAfterMs: 1000 },
      { state: "published", providerPostId: "abc", url: "https://www.youtube.com/watch?v=abc", uploadRef: { videoId: "abc" } },
    ]);
    setAdapterForTests("youtube", adapter);
    await queuePost(user.id, post.id, {});
    expect((await targetById(target.id)).status).toBe("queued");

    expect((await processTarget(target.id, "publish")).outcome).toBe("processing");
    let t = await targetById(target.id);
    expect(t.status).toBe("processing");
    expect(t.publishedAt).toBeNull();
    expect(t.providerPostId).toBeNull();

    // Poll before it's due is a no-op (claim refuses).
    expect((await processTarget(target.id, "poll")).outcome).toBe("skipped");
    await makeDue(target.id);
    expect((await processTarget(target.id, "poll")).outcome).toBe("processing");
    await makeDue(target.id);
    expect((await processTarget(target.id, "poll")).outcome).toBe("published");

    t = await targetById(target.id);
    expect(t.status).toBe("published");
    expect(t.providerPostId).toBe("abc");
    expect(t.publicationUrl).toContain("abc");
    const detail = await getPostDetail(user.id, post.id);
    expect(detail.status).toBe("published");
    expect(detail.events.map((e) => e.status)).toContain("published");
    // Resumable session data is never returned to clients.
    expect(JSON.stringify(detail.targets)).not.toContain("videoId");
    const notes = await serviceDb().select().from(schema.notifications).where(eq(schema.notifications.userId, user.id));
    expect(notes.some((n) => n.title.includes("Published"))).toBe(true);
  });

  it("can never be processed twice concurrently (atomic claim)", async () => {
    const { user, post, target } = await setup();
    setAdapterForTests("youtube", scriptedAdapter("youtube", [{ state: "published", providerPostId: "v1", url: null, uploadRef: {} }]));
    await queuePost(user.id, post.id, {});
    const results = await Promise.all([processTarget(target.id), processTarget(target.id), processTarget(target.id)]);
    expect(results.filter((r) => r.outcome === "published")).toHaveLength(1);
    expect(results.filter((r) => r.outcome === "skipped")).toHaveLength(2);
    // Already published: queueing again is rejected, preventing duplicate posts.
    await expect(queuePost(user.id, post.id, {})).rejects.toThrow(/Nothing to publish/);
  });

  it("retries retryable errors with persisted backoff, then fails after MAX_ATTEMPTS", async () => {
    const { user, post, target } = await setup();
    const steps = Array.from({ length: MAX_ATTEMPTS }, () => new ProviderError("HTTP 503", { retryable: true, status: 503 }));
    setAdapterForTests("youtube", scriptedAdapter("youtube", steps));
    await queuePost(user.id, post.id, {});
    for (let i = 1; i <= MAX_ATTEMPTS; i++) {
      const r = await processTarget(target.id);
      const t = await targetById(target.id);
      if (i < MAX_ATTEMPTS) {
        expect(r.outcome).toBe("retry");
        expect(t.status).toBe("queued");
        expect(t.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
        await makeDue(target.id);
      } else {
        expect(r.outcome).toBe("failed");
        expect(t.status).toBe("failed");
        expect(t.attempts).toBe(MAX_ATTEMPTS);
      }
    }
    // User retry after fixing the problem resets attempts and requeues.
    setAdapterForTests("youtube", scriptedAdapter("youtube", [{ state: "published", providerPostId: "ok", url: null, uploadRef: {} }]));
    await retryTarget(user.id, target.id);
    expect((await targetById(target.id)).attempts).toBe(0);
    expect((await processTarget(target.id)).outcome).toBe("published");
  });

  it("maps platform review blocks and user-fixable errors to the right statuses", async () => {
    const a = await setup();
    setAdapterForTests("youtube", scriptedAdapter("youtube", [new ProviderError("unaudited", { approvalRequired: true })]));
    await queuePost(a.user.id, a.post.id, {});
    await processTarget(a.target.id);
    expect((await targetById(a.target.id)).status).toBe("platform_approval_required");

    const b = await setup();
    setAdapterForTests("youtube", scriptedAdapter("youtube", [new ProviderError("token revoked", { reauth: true, status: 401 })]));
    await queuePost(b.user.id, b.post.id, {});
    await processTarget(b.target.id);
    expect((await targetById(b.target.id)).status).toBe("requires_user_action");
    const [conn] = await serviceDb().select().from(schema.platformConnections).where(eq(schema.platformConnections.id, b.conn.id));
    expect(conn.status).toBe("requires_reauth");
  });

  it("schedules for later and the reconciler only picks it up when due", async () => {
    const { user, post, target } = await setup();
    await queuePost(user.id, post.id, { scheduledAt: new Date(Date.now() + 3600_000) });
    expect((await targetById(target.id)).status).toBe("scheduled");
    expect((await findDueTargets()).map((t) => t.id)).not.toContain(target.id);
    expect((await processTarget(target.id)).outcome).toBe("skipped");
    await serviceDb().update(schema.postTargets).set({ scheduledAt: new Date(Date.now() - 1000), nextAttemptAt: new Date(Date.now() - 1000) }).where(eq(schema.postTargets.id, target.id));
    expect((await findDueTargets()).map((t) => t.id)).toContain(target.id);
  });

  it("rejects scheduling in the past and validates platform rules before queueing", async () => {
    const { user, post } = await setup();
    await expect(queuePost(user.id, post.id, { scheduledAt: new Date(Date.now() - 3600_000) })).rejects.toThrow(/past/);
    const u = await createUser();
    const conn = await createConnection(u.id, "youtube");
    const p = await createPost(u.id, { title: "No media", targets: [{ connectionId: conn.id, privacy: "private" }] });
    await expect(queuePost(u.id, p.id, {})).rejects.toMatchObject({ status: 422 });
  });

  it("cancels queued targets and duplicates posts as fresh drafts", async () => {
    const { user, post, target } = await setup();
    await queuePost(user.id, post.id, { scheduledAt: new Date(Date.now() + 3600_000) });
    await cancelTarget(user.id, target.id);
    expect((await targetById(target.id)).status).toBe("cancelled");
    const copy = await duplicatePost(user.id, post.id);
    const detail = await getPostDetail(user.id, copy.id);
    expect(detail.status).toBe("draft");
    expect(detail.targets).toHaveLength(1);
    expect(detail.targets[0].idempotencyKey).not.toBe(target.idempotencyKey);
  });

  it("does not let one user act on another user's posts", async () => {
    const { post } = await setup();
    const intruder = await createUser();
    await expect(queuePost(intruder.id, post.id, {})).rejects.toThrow(/not found/i);
    await expect(getPostDetail(intruder.id, post.id)).rejects.toThrow(/not found/i);
    const rows = await withUser(intruder.id, (tx) => tx.select().from(schema.postTargets));
    expect(rows).toHaveLength(0);
  });

  it("lists posts within a date range (calendar query)", async () => {
    const { user, post } = await setup();
    await queuePost(user.id, post.id, { scheduledAt: new Date(Date.now() + 2 * 86400_000) });
    const inRange = await listPosts(user.id, { from: new Date(Date.now() + 86400_000), to: new Date(Date.now() + 3 * 86400_000) });
    const outOfRange = await listPosts(user.id, { from: new Date(Date.now() + 5 * 86400_000), to: new Date(Date.now() + 9 * 86400_000) });
    expect(inRange.map((p) => p.id)).toContain(post.id);
    expect(outOfRange.map((p) => p.id)).not.toContain(post.id);
    expect(inRange[0].targets).toHaveLength(1);
  });
});
