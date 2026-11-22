/**
 * Regression tests for the bug-hunt fixes. Real Postgres (including a second connection to reproduce
 * the worker racing a user action), real local storage, real Redis for the worker schedules.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import IORedis from "ioredis";
import { eq } from "drizzle-orm";
import { schema, serviceDb } from "@/lib/db/client";
import { resetEnvCache } from "@/lib/env";
import { setFetchForTests } from "@/lib/providers/http";
import { completeOAuth, startOAuth } from "@/lib/services/oauth";
import { cancelTarget, createPost, deletePost, queuePost } from "@/lib/services/publishing";
import { completeDirectUpload, createDirectUpload, saveUpload } from "@/lib/services/media";
import { technicalAnalysis } from "@/lib/services/analyzer";
import { LocalStorage, UploadTooLargeError, storage, verifyUploadToken } from "@/lib/storage";
import { createConnection, createUser } from "../helpers";

const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypmp42"), Buffer.alloc(4096, 1)]);
const raw = postgres(process.env.DATABASE_URL!, { max: 2, onnotice: () => {} });
afterAll(async () => {
  await raw.end();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const streamOf = (...chunks: Buffer[]) => new ReadableStream<Uint8Array>({ start(c) { for (const ch of chunks) c.enqueue(new Uint8Array(ch)); c.close(); } });
async function readAll(s: ReadableStream<Uint8Array>) {
  const parts: Buffer[] = [];
  for await (const chunk of s as unknown as AsyncIterable<Uint8Array>) parts.push(Buffer.from(chunk));
  return Buffer.concat(parts);
}

async function postWithTarget() {
  const user = await createUser();
  const conn = await createConnection(user.id, "youtube");
  const asset = await saveUpload(user.id, { name: "clip.mp4", type: "video/mp4", buffer: MP4 });
  const post = await createPost(user.id, { title: "Race", baseCaption: "c", mediaAssetId: asset.id, targets: [{ connectionId: conn.id, title: "Race", caption: "c", hashtags: [], privacy: "private" }] });
  await queuePost(user.id, post.id, {});
  const [target] = await serviceDb().select().from(schema.postTargets).where(eq(schema.postTargets.postId, post.id));
  return { user, post, target };
}

describe("cancel and delete can't race the worker", () => {
  it("a cancel that loses the race to the worker's claim is refused instead of overwriting 'uploading'", async () => {
    const { user, target } = await postWithTarget();
    expect(target.status).toBe("queued");
    let cancel: Promise<unknown> | null = null;
    await raw.begin(async (tx) => {
      // The worker claims the target (uncommitted, holds the row lock)…
      await tx`update post_targets set status = 'uploading', locked_at = now(), attempts = attempts + 1 where id = ${target.id}`;
      // …while the user presses Cancel: it reads 'queued' and its update waits for the lock.
      cancel = cancelTarget(user.id, target.id).then(() => "cancelled", (e) => e);
      await sleep(400);
    });
    const result = await cancel!;
    expect(result).toMatchObject({ status: 409, code: "not_cancellable" });
    const [after] = await serviceDb().select().from(schema.postTargets).where(eq(schema.postTargets.id, target.id));
    expect(after.status).toBe("uploading");
  });

  it("a cancel that wins means the worker can no longer claim the target", async () => {
    const { user, target } = await postWithTarget();
    await cancelTarget(user.id, target.id);
    const claimed = await raw`update post_targets set status = 'uploading' where id = ${target.id} and status in ('queued','scheduled') returning id`;
    expect(claimed.length).toBe(0);
  });

  it("deleting a post waits for an in-flight claim and then refuses", async () => {
    const { user, post, target } = await postWithTarget();
    let del: Promise<unknown> | null = null;
    await raw.begin(async (tx) => {
      await tx`update post_targets set status = 'uploading', locked_at = now() where id = ${target.id}`;
      del = deletePost(user.id, post.id).then(() => "deleted", (e) => e);
      await sleep(400);
    });
    expect(await del!).toMatchObject({ status: 409, code: "locked" });
    const [still] = await serviceDb().select().from(schema.posts).where(eq(schema.posts.id, post.id));
    expect(still).toBeTruthy();
  });

  it("a delete that wins leaves nothing for the worker to claim", async () => {
    const { user, post, target } = await postWithTarget();
    await deletePost(user.id, post.id);
    const claimed = await raw`update post_targets set status = 'uploading' where id = ${target.id} returning id`;
    expect(claimed.length).toBe(0);
  });
});

describe("OAuth redirect targets stay on this site", () => {
  it("stores a safe path for hostile redirect values", async () => {
    const user = await createUser();
    for (const hostile of ["//evil.example/x", "/\\evil.example", "https://evil.example"]) {
      const url = new URL(await startOAuth(user.id, "youtube", hostile));
      const [row] = await serviceDb().select().from(schema.oauthStates).where(eq(schema.oauthStates.state, url.searchParams.get("state")!));
      expect(row.redirectTo).toBe("/settings?tab=connections");
    }
    const url = new URL(await startOAuth(user.id, "youtube", "/publishing?post=1"));
    const [row] = await serviceDb().select().from(schema.oauthStates).where(eq(schema.oauthStates.state, url.searchParams.get("state")!));
    expect(row.redirectTo).toBe("/publishing?post=1");
  });

  it("re-checks the stored value when completing (rows written before the fix)", async () => {
    const user = await createUser();
    await serviceDb().insert(schema.oauthStates).values({ state: `st-${user.id}`, userId: user.id, platform: "youtube", codeVerifier: "v", redirectTo: "//evil.example", expiresAt: new Date(Date.now() + 60_000) });
    setFetchForTests((async (input: string | URL | Request) => {
      const u = String(input);
      if (u.startsWith("https://oauth2.googleapis.com/token")) return new Response(JSON.stringify({ access_token: "a", refresh_token: "r", expires_in: 3600, scope: "s" }), { status: 200 });
      return new Response(JSON.stringify({ items: [{ id: "UCx", snippet: { title: "Chan" } }] }), { status: 200 });
    }) as typeof fetch);
    try {
      const r = await completeOAuth(user.id, "youtube", "code", `st-${user.id}`);
      expect(r.redirectTo).toBe("/settings?tab=connections");
    } finally {
      setFetchForTests(null);
    }
  });
});

describe("uploads never pass through memory and can't be registered twice", () => {
  it("local direct upload: signed URL, streaming write, size cap, no overwrite, verified completion", async () => {
    const user = await createUser();
    const plan = await createDirectUpload(user.id, { name: "vacances été.mp4", size: MP4.length });
    expect(plan.mode).toBe("direct");
    if (plan.mode !== "direct") return;
    expect(plan.url).toMatch(/^\/api\/v1\/media\/local-upload\//);
    expect(verifyUploadToken(plan.url.split("/").pop()!)).toBe(plan.key);
    const s = storage() as LocalStorage;
    expect(await s.putStream(plan.key, streamOf(MP4.subarray(0, 100), MP4.subarray(100)), 10_000)).toBe(MP4.length);
    // Reusing the link can't overwrite the stored object.
    await expect(s.putStream(plan.key, streamOf(Buffer.from("x")), 10_000)).rejects.toMatchObject({ code: "EEXIST" });
    const asset = await completeDirectUpload(user.id, { key: plan.key, filename: "vacances été.mp4" });
    expect(asset).toMatchObject({ kind: "video", mimeType: "video/mp4", sizeBytes: MP4.length });
    await expect(completeDirectUpload(user.id, { key: plan.key, filename: "again.mp4" })).rejects.toMatchObject({ status: 409 });

    const big = await createDirectUpload(user.id, { name: "big.mp4", size: 10 });
    if (big.mode !== "direct") return;
    await expect(s.putStream(big.key, streamOf(Buffer.alloc(600), Buffer.alloc(600)), 1000)).rejects.toBeInstanceOf(UploadTooLargeError);
    await expect(s.size(big.key)).rejects.toThrow(); // partial file removed
  });

  it("two simultaneous completions of one upload register it once", async () => {
    const user = await createUser();
    const plan = await createDirectUpload(user.id, { name: "twice.mp4", size: MP4.length });
    if (plan.mode !== "direct") return;
    await (storage() as LocalStorage).putStream(plan.key, streamOf(MP4), 10_000);
    const results = await Promise.allSettled([completeDirectUpload(user.id, { key: plan.key, filename: "a.mp4" }), completeDirectUpload(user.id, { key: plan.key, filename: "b.mp4" })]);
    expect(results.filter((r) => r.status === "fulfilled").length).toBe(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({ reason: { status: 409 } });
    const rows = await serviceDb().select().from(schema.mediaAssets).where(eq(schema.mediaAssets.storageKey, plan.key));
    expect(rows.length).toBe(1);
  });

  it("streams whole files and byte ranges from storage", async () => {
    const user = await createUser();
    const asset = await saveUpload(user.id, { name: "s.mp4", type: "video/mp4", buffer: MP4 });
    expect((await readAll(await storage().stream(asset.storageKey))).equals(MP4)).toBe(true);
    expect((await readAll(await storage().stream(asset.storageKey, { start: 4, end: 11 }))).toString()).toBe("ftypmp42");
    await expect(storage().stream(`${user.id}/missing.mp4`)).rejects.toThrow();
  });

  it("video analysis reads from storage to disk instead of loading the file into memory", async () => {
    const sintel = path.join(process.cwd(), "tests/fixtures/real/bbb.mp4");
    const user = await createUser();
    const asset = await saveUpload(user.id, { name: "bbb.mp4", type: "video/mp4", buffer: readFileSync(sintel) });
    const r = await technicalAnalysis({ storageKey: asset.storageKey }, "bbb.mp4");
    expect(r.available).toBe(true);
    if (r.available) expect(r.durationSeconds).toBeGreaterThan(10);
  }, 120_000);
});

describe("worker schedules survive Redis data loss", () => {
  it("ensureSchedules restores all maintenance schedulers after a flush, without duplicates", async () => {
    const url = process.env.TEST_REDIS_URL || "redis://127.0.0.1:6379/14";
    const probe = new IORedis(url, { lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null });
    try {
      await probe.connect();
    } catch {
      console.warn("Redis not reachable; skipping");
      return;
    }
    await probe.flushdb();
    process.env.REDIS_URL = url;
    process.env.VOS_WORKER_NO_AUTOSTART = "1";
    resetEnvCache();
    try {
      const { ensureSchedules, heartbeat } = await import("@/worker/index");
      const { getQueue, QUEUE_NAMES } = await import("@/lib/queue/queues");
      const q = getQueue(QUEUE_NAMES.maintenance)!;
      const names = async () => (await q.getJobSchedulers()).map((j) => j.key).sort();
      expect(await ensureSchedules()).toBe(true);
      const expected = ["analytics-sync", "cleanup", "reconcile", "token-refresh", "trend-watch"];
      expect(await names()).toEqual(expected);
      await probe.flushdb(); // Redis loses everything
      expect(await names()).toEqual([]);
      await ensureSchedules();
      await ensureSchedules(); // idempotent
      expect(await names()).toEqual(expected);
      await heartbeat();
      expect(await probe.get("vos:worker:heartbeat")).toMatch(/^\d{4}-\d\d-\d\dT/);
      await q.close();
    } finally {
      await probe.flushdb();
      probe.disconnect();
      process.env.REDIS_URL = "";
      resetEnvCache();
    }
  }, 30_000);
});
