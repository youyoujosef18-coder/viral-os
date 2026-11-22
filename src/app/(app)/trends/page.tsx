"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Radar, RefreshCw, Bookmark, Lightbulb, Plus, Trash2, Bell, BellOff, ExternalLink } from "lucide-react";
import { LineChart, Line, ResponsiveContainer } from "recharts";
import { api, errorText } from "@/lib/client/api";
import { useAction, useApiQuery } from "@/lib/client/hooks";
import { Badge, Button, Dialog, EmptyState, ErrorState, Field, Input, PageHeader, Panel, PanelHeader, Select, SignalMeter, SkeletonRows, SourceTag, Switch, Tooltip, HelpTip } from "@/components/ui/primitives";
import { NotConfigured } from "@/components/ui/domain";
import { DataTable, type Column } from "@/components/ui/data-table";
import { fmtDate, fmtNum, fmtRelative } from "@/lib/client/utils";

type Trend = { id: string; title: string; channelTitle: string | null; category: string | null; region: string; thumbnailUrl: string | null; url: string | null; publishedAt: string | null; metrics: Record<string, number>; momentum: number | null; opportunityScore: number | null; estimatedExpiry: string | null; history: { at: string; views: number }[]; saved: boolean; retrievedAt: string };
type Watchlist = { id: string; name: string; keywords: string[]; region: string; alertsEnabled: boolean; lastCheckedAt: string | null };

const REGIONS = [["US", "United States"], ["GB", "United Kingdom"], ["CA", "Canada"], ["AU", "Australia"], ["IN", "India"], ["FR", "France"], ["DE", "Germany"], ["ES", "Spain"], ["BR", "Brazil"], ["MX", "Mexico"], ["DZ", "Algeria"], ["MA", "Morocco"], ["EG", "Egypt"], ["SA", "Saudi Arabia"], ["AE", "United Arab Emirates"], ["JP", "Japan"], ["KR", "South Korea"], ["ID", "Indonesia"], ["NG", "Nigeria"], ["TR", "Türkiye"]];

function Sparkline({ history }: { history: { at: string; views: number }[] }) {
  if (history.length < 2) return <span className="text-xs text-faint">1 snapshot</span>;
  return (
    <div className="h-7 w-24" aria-label={`Views history over ${history.length} retrievals`}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={history}><Line type="monotone" dataKey="views" stroke="#22d3ee" strokeWidth={1.5} dot={false} isAnimationActive={false} /></LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export default function TrendsPage() {
  const router = useRouter();
  const [region, setRegion] = React.useState("US");
  const [savedOnly, setSavedOnly] = React.useState(false);
  const [wlOpen, setWlOpen] = React.useState(false);
  const trends = useApiQuery<Trend[]>(["trends", region, savedOnly], `/api/v1/trends?region=${region}${savedOnly ? "&saved=1" : ""}`);
  const watchlists = useApiQuery<Watchlist[]>(["watchlists"], "/api/v1/trends/watchlists");
  const refresh = useAction(() => api.post<{ count: number; alerts: number }>("/api/v1/trends/refresh", { region }), { invalidate: [["trends"], ["notifications"]], silentError: true, success: (r) => `Retrieved ${r.count} trending videos${r.alerts ? `, ${r.alerts} watchlist alert(s)` : ""}` });
  const save = useAction(({ id, saved }: { id: string; saved: boolean }) => api.patch(`/api/v1/trends/${id}`, { saved }), { invalidate: [["trends"]] });
  const [ideasFor, setIdeasFor] = React.useState<string | null>(null);
  const ideas = useAction((id: string) => api.post<{ interpretation: string; ideas: { title: string }[] }>(`/api/v1/trends/${id}/ideas`), {
    invalidate: [["ideas"]],
    onSuccess: (r) => toast.success(`${r.ideas.length} original ideas saved`, { description: r.interpretation, action: { label: "View ideas", onClick: () => router.push("/research?tab=ideas") } }),
  });
  const toggleWl = useAction(({ id, alertsEnabled }: { id: string; alertsEnabled: boolean }) => api.patch(`/api/v1/trends/watchlists/${id}`, { alertsEnabled }), { invalidate: [["watchlists"]] });
  const delWl = useAction((id: string) => api.del(`/api/v1/trends/watchlists/${id}`), { invalidate: [["watchlists"]], success: "Watchlist removed" });

  const rows = trends.data ?? [];
  const lastRetrieved = rows[0]?.retrievedAt;
  const columns: Column<Trend>[] = [
    {
      key: "title", header: "Trending video",
      cell: (t) => (
        <div className="flex items-center gap-3">
          {t.thumbnailUrl && <img src={t.thumbnailUrl} alt="" className="h-10 w-[72px] shrink-0 rounded-sm object-cover" loading="lazy" />}
          <div className="min-w-0">
            <a href={t.url ?? "#"} target="_blank" rel="noreferrer" className="line-clamp-1 font-medium hover:text-violet-soft">{t.title}</a>
            <p className="truncate text-xs text-muted">{t.channelTitle}{t.category ? ` in ${t.category}` : ""}, published {fmtRelative(t.publishedAt)}</p>
          </div>
        </div>
      ),
      sortValue: (t) => t.title,
      className: "max-w-[420px]",
    },
    { key: "views", header: "Views", cell: (t) => fmtNum(t.metrics.views), sortValue: (t) => t.metrics.views, align: "right" },
    { key: "momentum", header: <span className="inline-flex items-center gap-1">Momentum <HelpTip text="Views gained per hour between the last two retrievals (verified). On first retrieval: average views per hour since publish." /></span>, cell: (t) => (t.momentum === null ? "—" : `${fmtNum(t.momentum)}/h`), sortValue: (t) => t.momentum, align: "right" },
    { key: "history", header: "History", cell: (t) => <Sparkline history={t.history} /> },
    { key: "score", header: <span className="inline-flex items-center gap-1">Opportunity <HelpTip text="Computed: 60% momentum percentile in this batch, 25% recency, 15% engagement percentile." /></span>, cell: (t) => <div className="w-28"><SignalMeter value={t.opportunityScore} size="sm" label="" /></div>, sortValue: (t) => t.opportunityScore },
    { key: "expiry", header: <span className="inline-flex items-center gap-1">Est. window <HelpTip text="Estimate only. Projects when hourly gains drop below 10% of their peak, otherwise ~7 days from publish." /></span>, cell: (t) => <span className="text-xs text-muted">{t.estimatedExpiry ? `until ${fmtDate(t.estimatedExpiry)}` : "—"}</span>, sortValue: (t) => t.estimatedExpiry },
    {
      key: "actions", header: "",
      cell: (t) => (
        <div className="flex justify-end gap-1">
          <Tooltip content={t.saved ? "Remove from saved" : "Save trend"}><Button size="icon" variant="ghost" aria-label="Save trend" onClick={(e) => { e.stopPropagation(); save.mutate({ id: t.id, saved: !t.saved }); }}><Bookmark className={t.saved ? "fill-current text-violet-soft" : ""} /></Button></Tooltip>
          <Button size="sm" variant="ghost" onClick={() => { setIdeasFor(t.id); ideas.mutate(t.id, { onSettled: () => setIdeasFor(null) }); }} loading={ideas.isPending && ideasFor === t.id}><Lightbulb /> Ideas</Button>
        </div>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Trend Radar"
        description="What's trending on YouTube right now, from the official Data API. Metrics are verified; momentum, opportunity and windows are computed from them. Refresh again later to measure real momentum."
        actions={
          <>
            <Select value={region} onChange={(e) => setRegion(e.target.value)} className="w-48" aria-label="Region">{REGIONS.map(([c, n]) => <option key={c} value={c}>{n}</option>)}</Select>
            <Button variant="primary" onClick={() => refresh.mutate(undefined)} loading={refresh.isPending}><RefreshCw /> Refresh trends</Button>
          </>
        }
      />
      {refresh.error && <Panel className="mb-4"><NotConfigured error={refresh.error} title="Trend Radar needs a YouTube Data API key" />{!(refresh.error as { notConfigured?: boolean }).notConfigured && <p className="p-4 text-[13px] text-danger">{errorText(refresh.error)}</p>}</Panel>}
      <div className="grid gap-5 xl:grid-cols-[1fr_300px]">
        <Panel className="min-w-0">
          <PanelHeader
            title={savedOnly ? "Saved trends" : `Trending in ${REGIONS.find((r) => r[0] === region)?.[1]}`}
            description={lastRetrieved ? <span className="inline-flex items-center gap-2">Source: YouTube Data API (mostPopular), retrieved {fmtRelative(lastRetrieved)} <SourceTag source="platform_api" at={lastRetrieved} /></span> : undefined}
            actions={<label className="flex items-center gap-2 text-[13px] text-muted"><Switch checked={savedOnly} onCheckedChange={setSavedOnly} label="Saved only" /> Saved only</label>}
          />
          {trends.isLoading ? <SkeletonRows rows={8} /> : trends.error ? <ErrorState error={trends.error} onRetry={() => trends.refetch()} /> : (
            <DataTable rows={rows} columns={columns} rowKey={(t) => t.id} searchable={(t) => `${t.title} ${t.channelTitle} ${t.category}`} searchPlaceholder="Filter trends" initialSort={{ key: "score", dir: "desc" }} empty={<EmptyState icon={Radar} title={savedOnly ? "No saved trends" : "No trend data for this region yet"} description={savedOnly ? "Bookmark trends to keep them here." : "Refresh trends to pull the current most-popular list. Refresh again a few hours later and momentum becomes a measured rate."} action={!savedOnly && <Button variant="primary" onClick={() => refresh.mutate(undefined)} loading={refresh.isPending}>Refresh trends</Button>} />} />
          )}
        </Panel>

        <Panel className="h-fit">
          <PanelHeader title="Watchlists" description="Get alerted when new trending videos match your keywords." actions={<Button size="sm" onClick={() => setWlOpen(true)}><Plus /> New</Button>} />
          {watchlists.data?.length ? (
            <ul className="divide-y divide-line-soft border-t border-line-soft">
              {watchlists.data.map((w) => (
                <li key={w.id} className="px-5 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-[13.5px] font-medium">{w.name} <span className="text-xs font-normal text-faint">{w.region}</span></p>
                    <div className="flex">
                      <Tooltip content={w.alertsEnabled ? "Pause alerts" : "Resume alerts"}><Button size="icon" variant="ghost" className="size-7" aria-label="Toggle alerts" onClick={() => toggleWl.mutate({ id: w.id, alertsEnabled: !w.alertsEnabled })}>{w.alertsEnabled ? <Bell /> : <BellOff />}</Button></Tooltip>
                      <Button size="icon" variant="ghost" className="size-7" aria-label="Delete watchlist" onClick={() => delWl.mutate(w.id)}><Trash2 /></Button>
                    </div>
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-1">{w.keywords.map((k) => <Badge key={k}>{k}</Badge>)}</div>
                  <p className="mt-1.5 text-xs text-faint">Checked {fmtRelative(w.lastCheckedAt)}. The worker re-checks every 3 hours.</p>
                </li>
              ))}
            </ul>
          ) : <p className="px-5 pb-5 text-[13px] text-muted">No watchlists yet.</p>}
          <p className="border-t border-line-soft px-5 py-3 text-xs text-faint"><ExternalLink className="mr-1 inline size-3" />TikTok and Instagram do not offer an official public trends API for this app type, so Trend Radar uses YouTube data only.</p>
        </Panel>
      </div>
      <WatchlistDialog open={wlOpen} onOpenChange={setWlOpen} region={region} />
    </div>
  );
}

function WatchlistDialog({ open, onOpenChange, region }: { open: boolean; onOpenChange: (o: boolean) => void; region: string }) {
  const [name, setName] = React.useState("");
  const [keywords, setKeywords] = React.useState("");
  const [err, setErr] = React.useState<string | null>(null);
  const create = useAction(() => api.post("/api/v1/trends/watchlists", { name, keywords: keywords.split(",").map((k) => k.trim()).filter(Boolean), region }), { invalidate: [["watchlists"]], success: "Watchlist created", onSuccess: () => { onOpenChange(false); setName(""); setKeywords(""); } });
  const submit = () => {
    if (!name.trim()) return setErr("Give the watchlist a name.");
    if (!keywords.split(",").some((k) => k.trim().length >= 2)) return setErr("Add at least one keyword (2+ characters).");
    setErr(null);
    create.mutate(undefined);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="New trend watchlist" description={`Alerts for region ${region}.`} footer={<><Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="primary" onClick={submit} loading={create.isPending}>Create watchlist</Button></>}>
      <div className="space-y-4">
        <Field label="Name" htmlFor="wl-name"><Input id="wl-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Coffee gear" /></Field>
        <Field label="Keywords" htmlFor="wl-kw" hint="Comma separated. Matched against trending titles and tags." error={err ?? undefined}><Input id="wl-kw" value={keywords} onChange={(e) => setKeywords(e.target.value)} placeholder="espresso, latte art, grinder" /></Field>
      </div>
    </Dialog>
  );
}
