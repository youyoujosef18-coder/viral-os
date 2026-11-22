/**
 * End-to-end through a real Redis + BullMQ worker: queue a post, the worker consumes
 * the job, and the target ends published. Skipped automatically when Redis is unreachable.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Worker } from "bullmq";
import IORedis from "ioredis";
import { eq } from "drizzle-orm";
import { resetEnvCache } from "@/lib/env";

const REDIS = process.env.TEST_REDIS_URL || "redis://127.0.0.1:6379/15";
let redisUp = false;

beforeAll(async () => {
  const probe = new IORedis(REDIS, { lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null });
  try {
    await probe.connect();
    await probe.flushdb();
    redisUp = true;
  } catch {
    redisUp = false;
  } finally {
    probe.disconnect();
  }
  process.env.REDIS_URL = REDIS;
  resetEnvCache();
});

afterAll(() => {
  process.env.REDIS_URL = "";
  resetEnvCache();
});

describe("BullMQ publishing (real Redis)", () => {
  it("processes a queued post through the worker", async () => {
    if (!redisUp) {
      console.warn("Redis not reachable; skipping queue e2e");
      return;
    }
    const { QUEUE_NAMES, getQueue } = await import("@/lib/queue/queues");
    const { redisConnectionOptions } = await import("@/lib/queue/redis");
    const { setAdapterForTests } = await import("@/lib/providers/platforms");
    const { createPost, queuePost, processTarget } = await import("@/lib/services/publishing");
    const { saveUpload } = await import("@/lib/services/media");
    const { schema, serviceDb } = await import("@/lib/db/client");
    const { createUser, createConnection, scriptedAdapter } = await import("../helpers");

    setAdapterForTests("tiktok", scriptedAdapter("tiktok", [{ state: "published", providerPostId: "tt1", url: "https://www.tiktok.com/@x/video/tt1", uploadRef: {} }]));
    const user = await createUser();
    const conn = await createConnection(user.id, "tiktok");
    const asset = await saveUpload(user.id, { name: "a.mp4", type: "video/mp4", buffer: Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypmp42"), Buffer.alloc(512)]) });
    const post = await createPost(user.id, { title: "Queued", mediaAssetId: asset.id, targets: [{ connectionId: conn.id, privacy: "SELF_ONLY" }] });

    const done = new Promise<string>((resolve, reject) => {
      const worker = new Worker(QUEUE_NAMES.publish, async (job) => processTarget(job.data.targetId, job.data.mode), { connection: redisConnectionOptions()! });
      worker.on("completed", async (_job, result) => {
        await worker.close();
        resolve((result as { outcome: string }).outcome);
      });
      worker.on("failed", async (_job, err) => {
        await worker.close();
        reject(err);
      });
    });
    await queuePost(user.id, post.id, {});
    expect(await done).toBe("published");
    const [t] = await serviceDb().select().from(schema.postTargets).where(eq(schema.postTargets.postId, post.id));
    expect(t.status).toBe("published");
    expect(t.providerPostId).toBe("tt1");
    await getQueue(QUEUE_NAMES.publish)?.close();
    setAdapterForTests("tiktok", null);
  });
});
