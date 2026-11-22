"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { Area, AreaChart, ReferenceArea, ReferenceLine, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from "recharts";
import { Scissors, FileText, Play, RotateCw, Trash2, Download, Send, Clock, AlertTriangle, Minus, Plus, Sparkles, Info, Link2, Code2, ExternalLink, Paperclip, MonitorPlay } from "lucide-react";
import { embedCode, embedUrl, watchUrl } from "@/lib/clipping/youtube-urls";
import { api, errorText } from "@/lib/client/api";
import { useAction, useApiQuery } from "@/lib/client/hooks";
import { Badge, Button, ConfirmDialog, Dialog, EmptyState, ErrorState, Field, HelpTip, Input, PageHeader, Panel, PanelHeader, Select, SignalMeter, SkeletonRows, SourceTag, Switch, Textarea, Tooltip } from "@/components/ui/primitives";
import { StatusBadge } from "@/components/ui/domain";
import { MediaPicker } from "@/components/ui/media-picker";
import { cn, fmtDate, fmtRelative } from "@/lib/client/utils";

type Capabilities = { transcription: boolean; ai: boolean; ffmpeg: boolean; queue: boolean; youtube: { apiKey: boolean; channels: { id: string; name: string | null; captions: boolean }[]; captionScopeRequested: boolean } };
type JobSummary = { id: string; sourceType: string; youtubeVideoId: string | null; status: string; progress: number; stage: string | null; sourceFilename: string; transcriptSource: string; error: string | null; createdAt: string; clipCount: number; readyCount: number };
type RenderSettings = { aspect: "9:16" | "1:1" | "16:9"; reframe: "auto" | "crop" | "blur" | "fit"; focusX: number; quality: "720p" | "1080p"; captions: boolean; captionStyle: "bold" | "highlight" | "minimal"; uppercase: boolean; normalizeAudio: boolean };
type Clip = { id: string; rank: number; startSec: number; endSec: number; title: string; hook: string | null; caption: string; hashtags: string[]; transcript: string; computedScore: number; scoreBreakdown: Record<string, { value: number; weight: number; detail: string }>; aiScore: number | null; aiReason: string | null; status: string; renderSettings: RenderSettings; assetId: string | null; thumbnailAssetId: string | null; renderInfo: { width: number; height: number; duration: number; reframe: string; captions: boolean } | null; error: string | null };
type YtSource = { provider: "youtube"; videoId: string; title: string; channelTitle: string; duration: number; embeddable: boolean; owned: boolean; quotaUnits: number };
type YtSignals = { kind: "youtube"; chapters: { start: number; end: number; title: string }[]; mentions: { t: number; weight: number }[]; retention: { ratio: number; watch: number; relative: number | null }[] | null };
type JobDetail = { id: string; sourceType: string; youtubeVideoId: string | null; status: string; progress: number; stage: string | null; error: string | null; transcriptSource: string; transcript: { start: number; end: number; text: string }[] | null; notes: string[]; source: ({ duration: number; width: number; height: number; filename: string } & Partial<YtSource>) | null; signals: ({ loudness: { t: number; db: number }[]; silences: { start: number; end: number }[]; cuts: number[]; kind?: undefined } | YtSignals) | null; settings: Record<string, unknown>; sourceAsset: { id: string; filename: string } | null; createdAt: string; finishedAt: string | null; clips: Clip[] };

const ACTIVE = ["queued", "analyzing", "transcribing", "scoring", "rendering"];
const fmtT = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;
const LENGTHS: Record<string, [number, number]> = { short: [15, 30], medium: [30, 60], long: [60, 90], custom: [15, 60] };
const FACTOR: Record<string, string> = { energy: "Energy", hook: "Opening strength", speech: "Speech pace", pacing: "Visual pacing", completeness: "Complete thought", silence: "Little dead air", retention: "Audience retention", community: "Viewer timestamps", structure: "Chapter fit" };
const fmtS = (s: number) => { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60); return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`; };
/** "1:02:03", "2:15" or "135" → seconds; null when it isn't a time. */
function parseTimeInput(v: string): number | null {
  const t = v.trim();
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})$/.exec(t);
  return m ? Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
}
async function copy(text: string, what: string) {
  try { await navigator.clipboard.writeText(text); toast.success(`${what} copied`); } catch { toast.error("Couldn't copy. Select the text and copy it yourself."); }
}

export default function ClipsPage() {
  const params = useSearchParams();
  const router = useRouter();
  const [jobId, setJobId] = React.useState<string | null>(params.get("job"));
  const list = useApiQuery<{ jobs: JobSummary[]; capabilities: Capabilities }>(["clip-jobs"], "/api/v1/clips/jobs", { refetchInterval: 4000 });
  const caps = list.data?.capabilities;
  const select = (id: string | null) => {
    setJobId(id);
    router.replace(id ? `/clips?job=${id}` : "/clips");
  };

  return (
    <div>
      <PageHeader title="Clip Studio" description="Turn a long video into short clips. From a file, VIRAL OS measures loudness, pauses and scene cuts and renders vertical clips with captions. From a YouTube link, it finds moments with YouTube's official data and plays each clip in YouTube's player, without downloading the video." actions={jobId ? <Button variant="primary" onClick={() => select(null)}><Scissors /> New clip job</Button> : undefined} />
      {caps && !caps.ffmpeg && (
        <Panel className="mb-4 flex gap-3 border-warning/30 bg-warning/5 p-4 text-[13px]"><AlertTriangle className="size-5 shrink-0 text-warning" /><p className="text-muted">ffmpeg isn&apos;t installed on this server, so clipping can&apos;t run here. The worker image (Dockerfile.worker) includes it; clip jobs run on the worker.</p></Panel>
      )}
      <div className="grid gap-5 xl:grid-cols-[300px_1fr]">
        <Panel as="div" className="h-fit p-2">
          <p className="px-3 pb-1 pt-2 text-[12px] font-medium text-faint">Clip jobs</p>
          {list.isLoading ? <SkeletonRows rows={3} /> : !list.data?.jobs.length ? <p className="px-3 py-3 text-[13px] text-muted">Your clip jobs appear here.</p> : (
            <ul>
              {list.data.jobs.map((j) => (
                <li key={j.id}>
                  <button onClick={() => select(j.id)} className={cn("w-full rounded-md px-3 py-2 text-left", jobId === j.id ? "bg-raised" : "hover:bg-raised/50")}>
                    <span className="flex items-center gap-1.5 truncate text-[13.5px]">{j.sourceType === "youtube" && <MonitorPlay className="size-3.5 shrink-0 text-faint" aria-label="YouTube" />}<span className="truncate">{j.sourceFilename}</span></span>
                    <span className="mt-1 flex items-center gap-2 text-xs text-faint"><StatusBadge status={j.status} />{ACTIVE.includes(j.status) ? `${j.progress}%` : j.status === "completed" ? (j.sourceType === "youtube" ? `${j.clipCount} clips${j.readyCount ? `, ${j.readyCount} rendered` : ""}` : `${j.readyCount}/${j.clipCount} rendered`) : fmtRelative(j.createdAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <div className="min-w-0">{jobId ? <JobView key={jobId} id={jobId} onDeleted={() => select(null)} /> : <NewJob caps={caps} onCreated={(id) => select(id)} />}</div>
      </div>
    </div>
  );
}

function NewJob({ caps, onCreated }: { caps?: Capabilities; onCreated: (id: string) => void }) {
  const [source, setSource] = React.useState<"file" | "youtube">("file");
  return (
    <div className="space-y-3">
      <div role="radiogroup" aria-label="What to clip" className="inline-flex rounded-md border border-line p-0.5">
        {([["file", "A video file", FileText], ["youtube", "A YouTube link", MonitorPlay]] as const).map(([v, l, Icon]) => (
          <button key={v} type="button" role="radio" aria-checked={source === v} onClick={() => setSource(v)} className={cn("flex items-center gap-1.5 rounded px-3 py-1.5 text-[13px]", source === v ? "bg-raised font-medium" : "text-muted hover:text-fg")}><Icon className="size-4" />{l}</button>
        ))}
      </div>
      {source === "file" ? <FileJobForm caps={caps} onCreated={onCreated} /> : <YouTubeJobForm caps={caps} onCreated={onCreated} />}
    </div>
  );
}

function FileJobForm({ caps, onCreated }: { caps?: Capabilities; onCreated: (id: string) => void }) {
  const [assetId, setAssetId] = React.useState<string | null>(null);
  const [length, setLength] = React.useState("short");
  const [custom, setCustom] = React.useState({ min: 15, max: 45 });
  const [count, setCount] = React.useState(5);
  const [mode, setMode] = React.useState<"captions" | "auto" | "none">("none");
  const [captionsText, setCaptionsText] = React.useState("");
  const [captionsName, setCaptionsName] = React.useState("");
  const [autoRender, setAutoRender] = React.useState(true);
  const [render, setRender] = React.useState<RenderSettings>({ aspect: "9:16", reframe: "auto", focusX: 0.5, quality: "720p", captions: true, captionStyle: "bold", uppercase: true, normalizeAudio: true });
  const [errors, setErrors] = React.useState<string[]>([]);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const [min, max] = length === "custom" ? [custom.min, custom.max] : LENGTHS[length];
  const create = useAction(() => api.post<{ id: string }>("/api/v1/clips/jobs", { assetId, minSeconds: min, maxSeconds: max, count, transcriptMode: mode, captionsText: mode === "captions" ? captionsText : undefined, autoRender, render }), {
    invalidate: [["clip-jobs"]],
    silentError: true,
    success: "Clip job started",
    onSuccess: (j) => onCreated(j.id),
  });

  const loadCaptions = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > 2_000_000) return toast.error("Caption files must be under 2 MB.");
    if (!/\.(srt|vtt)$/i.test(f.name)) return toast.error("Choose an .srt or .vtt file.");
    setCaptionsText(await f.text());
    setCaptionsName(f.name);
  };
  const submit = () => {
    const p: string[] = [];
    if (!assetId) p.push("Choose the video to clip.");
    if (mode === "captions" && !captionsText) p.push("Attach the caption file, or pick another transcript option.");
    if (length === "custom" && max < min + 3) p.push("Maximum length must be at least 3 seconds longer than the minimum.");
    setErrors(p);
    if (!p.length) { create.reset(); create.mutate(undefined); }
  };

  return (
    <Panel>
      <PanelHeader title="New clip job" description="Clips are chosen from what's measured in your video, plus the transcript when you provide one." />
      <div className="space-y-5 border-t border-line-soft p-5">
        <Field label="Source video"><MediaPicker value={assetId} onChange={(id) => setAssetId(id)} kind="video" label="Choose video" /></Field>

        <fieldset>
          <legend className="mb-1.5 text-[13px] font-medium">Transcript</legend>
          <div className="grid gap-2 sm:grid-cols-3">
            {([["captions", "Upload captions", "Use an .srt or .vtt file. Clips follow full sentences and get burned-in captions."], ["auto", "Transcribe automatically", caps?.transcription ? "Speech-to-text with OpenAI. Billed to your OpenAI key." : "Needs OPENAI_API_KEY on the server."], ["none", "No transcript", "Clips follow loudness, pauses and scene cuts. No captions."]] as const).map(([v, l, d]) => {
              const disabled = v === "auto" && !caps?.transcription;
              return (
                <button key={v} type="button" disabled={disabled} onClick={() => setMode(v)} aria-pressed={mode === v} className={cn("rounded-md border p-3 text-left disabled:opacity-50", mode === v ? "border-violet bg-violet/10" : "border-line hover:border-faint")}>
                  <p className="text-[13.5px] font-medium">{l}</p><p className="mt-0.5 text-xs text-muted">{d}</p>
                </button>
              );
            })}
          </div>
          {mode === "captions" && (
            <div className="mt-3 flex items-center gap-3">
              <Button type="button" onClick={() => fileRef.current?.click()}><FileText /> {captionsName ? "Replace file" : "Choose .srt or .vtt"}</Button>
              {captionsName && <span className="text-[13px] text-muted">{captionsName} ({captionsText.split("-->").length - 1} cues)</span>}
              <input ref={fileRef} type="file" accept=".srt,.vtt,text/vtt,application/x-subrip" className="hidden" onChange={(e) => loadCaptions(e.target.files?.[0])} aria-label="Caption file" />
            </div>
          )}
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Clip length" htmlFor="cl-len"><Select id="cl-len" value={length} onChange={(e) => setLength(e.target.value)}><option value="short">15–30 seconds</option><option value="medium">30–60 seconds</option><option value="long">60–90 seconds</option><option value="custom">Custom</option></Select></Field>
          {length === "custom" ? (
            <div className="grid grid-cols-2 gap-2 sm:col-span-1">
              <Field label="Min (s)" htmlFor="cl-min"><Input id="cl-min" type="number" min={5} max={170} value={custom.min} onChange={(e) => setCustom({ ...custom, min: Number(e.target.value) })} /></Field>
              <Field label="Max (s)" htmlFor="cl-max"><Input id="cl-max" type="number" min={8} max={180} value={custom.max} onChange={(e) => setCustom({ ...custom, max: Number(e.target.value) })} /></Field>
            </div>
          ) : <div className="hidden sm:block" />}
          <Field label="Number of clips" htmlFor="cl-n"><Select id="cl-n" value={count} onChange={(e) => setCount(Number(e.target.value))}>{[1, 3, 5, 8, 10, 12].map((n) => <option key={n} value={n}>{n}</option>)}</Select></Field>
        </div>

        <RenderControls value={render} onChange={setRender} captionsAvailable={mode !== "none"} />

        <label className="flex items-center gap-2 text-[13px]"><Switch checked={autoRender} onCheckedChange={setAutoRender} label="Render clips automatically" />Render every clip automatically (otherwise review candidates first and render the ones you want)</label>
        {(errors.length > 0 || create.error) && <div role="alert" className="rounded-md border border-danger/30 bg-danger/5 p-3 text-[13px] text-danger"><ul className="list-disc pl-4">{(errors.length ? errors : [errorText(create.error)]).map((e) => <li key={e}>{e}</li>)}</ul></div>}
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" size="lg" onClick={submit} loading={create.isPending}><Scissors /> Find clips</Button>
          {caps && !caps.queue && <p className="text-xs text-muted">Jobs run on the background worker (npm run worker). Without Redis it checks for new jobs every 30 seconds.</p>}
        </div>
      </div>
    </Panel>
  );
}

function YouTubeJobForm({ caps, onCreated }: { caps?: Capabilities; onCreated: (id: string) => void }) {
  const yt = caps?.youtube;
  const [url, setUrl] = React.useState("");
  const [length, setLength] = React.useState("short");
  const [custom, setCustom] = React.useState({ min: 15, max: 45 });
  const [count, setCount] = React.useState(5);
  const [commentPages, setCommentPages] = React.useState(3);
  const [mode, setMode] = React.useState<"youtube" | "captions" | "none">("none");
  const [captionsText, setCaptionsText] = React.useState("");
  const [captionsName, setCaptionsName] = React.useState("");
  const [errors, setErrors] = React.useState<string[]>([]);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const [min, max] = length === "custom" ? [custom.min, custom.max] : LENGTHS[length];
  const canRead = !!yt && (yt.apiKey || yt.channels.length > 0);
  const captionChannels = yt?.channels.filter((c) => c.captions) ?? [];
  const create = useAction(() => api.post<{ id: string }>("/api/v1/clips/jobs", { source: "youtube", url, minSeconds: min, maxSeconds: max, count, commentPages, transcriptMode: mode, captionsText: mode === "captions" ? captionsText : undefined }), {
    invalidate: [["clip-jobs"]],
    silentError: true,
    success: "Looking for moments",
    onSuccess: (j) => onCreated(j.id),
  });
  const loadCaptions = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > 2_000_000) return toast.error("Caption files must be under 2 MB.");
    if (!/\.(srt|vtt)$/i.test(f.name)) return toast.error("Choose an .srt or .vtt file.");
    setCaptionsText(await f.text());
    setCaptionsName(f.name);
  };
  const submit = () => {
    const p: string[] = [];
    if (!url.trim()) p.push("Paste the YouTube link.");
    if (mode === "captions" && !captionsText) p.push("Attach the caption file, or pick another transcript option.");
    if (length === "custom" && max < min + 3) p.push("Maximum length must be at least 3 seconds longer than the minimum.");
    setErrors(p);
    if (!p.length) { create.reset(); create.mutate(undefined); }
  };
  const captionHint = captionChannels.length ? `Reads the caption track of a video on ${captionChannels.map((c) => c.name ?? "your channel").join(", ")}.` : yt?.captionScopeRequested ? "Reconnect YouTube in Settings to grant caption access." : "Needs YOUTUBE_CAPTION_ACCESS=true and a reconnected channel.";

  return (
    <Panel>
      <PanelHeader title="Clip a YouTube video" description="The video is never downloaded. Moments come from YouTube's official data, and each clip plays in YouTube's own player with a start and end time." />
      <div className="space-y-5 border-t border-line-soft p-5">
        {caps && !canRead && (
          <div role="alert" className="flex gap-3 rounded-md border border-warning/30 bg-warning/5 p-3 text-[13px] text-muted"><AlertTriangle className="size-5 shrink-0 text-warning" /><p>Reading YouTube data needs YOUTUBE_API_KEY on the server, or a YouTube channel connected in Settings.</p></div>
        )}
        <Field label="YouTube link" htmlFor="yt-url" hint="A watch, youtu.be, Shorts or embed link, or an 11-character video ID.">
          <Input id="yt-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://www.youtube.com/watch?v=…" inputMode="url" autoComplete="off" />
        </Field>
        <div className="rounded-md border border-line-soft p-4 text-[13px] text-muted">
          <p className="font-medium text-fg">Where moments come from</p>
          <ul className="mt-1.5 list-disc space-y-1 pl-4">
            <li>Chapters in the video description</li>
            <li>Timestamps viewers wrote in comments, weighted by likes</li>
            <li>For videos on your connected channel: audience retention from YouTube Analytics, and your caption track</li>
          </ul>
          <p className="mt-2">For your own videos you can then attach your original file to render real vertical clips.</p>
        </div>

        <fieldset>
          <legend className="mb-1.5 text-[13px] font-medium">Transcript</legend>
          <div className="grid gap-2 sm:grid-cols-3">
            {([["youtube", "Your YouTube captions", captionHint], ["captions", "Upload captions", "An .srt or .vtt that matches the video. Clips follow full sentences."], ["none", "No transcript", "Moments come from chapters, comments and retention only."]] as const).map(([v, l, d]) => {
              const disabled = v === "youtube" && !captionChannels.length;
              return (
                <button key={v} type="button" disabled={disabled} onClick={() => setMode(v)} aria-pressed={mode === v} className={cn("rounded-md border p-3 text-left disabled:opacity-50", mode === v ? "border-violet bg-violet/10" : "border-line hover:border-faint")}>
                  <p className="text-[13.5px] font-medium">{l}</p><p className="mt-0.5 text-xs text-muted">{d}</p>
                </button>
              );
            })}
          </div>
          {mode === "captions" && (
            <div className="mt-3 flex items-center gap-3">
              <Button type="button" onClick={() => fileRef.current?.click()}><FileText /> {captionsName ? "Replace file" : "Choose .srt or .vtt"}</Button>
              {captionsName && <span className="text-[13px] text-muted">{captionsName} ({captionsText.split("-->").length - 1} cues)</span>}
              <input ref={fileRef} type="file" accept=".srt,.vtt,text/vtt,application/x-subrip" className="hidden" onChange={(e) => loadCaptions(e.target.files?.[0])} aria-label="Caption file" />
            </div>
          )}
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Clip length" htmlFor="yt-len"><Select id="yt-len" value={length} onChange={(e) => setLength(e.target.value)}><option value="short">15–30 seconds</option><option value="medium">30–60 seconds</option><option value="long">60–90 seconds</option><option value="custom">Custom</option></Select></Field>
          {length === "custom" ? (
            <div className="grid grid-cols-2 gap-2">
              <Field label="Min (s)" htmlFor="yt-min"><Input id="yt-min" type="number" min={5} max={170} value={custom.min} onChange={(e) => setCustom({ ...custom, min: Number(e.target.value) })} /></Field>
              <Field label="Max (s)" htmlFor="yt-max"><Input id="yt-max" type="number" min={8} max={180} value={custom.max} onChange={(e) => setCustom({ ...custom, max: Number(e.target.value) })} /></Field>
            </div>
          ) : <Field label="Number of clips" htmlFor="yt-n"><Select id="yt-n" value={count} onChange={(e) => setCount(Number(e.target.value))}>{[1, 3, 5, 8, 10, 12].map((n) => <option key={n} value={n}>{n}</option>)}</Select></Field>}
          <Field label="Comments to read" htmlFor="yt-cp" hint="Each 100 comments uses 1 unit of your daily YouTube quota."><Select id="yt-cp" value={commentPages} onChange={(e) => setCommentPages(Number(e.target.value))}><option value={0}>None</option><option value={1}>Top 100</option><option value={3}>Top 300</option><option value={5}>Top 500</option><option value={10}>Top 1,000</option></Select></Field>
          {length === "custom" && <Field label="Number of clips" htmlFor="yt-n2"><Select id="yt-n2" value={count} onChange={(e) => setCount(Number(e.target.value))}>{[1, 3, 5, 8, 10, 12].map((n) => <option key={n} value={n}>{n}</option>)}</Select></Field>}
        </div>

        {(errors.length > 0 || create.error) && <div role="alert" className="rounded-md border border-danger/30 bg-danger/5 p-3 text-[13px] text-danger"><ul className="list-disc pl-4">{(errors.length ? errors : [errorText(create.error)]).map((e) => <li key={e}>{e}</li>)}</ul></div>}
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" size="lg" onClick={submit} loading={create.isPending} disabled={!!caps && !canRead}><Scissors /> Find moments</Button>
          {caps && !caps.queue && <p className="text-xs text-muted">Jobs run on the background worker (npm run worker). Without Redis it checks for new jobs every 30 seconds.</p>}
        </div>
      </div>
    </Panel>
  );
}

function RenderControls({ value, onChange, captionsAvailable }: { value: RenderSettings; onChange: (v: RenderSettings) => void; captionsAvailable: boolean }) {
  const set = <K extends keyof RenderSettings>(k: K, v: RenderSettings[K]) => onChange({ ...value, [k]: v });
  return (
    <fieldset className="rounded-md border border-line-soft p-4">
      <legend className="px-1 text-[13px] font-medium">Output</legend>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Format" htmlFor="r-aspect"><Select id="r-aspect" value={value.aspect} onChange={(e) => set("aspect", e.target.value as RenderSettings["aspect"])}><option value="9:16">Vertical 9:16 (Shorts, TikTok, Reels)</option><option value="1:1">Square 1:1</option><option value="16:9">Landscape 16:9</option></Select></Field>
        <Field label="Framing" htmlFor="r-frame" hint={value.reframe === "auto" ? "Crops when the shape is close, otherwise fills with a blurred copy." : undefined}><Select id="r-frame" value={value.reframe} onChange={(e) => set("reframe", e.target.value as RenderSettings["reframe"])}><option value="auto">Automatic</option><option value="crop">Crop to fill</option><option value="blur">Fit with blurred background</option><option value="fit">Fit with black bars</option></Select></Field>
        <Field label="Quality" htmlFor="r-q"><Select id="r-q" value={value.quality} onChange={(e) => set("quality", e.target.value as RenderSettings["quality"])}><option value="720p">720p (faster)</option><option value="1080p">1080p</option></Select></Field>
        {value.reframe === "crop" && <Field label={`Crop focus: ${value.focusX < 0.4 ? "left" : value.focusX > 0.6 ? "right" : "center"}`} htmlFor="r-fx" className="sm:col-span-3"><input id="r-fx" type="range" min={0} max={1} step={0.05} value={value.focusX} onChange={(e) => set("focusX", Number(e.target.value))} className="w-full accent-violet" /></Field>}
        <label className={cn("flex items-center gap-2 text-[13px]", !captionsAvailable && "opacity-50")}><Switch checked={value.captions && captionsAvailable} disabled={!captionsAvailable} onCheckedChange={(v) => set("captions", v)} label="Burn in captions" />Burn in captions</label>
        <Field label="Caption style" htmlFor="r-cs"><Select id="r-cs" value={value.captionStyle} disabled={!captionsAvailable || !value.captions} onChange={(e) => set("captionStyle", e.target.value as RenderSettings["captionStyle"])}><option value="bold">Bold white, word groups</option><option value="highlight">Bold yellow, word groups</option><option value="minimal">Subtitle box, full lines</option></Select></Field>
        <label className="flex items-center gap-2 text-[13px]"><Switch checked={value.normalizeAudio} onCheckedChange={(v) => set("normalizeAudio", v)} label="Normalize loudness" />Normalize audio to -14 LUFS</label>
      </div>
    </fieldset>
  );
}

function JobView({ id, onDeleted }: { id: string; onDeleted: () => void }) {
  const job = useApiQuery<JobDetail>(["clip-job", id], `/api/v1/clips/jobs/${id}`, { refetchInterval: 2500 });
  const [confirm, setConfirm] = React.useState(false);
  const retry = useAction(() => api.post(`/api/v1/clips/jobs/${id}/retry`), { invalidate: [["clip-job", id], ["clip-jobs"]], success: "Job queued again" });
  const remove = useAction(() => api.del(`/api/v1/clips/jobs/${id}`), { invalidate: [["clip-jobs"]], success: "Clip job deleted", onSuccess: onDeleted });
  const j = job.data;
  if (job.isLoading) return <Panel><SkeletonRows rows={6} /></Panel>;
  if (job.error || !j) return <Panel><ErrorState error={job.error} onRetry={() => job.refetch()} /></Panel>;
  const active = ACTIVE.includes(j.status);
  const yt = j.sourceType === "youtube" && j.source?.provider === "youtube" ? (j.source as YtSource) : null;
  const transcriptLabel = j.transcriptSource === "provided" ? "your caption file" : j.transcriptSource === "openai" ? "automatic (OpenAI)" : j.transcriptSource === "youtube" ? "your YouTube captions" : "none";

  return (
    <div className="space-y-4">
      <Panel>
        <PanelHeader
          title={yt ? yt.title : j.source?.filename ?? j.sourceAsset?.filename ?? "Clip job"}
          description={yt ? `${fmtS(yt.duration)} long, from ${yt.channelTitle}.${yt.owned ? " On your connected channel." : ""} Transcript: ${transcriptLabel}. Started ${fmtDate(j.createdAt, true)}.` : `${j.source ? `${fmtT(j.source.duration)} long, ${j.source.width}×${j.source.height}. ` : ""}Transcript: ${transcriptLabel}. Started ${fmtDate(j.createdAt, true)}.`}
          actions={<>{j.status === "failed" && <Button size="sm" onClick={() => retry.mutate(undefined)} loading={retry.isPending}><RotateCw /> Retry</Button>}<Button size="icon" variant="ghost" aria-label="Delete clip job" onClick={() => setConfirm(true)}><Trash2 /></Button></>}
        />
        <div className="border-t border-line-soft px-5 py-4">
          <div className="flex items-center gap-3">
            <StatusBadge status={j.status} />
            <span className="text-[13px] text-muted" aria-live="polite">{j.stage}</span>
            {active && <span className="ml-auto text-xs tabular-nums text-faint">{j.progress}%</span>}
          </div>
          {active && <div className="mt-3 h-1.5 overflow-hidden rounded bg-line" role="progressbar" aria-valuenow={j.progress} aria-valuemin={0} aria-valuemax={100}><div className="h-full bg-violet transition-[width] duration-500" style={{ width: `${j.progress}%` }} /></div>}
          {j.error && <p role="alert" className="mt-3 rounded border border-danger/20 bg-danger/5 px-3 py-2 text-[13px] text-danger">{j.error}</p>}
          {j.notes.length > 0 && <ul className="mt-3 space-y-1">{j.notes.map((n) => <li key={n} className="flex gap-2 text-xs text-muted"><Info className="mt-0.5 size-3.5 shrink-0" />{n}</li>)}</ul>}
        </div>
        {j.signals?.kind === "youtube" && yt ? <YouTubeTimeline j={j} signals={j.signals} duration={yt.duration} /> : j.signals && j.source && <Timeline j={j} />}
        {yt && j.status === "completed" && <YouTubeJobActions j={j} yt={yt} />}
      </Panel>

      {j.clips.length > 0 ? (
        <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
          {j.clips.map((c) => <ClipCard key={c.id} clip={c} jobId={id} duration={j.source?.duration ?? 0} sourceAssetId={j.sourceAsset?.id ?? null} hasTranscript={!!j.transcript?.length} yt={yt} />)}
        </div>
      ) : !active && j.status !== "failed" ? <Panel><EmptyState icon={Scissors} title="No clips" description={yt ? "Use Add a clip above to mark the moments you want with start and end times." : undefined} /></Panel> : active ? <Panel><EmptyState icon={Clock} title="Finding the best moments…" description="Clips appear here as soon as scoring finishes. Rendering continues in the background." /></Panel> : null}
      <ConfirmDialog open={confirm} onOpenChange={setConfirm} title="Delete this clip job?" description="Its clip list is removed. Rendered clip files stay in your Media Library under Clips." confirmLabel="Delete job" onConfirm={() => remove.mutate(undefined)} loading={remove.isPending} />
    </div>
  );
}

function Timeline({ j }: { j: JobDetail }) {
  const sig = j.signals as Exclude<JobDetail["signals"], YtSignals | null>;
  const data = sig.loudness;
  return (
    <div className="border-t border-line-soft px-3 pb-3 pt-3">
      <p className="mb-1 flex items-center gap-1.5 px-2 text-xs text-muted">Loudness across the video, with clips highlighted <HelpTip text="Measured RMS loudness per half second. Dashed lines are detected scene cuts. Shaded areas are the chosen clips." /></p>
      <div className="h-28" aria-label="Loudness timeline with clip positions">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
            <defs><linearGradient id="ld" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#22d3ee" stopOpacity={0.35} /><stop offset="100%" stopColor="#22d3ee" stopOpacity={0} /></linearGradient></defs>
            <XAxis dataKey="t" type="number" domain={[0, j.source!.duration]} tick={{ fill: "#8d93ad", fontSize: 10 }} tickFormatter={(v: number) => fmtT(v).replace(/\.\d$/, "")} tickLine={false} axisLine={false} />
            <YAxis domain={[-70, 0]} ticks={[-60, -30, 0]} tick={{ fill: "#8d93ad", fontSize: 10 }} tickFormatter={(v: number) => `${v} dB`} tickLine={false} axisLine={false} width={48} />
            <RTooltip contentStyle={{ background: "#1e2540", border: "1px solid #2a3150", fontSize: 12 }} labelFormatter={(v) => fmtT(Number(v))} formatter={(v) => [`${v} dBFS`, "Loudness"]} />
            {j.clips.map((c) => <ReferenceArea key={c.id} x1={c.startSec} x2={c.endSec} fill="#7c5cff" fillOpacity={0.18} stroke="#7c5cff" strokeOpacity={0.5} label={{ value: `#${c.rank}`, fill: "#a491ff", fontSize: 11, position: "insideTopLeft" }} />)}
            {sig.cuts.map((t) => <ReferenceLine key={t} x={t} stroke="#5d6383" strokeDasharray="2 3" />)}
            <Area type="monotone" dataKey="db" stroke="#22d3ee" strokeWidth={1.2} fill="url(#ld)" isAnimationActive={false} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function ClipCard({ clip, jobId, duration, sourceAssetId, hasTranscript, yt }: { clip: Clip; jobId: string; duration: number; sourceAssetId: string | null; hasTranscript: boolean; yt: YtSource | null }) {
  const router = useRouter();
  const [edit, setEdit] = React.useState(false);
  const [confirm, setConfirm] = React.useState(false);
  const inv = [["clip-job", jobId], ["clip-jobs"]];
  const render = useAction(() => api.post(`/api/v1/clips/${clip.id}/render`), { invalidate: inv, success: "Render queued" });
  const post = useAction(() => api.post<{ id: string }>(`/api/v1/clips/${clip.id}/post`), { success: "Draft post created", onSuccess: (p) => router.push(`/publishing?post=${p.id}`) });
  const remove = useAction(() => api.del(`/api/v1/clips/${clip.id}`), { invalidate: inv, success: "Clip removed" });
  const vertical = clip.renderSettings.aspect === "9:16";
  const busy = clip.status === "queued" || clip.status === "rendering";
  const score = clip.aiScore !== null ? Math.round(0.5 * clip.aiScore + 0.5 * clip.computedScore) : clip.computedScore;
  const manual = Object.keys(clip.scoreBreakdown).length === 0 && clip.aiScore === null;
  const embed = !!yt && clip.status === "embed";

  return (
    <Panel as="article" className="flex flex-col overflow-hidden">
      <div className={cn("relative mx-auto w-full bg-black", vertical && !embed ? "max-w-[260px]" : "")}>
        {embed ? (
          yt.embeddable ? (
            <iframe src={embedUrl(yt.videoId, clip.startSec, clip.endSec)} title={`Clip ${clip.rank}: ${clip.title}`} loading="lazy" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerPolicy="strict-origin-when-cross-origin" allowFullScreen className="aspect-video w-full" />
          ) : (
            <div className="grid aspect-video w-full place-items-center p-4 text-center text-xs text-muted">The owner turned off embedding for this video. Use Watch on YouTube.</div>
          )
        ) : clip.status === "ready" && clip.assetId ? (
          <video src={`/api/v1/media/${clip.assetId}/file`} poster={clip.thumbnailAssetId ? `/api/v1/media/${clip.thumbnailAssetId}/file` : undefined} controls preload="none" className={cn("w-full", vertical ? "aspect-[9/16]" : clip.renderSettings.aspect === "1:1" ? "aspect-square" : "aspect-video")} aria-label={`Clip ${clip.rank}: ${clip.title}`} />
        ) : sourceAssetId ? (
          <div className={cn("relative grid w-full place-items-center", vertical ? "aspect-[9/16]" : clip.renderSettings.aspect === "1:1" ? "aspect-square" : "aspect-video")}>
            <video src={`/api/v1/media/${sourceAssetId}/file#t=${clip.startSec},${clip.endSec}`} preload="metadata" muted className="absolute inset-0 size-full object-contain opacity-40" aria-hidden />
            <span className="relative flex items-center gap-2 rounded-full bg-ink/80 px-3 py-1.5 text-xs">{busy ? <><RotateCw className="size-3.5 animate-spin" />{clip.status === "queued" ? "Waiting to render" : "Rendering"}</> : clip.status === "failed" ? <><AlertTriangle className="size-3.5 text-danger" />Render failed</> : "Not rendered yet"}</span>
          </div>
        ) : null}
        <span className="absolute left-2 top-2 rounded bg-ink/80 px-1.5 py-0.5 text-xs font-semibold tabular-nums">#{clip.rank}</span>
      </div>
      <div className="flex flex-1 flex-col gap-3 p-4">
        <div>
          <h3 className="text-[14.5px] font-semibold leading-snug">{clip.title}</h3>
          <p className="mt-0.5 text-xs tabular-nums text-muted">{yt ? `${fmtS(clip.startSec)} to ${fmtS(clip.endSec)}, ${Math.round(clip.endSec - clip.startSec)}s` : `${fmtT(clip.startSec)} to ${fmtT(clip.endSec)}, ${(clip.endSec - clip.startSec).toFixed(1)}s`}{clip.renderInfo ? `, ${clip.renderInfo.width}×${clip.renderInfo.height}${clip.renderInfo.captions ? ", captions" : ""}` : ""}</p>
        </div>
        {manual ? <p className="text-xs text-muted">Added by you, not scored.</p> : <div className="grid grid-cols-[1fr_auto] items-end gap-3">
          <SignalMeter value={score} label={clip.aiScore !== null ? "Clip score (measured + AI)" : "Clip score (measured)"} />
          <Tooltip content={<div className="space-y-1">{Object.entries(clip.scoreBreakdown).map(([k, f]) => <p key={k}><span className="font-medium">{FACTOR[k] ?? k}</span> {Math.round(f.value * 100)}/100 ({Math.round(f.weight * 100)}%): {f.detail}</p>)}{clip.aiScore !== null && <p><span className="font-medium">AI estimate</span> {clip.aiScore}/100: {clip.aiReason}</p>}</div>}>
            <button className="text-faint hover:text-muted" aria-label="Score breakdown"><Info className="size-4" /></button>
          </Tooltip>
        </div>}
        <div className="flex flex-wrap gap-1">{!manual && <SourceTag source="computed" />}{clip.aiScore !== null && <SourceTag source="ai_estimate" />}{clip.hashtags.map((h) => <Badge key={h}>#{h}</Badge>)}</div>
        {clip.transcript && <p className="line-clamp-3 text-[13px] text-muted">&ldquo;{clip.transcript}&rdquo;</p>}
        {clip.error && <p className="text-xs text-danger">{clip.error}</p>}
        <div className="mt-auto flex flex-wrap gap-1.5 pt-1">
          {yt && (
            <>
              <a href={watchUrl(yt.videoId, clip.startSec)} target="_blank" rel="noopener noreferrer"><Button size="sm" variant={embed ? "primary" : "secondary"}><ExternalLink /> Watch on YouTube</Button></a>
              <Button size="sm" onClick={() => copy(watchUrl(yt.videoId, clip.startSec), "Timestamp link")}><Link2 /> Copy link</Button>
              {yt.embeddable && <Button size="sm" onClick={() => copy(embedCode(yt.videoId, clip.startSec, clip.endSec, clip.title), "Embed code")}><Code2 /> Copy embed</Button>}
            </>
          )}
          {embed ? null : clip.status === "ready" ? (
            <>
              <Button size="sm" variant="primary" onClick={() => post.mutate(undefined)} loading={post.isPending}><Send /> Create post</Button>
              <a href={`/api/v1/media/${clip.assetId}/file?download=1`}><Button size="sm"><Download /> Download</Button></a>
            </>
          ) : (
            <Button size="sm" variant="primary" onClick={() => render.mutate(undefined)} loading={render.isPending} disabled={busy}><Play /> {clip.status === "failed" ? "Retry render" : "Render"}</Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setEdit(true)} disabled={busy}><Scissors /> Edit</Button>
          <Button size="icon" variant="ghost" className="ml-auto" aria-label="Remove clip" onClick={() => setConfirm(true)}><Trash2 /></Button>
        </div>
      </div>
      {edit && <EditClip clip={clip} jobId={jobId} duration={duration} sourceAssetId={sourceAssetId} hasTranscript={hasTranscript} yt={yt} onClose={() => setEdit(false)} />}
      <ConfirmDialog open={confirm} onOpenChange={setConfirm} title="Remove this clip?" description="It's removed from this job. A rendered file stays in your Media Library." confirmLabel="Remove clip" onConfirm={() => remove.mutate(undefined)} loading={remove.isPending} />
    </Panel>
  );
}

function EditClip({ clip, jobId, duration, sourceAssetId, hasTranscript, yt, onClose }: { clip: Clip; jobId: string; duration: number; sourceAssetId: string | null; hasTranscript: boolean; yt: YtSource | null; onClose: () => void }) {
  const embed = !!yt && clip.status === "embed";
  const step = yt ? 1 : 0.5;
  const [previewKey, setPreviewKey] = React.useState(0);
  const [start, setStart] = React.useState(clip.startSec);
  const [end, setEnd] = React.useState(clip.endSec);
  const [title, setTitle] = React.useState(clip.title);
  const [caption, setCaption] = React.useState(clip.caption);
  const [hashtags, setHashtags] = React.useState(clip.hashtags.map((h) => `#${h}`).join(" "));
  const [render, setRender] = React.useState<RenderSettings>(clip.renderSettings);
  const preview = React.useRef<HTMLVideoElement>(null);
  const len = end - start;
  const problem = yt && (!Number.isInteger(start) || !Number.isInteger(end)) ? "Use whole seconds: YouTube's player only accepts whole seconds." : end > Math.ceil(duration) + 0.01 ? `Ends after the video (${duration.toFixed(1)}s).` : len < 1 ? "Clips must be at least 1 second." : len > 180 ? "Clips can be at most 3 minutes." : null;
  const timingChanged = Math.abs(start - clip.startSec) > 0.001 || Math.abs(end - clip.endSec) > 0.001 || (!embed && JSON.stringify(render) !== JSON.stringify(clip.renderSettings));
  const save = useAction(() => api.patch(`/api/v1/clips/${clip.id}`, { title, caption, hashtags: hashtags.split(/[\s,]+/).map((h) => h.replace(/^#+/, "")).filter(Boolean), ...(timingChanged ? { startSec: Number(start.toFixed(2)), endSec: Number(end.toFixed(2)), render } : {}) }), { invalidate: [["clip-job", jobId]], success: timingChanged && !embed ? "Saved. Re-rendering the clip." : "Clip saved", onSuccess: onClose });
  const nudge = (which: "start" | "end", d: number) => {
    const clamp = (v: number) => Math.max(0, Math.min(yt ? Math.ceil(duration) : duration, Number(v.toFixed(2))));
    if (which === "start") setStart(clamp(start + d));
    else setEnd(clamp(end + d));
  };
  const playRange = () => {
    if (embed) return setPreviewKey((k) => k + 1);
    const v = preview.current;
    if (!v) return;
    v.currentTime = start;
    void v.play();
    const stop = () => { if (v.currentTime >= end) { v.pause(); v.removeEventListener("timeupdate", stop); } };
    v.addEventListener("timeupdate", stop);
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={`Edit clip #${clip.rank}`} description={embed ? "Set the start and end in whole seconds and rewrite the title. The clip plays in YouTube's player." : "Trim, reframe and rewrite. Changing timing or output re-renders the clip."} wide footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => save.mutate(undefined)} loading={save.isPending} disabled={!!problem || !title.trim()}>{timingChanged && !embed ? "Save and re-render" : "Save"}</Button></>}>
      <div className="space-y-5">
        {embed && yt && (yt.embeddable ? <iframe key={previewKey} src={embedUrl(yt.videoId, start, Math.max(end, start + 1))} title="Clip preview" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerPolicy="strict-origin-when-cross-origin" allowFullScreen className="aspect-video w-full rounded-md bg-black" /> : <p className="text-[13px] text-muted">Embedding is off for this video. <a className="text-violet underline" href={watchUrl(yt.videoId, start)} target="_blank" rel="noopener noreferrer">Watch from {fmtS(start)} on YouTube</a>.</p>)}
        {sourceAssetId && <video ref={preview} src={`/api/v1/media/${sourceAssetId}/file`} preload="metadata" controls className="aspect-video w-full rounded-md bg-black" aria-label="Source video preview" />}
        <div className="grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          {(["start", "end"] as const).map((k) => (
            <Field key={k} label={k === "start" ? "Start (seconds)" : "End (seconds)"} htmlFor={`t-${k}`}>
              <div className="flex gap-1">
                <Button size="icon" variant="ghost" aria-label={`${k} earlier`} onClick={() => nudge(k, -step)}><Minus /></Button>
                <Input id={`t-${k}`} type="number" step={yt ? 1 : 0.1} min={0} max={duration} value={k === "start" ? start : end} onChange={(e) => (k === "start" ? setStart(Number(e.target.value)) : setEnd(Number(e.target.value)))} className="text-center tabular-nums" />
                <Button size="icon" variant="ghost" aria-label={`${k} later`} onClick={() => nudge(k, step)}><Plus /></Button>
              </div>
            </Field>
          ))}
          <Button onClick={playRange} disabled={!sourceAssetId && !(embed && yt?.embeddable)}><Play /> {embed ? `Preview ${Math.round(len)}s` : `Play ${len.toFixed(1)}s`}</Button>
        </div>
        {problem && <p role="alert" className="text-[13px] text-danger">{problem}</p>}
        {!embed && <RenderControls value={render} onChange={setRender} captionsAvailable={hasTranscript} />}
        <Field label="Title" htmlFor="c-title"><Input id="c-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} /></Field>
        <Field label="Caption" htmlFor="c-cap"><Textarea id="c-cap" rows={3} value={caption} onChange={(e) => setCaption(e.target.value)} maxLength={2200} /></Field>
        <Field label="Hashtags" htmlFor="c-tags"><Input id="c-tags" value={hashtags} onChange={(e) => setHashtags(e.target.value)} placeholder="#tag #another" /></Field>
        {clip.hook && <p className="flex items-center gap-1.5 text-xs text-muted"><Sparkles className="size-3.5" />Suggested hook: {clip.hook}</p>}
      </div>
    </Dialog>
  );
}

function YouTubeTimeline({ j, signals, duration }: { j: JobDetail; signals: YtSignals; duration: number }) {
  const retention = signals.retention;
  const bins = Math.min(120, Math.max(20, Math.round(duration / 10)));
  const data = retention?.length
    ? retention.map((p) => ({ t: Math.max(0, (p.ratio - 0.5 / retention.length) * duration), v: p.watch }))
    : Array.from({ length: bins }, (_, i) => {
        const a = (i * duration) / bins, b = ((i + 1) * duration) / bins;
        return { t: (a + b) / 2, v: Number(signals.mentions.filter((m) => m.t >= a && m.t < b).reduce((x, m) => x + m.weight, 0).toFixed(2)) };
      });
  const hasData = retention?.length || signals.mentions.length;
  if (!hasData && !signals.chapters.length) return null;
  const label = retention?.length ? "Audience retention across the video, with clips highlighted" : "Viewer timestamps across the video, with clips highlighted";
  const help = retention?.length ? "Audience watch ratio from YouTube Analytics (100 points across the video). Above 1 means parts were rewatched. Dashed lines are chapter starts." : "How often viewers' comments point at each part of the video, weighted by likes. Dashed lines are chapter starts.";
  return (
    <div className="border-t border-line-soft px-3 pb-3 pt-3">
      <p className="mb-1 flex items-center gap-1.5 px-2 text-xs text-muted">{label} <HelpTip text={help} /></p>
      <div className="h-28" aria-label={label}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
            <defs><linearGradient id="ytd" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#22d3ee" stopOpacity={0.35} /><stop offset="100%" stopColor="#22d3ee" stopOpacity={0} /></linearGradient></defs>
            <XAxis dataKey="t" type="number" domain={[0, duration]} tick={{ fill: "#8d93ad", fontSize: 10 }} tickFormatter={(v: number) => fmtS(v)} tickLine={false} axisLine={false} />
            <YAxis tick={{ fill: "#8d93ad", fontSize: 10 }} tickLine={false} axisLine={false} width={40} tickFormatter={(v: number) => (retention?.length ? v.toFixed(1) : String(Math.round(v)))} />
            <RTooltip contentStyle={{ background: "#1e2540", border: "1px solid #2a3150", fontSize: 12 }} labelFormatter={(v) => fmtS(Number(v))} formatter={(v) => [String(v), retention?.length ? "Audience watch ratio" : "Timestamp mentions"]} />
            {j.clips.map((c) => <ReferenceArea key={c.id} x1={c.startSec} x2={c.endSec} fill="#7c5cff" fillOpacity={0.18} stroke="#7c5cff" strokeOpacity={0.5} label={{ value: `#${c.rank}`, fill: "#a491ff", fontSize: 11, position: "insideTopLeft" }} />)}
            {signals.chapters.map((c) => <ReferenceLine key={c.start} x={c.start} stroke="#5d6383" strokeDasharray="2 3" />)}
            <Area type="monotone" dataKey="v" stroke="#22d3ee" strokeWidth={1.2} fill="url(#ytd)" isAnimationActive={false} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function YouTubeJobActions({ j, yt }: { j: JobDetail; yt: YtSource }) {
  const [adding, setAdding] = React.useState(false);
  const [assetId, setAssetId] = React.useState<string | null>(null);
  const inv = [["clip-job", j.id], ["clip-jobs"]];
  const attach = useAction(() => api.post(`/api/v1/clips/jobs/${j.id}/attach`, { assetId }), { invalidate: inv, success: "File attached. Render the clips you want." });
  return (
    <div className="space-y-3 border-t border-line-soft px-5 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => setAdding(true)}><Plus /> Add a clip</Button>
        <span className="text-xs text-muted">Mark any moment by its start and end time.</span>
      </div>
      {yt.owned && !j.sourceAsset && (
        <div className="rounded-md border border-line-soft p-3">
          <p className="flex items-center gap-1.5 text-[13px] font-medium"><Paperclip className="size-4" />Render real clips from your original file</p>
          <p className="mt-0.5 text-xs text-muted">This video is on your connected channel. Attach the file you uploaded to YouTube ({fmtS(yt.duration)} long) to render vertical clips with captions from it.</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <MediaPicker value={assetId} onChange={(id) => setAssetId(id)} kind="video" label="Choose your original file" />
            <Button size="sm" variant="primary" disabled={!assetId} loading={attach.isPending} onClick={() => attach.mutate(undefined)}>Attach file</Button>
          </div>
        </div>
      )}
      {j.sourceAsset && <p className="flex items-center gap-1.5 text-xs text-muted"><Paperclip className="size-3.5" />Rendering from your file {j.sourceAsset.filename}.</p>}
      {adding && <AddClipDialog jobId={j.id} duration={yt.duration} onClose={() => setAdding(false)} />}
    </div>
  );
}

function AddClipDialog({ jobId, duration, onClose }: { jobId: string; duration: number; onClose: () => void }) {
  const [start, setStart] = React.useState("");
  const [end, setEnd] = React.useState("");
  const [title, setTitle] = React.useState("");
  const s = parseTimeInput(start), e = parseTimeInput(end);
  const problem = !start || !end ? null : s === null || e === null ? "Use a time like 1:05 or 65." : e - s < 1 ? "The end must be at least 1 second after the start." : e - s > 180 ? "Clips can be at most 3 minutes." : e > Math.ceil(duration) ? `The video is ${fmtS(duration)} long.` : null;
  const add = useAction(() => api.post(`/api/v1/clips/jobs/${jobId}/clips`, { startSec: s, endSec: e, title: title.trim() || undefined }), { invalidate: [["clip-job", jobId], ["clip-jobs"]], success: "Clip added", onSuccess: onClose });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Add a clip" description="Times are in whole seconds, as YouTube's player requires." footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => add.mutate(undefined)} loading={add.isPending} disabled={!start || !end || !!problem}>Add clip</Button></>}>
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Start" htmlFor="m-start"><Input id="m-start" value={start} onChange={(ev) => setStart(ev.target.value)} placeholder="1:05" inputMode="numeric" /></Field>
          <Field label="End" htmlFor="m-end"><Input id="m-end" value={end} onChange={(ev) => setEnd(ev.target.value)} placeholder="1:40" inputMode="numeric" /></Field>
        </div>
        {problem && <p role="alert" className="text-[13px] text-danger">{problem}</p>}
        <Field label="Title (optional)" htmlFor="m-title"><Input id="m-title" value={title} onChange={(ev) => setTitle(ev.target.value)} maxLength={120} /></Field>
      </div>
    </Dialog>
  );
}
