/**
 * Scheduling and automation logic found in the bug-hunt review.
 */
import { describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { schema, serviceDb, withUser } from "@/lib/db/client";
import { dispatchScheduledWorkflows, workflowRefs } from "@/lib/services/automation";
import { assertOwned } from "@/lib/services/ownership";
import { getContentTable, getOverview } from "@/lib/services/analytics";
import { createPost, queuePost, updatePost } from "@/lib/services/publishing";
import { saveUpload } from "@/lib/services/media";
import { createConnection, createUser } from "../helpers";

describe("scheduled workflow dispatch", () => {
  it("a workflow with a broken schedule doesn't stop the others, and stops retrying itself", async () => {
    const user = await createUser();
    const past = new Date(Date.now() - 60_000);
    const [bad] = await withUser(user.id, (tx) =>
      tx.insert(schema.workflows).values({ userId: user.id, name: "Broken", trigger: { type: "schedule", cron: "not a cron", timezone: "UTC" }, steps: [{ type: "notify", title: "x" }], nextRunAt: past }).returning(),
    );
    const [good] = await withUser(user.id, (tx) =>
      tx.insert(schema.workflows).values({ userId: user.id, name: "Good", trigger: { type: "schedule", cron: "*/5 * * * *", timezone: "Africa/Algiers" }, steps: [{ type: "notify", title: "Scheduled hello" }], nextRunAt: past }).returning(),
    );
    await dispatchScheduledWorkflows();
    const runs = await serviceDb().select().from(schema.workflowRuns).where(eq(schema.workflowRuns.workflowId, good.id));
    expect(runs).toHaveLength(1);
    const [g] = await serviceDb().select().from(schema.workflows).where(eq(schema.workflows.id, good.id));
    expect(g.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
    const [b] = await serviceDb().select().from(schema.workflows).where(eq(schema.workflows.id, bad.id));
    expect(b.nextRunAt).toBeNull();
    const notes = await serviceDb().select().from(schema.notifications).where(eq(schema.notifications.userId, user.id));
    expect(notes.some((n) => /invalid schedule/.test(n.title))).toBe(true);
    // Second tick: the broken one is no longer due, the good one isn't due yet.
    await dispatchScheduledWorkflows();
    expect(await serviceDb().select().from(schema.workflowRuns).where(eq(schema.workflowRuns.workflowId, good.id))).toHaveLength(1);
  });
});

describe("workflow references", () => {
  it("steps and triggers can't point at another account's agent or watchlist", async () => {
    const a = await createUser();
    const b = await createUser();
    const [agent] = await withUser(a.id, (tx) => tx.insert(schema.agents).values({ userId: a.id, name: "A agent", role: "Researcher", instructions: "x", outputFormat: "text" }).returning());
    const [watch] = await withUser(a.id, (tx) => tx.insert(schema.trendWatchlists).values({ userId: a.id, name: "A watch", keywords: ["x"] }).returning());
    const refs = workflowRefs({ trigger: { type: "trend_alert", watchlistId: watch.id }, steps: [{ type: "run_agent", agentId: agent.id, input: "hi" }] });
    await expect(assertOwned(b.id, { agents: refs.agents })).rejects.toMatchObject({ status: 404 });
    await expect(assertOwned(b.id, { watchlists: refs.watchlists })).rejects.toMatchObject({ status: 404 });
    await expect(assertOwned(a.id, refs)).resolves.toBeUndefined();
  });
});

describe("analytics overview maths", () => {
  const day = 86400_000;
  async function seed() {
    const user = await createUser();
    const yt = await createConnection(user.id, "youtube");
    const tt = await createConnection(user.id, "tiktok");
    const ago = (d: number) => new Date(Date.now() - d * day);
    const snap = (v: Partial<typeof schema.metricSnapshots.$inferInsert>) => ({ userId: user.id, title: "t", metrics: {}, ...v }) as typeof schema.metricSnapshots.$inferInsert;
    await serviceDb().insert(schema.metricSnapshots).values([
      // Audience: 1000 → 1300 on YouTube, 500 → 600 on TikTok over the 28-day period.
      snap({ connectionId: yt.id, platform: "youtube", scope: "account", externalId: yt.externalAccountId, metrics: { subscribers: 1000 }, capturedAt: ago(40) }),
      snap({ connectionId: yt.id, platform: "youtube", scope: "account", externalId: yt.externalAccountId, metrics: { subscribers: 1300 }, capturedAt: ago(0.1) }),
      snap({ connectionId: tt.id, platform: "tiktok", scope: "account", externalId: tt.externalAccountId, metrics: { followers: 500 }, capturedAt: ago(35) }),
      snap({ connectionId: tt.id, platform: "tiktok", scope: "account", externalId: tt.externalAccountId, metrics: { followers: 600 }, capturedAt: ago(0.1) }),
      // YouTube has daily Analytics rows: 100/day in this period, 50/day in the previous one.
      ...Array.from({ length: 56 }, (_, i) => snap({ connectionId: yt.id, platform: "youtube", scope: "daily", externalId: yt.externalAccountId, metricDate: new Date(new Date(ago(i + 1)).toISOString().slice(0, 10) + "T00:00:00Z"), metrics: { views: i < 27 ? 100 : 50 }, capturedAt: ago(0.1) })),
      // TikTok has no daily data: two videos in this period (2000 + 4000 views), one in the previous (1000).
      snap({ connectionId: tt.id, platform: "tiktok", scope: "content", externalId: "tt-1", publishedAt: ago(3), metrics: { views: 2000, likes: 200 }, capturedAt: ago(0.1) }),
      snap({ connectionId: tt.id, platform: "tiktok", scope: "content", externalId: "tt-2", publishedAt: ago(10), metrics: { views: 4000, likes: 400 }, capturedAt: ago(0.1) }),
      snap({ connectionId: tt.id, platform: "tiktok", scope: "content", externalId: "tt-3", publishedAt: ago(40), metrics: { views: 1000, likes: 100 }, capturedAt: ago(0.1) }),
    ]);
    return { user, yt, tt };
  }

  it("adds views of platforms without daily data to the YouTube daily total", async () => {
    const { user } = await seed();
    const o = await getOverview(user.id, { days: 28 });
    expect(o.kpis.audience.value).toBe(1900);
    expect(o.kpis.audience.growth).toBe(400);
    // 27 full days at 100 + day 28 boundary may or may not be in range; check the TikTok part is included.
    expect(o.kpis.views.value! - 6000).toBeGreaterThanOrEqual(2700);
    expect(o.kpis.views.value! - 6000).toBeLessThanOrEqual(2800);
    expect(o.kpis.views.previous).not.toBeNull();
    expect(o.kpis.views.previous! - 1000).toBeGreaterThan(0);
    expect(o.kpis.views.source).toMatch(/plus/);
    expect(o.platformBreakdown.find((p) => p.platform === "tiktok")?.views).toBe(6000);
  });

  it("keeps the growth baseline when tens of thousands of newer snapshots pile up", async () => {
    const { user, tt } = await seed();
    // 25,000 newer content snapshots (what months of 6-hourly syncs produce).
    await serviceDb().execute(sql`
      insert into metric_snapshots (user_id, connection_id, platform, scope, external_id, title, metrics, published_at, captured_at)
      select ${user.id}::uuid, ${tt.id}::uuid, 'tiktok', 'content', 'bulk-' || (g % 500), 'bulk', '{"views": 10}'::jsonb, now() - interval '60 days', now() - (g || ' seconds')::interval
      from generate_series(1, 25000) g`);
    const o = await getOverview(user.id, { days: 28 });
    expect(o.kpis.audience.growth).toBe(400);
    expect(o.kpis.audience.value).toBe(1900);
    const table = await getContentTable(user.id, {});
    expect(table).toHaveLength(503);
  });

  it("uses a true median for an even number of videos", async () => {
    const user = await createUser();
    const tt = await createConnection(user.id, "tiktok");
    await serviceDb().insert(schema.metricSnapshots).values(
      [100, 200, 300, 400].map((views, i) => ({ userId: user.id, connectionId: tt.id, platform: "tiktok" as const, scope: "content" as const, externalId: `m-${i}`, title: "t", publishedAt: new Date(), metrics: { views }, capturedAt: new Date() })),
    );
    const o = await getOverview(user.id, { days: 28 });
    expect(o.top[0].vsMedian).toBeCloseTo(400 / 250);
  });
});

describe("editing posts", () => {
  const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypmp42"), Buffer.alloc(2048, 1)]);
  async function scheduled() {
    const user = await createUser();
    const conn = await createConnection(user.id, "youtube");
    const asset = await saveUpload(user.id, { name: "clip.mp4", type: "video/mp4", buffer: MP4 });
    const input = { title: "T", baseCaption: "c", mediaAssetId: asset.id, timezone: "Africa/Algiers", targets: [{ connectionId: conn.id, title: "T", caption: "c", hashtags: [], privacy: "private" }] };
    const post = await createPost(user.id, input);
    await queuePost(user.id, post.id, { scheduledAt: new Date(Date.now() + 86400_000) });
    return { user, post, input };
  }

  it("a scheduled post can be edited (saved back as a draft) and rescheduled", async () => {
    const { user, post, input } = await scheduled();
    const updated = await updatePost(user.id, post.id, { ...input, title: "Fixed typo", status: "draft" });
    expect(updated.title).toBe("Fixed typo");
    const at = new Date(Date.now() + 2 * 86400_000);
    await queuePost(user.id, post.id, { scheduledAt: at });
    const [p] = await serviceDb().select().from(schema.posts).where(eq(schema.posts.id, post.id));
    expect(p.status).toBe("scheduled");
    expect(p.scheduledAt?.toISOString()).toBe(at.toISOString());
  });

  it("rejects an unknown timezone on a post", async () => {
    const { user, post, input } = await scheduled();
    await expect(updatePost(user.id, post.id, { ...input, timezone: "Mars/Olympus" })).rejects.toThrow(/Unknown timezone/);
  });
});
