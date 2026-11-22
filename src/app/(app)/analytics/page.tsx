"use client";

import * as React from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { LineChart, RefreshCw, Download } from "lucide-react";
import { api } from "@/lib/client/api";
import { useAction, useApiQuery, useConnections } from "@/lib/client/hooks";
import { Button, EmptyState, ErrorState, PageHeader, Panel, PanelHeader, Select, Skeleton, SkeletonRows, SourceTag, Stat } from "@/components/ui/primitives";
import { PlatformMark, StatusBadge } from "@/components/ui/domain";
import { DataTable, type Column } from "@/components/ui/data-table";
import { RangePicker, SeriesChart, BarsChart } from "@/components/charts";
import { fmtDate, fmtNum, fmtPct, fmtRelative } from "@/lib/client/utils";

type Row = { id: string; platform: string; externalId: string; title: string | null; url: string | null; thumbnailUrl: string | null; publishedAt: string | null; capturedAt: string; views: number | null; likes: number | null; comments: number | null; shares: number | null; engagementRate: number | null };
type Overview = { kpis: { views: { value: number | null; previous: number | null; source: string }; audience: { value: number | null; growth: number | null }; engagementRate: { value: number | null; previous: number | null }; postsPublished: { value: number } }; series: Record<string, number | string>[]; lastCapturedAt: string | null };

const csv = (rows: Row[]) => {
  const esc = (v: unknown) => { const s = v === null || v === undefined ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return ["platform,title,url,published_at,views,likes,comments,shares,engagement_rate,retrieved_at", ...rows.map((r) => [r.platform, r.title, r.url, r.publishedAt, r.views, r.likes, r.comments, r.shares, r.engagementRate, r.capturedAt].map(esc).join(","))].join("\n");
};

export default function AnalyticsPage() {
  const qc = useQueryClient();
  const [platform, setPlatform] = React.useState("");
  const [days, setDays] = React.useState(30);
  const { data: connections } = useConnections();
  const [now] = React.useState(() => Date.now());
  const content = useApiQuery<Row[]>(["analytics-content", platform], `/api/v1/analytics/content${platform ? `?platform=${platform}` : ""}`);
  const overview = useApiQuery<Overview>(["overview", "analytics", days, platform], `/api/v1/analytics/overview?days=${days}${platform ? `&platform=${platform}` : ""}`);
  const sync = useAction(() => api.post<{ results: { ok: boolean; error?: string }[] }>("/api/v1/analytics/sync"), {
    onSuccess: (r) => {
      const bad = r.results.filter((x) => !x.ok);
      if (!r.results.length) toast.info("No connected accounts to sync.");
      else if (bad.length) toast.error(bad[0].error ?? "Sync failed");
      else toast.success("Sync complete");
      qc.invalidateQueries({ queryKey: ["analytics-content"] });
      qc.invalidateQueries({ queryKey: ["overview"] });
      qc.invalidateQueries({ queryKey: ["connections"] });
    },
  });
  const syncOne = useAction((id: string) => api.post(`/api/v1/connections/${id}/sync`), { invalidate: [["analytics-content"], ["overview"], ["connections"]], success: "Account synced" });
  const rows = (content.data ?? []).filter((r) => !r.publishedAt || new Date(r.publishedAt).getTime() >= now - days * 86400_000 || days >= 365);
  const o = overview.data;
  const cols: Column<Row>[] = [
    { key: "title", header: "Content", cell: (r) => <div className="flex items-center gap-3">{r.thumbnailUrl ? <img src={r.thumbnailUrl} alt="" className="h-9 w-16 shrink-0 rounded-sm object-cover" loading="lazy" /> : <PlatformMark platform={r.platform} />}<a href={r.url ?? "#"} target="_blank" rel="noreferrer" className="line-clamp-2 hover:text-violet-soft">{r.title ?? "Untitled"}</a></div>, sortValue: (r) => r.title, className: "max-w-md" },
    { key: "platform", header: "Platform", cell: (r) => <PlatformMark platform={r.platform} />, sortValue: (r) => r.platform },
    { key: "published", header: "Published", cell: (r) => <span className="text-xs text-muted">{fmtDate(r.publishedAt)}</span>, sortValue: (r) => r.publishedAt },
    { key: "views", header: "Views", cell: (r) => fmtNum(r.views), sortValue: (r) => r.views, align: "right" },
    { key: "likes", header: "Likes", cell: (r) => fmtNum(r.likes), sortValue: (r) => r.likes, align: "right" },
    { key: "comments", header: "Comments", cell: (r) => fmtNum(r.comments), sortValue: (r) => r.comments, align: "right" },
    { key: "shares", header: "Shares", cell: (r) => fmtNum(r.shares), sortValue: (r) => r.shares, align: "right" },
    { key: "er", header: "Engagement", cell: (r) => fmtPct(r.engagementRate), sortValue: (r) => r.engagementRate, align: "right" },
  ];
  const download = () => {
    const blob = new Blob([csv(rows)], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `viral-os-analytics-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
  };

  return (
    <div>
      <PageHeader title="Analytics" description="Only numbers retrieved from the platforms' official APIs. Nothing here is estimated." actions={<><RangePicker days={days} onChange={setDays} /><Select value={platform} onChange={(e) => setPlatform(e.target.value)} className="w-36" aria-label="Platform"><option value="">All platforms</option><option value="youtube">YouTube</option><option value="tiktok">TikTok</option><option value="instagram">Instagram</option></Select><Button onClick={() => sync.mutate(undefined)} loading={sync.isPending}><RefreshCw /> Sync now</Button></>} />
      <Panel className="mb-5 grid grid-cols-2 lg:grid-cols-4 lg:divide-x divide-line-soft">
        <Stat label="Views" loading={overview.isLoading} value={fmtNum(o?.kpis.views.value)} delta={o?.kpis.views.value != null && o.kpis.views.previous ? (o.kpis.views.value - o.kpis.views.previous) / o.kpis.views.previous : null} hint={o?.kpis.views.source} />
        <Stat label="Audience" loading={overview.isLoading} value={fmtNum(o?.kpis.audience.value)} />
        <Stat label="Engagement rate" loading={overview.isLoading} value={fmtPct(o?.kpis.engagementRate.value)} />
        <Stat label="Published via VIRAL OS" loading={overview.isLoading} value={fmtNum(o?.kpis.postsPublished.value)} />
      </Panel>
      <div className="mb-5 grid gap-5 xl:grid-cols-[1fr_340px]">
        <Panel>
          <PanelHeader title="Views over time" description={o?.lastCapturedAt ? `Last synced ${fmtRelative(o.lastCapturedAt)}` : undefined} actions={o?.lastCapturedAt ? <SourceTag source="platform_api" at={o.lastCapturedAt} /> : undefined} />
          <div className="px-3 pb-4">{overview.isLoading ? <Skeleton className="mx-2 h-64" /> : overview.error ? <ErrorState error={overview.error} /> : o?.series.length ? <SeriesChart data={o.series} keys={[...new Set(o.series.flatMap((r) => Object.keys(r).filter((k) => k !== "date")))]} /> : <p className="px-2 py-16 text-center text-[13px] text-muted">No data for this period.</p>}</div>
        </Panel>
        <Panel>
          <PanelHeader title="Accounts" />
          {connections?.length ? (
            <ul className="divide-y divide-line-soft border-t border-line-soft">
              {connections.map((c) => (
                <li key={c.id} className="px-5 py-3">
                  <div className="flex items-center gap-2"><PlatformMark platform={c.platform} /><span className="flex-1 truncate text-[13.5px]">{c.accountName}</span><StatusBadge status={c.status} /></div>
                  <div className="mt-1 flex items-center justify-between text-xs text-muted"><span>Synced {fmtRelative(c.lastSyncedAt)}</span><Button size="sm" variant="ghost" onClick={() => syncOne.mutate(c.id)} loading={syncOne.isPending && syncOne.variables === c.id}>Sync</Button></div>
                  {c.lastError && <p className="mt-1 text-xs text-danger">{c.lastError}</p>}
                </li>
              ))}
            </ul>
          ) : <p className="px-5 pb-5 text-[13px] text-muted">No connected accounts.</p>}
        </Panel>
      </div>
      {rows.length > 0 && <Panel className="mb-5"><PanelHeader title="Top content by views" /><div className="px-3 pb-4"><BarsChart data={[...rows].sort((a, b) => (b.views ?? 0) - (a.views ?? 0)).slice(0, 8).map((r) => ({ name: (r.title ?? "Untitled").slice(0, 22), views: r.views ?? 0 }))} dataKey="views" xKey="name" nameLabel="Views" /></div></Panel>}
      <Panel>
        <PanelHeader title="Content performance" description="Latest verified metrics per post" actions={<Button size="sm" onClick={download} disabled={!rows.length}><Download /> Export CSV</Button>} />
        {content.isLoading ? <SkeletonRows /> : content.error ? <ErrorState error={content.error} onRetry={() => content.refetch()} /> : (
          <DataTable rows={rows} columns={cols} rowKey={(r) => r.id} searchable={(r) => r.title ?? ""} initialSort={{ key: "views", dir: "desc" }} empty={<EmptyState icon={LineChart} title="No analytics yet" description="Connect an account and sync to pull your content's metrics." action={<Link href="/settings?tab=connections"><Button variant="primary">Connect an account</Button></Link>} />} />
        )}
      </Panel>
    </div>
  );
}
