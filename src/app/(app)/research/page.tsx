"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Microscope, Lightbulb, Users, FileText, Bookmark, Trash2, FolderPlus, ChevronDown } from "lucide-react";
import { api } from "@/lib/client/api";
import { useAction, useApiQuery, useMe } from "@/lib/client/hooks";
import { Badge, Button, EmptyState, Field, Input, PageHeader, Panel, PanelHeader, Select, SignalMeter, SkeletonRows, SourceTag, TabPanel, Tabs, Textarea, ErrorState } from "@/components/ui/primitives";
import { NotConfigured } from "@/components/ui/domain";
import { cn, fmtRelative } from "@/lib/client/utils";

type Run = { id: string; kind: string; input: Record<string, unknown>; output: Record<string, unknown>; provider: string; model: string | null; createdAt: string };
type Idea = { id: string; title: string; angle: string | null; format: string | null; sourceType: string; score: number | null; scoreBreakdown: Record<string, { score: number; reason: string }> | null; confidence: string | null; scoreSource: string; status: string; projectId: string | null; createdAt: string };

const FACTOR_LABEL: Record<string, string> = {
  audienceDemand: "Audience demand", trendMomentum: "Trend momentum", competition: "Competition (lower is better)", creatorRelevance: "Creator relevance",
  productionDifficulty: "Production difficulty (lower is better)", potentialRetention: "Potential retention", contentOriginality: "Originality", monetizationPotential: "Monetization potential",
};

const formSchema = z.object({ niche: z.string().trim().min(2, "Describe your niche in a few words"), audience: z.string().max(300).optional(), count: z.coerce.number().int().min(1).max(15), focus: z.string().max(300).optional() });

export default function ResearchPage() {
  const params = useSearchParams();
  const router = useRouter();
  const [tab, setTab] = React.useState(params.get("tab") ?? "research");
  const { data: me } = useMe();
  const runs = useApiQuery<Run[]>(["research-runs"], "/api/v1/research");
  const ideas = useApiQuery<Idea[]>(["ideas"], "/api/v1/ideas");
  const form = useForm<z.input<typeof formSchema>, unknown, z.output<typeof formSchema>>({ resolver: zodResolver(formSchema), values: { niche: me?.niche ?? "", audience: "", count: 8, focus: "" } });
  const [activeRun, setActiveRun] = React.useState<string | null>(null);

  const run = useAction((body: Record<string, unknown>) => api.post<Run & { run?: Run; ideas?: Idea[] }>("/api/v1/research", body), {
    invalidate: [["research-runs"], ["ideas"]],
    silentError: true,
    onSuccess: (r, v) => {
      if (v.mode === "ideas") setTab("ideas");
      else setActiveRun((r as Run).id);
    },
    success: "Research complete",
  });
  const updateIdea = useAction(({ id, ...b }: { id: string; status: string }) => api.patch(`/api/v1/ideas/${id}`, b), { invalidate: [["ideas"]] });
  const deleteIdea = useAction((id: string) => api.del(`/api/v1/ideas/${id}`), { invalidate: [["ideas"]], success: "Idea deleted" });
  const toProject = useAction((id: string) => api.post<{ id: string }>(`/api/v1/ideas/${id}/project`), { invalidate: [["ideas"], ["projects"]], success: "Project created", onSuccess: (p) => router.push(`/studio?project=${p.id}`) });

  const submit = (mode: "niche" | "ideas" | "personas") => form.handleSubmit((v) => run.mutate({ mode, niche: v.niche, audience: v.audience || undefined, ...(mode === "ideas" ? { count: v.count, focus: v.focus || undefined } : {}) }))();

  const shown = runs.data?.find((r) => r.id === activeRun) ?? runs.data?.find((r) => r.kind === (tab === "personas" ? "personas" : tab === "briefs" ? "brief" : "niche_research"));

  return (
    <div>
      <PageHeader title="AI Content Research Lab" description="Research a niche, find audience pain points and gaps, and generate ideas scored across eight factors. Scores are AI estimates; trend momentum uses verified Trend Radar data when you have it." />
      <div className="grid gap-5 lg:grid-cols-[340px_1fr]">
        <Panel as="div" className="h-fit p-5">
          <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); submit(tab === "ideas" ? "ideas" : tab === "personas" ? "personas" : "niche"); }}>
            <Field label="Niche" htmlFor="niche" error={form.formState.errors.niche?.message}>
              <Input id="niche" placeholder="e.g. home espresso for beginners" {...form.register("niche")} />
            </Field>
            <Field label="Audience" htmlFor="audience" hint="Optional. Who are you making this for?">
              <Textarea id="audience" rows={2} placeholder="e.g. busy professionals who just bought their first machine" {...form.register("audience")} />
            </Field>
            {tab === "ideas" && (
              <>
                <Field label="Number of ideas" htmlFor="count">
                  <Select id="count" {...form.register("count")}>{[5, 8, 10, 15].map((n) => <option key={n} value={n}>{n}</option>)}</Select>
                </Field>
                <Field label="Focus" htmlFor="focus" hint="Optional, e.g. 'beginner mistakes' or 'Shorts only'.">
                  <Input id="focus" {...form.register("focus")} />
                </Field>
              </>
            )}
            <div className="grid gap-2">
              <Button type="button" variant={tab === "research" || tab === "briefs" ? "primary" : "secondary"} onClick={() => submit("niche")} loading={run.isPending && run.variables?.mode === "niche"}><Microscope /> Research niche</Button>
              <Button type="button" variant={tab === "ideas" ? "primary" : "secondary"} onClick={() => submit("ideas")} loading={run.isPending && run.variables?.mode === "ideas"}><Lightbulb /> Generate scored ideas</Button>
              <Button type="button" variant={tab === "personas" ? "primary" : "secondary"} onClick={() => submit("personas")} loading={run.isPending && run.variables?.mode === "personas"}><Users /> Build audience personas</Button>
            </div>
          </form>
          {run.error && <div className="-mx-5 -mb-5 mt-2"><NotConfigured error={run.error} title="Connect an AI provider to run research" />{!(run.error as { notConfigured?: boolean }).notConfigured && <ErrorState error={run.error} />}</div>}
        </Panel>

        <div className="min-w-0">
          <Tabs value={tab} onValueChange={(v) => { setTab(v); setActiveRun(null); }} items={[{ value: "research", label: "Niche research" }, { value: "ideas", label: `Ideas${ideas.data?.length ? ` (${ideas.data.length})` : ""}` }, { value: "personas", label: "Personas" }, { value: "briefs", label: "Briefs" }, { value: "history", label: "History" }]}>
            <TabPanel value="research">{run.isPending ? <Panel><SkeletonRows rows={8} /></Panel> : shown?.kind === "niche_research" ? <NicheResult run={shown} /> : <Panel><EmptyState icon={Microscope} title="Research a niche" description="Get pain points, questions people ask, search intent, content gaps, viral formats, clusters and series ideas." /></Panel>}</TabPanel>
            <TabPanel value="ideas">
              <IdeasList ideas={ideas.data} loading={ideas.isLoading} onStatus={(id, status) => updateIdea.mutate({ id, status })} onDelete={(id) => deleteIdea.mutate(id)} onProject={(id) => toProject.mutate(id)} onBrief={(id) => run.mutate({ mode: "brief", ideaId: id }, { onSuccess: () => setTab("briefs") })} briefing={run.isPending && run.variables?.mode === "brief" ? (run.variables.ideaId as string) : null} />
            </TabPanel>
            <TabPanel value="personas">{shown?.kind === "personas" ? <Personas run={shown} /> : <Panel><EmptyState icon={Users} title="No personas yet" description="Build three audience archetypes with goals, frustrations and objections." /></Panel>}</TabPanel>
            <TabPanel value="briefs">{shown?.kind === "brief" ? <Brief run={shown} /> : <Panel><EmptyState icon={FileText} title="No briefs yet" description="Open the Ideas tab and choose “Create brief” on any idea." /></Panel>}</TabPanel>
            <TabPanel value="history">
              <Panel>
                {runs.isLoading ? <SkeletonRows /> : runs.data?.length ? (
                  <ul className="divide-y divide-line-soft">
                    {runs.data.map((r) => (
                      <li key={r.id}>
                        <button onClick={() => { setActiveRun(r.id); setTab(r.kind === "personas" ? "personas" : r.kind === "brief" ? "briefs" : r.kind === "idea_generation" ? "ideas" : "research"); }} className="flex w-full items-center gap-3 px-5 py-3 text-left hover:bg-raised/40">
                          <Badge tone="violet">{r.kind.replace(/_/g, " ")}</Badge>
                          <span className="flex-1 truncate text-[13.5px]">{String(r.input.niche ?? r.input.title ?? "")}</span>
                          <span className="text-xs text-faint">{fmtRelative(r.createdAt)}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : <EmptyState title="No research yet" />}
              </Panel>
            </TabPanel>
          </Tabs>
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-t border-line-soft px-5 py-4">
      <h3 className="mb-2 text-[13.5px] font-semibold">{title}</h3>
      {children}
    </div>
  );
}

function NicheResult({ run }: { run: Run }) {
  const o = run.output as { summary: string; painPoints: { pain: string; detail: string }[]; questions: string[]; searchIntent: { intent: string; share: string; notes: string }[]; contentGaps: string[]; viralFormats: { format: string; whyItWorks: string }[]; angles: string[]; clusters: { pillar: string; subtopics: string[] }[]; series: { name: string; episodes: string[] }[] };
  return (
    <Panel>
      <PanelHeader title={String(run.input.niche)} description={`Generated ${fmtRelative(run.createdAt)} by ${run.model}`} actions={<SourceTag source="ai_estimate" at={run.createdAt} />} />
      <p className="px-5 pb-4 text-[14px] leading-relaxed text-fg/90">{o.summary}</p>
      <div className="grid md:grid-cols-2 [&>*:nth-child(even)]:md:border-l [&>*]:border-line-soft">
        <Section title="Audience pain points"><ul className="space-y-2 text-[13px]">{o.painPoints.map((p) => <li key={p.pain}><span className="font-medium">{p.pain}.</span> <span className="text-muted">{p.detail}</span></li>)}</ul></Section>
        <Section title="Questions people ask"><ul className="list-disc space-y-1 pl-4 text-[13px] text-muted">{o.questions.map((q) => <li key={q}>{q}</li>)}</ul></Section>
        <Section title="Search intent"><ul className="space-y-1.5 text-[13px]">{o.searchIntent.map((s) => <li key={s.intent} className="flex gap-2"><Badge tone={s.share === "dominant" ? "violet" : "neutral"}>{s.share}</Badge><span><span className="font-medium">{s.intent}</span> <span className="text-muted">{s.notes}</span></span></li>)}</ul></Section>
        <Section title="Content gaps"><ul className="list-disc space-y-1 pl-4 text-[13px] text-muted">{o.contentGaps.map((g) => <li key={g}>{g}</li>)}</ul></Section>
        <Section title="Viral formats"><ul className="space-y-2 text-[13px]">{o.viralFormats.map((f) => <li key={f.format}><span className="font-medium">{f.format}</span> <span className="text-muted">{f.whyItWorks}</span></li>)}</ul></Section>
        <Section title="Content angles"><ul className="list-disc space-y-1 pl-4 text-[13px] text-muted">{o.angles.map((a) => <li key={a}>{a}</li>)}</ul></Section>
        <Section title="Content clusters"><div className="space-y-2">{o.clusters.map((c) => <div key={c.pillar}><p className="text-[13px] font-medium">{c.pillar}</p><div className="mt-1 flex flex-wrap gap-1">{c.subtopics.map((s) => <Badge key={s}>{s}</Badge>)}</div></div>)}</div></Section>
        <Section title="Series ideas"><div className="space-y-2">{o.series.map((s) => <div key={s.name}><p className="text-[13px] font-medium">{s.name}</p><ol className="mt-1 list-decimal pl-4 text-[13px] text-muted">{s.episodes.map((e) => <li key={e}>{e}</li>)}</ol></div>)}</div></Section>
      </div>
    </Panel>
  );
}

function IdeasList({ ideas, loading, onStatus, onDelete, onProject, onBrief, briefing }: { ideas?: Idea[]; loading: boolean; onStatus: (id: string, s: string) => void; onDelete: (id: string) => void; onProject: (id: string) => void; onBrief: (id: string) => void; briefing: string | null }) {
  const [filter, setFilter] = React.useState("active");
  const [open, setOpen] = React.useState<string | null>(null);
  const rows = (ideas ?? []).filter((i) => (filter === "active" ? i.status !== "dismissed" : i.status === filter)).sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  if (loading) return <Panel><SkeletonRows /></Panel>;
  return (
    <Panel>
      <PanelHeader title="Scored ideas" description="Sorted by opportunity score. Open an idea to see each factor and its reasoning." actions={<Select value={filter} onChange={(e) => setFilter(e.target.value)} className="w-36" aria-label="Filter ideas"><option value="active">Active</option><option value="saved">Saved</option><option value="in_production">In production</option><option value="dismissed">Dismissed</option></Select>} />
      {!rows.length ? <EmptyState icon={Lightbulb} title="No ideas here" description="Generate scored ideas from the panel on the left, or turn a trend into ideas in Trend Radar." /> : (
        <ul className="divide-y divide-line-soft border-t border-line-soft">
          {rows.map((i) => (
            <li key={i.id}>
              <div className="grid gap-3 px-5 py-3.5 md:grid-cols-[1fr_160px_auto] md:items-center">
                <button className="min-w-0 text-left" onClick={() => setOpen(open === i.id ? null : i.id)} aria-expanded={open === i.id}>
                  <p className="flex items-center gap-2 text-[14px] font-medium">{i.title}<ChevronDown className={cn("size-3.5 shrink-0 text-faint transition-transform", open === i.id && "rotate-180")} /></p>
                  <p className="mt-0.5 line-clamp-2 text-[13px] text-muted">{i.angle}</p>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">{i.format && <Badge>{i.format}</Badge>}<Badge tone="neutral">{i.sourceType}</Badge>{i.status !== "new" && <Badge tone="cyan">{i.status.replace("_", " ")}</Badge>}</div>
                </button>
                <SignalMeter value={i.score} label="Opportunity" />
                <div className="flex gap-1">
                  <Button size="icon" variant="ghost" aria-label="Save idea" onClick={() => onStatus(i.id, i.status === "saved" ? "new" : "saved")}><Bookmark className={i.status === "saved" ? "fill-current text-violet-soft" : ""} /></Button>
                  <Button size="sm" variant="ghost" onClick={() => onBrief(i.id)} loading={briefing === i.id}><FileText /> Create brief</Button>
                  <Button size="sm" variant="ghost" onClick={() => onProject(i.id)} disabled={!!i.projectId}><FolderPlus /> {i.projectId ? "In studio" : "To studio"}</Button>
                  <Button size="icon" variant="ghost" aria-label="Delete idea" onClick={() => onDelete(i.id)}><Trash2 /></Button>
                </div>
              </div>
              {open === i.id && i.scoreBreakdown && (
                <div className="border-t border-line-soft bg-ink-2/60 px-5 py-4">
                  <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-muted"><SourceTag source={i.scoreSource} /> Confidence: {i.confidence}</div>
                  <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
                    {Object.entries(i.scoreBreakdown).map(([k, f]) => (
                      <div key={k}>
                        <SignalMeter value={f.score} label={FACTOR_LABEL[k] ?? k} size="sm" />
                        <p className="mt-1 text-xs text-muted">{f.reason}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function Personas({ run }: { run: Run }) {
  const o = run.output as { personas: { name: string; summary: string; goals: string[]; frustrations: string[]; platforms: string[]; contentPreferences: string[]; objections: string[] }[] };
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {o.personas.map((p) => (
        <Panel key={p.name} className="p-5">
          <div className="mb-1 flex items-center justify-between"><h3 className="text-[15px] font-semibold">{p.name}</h3><SourceTag source="ai_estimate" /></div>
          <p className="text-[13px] text-muted">{p.summary}</p>
          {[["Goals", p.goals], ["Frustrations", p.frustrations], ["Content they like", p.contentPreferences], ["Objections", p.objections]].map(([t, list]) => (
            <div key={t as string} className="mt-3"><p className="text-[12.5px] font-medium">{t as string}</p><ul className="mt-1 list-disc pl-4 text-[13px] text-muted">{(list as string[]).map((x) => <li key={x}>{x}</li>)}</ul></div>
          ))}
          <div className="mt-3 flex flex-wrap gap-1">{p.platforms.map((x) => <Badge key={x}>{x}</Badge>)}</div>
        </Panel>
      ))}
    </div>
  );
}

function Brief({ run }: { run: Run }) {
  const b = run.output as { workingTitle: string; objective: string; targetAudience: string; keyMessage: string; hookOptions: string[]; outline: { section: string; points: string[] }[]; cta: string; successMetrics: string[]; productionNotes: string[] };
  const copy = () => navigator.clipboard.writeText(JSON.stringify(b, null, 2));
  return (
    <Panel>
      <PanelHeader title={b.workingTitle} description={`Brief for “${String(run.input.title)}”`} actions={<><SourceTag source="ai_estimate" /><Button size="sm" onClick={copy}>Copy</Button></>} />
      <dl className="grid gap-4 border-t border-line-soft px-5 py-4 text-[13.5px] md:grid-cols-3">
        <div><dt className="text-xs text-muted">Objective</dt><dd className="mt-0.5">{b.objective}</dd></div>
        <div><dt className="text-xs text-muted">Audience</dt><dd className="mt-0.5">{b.targetAudience}</dd></div>
        <div><dt className="text-xs text-muted">Key message</dt><dd className="mt-0.5">{b.keyMessage}</dd></div>
      </dl>
      <Section title="Hook options"><ol className="list-decimal space-y-1 pl-4 text-[13px] text-muted">{b.hookOptions.map((h) => <li key={h}>{h}</li>)}</ol></Section>
      <Section title="Outline">{b.outline.map((s) => <div key={s.section} className="mb-2"><p className="text-[13px] font-medium">{s.section}</p><ul className="list-disc pl-4 text-[13px] text-muted">{s.points.map((p) => <li key={p}>{p}</li>)}</ul></div>)}</Section>
      <Section title="Call to action"><p className="text-[13px] text-muted">{b.cta}</p></Section>
      <div className="grid md:grid-cols-2"><Section title="Success metrics"><ul className="list-disc pl-4 text-[13px] text-muted">{b.successMetrics.map((m) => <li key={m}>{m}</li>)}</ul></Section><Section title="Production notes"><ul className="list-disc pl-4 text-[13px] text-muted">{b.productionNotes.map((m) => <li key={m}>{m}</li>)}</ul></Section></div>
    </Panel>
  );
}
