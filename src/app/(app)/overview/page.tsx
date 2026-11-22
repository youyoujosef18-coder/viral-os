"use client";

import * as React from "react";
import Link from "next/link";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { RefreshCw, Sparkles, ChevronUp, ChevronDown, EyeOff, LayoutGrid, AlertTriangle, CalendarClock, Workflow, PlugZap } from "lucide-react";
import { api, errorText } from "@/lib/client/api";
import { useApiQuery, useConnections, useMe, useAction } from "@/lib/client/hooks";
import { Badge, Button, Dialog, EmptyState, ErrorState, PageHeader, Panel, PanelHeader, Select, Skeleton, SkeletonRows, Stat, Switch } from "@/components/ui/primitives";
import { PlatformMark, StatusBadge, NotConfigured } from "@/components/ui/domain";
import { SeriesChart, BarsChart, RangePicker } from "@/components/charts";
import { fmtDate, fmtNum, fmtPct, fmtRelative, PLATFORM_LABEL } from "@/lib/client/utils";

type Overview = {
  hasData: boolean;
  kpis: {
    views: { value: number | null; previous: number | null; source: string };
    audience: { value: number | null; growth: number | null };
    engagementRate: { value: number | null; previous: number | null };
    postsPublished: { value: number };
    scheduled: { value: number };
    failed: { value: number };
  };
  series: Record<string, number | string>[];
  platformBreakdown: { platform: string; views: number; posts: number; audience: number }[];
  top: ContentItem[];
  under: ContentItem[];
  bestTimes: { weekday: number; hourUtc: number; avgViews: number; samples: number }[];
  connections: { id: string; platform: string; accountName: string | null; status: string; lastSyncedAt: string | null; lastError: string | null }[];
  lastCapturedAt: string | null;
};
type ContentItem = { id: string; platform: string; title: string | null; url: string | null; thumbnailUrl: string | null; metrics: Record<string, number>; vsMedian: number | null };
type Post = { id: string; title: string; status: string; scheduledAt: string | null; targets: { id: string; platform: string; status: string; lastError: string | null }[] };
type Activity = { id: string; summary: string; createdAt: string };
type WorkflowRow = { id: string; name: string; enabled: boolean; nextRunAt: string | null; trigger: { type: string } };
type Recs = { recommendations: { title: string; why: string; action: string; section: string; basedOn: string }[]; provider: string; model: string; generatedAt: string };

const WIDGETS = [
  { id: "kpis", label: "Key metrics" },
  { id: "performance", label: "Content performance" },
  { id: "recommendations", label: "AI recommendations" },
  { id: "schedule", label: "Upcoming schedule" },
  { id: "attention", label: "Needs attention" },
  { id: "top", label: "Top and underperforming content" },
  { id: "platforms", label: "Platform breakdown" },
  { id: "times", label: "Best publishing times" },
  { id: "automations", label: "Pending automations" },
  { id: "accounts", label: "Connected account health" },
  { id: "activity", label: "Recent activity" },
] as const;
type WidgetId = (typeof WIDGETS)[number]["id"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const delta = (cur: number | null, prev: number | null) => (cur !== null && prev ? (cur - prev) / prev : null);

export default function OverviewPage() {
  const qc = useQueryClient();
  const { data: me } = useMe();
  const { data: connections } = useConnections();
  const [days, setDays] = React.useState(30);
  const [platform, setPlatform] = React.useState("");
  const [connectionId, setConnectionId] = React.useState("");
  const [customize, setCustomize] = React.useState(false);
  const qs = `days=${days}${platform ? `&platform=${platform}` : ""}${connectionId ? `&connectionId=${connectionId}` : ""}`;
  const overview = useApiQuery<Overview>(["overview", qs], `/api/v1/analytics/overview?${qs}`);
  const posts = useApiQuery<Post[]>(["posts", "overview"], "/api/v1/posts?limit=100");
  const activity = useApiQuery<Activity[]>(["activity", 8], "/api/v1/activity?limit=8");
  const workflows = useApiQuery<WorkflowRow[]>(["workflows"], "/api/v1/workflows");
  const [recs, setRecs] = React.useState<Recs | null>(null);
  const recMutation = useMutation({ mutationFn: () => api.post<Recs>("/api/v1/ai/recommendations"), onSuccess: setRecs });

  const layout: WidgetId[] = (me?.dashboardLayout?.filter((w) => WIDGETS.some((x) => x.id === w)) as WidgetId[] | undefined) ?? WIDGETS.map((w) => w.id);
  const saveLayout = useAction((l: WidgetId[]) => api.patch("/api/v1/me", { dashboardLayout: l }), { invalidate: [["me"]] });
  const move = (id: WidgetId, dir: -1 | 1) => {
    const l = [...layout];
    const i = l.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= l.length) return;
    [l[i], l[j]] = [l[j], l[i]];
    saveLayout.mutate(l);
  };

  const sync = useMutation({
    mutationFn: () => api.post<{ results: { ok: boolean; queued?: boolean; error?: string }[] }>("/api/v1/analytics/sync"),
    onSuccess: (r) => {
      const failed = r.results.filter((x) => !x.ok);
      if (!r.results.length) toast.info("Connect an account first to sync analytics.");
      else if (failed.length) toast.error(`Sync failed for ${failed.length} account(s): ${failed[0].error}`);
      else toast.success(r.results.some((x) => x.queued) ? "Sync started. New numbers appear in a minute." : "Analytics refreshed");
      qc.invalidateQueries({ queryKey: ["overview"] });
    },
    onError: (e) => toast.error(errorText(e)),
  });

  const o = overview.data;
  const upcoming = (posts.data ?? []).filter((p) => p.status === "scheduled" && p.scheduledAt).sort((a, b) => +new Date(a.scheduledAt!) - +new Date(b.scheduledAt!)).slice(0, 6);
  const attention = (posts.data ?? []).flatMap((p) => p.targets.filter((t) => ["failed", "requires_user_action", "platform_approval_required"].includes(t.status)).map((t) => ({ post: p, target: t })));
  const pendingFlows = (workflows.data ?? []).filter((w) => w.enabled);
  const firstName = (me?.displayName ?? "").split(" ")[0];

  const widgets: Record<WidgetId, React.ReactNode> = {
    kpis: (
      <Panel className="grid grid-cols-2 divide-line-soft md:grid-cols-3 xl:grid-cols-6 [&>*]:border-line-soft max-xl:[&>*:nth-child(n+3)]:border-t xl:divide-x">
        <Stat label="Views" loading={overview.isLoading} value={fmtNum(o?.kpis.views.value)} delta={o ? delta(o.kpis.views.value, o.kpis.views.previous) : null} hint={o?.kpis.views.source ?? "Views from connected platforms"} />
        <Stat label="Audience" loading={overview.isLoading} value={fmtNum(o?.kpis.audience.value)} hint="Followers and subscribers from the latest sync across connected accounts." />
        <Stat label="Audience growth" loading={overview.isLoading} value={o?.kpis.audience.growth === null || o?.kpis.audience.growth === undefined ? "—" : `${o.kpis.audience.growth >= 0 ? "+" : ""}${fmtNum(o.kpis.audience.growth)}`} hint="Change between the snapshot at the start of the period and the latest one. Needs at least two syncs." />
        <Stat label="Engagement rate" loading={overview.isLoading} value={fmtPct(o?.kpis.engagementRate.value)} delta={o ? delta(o.kpis.engagementRate.value, o.kpis.engagementRate.previous) : null} hint="(likes + comments + shares + saves) ÷ views, averaged over content published in the period." />
        <Stat label="Posts published" loading={overview.isLoading} value={fmtNum(o?.kpis.postsPublished.value)} hint="Published through VIRAL OS in this period and confirmed by the platform." />
        <Stat label="Scheduled" loading={overview.isLoading} value={fmtNum(o?.kpis.scheduled.value)} />
      </Panel>
    ),
    performance: (
      <Panel>
        <PanelHeader title="Content performance" description={o?.lastCapturedAt ? `Verified platform data, last synced ${fmtRelative(o.lastCapturedAt)}` : "Verified platform data"} tooltip="Daily views from YouTube Analytics when available, otherwise views of content grouped by publish date." />
        <div className="px-3 pb-4">
          {overview.isLoading ? <Skeleton className="mx-2 h-64" /> : overview.error ? <ErrorState error={overview.error} onRetry={() => overview.refetch()} /> : o?.series.length ? (
            <SeriesChart data={o.series} keys={[...new Set(o.series.flatMap((r) => Object.keys(r).filter((k) => k !== "date")))]} />
          ) : (
            <EmptyState icon={LayoutGrid} title="No performance data yet" description="Connect YouTube, TikTok or Instagram and sync. Charts only show numbers retrieved from the platforms." action={<Link href="/settings?tab=connections"><Button variant="primary">Connect an account</Button></Link>} />
          )}
        </div>
      </Panel>
    ),
    recommendations: (
      <Panel>
        <PanelHeader
          title="AI recommendations"
          description={recs ? `Generated ${fmtRelative(recs.generatedAt)} by ${recs.model}, using only your verified data` : "Next best actions based on your metrics and workspace"}
          actions={<Button size="sm" variant={recs ? "ghost" : "primary"} onClick={() => recMutation.mutate()} loading={recMutation.isPending}><Sparkles /> {recs ? "Regenerate" : "Get recommendations"}</Button>}
        />
        {recMutation.error && (<><NotConfigured error={recMutation.error} title="Connect an AI provider to get recommendations" />{!(recMutation.error as { notConfigured?: boolean }).notConfigured && <ErrorState error={recMutation.error} />}</>)}
        {recMutation.isPending && <SkeletonRows rows={3} />}
        {recs && (
          <ol className="divide-y divide-line-soft border-t border-line-soft">
            {recs.recommendations.map((r, i) => (
              <li key={i} className="grid gap-1 px-5 py-3.5 sm:grid-cols-[1fr_auto] sm:gap-4">
                <div>
                  <p className="text-[14px] font-medium">{r.title}</p>
                  <p className="mt-0.5 text-[13px] text-muted">{r.why} {r.action}</p>
                  <p className="mt-1 text-xs text-faint">Based on: {r.basedOn}</p>
                </div>
                <Link href={`/${r.section}`} className="self-center text-[13px] text-violet-soft hover:underline">Open {r.section}</Link>
              </li>
            ))}
          </ol>
        )}
      </Panel>
    ),
    schedule: (
      <Panel>
        <PanelHeader title="Upcoming schedule" actions={<Link href="/calendar" className="text-[13px] text-violet-soft hover:underline">Calendar</Link>} />
        {posts.isLoading ? <SkeletonRows rows={3} /> : upcoming.length ? (
          <ul className="divide-y divide-line-soft border-t border-line-soft">
            {upcoming.map((p) => (
              <li key={p.id}>
                <Link href={`/publishing?post=${p.id}`} className="flex items-center gap-3 px-5 py-2.5 hover:bg-raised/40">
                  <CalendarClock className="size-4 text-faint" />
                  <span className="min-w-0 flex-1 truncate text-[13.5px]">{p.title}</span>
                  <span className="flex gap-1">{p.targets.map((t) => <PlatformMark key={t.id} platform={t.platform} className="size-5 text-[8px]" />)}</span>
                  <span className="text-xs tabular-nums text-muted">{fmtDate(p.scheduledAt, true, me?.timezone)}</span>
                </Link>
              </li>
            ))}
          </ul>
        ) : <EmptyState title="Nothing scheduled" description="Schedule a post and it appears here with its target platforms." action={<Link href="/publishing?new=1"><Button>Schedule a post</Button></Link>} />}
      </Panel>
    ),
    attention: (
      <Panel>
        <PanelHeader title="Needs attention" description="Failed or blocked publishing" />
        {attention.length ? (
          <ul className="divide-y divide-line-soft border-t border-line-soft">
            {attention.slice(0, 6).map(({ post, target }) => (
              <li key={target.id}>
                <Link href={`/publishing?post=${post.id}`} className="flex items-start gap-3 px-5 py-2.5 hover:bg-raised/40">
                  <AlertTriangle className="mt-0.5 size-4 text-warning" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px]">{post.title}</span>
                    <span className="line-clamp-1 text-xs text-muted">{target.lastError}</span>
                  </span>
                  <StatusBadge status={target.status} />
                </Link>
              </li>
            ))}
          </ul>
        ) : <p className="px-5 pb-5 text-[13px] text-muted">No failed or blocked posts.</p>}
      </Panel>
    ),
    top: (
      <Panel>
        <PanelHeader title="Top and underperforming content" tooltip="Ranked by views from the latest sync. 'vs median' compares each item with your median content." />
        {o && (o.top.length || o.under.length) ? (
          <div className="grid gap-px border-t border-line-soft bg-line-soft md:grid-cols-2">
            {[{ label: "Top performing", rows: o.top }, { label: "Underperforming", rows: o.under }].map((g) => (
              <div key={g.label} className="bg-panel p-4">
                <p className="mb-2 text-[12.5px] text-muted">{g.label}</p>
                {g.rows.length ? (
                  <ul className="space-y-2.5">
                    {g.rows.map((c) => (
                      <li key={c.id} className="flex items-center gap-3">
                        {c.thumbnailUrl ? <img src={c.thumbnailUrl} alt="" className="h-9 w-16 shrink-0 rounded-sm object-cover" /> : <PlatformMark platform={c.platform} />}
                        <a href={c.url ?? "#"} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate text-[13px] hover:text-violet-soft">{c.title ?? "Untitled"}</a>
                        <span className="text-right text-xs tabular-nums">
                          <span className="block">{fmtNum(c.metrics.views)}</span>
                          {c.vsMedian !== null && <span className="text-faint">{c.vsMedian.toFixed(1)}× median</span>}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : <p className="text-[13px] text-muted">Needs at least 6 synced posts to compare.</p>}
              </div>
            ))}
          </div>
        ) : <p className="px-5 pb-5 text-[13px] text-muted">Sync a connected account to rank your content.</p>}
      </Panel>
    ),
    platforms: (
      <Panel>
        <PanelHeader title="Platform breakdown" description={`Views of content published in the last ${days} days`} />
        <div className="px-3 pb-4">
          {o?.platformBreakdown.length ? <BarsChart data={o.platformBreakdown.map((p) => ({ ...p, name: PLATFORM_LABEL[p.platform] }))} dataKey="views" xKey="name" nameLabel="Views" /> : <p className="px-2 pb-2 text-[13px] text-muted">No platform data for this period.</p>}
        </div>
      </Panel>
    ),
    times: (
      <Panel>
        <PanelHeader title="Best publishing times" tooltip="Average views of your own content by weekday and hour (UTC) of publishing. Slots need at least 2 posts. This is historical correlation, not a guarantee." />
        {o?.bestTimes.length ? (
          <ul className="divide-y divide-line-soft border-t border-line-soft">
            {o.bestTimes.map((t) => (
              <li key={`${t.weekday}-${t.hourUtc}`} className="flex items-center justify-between px-5 py-2.5 text-[13.5px]">
                <span>{DAYS[t.weekday]} {String(t.hourUtc).padStart(2, "0")}:00 UTC</span>
                <span className="text-xs tabular-nums text-muted">{fmtNum(t.avgViews)} avg views from {t.samples} posts</span>
              </li>
            ))}
          </ul>
        ) : <p className="px-5 pb-5 text-[13px] text-muted">Not enough published history yet to find reliable time slots.</p>}
      </Panel>
    ),
    automations: (
      <Panel>
        <PanelHeader title="Pending automations" actions={<Link href="/automation" className="text-[13px] text-violet-soft hover:underline">Manage</Link>} />
        {pendingFlows.length ? (
          <ul className="divide-y divide-line-soft border-t border-line-soft">
            {pendingFlows.slice(0, 5).map((w) => (
              <li key={w.id} className="flex items-center gap-3 px-5 py-2.5 text-[13.5px]">
                <Workflow className="size-4 text-faint" />
                <span className="flex-1 truncate">{w.name}</span>
                <span className="text-xs text-muted">{w.trigger.type === "schedule" && w.nextRunAt ? `Next ${fmtDate(w.nextRunAt, true, me?.timezone)}` : `On ${w.trigger.type.replace(/_/g, " ")}`}</span>
              </li>
            ))}
          </ul>
        ) : <p className="px-5 pb-5 text-[13px] text-muted">No active automations.</p>}
      </Panel>
    ),
    accounts: (
      <Panel>
        <PanelHeader title="Connected account health" actions={<Link href="/settings?tab=connections" className="text-[13px] text-violet-soft hover:underline">Connections</Link>} />
        {connections?.length ? (
          <ul className="divide-y divide-line-soft border-t border-line-soft">
            {connections.map((c) => (
              <li key={c.id} className="flex items-center gap-3 px-5 py-2.5">
                <PlatformMark platform={c.platform} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px]">{c.accountName}</span>
                  <span className="text-xs text-muted">Synced {fmtRelative(c.lastSyncedAt)}</span>
                </span>
                <StatusBadge status={c.status} />
              </li>
            ))}
          </ul>
        ) : <EmptyState icon={PlugZap} title="No accounts connected" description="Connect your channels to publish and see verified analytics." action={<Link href="/settings?tab=connections"><Button variant="primary">Connect</Button></Link>} />}
      </Panel>
    ),
    activity: (
      <Panel>
        <PanelHeader title="Recent activity" actions={<Link href="/activity" className="text-[13px] text-violet-soft hover:underline">All activity</Link>} />
        {activity.data?.length ? (
          <ul className="space-y-0 border-t border-line-soft">
            {activity.data.map((a) => (
              <li key={a.id} className="flex justify-between gap-3 border-b border-line-soft/60 px-5 py-2.5 text-[13px] last:border-0">
                <span className="truncate">{a.summary}</span>
                <span className="shrink-0 text-xs text-faint">{fmtRelative(a.createdAt)}</span>
              </li>
            ))}
          </ul>
        ) : <p className="px-5 pb-5 text-[13px] text-muted">Your actions across VIRAL OS will be listed here.</p>}
      </Panel>
    ),
  };

  // Wide widgets span both columns; the rest flow two-up on large screens.
  const wide: WidgetId[] = ["kpis", "performance", "top", "recommendations"];

  return (
    <div>
      <PageHeader
        title={firstName ? `Welcome back, ${firstName}` : "Creator Command Center"}
        description="Verified performance from your connected platforms, what's scheduled, and what needs you next."
        actions={
          <>
            <RangePicker days={days} onChange={setDays} />
            <Select value={platform} onChange={(e) => setPlatform(e.target.value)} className="w-36" aria-label="Platform filter">
              <option value="">All platforms</option>
              <option value="youtube">YouTube</option>
              <option value="tiktok">TikTok</option>
              <option value="instagram">Instagram</option>
            </Select>
            {!!connections?.length && (
              <Select value={connectionId} onChange={(e) => setConnectionId(e.target.value)} className="w-40" aria-label="Account filter">
                <option value="">All accounts</option>
                {connections.map((c) => <option key={c.id} value={c.id}>{c.accountName}</option>)}
              </Select>
            )}
            <Button onClick={() => sync.mutate()} loading={sync.isPending}><RefreshCw /> Refresh</Button>
            <Button variant="ghost" size="icon" onClick={() => setCustomize(true)} aria-label="Customize dashboard"><LayoutGrid /></Button>
          </>
        }
      />
      <div className="grid gap-4 xl:grid-cols-2">
        {layout.map((id) => (
          <div key={id} className={wide.includes(id) ? "xl:col-span-2" : undefined}>
            {widgets[id]}
          </div>
        ))}
      </div>

      <Dialog open={customize} onOpenChange={setCustomize} title="Customize dashboard" description="Reorder or hide widgets. Saved to your profile.">
        <ul className="space-y-1.5">
          {WIDGETS.map((w) => {
            const visible = layout.includes(w.id);
            return (
              <li key={w.id} className="flex items-center gap-3 rounded-md border border-line-soft bg-ink-2 px-3 py-2">
                <Switch checked={visible} label={`Show ${w.label}`} onCheckedChange={(v) => saveLayout.mutate(v ? [...layout, w.id] : layout.filter((x) => x !== w.id))} />
                <span className={`flex-1 text-[13.5px] ${visible ? "" : "text-faint"}`}>{w.label}</span>
                {visible ? (
                  <>
                    <Button size="icon" variant="ghost" className="size-7" onClick={() => move(w.id, -1)} aria-label={`Move ${w.label} up`}><ChevronUp /></Button>
                    <Button size="icon" variant="ghost" className="size-7" onClick={() => move(w.id, 1)} aria-label={`Move ${w.label} down`}><ChevronDown /></Button>
                  </>
                ) : <EyeOff className="size-4 text-faint" />}
              </li>
            );
          })}
        </ul>
        <div className="mt-4 flex justify-between">
          <Badge>Order: {layout.length} visible</Badge>
          <Button size="sm" variant="ghost" onClick={() => saveLayout.mutate(WIDGETS.map((w) => w.id))}>Reset to default</Button>
        </div>
      </Dialog>
    </div>
  );
}
