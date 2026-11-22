"use client";

import * as React from "react";
import { ImageIcon, Sparkles, ScanEye, Wand2, Trash2, Download, Columns2, CheckCircle2, XCircle, Copy } from "lucide-react";
import { api } from "@/lib/client/api";
import { useAction, useApiQuery } from "@/lib/client/hooks";
import { Badge, Button, Dialog, EmptyState, ErrorState, Field, Input, PageHeader, Panel, PanelHeader, SignalMeter, SkeletonRows, SourceTag, TabPanel, Tabs, Textarea, Tooltip } from "@/components/ui/primitives";
import { NotConfigured } from "@/components/ui/domain";
import { MediaPicker } from "@/components/ui/media-picker";
import { cn } from "@/lib/client/utils";

type Analysis = { method: string; width: number | null; height: number | null; is16by9: boolean | null; brightness: number; rmsContrast: number; colorfulness: number; detailRetentionAtMobile: number; focalPoint: { x: number; y: number }; dominantColor: string; scores: { contrast: number; mobileReadability: number; visualHierarchy: number }; textChecks: { label: string; value: string; pass: boolean }[]; recommendations: string[] };
type Thumb = { id: string; kind: string; title: string; overlayText: string | null; prompt: string | null; assetId: string | null; concept: { name?: string; composition?: string; colorPalette?: string[]; emotion?: string; pairedTitle?: string; whyItWorks?: string; imagePrompt?: string; model?: string } | null; analysis: Analysis | null; createdAt: string };

export default function ThumbnailsPage() {
  const [tab, setTab] = React.useState("concepts");
  const thumbs = useApiQuery<Thumb[]>(["thumbnails"], "/api/v1/thumbnails");
  const [compare, setCompare] = React.useState<string[]>([]);
  const [compareOpen, setCompareOpen] = React.useState(false);
  const remove = useAction((id: string) => api.del(`/api/v1/thumbnails/${id}`), { invalidate: [["thumbnails"]] });
  const generate = useAction((thumbnailId: string) => api.post<Thumb>("/api/v1/thumbnails/generate", { thumbnailId }), { invalidate: [["thumbnails"], ["media"]], silentError: true, success: "Image generated and saved to your Media Library" });

  const rows = thumbs.data ?? [];
  const concepts = rows.filter((t) => t.kind === "concept");
  const images = rows.filter((t) => t.assetId && t.analysis);
  const toggleCompare = (id: string) => setCompare((c) => (c.includes(id) ? c.filter((x) => x !== id) : c.length >= 3 ? [...c.slice(1), id] : [...c, id]));

  return (
    <div>
      <PageHeader title="Thumbnail Lab" description="Generate original concepts, create images (optional provider), and measure contrast, mobile readability and visual hierarchy with real image analysis." />
      <Tabs value={tab} onValueChange={setTab} items={[{ value: "concepts", label: "Concepts" }, { value: "analyze", label: "Analyze" }, { value: "library", label: `Library${images.length ? ` (${images.length})` : ""}` }]}>
        <TabPanel value="concepts"><ConceptsTab concepts={concepts} loading={thumbs.isLoading} onGenerate={(id) => generate.mutate(id)} generating={generate.isPending ? (generate.variables as string) : null} genError={generate.error} onDelete={(id) => remove.mutate(id)} /></TabPanel>
        <TabPanel value="analyze"><AnalyzeTab onDone={() => setTab("library")} /></TabPanel>
        <TabPanel value="library">
          <Panel>
            <PanelHeader title="Analyzed thumbnails" description="Select up to three to compare side by side." actions={<Button size="sm" onClick={() => setCompareOpen(true)} disabled={compare.length < 2}><Columns2 /> Compare {compare.length || ""}</Button>} />
            {thumbs.isLoading ? <SkeletonRows /> : !images.length ? <EmptyState icon={ImageIcon} title="No thumbnails yet" description="Upload and analyze an image, or generate one from a concept." action={<Button onClick={() => setTab("analyze")}>Analyze an image</Button>} /> : (
              <div className="grid gap-4 border-t border-line-soft p-5 sm:grid-cols-2 xl:grid-cols-3">
                {images.map((t) => (
                  <article key={t.id} className={cn("overflow-hidden rounded-md border bg-ink-2", compare.includes(t.id) ? "border-violet" : "border-line-soft")}>
                    <img src={`/api/v1/media/${t.assetId}/file`} alt={t.title} className="aspect-video w-full object-cover" loading="lazy" />
                    <div className="space-y-2 p-3">
                      <div className="flex items-start justify-between gap-2"><p className="line-clamp-1 text-[13.5px] font-medium">{t.title}</p><Badge>{t.kind}</Badge></div>
                      <SignalMeter value={t.analysis!.scores.mobileReadability} label="Mobile readability" size="sm" />
                      <SignalMeter value={t.analysis!.scores.contrast} label="Contrast" size="sm" />
                      <SignalMeter value={t.analysis!.scores.visualHierarchy} label="Visual hierarchy" size="sm" />
                      <div className="flex gap-1 pt-1">
                        <label className="flex flex-1 cursor-pointer items-center gap-2 text-xs text-muted"><input type="checkbox" checked={compare.includes(t.id)} onChange={() => toggleCompare(t.id)} className="accent-violet" /> Compare</label>
                        <a href={`/api/v1/media/${t.assetId}/file?download=1`}><Button size="icon" variant="ghost" className="size-7" aria-label="Download thumbnail"><Download /></Button></a>
                        <Button size="icon" variant="ghost" className="size-7" aria-label="Delete" onClick={() => remove.mutate(t.id)}><Trash2 /></Button>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </Panel>
        </TabPanel>
      </Tabs>
      <Dialog open={compareOpen} onOpenChange={setCompareOpen} title="Compare thumbnails" description="Measured scores side by side. Higher is better." wide>
        <div className={cn("grid gap-4", compare.length === 3 ? "md:grid-cols-3" : "md:grid-cols-2")}>
          {rows.filter((t) => compare.includes(t.id)).map((t) => {
            const best = (k: keyof Analysis["scores"]) => Math.max(...rows.filter((x) => compare.includes(x.id)).map((x) => x.analysis?.scores[k] ?? 0)) === t.analysis?.scores[k];
            return (
              <div key={t.id} className="space-y-2">
                <img src={`/api/v1/media/${t.assetId}/file`} alt={t.title} className="aspect-video w-full rounded-md object-cover" />
                <img src={`/api/v1/media/${t.assetId}/file`} alt="" aria-hidden className="h-[47px] w-[84px] rounded-sm object-cover" title="Approximate size in a mobile feed" />
                <p className="text-xs text-faint">Shown at mobile feed size</p>
                {(["mobileReadability", "contrast", "visualHierarchy"] as const).map((k) => <div key={k} className={cn("rounded p-1", best(k) && "bg-violet/10")}><SignalMeter value={t.analysis?.scores[k]} label={k === "mobileReadability" ? "Mobile readability" : k === "contrast" ? "Contrast" : "Visual hierarchy"} size="sm" /></div>)}
              </div>
            );
          })}
        </div>
      </Dialog>
    </div>
  );
}

function ConceptsTab({ concepts, loading, onGenerate, generating, genError, onDelete }: { concepts: Thumb[]; loading: boolean; onGenerate: (id: string) => void; generating: string | null; genError: unknown; onDelete: (id: string) => void }) {
  const [title, setTitle] = React.useState("");
  const [topic, setTopic] = React.useState("");
  const [style, setStyle] = React.useState("");
  const create = useAction(() => api.post<Thumb[]>("/api/v1/thumbnails/concepts", { title, topic, style: style || undefined }), { invalidate: [["thumbnails"]], silentError: true, success: (r) => `${r.length} concepts created` });
  return (
    <div className="grid gap-5 lg:grid-cols-[320px_1fr]">
      <Panel as="div" className="h-fit p-5">
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); create.mutate(undefined); }}>
          <Field label="Video title" htmlFor="t-title"><Input id="t-title" value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
          <Field label="What's the video about?" htmlFor="t-topic"><Textarea id="t-topic" rows={3} value={topic} onChange={(e) => setTopic(e.target.value)} /></Field>
          <Field label="Style" htmlFor="t-style" hint="Optional, e.g. 'minimal, one object, warm light'"><Input id="t-style" value={style} onChange={(e) => setStyle(e.target.value)} /></Field>
          <Button type="submit" variant="primary" className="w-full" loading={create.isPending} disabled={title.trim().length < 3 || topic.trim().length < 3}><Sparkles /> Generate concepts</Button>
        </form>
        <p className="mt-4 text-xs leading-relaxed text-faint">Concepts are original. VIRAL OS won&apos;t suggest imagery that misrepresents your video or imitates another creator&apos;s thumbnail.</p>
      </Panel>
      <div className="min-w-0 space-y-4">
        {create.error && <Panel><NotConfigured error={create.error} title="Concepts need an AI provider" />{!(create.error as { notConfigured?: boolean }).notConfigured && <ErrorState error={create.error} />}</Panel>}
        {genError ? <Panel><NotConfigured error={genError} title="Image generation isn't configured (concepts and analysis still work)" />{!(genError as { notConfigured?: boolean }).notConfigured && <ErrorState error={genError} />}</Panel> : null}
        {loading ? <Panel><SkeletonRows /></Panel> : !concepts.length ? <Panel><EmptyState icon={Wand2} title="No concepts yet" description="Describe the video to get four distinct thumbnail directions, each with an image prompt and a paired title." /></Panel> : (
          <div className="grid gap-4 md:grid-cols-2">
            {concepts.map((t) => {
              const c = t.concept ?? {};
              return (
                <Panel key={t.id} className="flex flex-col p-5">
                  <div className="flex items-start justify-between gap-2"><h3 className="text-[15px] font-semibold">{t.title}</h3><SourceTag source="ai_estimate" at={t.createdAt} /></div>
                  {t.overlayText && <p className="mt-2 inline-block w-fit rounded bg-ink-2 px-2 py-1 text-[15px] font-bold tracking-tight">{t.overlayText}</p>}
                  <p className="mt-2 text-[13px] text-muted">{c.composition}</p>
                  {c.colorPalette && <div className="mt-2 flex gap-1">{c.colorPalette.map((col) => <Tooltip key={col} content={col}><span className="size-5 rounded border border-line" style={{ background: col }} /></Tooltip>)}</div>}
                  <dl className="mt-3 space-y-1 text-[13px]"><div><dt className="inline text-muted">Paired title: </dt><dd className="inline">{c.pairedTitle}</dd></div><div><dt className="inline text-muted">Emotion: </dt><dd className="inline">{c.emotion}</dd></div></dl>
                  <p className="mt-2 text-xs text-faint">{c.whyItWorks}</p>
                  <details className="mt-2 text-xs"><summary className="cursor-pointer text-muted">Image prompt</summary><p className="mt-1 text-muted">{t.prompt}</p></details>
                  <div className="mt-auto flex gap-2 pt-4">
                    <Button size="sm" variant="primary" onClick={() => onGenerate(t.id)} loading={generating === t.id}><ImageIcon /> Generate image</Button>
                    <Button size="sm" variant="ghost" onClick={() => navigator.clipboard.writeText(t.prompt ?? "")}><Copy /> Copy prompt</Button>
                    <Button size="icon" variant="ghost" aria-label="Delete concept" onClick={() => onDelete(t.id)}><Trash2 /></Button>
                  </div>
                </Panel>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function AnalyzeTab({ onDone }: { onDone: () => void }) {
  const [assetId, setAssetId] = React.useState<string | null>(null);
  const [overlay, setOverlay] = React.useState("");
  const [textColor, setTextColor] = React.useState("#ffffff");
  const [bg, setBg] = React.useState("#000000");
  const [result, setResult] = React.useState<Thumb | null>(null);
  const analyze = useAction(() => api.post<Thumb>("/api/v1/thumbnails/analyze", { assetId, overlayText: overlay || undefined, textColor: overlay ? textColor : undefined, backgroundColor: overlay ? bg : undefined }), { invalidate: [["thumbnails"]], onSuccess: setResult, success: "Analysis saved to your library" });
  const a = result?.analysis;
  return (
    <div className="grid gap-5 lg:grid-cols-[360px_1fr]">
      <Panel as="div" className="h-fit space-y-4 p-5">
        <Field label="Thumbnail image"><MediaPicker value={assetId} onChange={(id) => setAssetId(id)} kind="image" label="Choose image" /></Field>
        <Field label="Overlay text" htmlFor="ov" hint="Optional. Checks word count and text contrast."><Input id="ov" value={overlay} onChange={(e) => setOverlay(e.target.value)} placeholder="e.g. I was wrong" /></Field>
        {overlay && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Text color" htmlFor="tc"><div className="flex gap-2"><input type="color" value={textColor} onChange={(e) => setTextColor(e.target.value)} className="h-9 w-10 rounded border border-line bg-transparent" aria-label="Pick text color" /><Input id="tc" value={textColor} onChange={(e) => setTextColor(e.target.value)} /></div></Field>
            <Field label="Behind text" htmlFor="bc"><div className="flex gap-2"><input type="color" value={bg} onChange={(e) => setBg(e.target.value)} className="h-9 w-10 rounded border border-line bg-transparent" aria-label="Pick background color" /><Input id="bc" value={bg} onChange={(e) => setBg(e.target.value)} /></div></Field>
          </div>
        )}
        <Button variant="primary" className="w-full" onClick={() => analyze.mutate(undefined)} loading={analyze.isPending} disabled={!assetId}><ScanEye /> Analyze thumbnail</Button>
      </Panel>
      {a ? (
        <Panel>
          <PanelHeader title="Analysis" description={a.method} actions={<><SourceTag source="computed" /><Button size="sm" onClick={onDone}>Open library</Button></>} />
          <div className="grid gap-5 border-t border-line-soft p-5 md:grid-cols-[1fr_220px]">
            <div className="space-y-4">
              <SignalMeter value={a.scores.mobileReadability} label="Mobile readability" size="lg" />
              <SignalMeter value={a.scores.contrast} label="Contrast" size="lg" />
              <SignalMeter value={a.scores.visualHierarchy} label="Visual hierarchy" size="lg" />
            </div>
            <div className="space-y-2">
              <div className="relative">
                <img src={`/api/v1/media/${result!.assetId}/file`} alt="Analyzed thumbnail" className="aspect-video w-full rounded-md object-cover" />
                <span className="absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-violet shadow" style={{ left: `${a.focalPoint.x * 100}%`, top: `${a.focalPoint.y * 100}%` }} title="Detected focal point" />
              </div>
              <img src={`/api/v1/media/${result!.assetId}/file`} alt="" aria-hidden className="h-[47px] w-[84px] rounded-sm object-cover" />
              <p className="text-xs text-faint">Top: focal point marker. Bottom: mobile feed size.</p>
            </div>
          </div>
          <dl className="grid grid-cols-2 gap-px border-t border-line-soft bg-line-soft text-[13px] sm:grid-cols-4">
            {[["Resolution", a.width ? `${a.width}×${a.height}` : "—"], ["16:9", a.is16by9 ? "Yes" : "No (YouTube expects 16:9)"], ["Brightness", `${a.brightness}%`], ["Colorfulness", a.colorfulness], ["RMS contrast", a.rmsContrast], ["Detail kept at mobile size", `${Math.round(a.detailRetentionAtMobile * 100)}%`], ["Dominant color", <span key="c" className="flex items-center gap-1.5"><span className="size-3 rounded-sm" style={{ background: a.dominantColor }} />{a.dominantColor}</span>]].map(([l, v]) => <div key={l as string} className="bg-panel px-4 py-2.5"><dt className="text-xs text-muted">{l}</dt><dd>{v}</dd></div>)}
          </dl>
          {!!a.textChecks.length && <ul className="space-y-1 border-t border-line-soft px-5 py-3 text-[13px]">{a.textChecks.map((t) => <li key={t.label} className="flex items-center gap-2">{t.pass ? <CheckCircle2 className="size-4 text-success" /> : <XCircle className="size-4 text-danger" />}{t.label}: {t.value}</li>)}</ul>}
          <div className="border-t border-line-soft px-5 py-4"><h3 className="mb-2 text-[13.5px] font-semibold">Recommendations</h3>{a.recommendations.length ? <ul className="list-disc space-y-1 pl-4 text-[13px] text-muted">{a.recommendations.map((r) => <li key={r}>{r}</li>)}</ul> : <p className="text-[13px] text-muted">No issues found by the measured checks.</p>}</div>
        </Panel>
      ) : <Panel><EmptyState icon={ScanEye} title="Measure a thumbnail" description="Pick or upload an image. Results are saved to your library." /></Panel>}
    </div>
  );
}
