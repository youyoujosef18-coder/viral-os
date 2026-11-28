import { and, desc, eq, gte, inArray, lte, type SQL } from "drizzle-orm";
import { serviceDb, schema, withUser } from "../db/client";
import { getAdapter } from "../providers/platforms";
import { getValidAccessToken, markConnectionError } from "./connections";
import type { Platform } from "../providers/platforms/types";
import { notFound } from "../api/errors";
import { meteredFor } from "../usage";

/** Pull verified metrics from the platform API and store snapshots. */
async function syncConnectionUnmetered(connectionId: string, days = 90) {
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
const ms = schema.metricSnapshots;

const engagement = (m: Record<string, number>) => {
  const views = m.views ?? m.reach ?? 0;
  if (!views) return null;
  return ((m.likes ?? 0) + (m.comments ?? 0) + (m.shares ?? 0) + (m.saved ?? 0)) / views;
};

function median(values: number[]) {
  if (!values.length) return 0;
  const v = [...values].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/**
 * Overview analytics computed ONLY from stored platform snapshots and our own publishing records.
 * Missing data stays missing (null) rather than being estimated.
 *
 * Each figure is read with its own query (latest per account/video via DISTINCT ON) instead of one
 * capped list of recent snapshots, so older baselines are never pushed out as snapshots accumulate.
 */
export async function getOverview(userId: string, opts: { days: number; platform?: Platform; connectionId?: string }) {
  return withUser(userId, async (tx) => {
    const since = new Date(Date.now() - opts.days * 86400_000);
    const prevSince = new Date(Date.now() - 2 * opts.days * 86400_000);
    const base = [gte(ms.capturedAt, new Date(Date.now() - 400 * 86400_000))];
    if (opts.platform) base.push(eq(ms.platform, opts.platform));
    if (opts.connectionId) base.push(eq(ms.connectionId, opts.connectionId));
    const where = (...extra: SQL[]) => and(...base, ...extra);

    const [latestAccounts, olderAccounts, content, dailyRows, dailyConnRows, connections] = await Promise.all([
      tx.selectDistinctOn([ms.platform, ms.externalId]).from(ms).where(where(eq(ms.scope, "account"))).orderBy(ms.platform, ms.externalId, desc(ms.capturedAt)),
      tx.selectDistinctOn([ms.platform, ms.externalId]).from(ms).where(where(eq(ms.scope, "account"), lte(ms.capturedAt, since))).orderBy(ms.platform, ms.externalId, desc(ms.capturedAt)),
      tx.selectDistinctOn([ms.platform, ms.externalId]).from(ms).where(where(eq(ms.scope, "content"))).orderBy(ms.platform, ms.externalId, desc(ms.capturedAt)),
      tx.select().from(ms).where(where(eq(ms.scope, "daily"), gte(ms.metricDate, prevSince))),
      tx.selectDistinct({ id: ms.connectionId }).from(ms).where(where(eq(ms.scope, "daily"))),
      tx.select().from(schema.platformConnections),
    ]);

    const audienceOf = (m: Record<string, number>) => m.subscribers ?? m.followers ?? 0;
    const totalAudience = latestAccounts.length ? latestAccounts.reduce((a, s) => a + audienceOf(s.metrics), 0) : null;

    // Audience growth: latest snapshot vs the closest snapshot at/before the period start, per account.
    let growth: number | null = null;
    for (const acc of latestAccounts) {
      const older = olderAccounts.find((o) => o.platform === acc.platform && o.externalId === acc.externalId);
      if (older) growth = (growth ?? 0) + audienceOf(acc.metrics) - audienceOf(older.metrics);
    }

    // Accounts with daily Analytics data use it for views; every other account uses views of content
    // published in the period. Both are added up so no platform is dropped from the total.
    const dailyConns = new Set(dailyConnRows.map((r) => r.id).filter((id): id is string => !!id));
    const noDaily = (rows: Snapshot[]) => rows.filter((c) => !c.connectionId || !dailyConns.has(c.connectionId));
    const inPeriod = content.filter((c) => c.publishedAt && c.publishedAt >= since);
    const inPrev = content.filter((c) => c.publishedAt && c.publishedAt >= prevSince && c.publishedAt < since);
    const sum = (rows: Snapshot[], k: string) => rows.reduce((a, r) => a + (r.metrics[k] ?? 0), 0);
    const daily = dailyRows.filter((s) => s.metricDate && s.metricDate >= since);
    const dailyPrev = dailyRows.filter((s) => s.metricDate && s.metricDate < since);
    const hasDaily = dailyConns.size > 0;
    const contentOnly = noDaily(content);
    const hasContentOnly = contentOnly.length > 0;

    const viewsTotal = hasDaily || content.length ? (hasDaily ? sum(daily, "views") : 0) + sum(noDaily(inPeriod), "views") : null;
    const prevDailyPart = hasDaily ? (dailyPrev.length ? sum(dailyPrev, "views") : null) : 0;
    const prevContentPart = hasContentOnly ? (noDaily(inPrev).length ? sum(noDaily(inPrev), "views") : null) : 0;
    const viewsPrev = (hasDaily || hasContentOnly) && prevDailyPart !== null && prevContentPart !== null ? prevDailyPart + prevContentPart : null;
    const viewsSource = hasDaily && hasContentOnly ? "YouTube Analytics daily views plus views of other content published in period" : hasDaily ? "YouTube Analytics daily views" : "Views of content published in period";

    const engRates = inPeriod.map((c) => engagement(c.metrics)).filter((x): x is number => x !== null);
    const engagementRate = engRates.length ? engRates.reduce((a, b) => a + b, 0) / engRates.length : null;
    const engPrevRates = inPrev.map((c) => engagement(c.metrics)).filter((x): x is number => x !== null);
    const engagementPrev = engPrevRates.length ? engPrevRates.reduce((a, b) => a + b, 0) / engPrevRates.length : null;
    const snapsCount = latestAccounts.length + content.length + dailyRows.length;
    const lastCapturedAt = [...latestAccounts, ...content].reduce<Date | null>((a, r) => (!a || r.capturedAt > a ? r.capturedAt : a), null);

    const ranked = [...content].filter((c) => (c.metrics.views ?? 0) > 0).sort((a, b) => (b.metrics.views ?? 0) - (a.metrics.views ?? 0));
    const medianViews = median(ranked.map((c) => c.metrics.views ?? 0));
    const toItem = (c: Snapshot) => ({ id: c.id, platform: c.platform, title: c.title, url: c.url, thumbnailUrl: c.thumbnailUrl, publishedAt: c.publishedAt, metrics: c.metrics, vsMedian: medianViews ? (c.metrics.views ?? 0) / medianViews : null, capturedAt: c.capturedAt });
    const top = ranked.slice(0, 5).map(toItem);
    const under = ranked.length >= 6 ? ranked.slice(-5).reverse().map(toItem) : [];

    // Series: daily views when Analytics API data exists; otherwise per-publish-day views of content.
    const seriesMap = new Map<string, Record<string, number>>();
    const addPoint = (k: string, platform: string, views: number) => {
      const row = seriesMap.get(k) ?? {};
      row[platform] = (row[platform] ?? 0) + views;
      seriesMap.set(k, row);
    };
    for (const d of daily) addPoint(d.metricDate!.toISOString().slice(0, 10), d.platform, d.metrics.views ?? 0);
    for (const c of noDaily(inPeriod)) addPoint(c.publishedAt!.toISOString().slice(0, 10), c.platform, c.metrics.views ?? 0);
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
      hasData: snapsCount > 0,
      kpis: {
        views: { value: viewsTotal, previous: viewsPrev, source: viewsSource },
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
      lastCapturedAt,
    };
  });
}

export async function getContentTable(userId: string, opts: { platform?: Platform }) {
  return withUser(userId, async (tx) => {
    const conds = [eq(ms.scope, "content")];
    if (opts.platform) conds.push(eq(ms.platform, opts.platform));
    const rows = await tx.selectDistinctOn([ms.platform, ms.externalId]).from(ms).where(and(...conds)).orderBy(ms.platform, ms.externalId, desc(ms.capturedAt));
    return rows.sort((a, b) => +b.capturedAt - +a.capturedAt).map((c) => ({
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


export function syncConnection(connectionId: string, days = 90) {
  return meteredFor("platform_connections", connectionId, () => syncConnectionUnmetered(connectionId, days));
}
