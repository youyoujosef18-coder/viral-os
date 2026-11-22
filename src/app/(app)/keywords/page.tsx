"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { KeyRound, Search, Download, Gauge, Trash2, ListPlus, Lightbulb } from "lucide-react";
import { api } from "@/lib/client/api";
import { useAction, useApiQuery } from "@/lib/client/hooks";
import { Badge, Button, Dialog, EmptyState, ErrorState, Field, HelpTip, Input, PageHeader, Panel, PanelHeader, Select, SignalMeter, SkeletonRows, SourceTag, Tooltip } from "@/components/ui/primitives";
import { NotConfigured } from "@/components/ui/domain";
import { DataTable, type Column } from "@/components/ui/data-table";
import { fmtNum, fmtRelative } from "@/lib/client/utils";

type Keyword = { id: string; keyword: string; seed: string | null; intent: string | null; cluster: string | null; isQuestion: boolean; searchVolume: number | null; volumeSource: string | null; difficulty: number | null; difficultySource: string | null; opportunity: number | null; competitionData: Record<string, unknown> | null; retrievedAt: string | null; listId: string | null; createdAt: string };
type KwList = { id: string; name: string };
type DiscoverResult = { keywords: Keyword[]; titleSuggestions: string[]; contentGaps: string[]; model: string };

export default function KeywordsPage() {
  const router = useRouter();
  const [seed, setSeed] = React.useState("");
  const [platform, setPlatform] = React.useState("YouTube");
  const [language, setLanguage] = React.useState("English");
  const [listFilter, setListFilter] = React.useState("");
  const [view, setView] = React.useState<"table" | "clusters">("table");
  const [last, setLast] = React.useState<DiscoverResult | null>(null);
  const [detail, setDetail] = React.useState<Keyword | null>(null);
  const [newList, setNewList] = React.useState(false);
  const [listName, setListName] = React.useState("");

  const keywords = useApiQuery<Keyword[]>(["keywords", listFilter], `/api/v1/keywords${listFilter ? `?listId=${listFilter}` : ""}`);
  const lists = useApiQuery<KwList[]>(["keyword-lists"], "/api/v1/keyword-lists");
  const discover = useAction(() => api.post<DiscoverResult>("/api/v1/keywords/discover", { seed, platform, language, listId: listFilter || null }), { invalidate: [["keywords"]], silentError: true, onSuccess: setLast, success: (r) => `Found ${r.keywords.length} keywords` });
  const analyze = useAction((id: string) => api.post<Keyword>(`/api/v1/keywords/${id}/analyze`), { invalidate: [["keywords"]], silentError: true, onSuccess: (k) => setDetail(k), success: "Competition measured from YouTube results" });
  const remove = useAction((id: string) => api.del(`/api/v1/keywords/${id}`), { invalidate: [["keywords"]] });
  const assign = useAction(({ id, listId }: { id: string; listId: string | null }) => api.patch(`/api/v1/keywords/${id}`, { listId }), { invalidate: [["keywords"]], success: "Keyword list updated" });
  const createList = useAction(() => api.post<KwList>("/api/v1/keyword-lists", { name: listName }), { invalidate: [["keyword-lists"]], success: "List created", onSuccess: (l) => { setNewList(false); setListName(""); setListFilter(l.id); } });
  const toIdea = useAction((k: Keyword) => api.post("/api/v1/ideas", { title: k.keyword, angle: `Content targeting the ${k.intent ?? ""} search "${k.keyword}"${k.cluster ? ` (cluster: ${k.cluster})` : ""}.`, format: platform === "YouTube" ? "Long-form YouTube video" : "Short-form video" }), { invalidate: [["ideas"]], success: "Saved as an idea", onSuccess: () => router.push("/research?tab=ideas") });

  const rows = keywords.data ?? [];
  const columns: Column<Keyword>[] = [
    { key: "keyword", header: "Keyword", cell: (k) => <div><p className="font-medium">{k.keyword}</p><p className="text-xs text-faint">{k.cluster}</p></div>, sortValue: (k) => k.keyword },
    { key: "intent", header: "Intent", cell: (k) => <Badge tone={k.intent === "commercial" || k.intent === "transactional" ? "warning" : "neutral"}>{k.intent}</Badge>, sortValue: (k) => k.intent },
    { key: "q", header: "Question", cell: (k) => (k.isQuestion ? <Badge tone="cyan">Question</Badge> : null), sortValue: (k) => (k.isQuestion ? 1 : 0) },
    { key: "volume", header: <span className="inline-flex items-center gap-1">Volume <HelpTip text="Shown only when a licensed search-volume provider supplies it. None is configured, so volume is not estimated." /></span>, cell: (k) => (k.searchVolume === null ? <span className="text-xs text-faint">Not available</span> : fmtNum(k.searchVolume)), sortValue: (k) => k.searchVolume, align: "right" },
    { key: "difficulty", header: "Difficulty", cell: (k) => <div className="flex w-36 items-center gap-2"><div className="flex-1"><SignalMeter value={k.difficulty} size="sm" label="" /></div>{k.difficultySource && <SourceTag source={k.difficultySource} at={k.retrievedAt} />}</div>, sortValue: (k) => k.difficulty },
    { key: "opportunity", header: <span className="inline-flex items-center gap-1">Opportunity <HelpTip text="Computed from top YouTube results: demand (median views) with weak title optimization or older results scores higher. Measure competition to calculate it." /></span>, cell: (k) => (k.opportunity === null ? <span className="text-xs text-faint">Not measured</span> : <div className="w-24"><SignalMeter value={k.opportunity} size="sm" label="" /></div>), sortValue: (k) => k.opportunity },
    {
      key: "actions", header: "",
      cell: (k) => (
        <div className="flex justify-end gap-1">
          <Tooltip content="Measure competition from the top 20 YouTube results (uses 1 of the project's 100 daily YouTube searches; cached 24h)"><Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); analyze.mutate(k.id); }} loading={analyze.isPending && analyze.variables === k.id}><Gauge /> Measure</Button></Tooltip>
          <Tooltip content="Save as content idea"><Button size="icon" variant="ghost" aria-label="Save as idea" onClick={(e) => { e.stopPropagation(); toIdea.mutate(k); }}><Lightbulb /></Button></Tooltip>
          <Button size="icon" variant="ghost" aria-label="Delete keyword" onClick={(e) => { e.stopPropagation(); remove.mutate(k.id); }}><Trash2 /></Button>
        </div>
      ),
    },
  ];
  const clusters = Object.entries(rows.reduce<Record<string, Keyword[]>>((acc, k) => ((acc[k.cluster ?? "Other"] ??= []).push(k), acc), {}));

  return (
    <div>
      <PageHeader title="Keyword and SEO Explorer" description="Expand a topic into keywords, clusters and questions, then measure real competition from YouTube results. Search volume is never invented." />
      <Panel className="mb-5 p-5">
        <form className="grid gap-3 md:grid-cols-[1fr_150px_150px_auto] md:items-end" onSubmit={(e) => { e.preventDefault(); if (seed.trim().length >= 2) discover.mutate(undefined); }}>
          <Field label="Seed topic" htmlFor="seed"><Input id="seed" value={seed} onChange={(e) => setSeed(e.target.value)} placeholder="e.g. budget travel Japan" /></Field>
          <Field label="Platform" htmlFor="kplat"><Select id="kplat" value={platform} onChange={(e) => setPlatform(e.target.value)}><option>YouTube</option><option>TikTok</option><option>Instagram</option></Select></Field>
          <Field label="Language" htmlFor="klang"><Select id="klang" value={language} onChange={(e) => setLanguage(e.target.value)}>{["English", "French", "Arabic", "Spanish", "German", "Portuguese"].map((l) => <option key={l}>{l}</option>)}</Select></Field>
          <Button type="submit" variant="primary" loading={discover.isPending} disabled={seed.trim().length < 2}><Search /> Discover keywords</Button>
        </form>
        {discover.error && <div className="-mx-5 -mb-5"><NotConfigured error={discover.error} title="Keyword discovery needs an AI provider" />{!(discover.error as { notConfigured?: boolean }).notConfigured && <ErrorState error={discover.error} />}</div>}
        {analyze.error && <div className="-mx-5 -mb-5"><NotConfigured error={analyze.error} title="Measuring competition needs a YouTube Data API key" />{!(analyze.error as { notConfigured?: boolean }).notConfigured && <ErrorState error={analyze.error} />}</div>}
      </Panel>

      {last && (
        <div className="mb-5 grid gap-4 md:grid-cols-2">
          <Panel className="p-5"><h3 className="mb-2 flex items-center gap-2 text-[14px] font-semibold">YouTube title suggestions <SourceTag source="ai_estimate" /></h3><ul className="list-disc space-y-1 pl-4 text-[13px] text-muted">{last.titleSuggestions.map((t) => <li key={t}>{t}</li>)}</ul></Panel>
          <Panel className="p-5"><h3 className="mb-2 flex items-center gap-2 text-[14px] font-semibold">Content gaps <SourceTag source="ai_estimate" /></h3><ul className="list-disc space-y-1 pl-4 text-[13px] text-muted">{last.contentGaps.map((t) => <li key={t}>{t}</li>)}</ul></Panel>
        </div>
      )}

      <Panel>
        <PanelHeader
          title="Saved keyword research"
          description="Every discovery is saved here with its source and retrieval date."
          actions={
            <>
              <Select value={listFilter} onChange={(e) => setListFilter(e.target.value)} className="w-44" aria-label="Keyword list"><option value="">All keywords</option>{lists.data?.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select>
              <Button size="sm" variant="ghost" onClick={() => setNewList(true)}><ListPlus /> New list</Button>
              <div className="flex rounded-md border border-line p-0.5" role="group" aria-label="View">{(["table", "clusters"] as const).map((v) => <button key={v} onClick={() => setView(v)} aria-pressed={view === v} className={`rounded-sm px-2.5 py-1 text-xs ${view === v ? "bg-raised text-fg" : "text-muted"}`}>{v === "table" ? "Table" : "Clusters"}</button>)}</div>
              <a href={`/api/v1/keywords/export${listFilter ? `?listId=${listFilter}` : ""}`} download><Button size="sm" disabled={!rows.length}><Download /> Export CSV</Button></a>
            </>
          }
        />
        {keywords.isLoading ? <SkeletonRows /> : view === "table" ? (
          <DataTable rows={rows} columns={columns} rowKey={(k) => k.id} searchable={(k) => `${k.keyword} ${k.cluster} ${k.intent}`} searchPlaceholder="Filter keywords" onRowClick={setDetail} dense empty={<EmptyState icon={KeyRound} title="No keywords yet" description="Enter a seed topic above to discover keywords, long-tail variations and questions." />} />
        ) : (
          <div className="grid gap-3 border-t border-line-soft p-5 md:grid-cols-2 xl:grid-cols-3">
            {clusters.map(([name, ks]) => (
              <div key={name} className="rounded-md border border-line-soft bg-ink-2 p-4">
                <p className="mb-2 text-[13.5px] font-semibold">{name} <span className="font-normal text-faint">({ks.length})</span></p>
                <div className="flex flex-wrap gap-1">{ks.map((k) => <button key={k.id} onClick={() => setDetail(k)}><Badge tone={k.isQuestion ? "cyan" : "neutral"}>{k.keyword}</Badge></button>)}</div>
              </div>
            ))}
            {!clusters.length && <p className="text-[13px] text-muted">No keywords yet.</p>}
          </div>
        )}
      </Panel>

      <Dialog open={!!detail} onOpenChange={(o) => !o && setDetail(null)} title={detail?.keyword ?? ""} description={detail?.retrievedAt ? `Retrieved ${fmtRelative(detail.retrievedAt)}` : undefined} wide>
        {detail && <KeywordDetail k={detail} lists={lists.data ?? []} onAssign={(listId) => assign.mutate({ id: detail.id, listId })} onMeasure={() => analyze.mutate(detail.id)} measuring={analyze.isPending} />}
      </Dialog>
      <Dialog open={newList} onOpenChange={setNewList} title="New keyword list" footer={<Button variant="primary" onClick={() => listName.trim() && createList.mutate(undefined)} loading={createList.isPending} disabled={!listName.trim()}>Create list</Button>}>
        <Field label="List name" htmlFor="ln"><Input id="ln" value={listName} onChange={(e) => setListName(e.target.value)} placeholder="e.g. Q1 video topics" /></Field>
      </Dialog>
    </div>
  );
}

function KeywordDetail({ k, lists, onAssign, onMeasure, measuring }: { k: Keyword; lists: KwList[]; onAssign: (id: string | null) => void; onMeasure: () => void; measuring: boolean }) {
  const c = (k.competitionData ?? {}) as { rationale?: string; medianViews?: number; avgAgeDays?: number; titleMatchRatio?: number; sampleSize?: number; source?: string; topResults?: { id: string; title: string; channel: string; views: number }[] };
  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <div><SignalMeter value={k.difficulty} label="Difficulty" size="lg" /><div className="mt-2">{k.difficultySource && <SourceTag source={k.difficultySource} at={k.retrievedAt} />}</div></div>
        <div><SignalMeter value={k.opportunity} label="Opportunity" size="lg" /><p className="mt-2 text-xs text-muted">{k.opportunity === null ? "Measure competition to compute it." : "Computed from YouTube results."}</p></div>
      </div>
      {c.rationale && <p className="text-[13px] text-muted"><span className="text-fg">AI rationale:</span> {c.rationale}</p>}
      {c.sampleSize ? (
        <div className="rounded-md border border-line-soft bg-ink-2 p-4 text-[13px]">
          <p className="mb-2 text-xs text-muted">{c.source}</p>
          <dl className="grid grid-cols-3 gap-3"><div><dt className="text-xs text-muted">Median views</dt><dd className="font-semibold tabular-nums">{fmtNum(c.medianViews)}</dd></div><div><dt className="text-xs text-muted">Avg. age</dt><dd className="font-semibold tabular-nums">{c.avgAgeDays} days</dd></div><div><dt className="text-xs text-muted">Titles containing keyword</dt><dd className="font-semibold tabular-nums">{Math.round((c.titleMatchRatio ?? 0) * 100)}%</dd></div></dl>
          {c.topResults && <ul className="mt-3 space-y-1">{c.topResults.map((r) => <li key={r.id} className="flex justify-between gap-3"><a className="truncate hover:text-violet-soft" href={`https://www.youtube.com/watch?v=${r.id}`} target="_blank" rel="noreferrer">{r.title}</a><span className="shrink-0 text-xs tabular-nums text-muted">{fmtNum(r.views)}</span></li>)}</ul>}
        </div>
      ) : <Button onClick={onMeasure} loading={measuring}><Gauge /> Measure competition on YouTube</Button>}
      <Field label="Keyword list" htmlFor="kl"><Select id="kl" value={k.listId ?? ""} onChange={(e) => onAssign(e.target.value || null)}><option value="">No list</option>{lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select></Field>
    </div>
  );
}
