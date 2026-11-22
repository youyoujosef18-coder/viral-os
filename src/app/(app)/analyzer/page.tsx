"use client";

import * as React from "react";
import { ScanSearch, Trash2, Film, Clock, Scissors } from "lucide-react";
import { api } from "@/lib/client/api";
import { useAction, useApiQuery } from "@/lib/client/hooks";
import { Badge, Button, EmptyState, ErrorState, Field, Input, PageHeader, Panel, PanelHeader, Select, SignalMeter, SkeletonRows, SourceTag, Textarea } from "@/components/ui/primitives";
import { NotConfigured } from "@/components/ui/domain";
import { MediaPicker } from "@/components/ui/media-picker";
import { cn, fmtRelative } from "@/lib/client/utils";

type ScoreBlock = { score: number; rationale: string };
type Result = { overall: ScoreBlock; hook: ScoreBlock; clarity: ScoreBlock; retention: ScoreBlock; originality: ScoreBlock; platformFit: ScoreBlock; cta: ScoreBlock; pacing: string; storytelling: string; titleFeedback: string; descriptionFeedback: string; hashtagFeedback: string; audienceFit: string; recommendations: { priority: number; title: string; detail: string; impact: string }[]; editingChanges: string[]; alternativeHooks: string[]; titleVariants: string[]; confidence: string; confidenceExplanation: string; model: string; label: string };
type Technical = { available: true; durationSeconds: number; width: number; height: number; orientation: string; fps: number | null; hasAudio: boolean; sceneChanges: number; cutsPerMinute: number; averageShotSeconds: number; longestShotSeconds: number; firstCutSeconds: number | null; bitrateKbps: number | null } | { available: false; reason: string };
type Analysis = { id: string; platform: string; input: { title?: string }; technical: Technical | null; result: Result; overallScore: number; confidence: string; createdAt: string };

export default function AnalyzerPage() {
  const list = useApiQuery<Analysis[]>(["analyses"], "/api/v1/analyses");
  const [selected, setSelected] = React.useState<string | null>(null);
  const [f, setF] = React.useState({ assetId: null as string | null, platform: "TikTok", title: "", description: "", hashtags: "", transcript: "", audience: "" });
  const run = useAction(() => api.post<Analysis>("/api/v1/analyses", f), { invalidate: [["analyses"]], silentError: true, success: "Analysis complete", onSuccess: (a) => setSelected(a.id) });
  const remove = useAction((id: string) => api.del(`/api/v1/analyses/${id}`), { invalidate: [["analyses"]], onSuccess: () => setSelected(null) });
  const current = list.data?.find((a) => a.id === selected) ?? (selected ? undefined : list.data?.[0]);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });

  return (
    <div>
      <PageHeader title="Video Performance and Optimization Analyzer" description="Get a pre-publish assessment of your hook, clarity, pacing and platform fit. Technical pacing is measured from the file; scores are AI assessments of predicted quality, never actual performance." />
      <div className="grid gap-5 xl:grid-cols-[380px_1fr]">
        <Panel as="div" className="h-fit space-y-4 p-5">
          <Field label="Video file" hint="Optional. Enables measured duration, orientation and cut pacing."><MediaPicker value={f.assetId} onChange={(id) => setF({ ...f, assetId: id })} kind="video" label="Choose video" /></Field>
          <Field label="Platform" htmlFor="a-plat"><Select id="a-plat" value={f.platform} onChange={set("platform")}>{["YouTube", "YouTube Shorts", "TikTok", "Instagram Reels"].map((p) => <option key={p}>{p}</option>)}</Select></Field>
          <Field label="Title" htmlFor="a-title"><Input id="a-title" value={f.title} onChange={set("title")} /></Field>
          <Field label="Description or caption" htmlFor="a-desc"><Textarea id="a-desc" rows={2} value={f.description} onChange={set("description")} /></Field>
          <Field label="Hashtags" htmlFor="a-tags"><Input id="a-tags" value={f.hashtags} onChange={set("hashtags")} placeholder="#coffee #espresso" /></Field>
          <Field label="Transcript" htmlFor="a-tr" hint="Paste what's said in the video. Without it, confidence is lower."><Textarea id="a-tr" rows={5} value={f.transcript} onChange={set("transcript")} /></Field>
          <Field label="Target audience" htmlFor="a-aud"><Input id="a-aud" value={f.audience} onChange={set("audience")} /></Field>
          <Button variant="primary" className="w-full" onClick={() => run.mutate(undefined)} loading={run.isPending} disabled={!f.assetId && !f.transcript.trim() && !f.title.trim()}><ScanSearch /> Analyze video</Button>
          {run.isPending && f.assetId && <p className="text-xs text-muted">Measuring scene changes with ffmpeg, then scoring. Large files take longer.</p>}
          {run.error && <div className="-mx-5 -mb-5"><NotConfigured error={run.error} title="The analyzer needs an AI provider" />{!(run.error as { notConfigured?: boolean }).notConfigured && <ErrorState error={run.error} />}</div>}
        </Panel>

        <div className="min-w-0 space-y-4">
          {list.isLoading ? <Panel><SkeletonRows /></Panel> : !current ? <Panel><EmptyState icon={Film} title="No analyses yet" description="Add a video, transcript or title on the left to get a scored, ranked list of improvements." /></Panel> : <AnalysisView a={current} onDelete={() => remove.mutate(current.id)} />}
          {!!list.data?.length && (
            <Panel>
              <PanelHeader title="Previous analyses" />
              <ul className="divide-y divide-line-soft border-t border-line-soft">
                {list.data.map((a) => (
                  <li key={a.id}><button onClick={() => setSelected(a.id)} className={cn("flex w-full items-center gap-3 px-5 py-2.5 text-left hover:bg-raised/40", current?.id === a.id && "bg-raised/50")}><span className="w-8 text-right font-semibold tabular-nums">{a.overallScore}</span><span className="flex-1 truncate text-[13.5px]">{a.input.title || "Untitled analysis"}</span><Badge>{a.platform}</Badge><span className="text-xs text-faint">{fmtRelative(a.createdAt)}</span></button></li>
                ))}
              </ul>
            </Panel>
          )}
        </div>
      </div>
    </div>
  );
}

function AnalysisView({ a, onDelete }: { a: Analysis; onDelete: () => void }) {
  const r = a.result;
  const t = a.technical;
  const scores: [string, ScoreBlock][] = [["Hook", r.hook], ["Clarity", r.clarity], ["Retention potential", r.retention], ["Originality", r.originality], ["Platform fit", r.platformFit], ["Call to action", r.cta]];
  return (
    <>
      <Panel>
        <PanelHeader title={a.input.title || "Analysis"} description={`${r.label}. Generated ${fmtRelative(a.createdAt)} by ${r.model}.`} actions={<><SourceTag source="ai_estimate" at={a.createdAt} /><Button size="icon" variant="ghost" aria-label="Delete analysis" onClick={onDelete}><Trash2 /></Button></>} />
        <div className="grid gap-6 border-t border-line-soft p-5 md:grid-cols-[220px_1fr]">
          <div>
            <SignalMeter value={r.overall.score} label="Overall (AI assessment)" size="lg" />
            <p className="mt-2 text-[13px] text-muted">{r.overall.rationale}</p>
            <p className="mt-3 text-xs"><Badge tone={r.confidence === "high" ? "success" : r.confidence === "medium" ? "warning" : "danger"}>{r.confidence} confidence</Badge></p>
            <p className="mt-1 text-xs text-faint">{r.confidenceExplanation}</p>
          </div>
          <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
            {scores.map(([l, s]) => <div key={l}><SignalMeter value={s.score} label={l} /><p className="mt-1 text-xs text-muted">{s.rationale}</p></div>)}
          </div>
        </div>
      </Panel>

      {t && (
        <Panel>
          <PanelHeader title="Measured technical data" description={t.available ? "Measured from the file with ffprobe and ffmpeg scene detection" : t.reason} actions={t.available ? <SourceTag source="computed" /> : undefined} />
          {t.available && (
            <dl className="grid grid-cols-2 gap-px border-t border-line-soft bg-line-soft text-[13px] sm:grid-cols-4">
              {[[Clock, "Duration", `${t.durationSeconds}s`], [Film, "Format", `${t.width}×${t.height} ${t.orientation}`], [Scissors, "Scene changes", `${t.sceneChanges} (${t.cutsPerMinute}/min)`], [Scissors, "First cut at", t.firstCutSeconds === null ? "No cuts" : `${t.firstCutSeconds}s`], [Clock, "Average shot", `${t.averageShotSeconds}s`], [Clock, "Longest shot", `${t.longestShotSeconds}s`], [Film, "Frame rate", t.fps ? `${t.fps} fps` : "—"], [Film, "Audio track", t.hasAudio ? "Yes" : "None found"]].map(([Icon, l, v]) => {
                const I = Icon as typeof Clock;
                return <div key={l as string} className="bg-panel px-4 py-3"><dt className="flex items-center gap-1.5 text-xs text-muted"><I className="size-3.5" />{l as string}</dt><dd className="mt-0.5 font-medium tabular-nums">{v as string}</dd></div>;
              })}
            </dl>
          )}
        </Panel>
      )}

      <Panel>
        <PanelHeader title="Ranked recommendations" />
        <ol className="divide-y divide-line-soft border-t border-line-soft">
          {r.recommendations.map((rec, i) => (
            <li key={i} className="flex gap-4 px-5 py-3">
              <span className="w-5 shrink-0 pt-0.5 text-right text-[13px] font-semibold tabular-nums text-faint">{i + 1}</span>
              <div className="min-w-0 flex-1"><p className="text-[14px] font-medium">{rec.title}</p><p className="mt-0.5 text-[13px] text-muted">{rec.detail}</p></div>
              <Badge tone={rec.impact === "high" ? "violet" : rec.impact === "medium" ? "cyan" : "neutral"}>{rec.impact} impact</Badge>
            </li>
          ))}
        </ol>
      </Panel>

      <div className="grid gap-4 md:grid-cols-2">
        {[["Pacing", r.pacing], ["Storytelling", r.storytelling], ["Title", r.titleFeedback], ["Description", r.descriptionFeedback], ["Hashtags", r.hashtagFeedback], ["Audience fit", r.audienceFit]].map(([l, v]) => <Panel key={l} className="p-5"><h3 className="mb-1 text-[13.5px] font-semibold">{l}</h3><p className="text-[13px] leading-relaxed text-muted">{v}</p></Panel>)}
        <Panel className="p-5"><h3 className="mb-2 text-[13.5px] font-semibold">Editing changes</h3><ul className="list-disc space-y-1 pl-4 text-[13px] text-muted">{r.editingChanges.map((x) => <li key={x}>{x}</li>)}</ul></Panel>
        <Panel className="p-5"><h3 className="mb-2 text-[13.5px] font-semibold">Alternative hooks</h3><ul className="list-disc space-y-1 pl-4 text-[13px] text-muted">{r.alternativeHooks.map((x) => <li key={x}>{x}</li>)}</ul></Panel>
        <Panel className="p-5 md:col-span-2"><h3 className="mb-2 text-[13.5px] font-semibold">Title variants</h3><ul className="list-disc space-y-1 pl-4 text-[13px] text-muted">{r.titleVariants.map((x) => <li key={x}>{x}</li>)}</ul></Panel>
      </div>
    </>
  );
}
