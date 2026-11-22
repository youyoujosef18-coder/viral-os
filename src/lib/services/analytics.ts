import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { serviceDb, schema, withUser } from "../db/client";
import { getAdapter } from "../providers/platforms";
import { getValidAccessToken, markConnectionError } from "./connections";
import type { Platform } from "../providers/platforms/types";
import { notFound } from "../api/errors";

/** Pull verified metrics from the platform API and store snapshots. */
export async function syncConnection(connectionId: string, days = 90) {
  const db = serviceDb();
  const [conn] = await db.select().from(schema.platformConnections).where(eq(schema.platformConnections.id, connectionId));
  if (!conn) throw notFound("Connection");
  try {
    const token = await getValidAccessToken(conn);
    const result = await getAdapter(conn.platform).fetchAnalytics({ accessToken: token, externalAccountId: conn.externalAccountId, days });
    const now = new Date();
    await db.insert(schema.metricSnapshots).values({ userId: conn.userId, connectionId: conn.id, platform: conn.platform, scope: "account", externalId: conn.externalAccountId, title: conn.accountName, metrics: result.account, capturedAt: now });
    for (const c of result.content) {
      await db.insert(schema.metricSnapshots).values({
        userId: conn.userId,
        connectionId: conn.id,
        platform: conn.platform,
        scope: "content",
        externalId: c.externalId,
        title: c.title,
        url: c.url,
        thumbnailUrl: c.thumbnailUrl,
        publishedAt: c.publishedAt,
        metrics: c.metrics,
        capturedAt: now,
      });
    }
    for (const d of result.daily) {
      const metricDate = new Date(`${d.date}T00:00:00Z`);
      await db
        .insert(schema.metricSnapshots)
        .values({ userId: conn.userId, connectionId: conn.id, platform: conn.platform, scope: "daily", externalId: conn.externalAccountId, metricDate, metrics: d.metrics, capturedAt: now })
        .onConflictDoUpdate({ target: [schema.metricSnapshots.connectionId, schema.metricSnapshots.scope, schema.metricSnapshots.externalId, schema.metricSnapshots.metricDate], set: { metrics: d.metrics, capturedAt: now } });
    }
    await db.update(schema.platformConnections).set({ lastSyncedAt: now, lastError: null, status: "active" }).where(eq(schema.platformConnections.id, conn.id));
    return { content: result.content.length, daily: result.daily.length };
  } catch (err) {
    await markConnectionError(conn.id, err);
    throw err;
  }
}

type Snapshot = typeof schema.metricSnapshots.$inferSelect;

function latestBy<T extends Snapshot>(rows: T[], key: (r: T) => string) {
  const map = new Map<string, T>();
  for (const r of rows) {
    const k = key(r);
    const cur = map.get(k);
    if (!cur || cur.capturedAt < r.capturedAt) map.set(k, r);
  }
  return [...map.values()];
}

const engagement = (m: Record<string, number>) => {
  const views = m.views ?? m.reach ?? 0;
  if (!views) return null;
  return ((m.likes ?? 0) + (m.comments ?? 0) + (m.shares ?? 0) + (m.saved ?? 0)) / views;
};

/**
 * Overview analytics computed ONLY from stored platform snapshots and our own publishing records.
 * Missing data stays missing (null) rather than being estimated.
 */
export async function getOverview(userId: string, opts: { days: number; platform?: Platform; connectionId?: string }) {
  return withUser(userId, async (tx) => {
    const since = new Date(Date.now() - opts.days * 86400_000);
    const prevSince = new Date(Date.now() - 2 * opts.days * 86400_000);
    const conds = [gte(schema.metricSnapshots.capturedAt, new Date(Date.now() - 400 * 86400_000))];
    if (opts.platform) conds.push(eq(schema.metricSnapshots.platform, opts.platform));
    if (opts.connectionId) conds.push(eq(schema.metricSnapshots.connectionId, opts.connectionId));
    const snaps = await tx.select().from(schema.metricSnapshots).where(and(...conds)).orderBy(desc(schema.metricSnapshots.capturedAt)).limit(20000);
    const connections = await tx.select().from(schema.platformConnections);

    const accountSnaps = snaps.filter((s) => s.scope === "account");
    const latestAccounts = latestBy(accountSnaps, (s) => s.connectionId ?? s.externalId);
    const audienceOf = (m: Record<string, number>) => m.subscribers ?? m.followers ?? 0;
    const totalAudience = latestAccounts.length ? latestAccounts.reduce((a, s) => a + audienceOf(s.metrics), 0) : null;

    // Audience growth: latest snapshot vs the closest snapshot at/before the period start, per account.
    let growth: number | null = null;
    for (const acc of latestAccounts) {
      const older = accountSnaps.filter((s) => s.connectionId === acc.connectionId && s.capturedAt <= since).sort((a, b) => +b.capturedAt - +a.capturedAt)[0];
      if (older) growth = (growth ?? 0) + audienceOf(acc.metrics) - audienceOf(older.metrics);
    }

    const content = latestBy(snaps.filter((s) => s.scope === "content"), (s) => `${s.platform}:${s.externalId}`);
    const inPeriod = content.filter((c) => c.publishedAt && c.publishedAt >= since);
    const inPrev = content.filter((c) => c.publishedAt && c.publishedAt >= prevSince && c.publishedAt < since);
    const sum = (rows: Snapshot[], k: string) => rows.reduce((a, r) => a + (r.metrics[k] ?? 0), 0);
    const daily = snaps.filter((s) => s.scope === "daily" && s.metricDate && s.metricDate >= since);
    const dailyPrev = snaps.filter((s) => s.scope === "daily" && s.metricDate && s.metricDate >= prevSince && s.metricDate < since);
    const hasDaily = daily.length > 0;

    const viewsTotal = hasDaily ? sum(daily, "views") : content.length ? sum(inPeriod, "views") : null;
    const viewsPrev = hasDaily ? (dailyPrev.length ? sum(dailyPrev, "views") : null) : inPrev.length ? sum(inPrev, "views") : null;
    const engRates = inPeriod.map((c) => engagement(c.metrics)).filter((x): x is number => x !== null);
    const engagementRate = engRates.length ? engRates.reduce((a, b) => a + b, 0) / engRates.length : null;
    const engPrevRates = inPrev.map((c) => engagement(c.metrics)).filter((x): x is number => x !== null);
    const engagementPrev = engPrevRates.length ? engPrevRates.reduce((a, b) => a + b, 0) / engPrevRates.length : null;

    const ranked = [...content].filter((c) => (c.metrics.views ?? 0) > 0).sort((a, b) => (b.metrics.views ?? 0) - (a.metrics.views ?? 0));
    const median = ranked.length ? ranked[Math.floor(ranked.length / 2)].metrics.views ?? 0 : 0;
    const toItem = (c: Snapshot) => ({ id: c.id, platform: c.platform, title: c.title, url: c.url, thumbnailUrl: c.thumbnailUrl, publishedAt: c.publishedAt, metrics: c.metrics, vsMedian: median ? (c.metrics.views ?? 0) / median : null, capturedAt: c.capturedAt });
    const top = ranked.slice(0, 5).map(toItem);
    const under = ranked.length >= 6 ? ranked.slice(-5).reverse().map(toItem) : [];

    // Series: daily views when Analytics API data exists; otherwise per-publish-day views of content.
    const seriesMap = new Map<string, Record<string, number>>();
    if (hasDaily) {
      for (const d of daily) {
        const k = d.metricDate!.toISOString().slice(0, 10);
        const row = seriesMap.get(k) ?? {};
        row[d.platform] = (row[d.platform] ?? 0) + (d.metrics.views ?? 0);
        seriesMap.set(k, row);
      }
    } else {
      for (const c of inPeriod) {
        const k = c.publishedAt!.toISOString().slice(0, 10);
        const row = seriesMap.get(k) ?? {};
        row[c.platform] = (row[c.platform] ?? 0) + (c.metrics.views ?? 0);
        seriesMap.set(k, row);
      }
    }
    const series = [...seriesMap.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, v]) => ({ date, ...v }));

    const platformBreakdown = (["youtube", "tiktok", "instagram"] as const)
      .map((p) => ({ platform: p, views: sum(inPeriod.filter((c) => c.platform === p), "views"), posts: inPeriod.filter((c) => c.platform === p).length, audience: latestAccounts.filter((a) => a.platform === p).reduce((s, a) => s + audienceOf(a.metrics), 0) }))
      .filter((p) => p.posts > 0 || p.audience > 0);

    // Best publishing times: average views by weekday/hour (UTC) of the user's own published content.
    const buckets = new Map<string, { total: number; n: number }>();
    for (const c of content) {
      if (!c.publishedAt || !c.metrics.views) continue;
      const k = `${c.publishedAt.getUTCDay()}-${c.publishedAt.getUTCHours()}`;
      const b = buckets.get(k) ?? { total: 0, n: 0 };
      b.total += c.metrics.views;
      b.n += 1;
      buckets.set(k, b);
    }
    const bestTimes = [...buckets.entries()]
      .filter(([, b]) => b.n >= 2)
      .map(([k, b]) => ({ weekday: Number(k.split("-")[0]), hourUtc: Number(k.split("-")[1]), avgViews: Math.round(b.total / b.n), samples: b.n }))
      .sort((a, b) => b.avgViews - a.avgViews)
      .slice(0, 5);

    const targets = await tx.select({ status: schema.postTargets.status, publishedAt: schema.postTargets.publishedAt }).from(schema.postTargets);
    const postsPublished = targets.filter((t) => t.status === "published" && t.publishedAt && t.publishedAt >= since).length;
    const scheduled = targets.filter((t) => t.status === "scheduled").length;
    const failed = targets.filter((t) => ["failed", "requires_user_action", "platform_approval_required"].includes(t.status)).length;

    return {
      range: { days: opts.days, since },
      hasData: snaps.length > 0,
      kpis: {
        views: { value: viewsTotal, previous: viewsPrev, source: hasDaily ? "YouTube Analytics daily views" : "Views of content published in period" },
        audience: { value: totalAudience, growth },
        engagementRate: { value: engagementRate, previous: engagementPrev },
        postsPublished: { value: postsPublished },
        scheduled: { value: scheduled },
        failed: { value: failed },
      },
      series,
      platformBreakdown,
      top,
      under,
      bestTimes,
      connections: connections.map((c) => ({ id: c.id, platform: c.platform, accountName: c.accountName, status: c.status, lastSyncedAt: c.lastSyncedAt, lastError: c.lastError })),
      lastCapturedAt: snaps[0]?.capturedAt ?? null,
    };
  });
}

export async function getContentTable(userId: string, opts: { platform?: Platform }) {
  return withUser(userId, async (tx) => {
    const conds = [eq(schema.metricSnapshots.scope, "content")];
    if (opts.platform) conds.push(eq(schema.metricSnapshots.platform, opts.platform));
    const rows = await tx.select().from(schema.metricSnapshots).where(and(...conds)).orderBy(desc(schema.metricSnapshots.capturedAt)).limit(10000);
    return latestBy(rows, (s) => `${s.platform}:${s.externalId}`).map((c) => ({
      id: c.id,
      platform: c.platform,
      externalId: c.externalId,
      title: c.title,
      url: c.url,
      thumbnailUrl: c.thumbnailUrl,
      publishedAt: c.publishedAt,
      capturedAt: c.capturedAt,
      views: c.metrics.views ?? null,
      likes: c.metrics.likes ?? null,
      comments: c.metrics.comments ?? null,
      shares: c.metrics.shares ?? null,
      engagementRate: engagement(c.metrics),
    }));
  });
}

export async function syncAllForUser(userId: string) {
  const conns = await serviceDb().select({ id: schema.platformConnections.id }).from(schema.platformConnections).where(and(eq(schema.platformConnections.userId, userId), inArray(schema.platformConnections.status, ["active", "error"])));
  return conns;
}

void sql;
