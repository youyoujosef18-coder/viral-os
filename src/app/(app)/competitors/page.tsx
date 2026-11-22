"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import { Swords, Plus, RefreshCw, Sparkles, Trash2, PenSquare } from "lucide-react";
import { api } from "@/lib/client/api";
import { useAction, useApiQuery } from "@/lib/client/hooks";
import { Badge, Button, ConfirmDialog, Dialog, EmptyState, ErrorState, Field, HelpTip, Input, PageHeader, Panel, PanelHeader, Select, SkeletonRows, SourceTag } from "@/components/ui/primitives";
import { NotConfigured, PlatformMark } from "@/components/ui/domain";
import { DataTable, type Column } from "@/components/ui/data-table";
import { BarsChart } from "@/components/charts";
import { cn, fmtDate, fmtNum, fmtRelative } from "@/lib/client/utils";

type Stats = { sample: number; uploadsPerWeek: number | null; medianViews: number; avgViews: number; shortFormShare: number; avgDurationSeconds: number; titlePatterns: { avgLength: number; questionPct: number; numberPct: number; allCapsWordPct: number; bracketPct: number }; outliers: { id: string; title: string; views: number | null; multiple: number }[] } | null;
type Competitor = { id: string; platform: string; name: string; handle: string | null; avatarUrl: string | null; subscriberCount: number | null; videoCount: number | null; viewCount: number | null; retrievedAt: string | null; analysis: Analysis | null; analysisAt: string | null; stats: Stats; contentCount: number };
type Analysis = { stats: Stats; ai: { topics: { topic: string; evidence: string }[]; hookPatterns: string[]; titleInsights: string[]; thumbnailInsights: string[]; formatInsights: string[]; audiencePositioning: string; contentGaps: string[]; originalIdeas: { title: string; angle: string }[] }; model: string; generatedAt: string };
type ContentRow = { id: string; externalId: string; title: string; thumbnailUrl: string | null; publishedAt: string | null; durationSeconds: number | null; viewCount: number | null; likeCount: number | null; commentCount: number | null };

export default function CompetitorsPage() {
  const params = useSearchParams();
  const [selected, setSelected] = React.useState<string | null>(params.get("id"));
  const [addOpen, setAddOpen] = React.useState(false);
  const comps = useApiQuery<Competitor[]>(["competitors"], "/api/v1/competitors");
  const current = comps.data?.find((c) => c.id === selected) ?? comps.data?.[0];

  const compareCols: Column<Competitor>[] = [
    { key: "name", header: "Competitor", cell: (c) => <span className="flex items-center gap-2"><PlatformMark platform={c.platform} />{c.avatarUrl && <img src={c.avatarUrl} alt="" className="size-6 rounded-full" />}<span className="font-medium">{c.name}</span></span>, sortValue: (c) => c.name },
    { key: "subs", header: "Subscribers", cell: (c) => fmtNum(c.subscriberCount), sortValue: (c) => c.subscriberCount, align: "right" },
    { key: "freq", header: "Uploads/week", cell: (c) => c.stats?.uploadsPerWeek ?? "—", sortValue: (c) => c.stats?.uploadsPerWeek, align: "right" },
    { key: "median", header: "Median views", cell: (c) => fmtNum(c.stats?.medianViews), sortValue: (c) => c.stats?.medianViews, align: "right" },
    { key: "short", header: "Short-form share", cell: (c) => (c.stats ? `${c.stats.shortFormShare}%` : "—"), sortValue: (c) => c.stats?.shortFormShare, align: "right" },
    { key: "sample", header: "Videos analyzed", cell: (c) => c.contentCount, sortValue: (c) => c.contentCount, align: "right" },
  ];

  return (
    <div>
      <PageHeader title="Competitor Intelligence" description="Track public channels, see their publishing patterns and outliers, and turn general patterns into original ideas. Uses the official YouTube Data API; TikTok and Instagram competitors are tracked manually." actions={<Button variant="primary" onClick={() => setAddOpen(true)}><Plus /> Add competitor</Button>} />
      {comps.isLoading ? <Panel><SkeletonRows /></Panel> : comps.error ? <Panel><ErrorState error={comps.error} onRetry={() => comps.refetch()} /></Panel> : !comps.data?.length ? (
        <Panel><EmptyState icon={Swords} title="No competitors tracked" description="Add a YouTube channel by handle, URL or channel ID to pull its recent public uploads." action={<Button variant="primary" onClick={() => setAddOpen(true)}>Add competitor</Button>} /></Panel>
      ) : (
        <>
          {comps.data.length > 1 && <Panel className="mb-5"><PanelHeader title="Compare competitors" tooltip="Computed from each channel's recent public uploads (up to 50)." /><DataTable rows={comps.data} columns={compareCols} rowKey={(c) => c.id} onRowClick={(c) => setSelected(c.id)} dense /></Panel>}
          <div className="grid gap-5 lg:grid-cols-[260px_1fr]">
            <Panel as="div" className="h-fit p-2">
              <ul>
                {comps.data.map((c) => (
                  <li key={c.id}>
                    <button onClick={() => setSelected(c.id)} className={cn("flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-[13.5px]", current?.id === c.id ? "bg-raised" : "hover:bg-raised/50")}>
                      {c.avatarUrl ? <img src={c.avatarUrl} alt="" className="size-7 rounded-full" /> : <PlatformMark platform={c.platform} />}
                      <span className="min-w-0 flex-1"><span className="block truncate">{c.name}</span><span className="text-xs text-faint">{c.handle}</span></span>
                    </button>
                  </li>
                ))}
              </ul>
            </Panel>
            {current && <CompetitorDetail key={current.id} c={current} />}
          </div>
        </>
      )}
      <AddDialog open={addOpen} onOpenChange={setAddOpen} onAdded={(id) => setSelected(id)} />
    </div>
  );
}

function CompetitorDetail({ c }: { c: Competitor }) {
  const detail = useApiQuery<Competitor & { content: ContentRow[] }>(["competitor", c.id], `/api/v1/competitors/${c.id}`);
  const [confirm, setConfirm] = React.useState(false);
  const [logOpen, setLogOpen] = React.useState(false);
  const refresh = useAction(() => api.post<{ videos: number }>(`/api/v1/competitors/${c.id}/refresh`), { invalidate: [["competitors"], ["competitor", c.id]], success: (r) => `Pulled ${r.videos} recent uploads` });
  const analyze = useAction(() => api.post(`/api/v1/competitors/${c.id}/analyze`), { invalidate: [["competitors"]], silentError: true, success: "Analysis ready" });
  const remove = useAction(() => api.del(`/api/v1/competitors/${c.id}`), { invalidate: [["competitors"]], success: "Competitor removed", onSuccess: () => setConfirm(false) });
  const s = c.stats;
  const a = c.analysis;
  const content = detail.data?.content ?? [];
  const cols: Column<ContentRow>[] = [
    { key: "title", header: "Video", cell: (r) => <div className="flex items-center gap-3">{r.thumbnailUrl && <img src={r.thumbnailUrl} alt="" className="h-9 w-16 shrink-0 rounded-sm object-cover" loading="lazy" />}{c.platform === "youtube" ? <a href={`https://www.youtube.com/watch?v=${r.externalId}`} target="_blank" rel="noreferrer" className="line-clamp-2 hover:text-violet-soft">{r.title}</a> : <span className="line-clamp-2">{r.title}</span>}</div>, sortValue: (r) => r.title, className: "max-w-md" },
    { key: "date", header: "Published", cell: (r) => <span className="text-xs text-muted">{fmtDate(r.publishedAt)}</span>, sortValue: (r) => r.publishedAt },
    { key: "dur", header: "Length", cell: (r) => (r.durationSeconds ? `${Math.floor(r.durationSeconds / 60)}:${String(r.durationSeconds % 60).padStart(2, "0")}` : "—"), sortValue: (r) => r.durationSeconds, align: "right" },
    { key: "views", header: "Views", cell: (r) => fmtNum(r.viewCount), sortValue: (r) => r.viewCount, align: "right" },
    { key: "eng", header: "Likes", cell: (r) => fmtNum(r.likeCount), sortValue: (r) => r.likeCount, align: "right" },
  ];

  return (
    <div className="min-w-0 space-y-5">
      <Panel>
        <PanelHeader
          title={<span className="flex items-center gap-2"><PlatformMark platform={c.platform} />{c.name}</span>}
          description={c.retrievedAt ? `Public data retrieved ${fmtRelative(c.retrievedAt)}` : "Manually tracked"}
          actions={
            <>
              {c.platform === "youtube" ? <Button size="sm" onClick={() => refresh.mutate(undefined)} loading={refresh.isPending}><RefreshCw /> Refresh</Button> : <Button size="sm" onClick={() => setLogOpen(true)}><PenSquare /> Log a post</Button>}
              <Button size="sm" variant="primary" onClick={() => analyze.mutate(undefined)} loading={analyze.isPending} disabled={!c.contentCount}><Sparkles /> Analyze patterns</Button>
              <Button size="icon" variant="ghost" aria-label="Remove competitor" onClick={() => setConfirm(true)}><Trash2 /></Button>
            </>
          }
        />
        {analyze.error && <><NotConfigured error={analyze.error} title="Pattern analysis needs an AI provider" />{!(analyze.error as { notConfigured?: boolean }).notConfigured && <ErrorState error={analyze.error} />}</>}
        <dl className="grid grid-cols-2 gap-px border-t border-line-soft bg-line-soft sm:grid-cols-4">
          {[["Subscribers", fmtNum(c.subscriberCount)], ["Uploads per week", s?.uploadsPerWeek ?? "—"], ["Median views", fmtNum(s?.medianViews)], ["Short-form share", s ? `${s.shortFormShare}%` : "—"]].map(([l, v]) => (
            <div key={l as string} className="bg-panel px-5 py-3"><dt className="text-xs text-muted">{l}</dt><dd className="mt-0.5 text-lg font-semibold tabular-nums">{v}</dd></div>
          ))}
        </dl>
        {s && (
          <div className="flex flex-wrap items-center gap-2 border-t border-line-soft px-5 py-3 text-xs text-muted">
            <span className="flex items-center gap-1">Title patterns <HelpTip text="Share of recent titles with each pattern. Computed from public titles." /></span>
            <Badge>avg {s.titlePatterns.avgLength} chars</Badge><Badge>{s.titlePatterns.numberPct}% use numbers</Badge><Badge>{s.titlePatterns.questionPct}% questions</Badge><Badge>{s.titlePatterns.allCapsWordPct}% CAPS words</Badge><Badge>{s.titlePatterns.bracketPct}% brackets</Badge>
            <SourceTag source={c.platform === "youtube" ? "computed" : "user_input"} at={c.retrievedAt} />
          </div>
        )}
      </Panel>

      {s?.outliers.length ? (
        <Panel>
          <PanelHeader title="Outlier videos" description="Videos with at least 2× the channel's median views" />
          <div className="px-3 pb-4"><BarsChart data={s.outliers.map((o) => ({ name: o.title.length > 28 ? `${o.title.slice(0, 28)}…` : o.title, multiple: o.multiple }))} dataKey="multiple" xKey="name" nameLabel="× median" color="#22d3ee" /></div>
        </Panel>
      ) : null}

      {a && (
        <Panel>
          <PanelHeader title="Pattern analysis" description={`Generated ${fmtRelative(a.generatedAt)} by ${a.model} from public titles and stats. Ideas are original, not copies.`} actions={<SourceTag source="ai_estimate" at={a.generatedAt} />} />
          <div className="grid gap-px border-t border-line-soft bg-line-soft md:grid-cols-2">
            {[["Topics", a.ai.topics.map((t) => `${t.topic}: ${t.evidence}`)], ["Hook patterns", a.ai.hookPatterns], ["Title insights", a.ai.titleInsights], ["Thumbnail hypotheses", a.ai.thumbnailInsights], ["Format insights", a.ai.formatInsights], ["Content gaps", a.ai.contentGaps]].map(([t, list]) => (
              <div key={t as string} className="bg-panel p-5"><h3 className="mb-2 text-[13.5px] font-semibold">{t as string}</h3><ul className="list-disc space-y-1 pl-4 text-[13px] text-muted">{(list as string[]).map((x) => <li key={x}>{x}</li>)}</ul></div>
            ))}
          </div>
          <div className="border-t border-line-soft p-5"><h3 className="mb-1 text-[13.5px] font-semibold">Audience positioning</h3><p className="text-[13px] text-muted">{a.ai.audiencePositioning}</p></div>
          <div className="border-t border-line-soft p-5"><h3 className="mb-2 text-[13.5px] font-semibold">Original ideas inspired by these patterns</h3><ul className="space-y-2">{a.ai.originalIdeas.map((i) => <li key={i.title} className="text-[13px]"><span className="font-medium">{i.title}</span> <span className="text-muted">{i.angle}</span></li>)}</ul></div>
        </Panel>
      )}

      <Panel>
        <PanelHeader title="Content library" description={`${content.length} public posts`} />
        {detail.isLoading ? <SkeletonRows /> : <DataTable rows={content} columns={cols} rowKey={(r) => r.id} searchable={(r) => r.title} initialSort={{ key: "views", dir: "desc" }} empty={<EmptyState title="No content yet" description={c.platform === "youtube" ? "Refresh to pull recent uploads." : "Log posts manually to analyze this competitor."} />} />}
      </Panel>
      <ConfirmDialog open={confirm} onOpenChange={setConfirm} title={`Stop tracking ${c.name}?`} description="Its stored content and analysis will be deleted." confirmLabel="Remove competitor" onConfirm={() => remove.mutate(undefined)} loading={remove.isPending} />
      <LogPostDialog open={logOpen} onOpenChange={setLogOpen} competitorId={c.id} />
    </div>
  );
}

function AddDialog({ open, onOpenChange, onAdded }: { open: boolean; onOpenChange: (o: boolean) => void; onAdded: (id: string) => void }) {
  const [platform, setPlatform] = React.useState("youtube");
  const [identifier, setIdentifier] = React.useState("");
  const add = useAction(() => api.post<{ id: string }>("/api/v1/competitors", { platform, identifier }), { invalidate: [["competitors"]], silentError: true, success: "Competitor added", onSuccess: (r) => { onAdded(r.id); onOpenChange(false); setIdentifier(""); } });
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Add competitor" footer={<><Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="primary" onClick={() => add.mutate(undefined)} loading={add.isPending} disabled={identifier.trim().length < 2}>Add competitor</Button></>}>
      <div className="space-y-4">
        <Field label="Platform" htmlFor="cp"><Select id="cp" value={platform} onChange={(e) => setPlatform(e.target.value)}><option value="youtube">YouTube (automatic)</option><option value="tiktok">TikTok (manual tracking)</option><option value="instagram">Instagram (manual tracking)</option></Select></Field>
        <Field label={platform === "youtube" ? "Channel handle, URL or ID" : "Profile handle or URL"} htmlFor="cid" hint={platform === "youtube" ? "e.g. @mkbhd or https://www.youtube.com/@mkbhd" : "TikTok and Instagram don't provide an official API for other creators' analytics, so you log their posts yourself."}>
          <Input id="cid" value={identifier} onChange={(e) => setIdentifier(e.target.value)} placeholder="@handle" />
        </Field>
        {add.error && <><NotConfigured error={add.error} title="Competitor lookup needs a YouTube Data API key" />{!(add.error as { notConfigured?: boolean }).notConfigured && <p role="alert" className="text-[13px] text-danger">{(add.error as Error).message}</p>}</>}
      </div>
    </Dialog>
  );
}

function LogPostDialog({ open, onOpenChange, competitorId }: { open: boolean; onOpenChange: (o: boolean) => void; competitorId: string }) {
  const [f, setF] = React.useState({ title: "", url: "", views: "", likes: "", publishedAt: "" });
  const log = useAction(() => api.post(`/api/v1/competitors/${competitorId}/content`, { title: f.title, url: f.url || undefined, views: f.views ? Number(f.views) : undefined, likes: f.likes ? Number(f.likes) : undefined, publishedAt: f.publishedAt ? new Date(f.publishedAt).toISOString() : undefined }), { invalidate: [["competitors"], ["competitor", competitorId]], success: "Post logged", onSuccess: () => { onOpenChange(false); setF({ title: "", url: "", views: "", likes: "", publishedAt: "" }); } });
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Log a competitor post" description="Saved as manual data and labeled that way everywhere." footer={<Button variant="primary" onClick={() => log.mutate(undefined)} loading={log.isPending} disabled={!f.title.trim()}>Log post</Button>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Title or caption" htmlFor="lt" className="sm:col-span-2"><Input id="lt" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
        <Field label="URL" htmlFor="lu" className="sm:col-span-2"><Input id="lu" type="url" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} /></Field>
        <Field label="Views" htmlFor="lv"><Input id="lv" type="number" min={0} value={f.views} onChange={(e) => setF({ ...f, views: e.target.value })} /></Field>
        <Field label="Likes" htmlFor="ll"><Input id="ll" type="number" min={0} value={f.likes} onChange={(e) => setF({ ...f, likes: e.target.value })} /></Field>
        <Field label="Published" htmlFor="lp" className="sm:col-span-2"><Input id="lp" type="date" value={f.publishedAt} onChange={(e) => setF({ ...f, publishedAt: e.target.value })} className="[color-scheme:dark]" /></Field>
      </div>
    </Dialog>
  );
}
