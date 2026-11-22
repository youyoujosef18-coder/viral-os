"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { PenLine, Plus, Copy, Download, History, Wand2, Sparkles, Scissors, Expand, Languages, MessageSquareQuote, RotateCcw, Trash2, Check, Loader2, Shuffle, Mic } from "lucide-react";
import { api, errorText } from "@/lib/client/api";
import { useAction, useApiQuery, useMe } from "@/lib/client/hooks";
import { Badge, Button, ConfirmDialog, Dialog, EmptyState, ErrorState, Field, Input, Menu, PageHeader, Panel, PanelHeader, Select, SkeletonRows, SourceTag, TabPanel, Tabs, Textarea, Tooltip } from "@/components/ui/primitives";
import { NotConfigured } from "@/components/ui/domain";
import { cn, fmtRelative } from "@/lib/client/utils";

type Scene = { title: string; voiceover: string; visual: string; onScreenText: string; broll?: string; transition?: string; durationSeconds?: number };
type Content = { hook: string; scenes: Scene[]; editingInstructions: string; cta: string; caption: string; hashtags: string[]; titleOptions: string[]; description?: string; pinnedComment?: string; repurposingIdeas?: string[] };
type Script = { id: string; title: string; platform: string; controls: Record<string, unknown>; content: Content; version: number; generatedBy: string | null; projectId: string | null; updatedAt: string };
type ScriptListItem = Pick<Script, "id" | "title" | "platform" | "version" | "updatedAt" | "projectId" | "generatedBy">;

const PLATFORMS = ["YouTube", "YouTube Shorts", "TikTok", "Instagram Reels", "Instagram Carousel"];
const HOOKS = ["curiosity", "storytelling", "problem-solution", "bold claim", "question", "viral pattern interrupt"];
const TONES = ["conversational", "energetic", "authoritative", "playful", "calm", "inspirational", "humorous", "professional"];
const STYLES = ["educational", "marketing", "sales", "storytelling", "tutorial", "voiceover / faceless", "entertainment"];
const GOALS = ["grow audience", "drive engagement", "sell a product", "build authority", "get comments", "drive link clicks"];

export default function ScriptsPage() {
  const params = useSearchParams();
  const router = useRouter();
  const [selected, setSelected] = React.useState<string | null>(params.get("id"));
  const [creating, setCreating] = React.useState(!!params.get("new") || !params.get("id"));
  const list = useApiQuery<ScriptListItem[]>(["scripts"], "/api/v1/scripts");


  return (
    <div>
      <PageHeader title="AI Script Studio" description="Generate scene-by-scene scripts with hooks, voiceover, visuals, on-screen text, B-roll and captions. Edit anything; every change autosaves with version history." actions={<Button variant="primary" onClick={() => { setCreating(true); setSelected(null); }}><Plus /> New script</Button>} />
      <div className="grid gap-5 lg:grid-cols-[260px_1fr]">
        <Panel as="div" className="h-fit max-h-[70vh] overflow-y-auto p-2">
          {list.isLoading ? <SkeletonRows rows={4} /> : list.data?.length ? (
            <ul>
              {list.data.map((s) => (
                <li key={s.id}>
                  <button onClick={() => { setSelected(s.id); setCreating(false); router.replace(`/scripts?id=${s.id}`); }} className={cn("w-full rounded-md px-3 py-2 text-left", selected === s.id && !creating ? "bg-raised" : "hover:bg-raised/50")}>
                    <span className="line-clamp-2 text-[13.5px]">{s.title}</span>
                    <span className="mt-0.5 block text-xs text-faint">{s.platform}, edited {fmtRelative(s.updatedAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : <p className="p-3 text-[13px] text-muted">Your scripts appear here.</p>}
        </Panel>
        <div className="min-w-0">
          {creating ? <Generator projectId={params.get("project")} onCreated={(id) => { setCreating(false); setSelected(id); router.replace(`/scripts?id=${id}`); }} /> : selected ? <Editor key={selected} id={selected} onDeleted={() => { setSelected(null); setCreating(true); }} /> : <Panel><EmptyState icon={PenLine} title="No script selected" /></Panel>}
        </div>
      </div>
    </div>
  );
}

function Generator({ projectId, onCreated }: { projectId: string | null; onCreated: (id: string) => void }) {
  const { data: me } = useMe();
  const [tab, setTab] = React.useState("script");
  const [c, setC] = React.useState({ topic: "", platform: "TikTok", language: "English", audience: "", tone: "conversational", lengthSeconds: 45, contentStyle: "educational", goal: "grow audience", hookType: "curiosity", ctaType: "follow for more", readingLevel: "standard" });
  const set = (k: keyof typeof c) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setC({ ...c, [k]: k === "lengthSeconds" ? Number(e.target.value) : e.target.value });
  const gen = useAction(() => api.post<Script>("/api/v1/scripts", { ...c, audience: c.audience || me?.niche || "general audience", projectId }), { invalidate: [["scripts"]], silentError: true, success: "Script generated", onSuccess: (s) => onCreated(s.id) });
  const hooks = useAction(() => api.post<{ hooks: { type: string; text: string; whyItWorks: string }[] }>("/api/v1/ai/hooks", { topic: c.topic, platform: c.platform, language: c.language }), { silentError: true });
  const [assetKind, setAssetKind] = React.useState("titles");
  const assets = useAction(() => api.post<{ items: string[] }>("/api/v1/ai/assets", { kind: assetKind, topic: c.topic, platform: c.platform, language: c.language }), { silentError: true });
  const topicOk = c.topic.trim().length >= 3;
  const err = gen.error ?? hooks.error ?? assets.error;

  return (
    <Panel>
      <PanelHeader title="Write with AI" description="Describe the video and set the controls. The topic is the only required field." />
      <div className="space-y-4 border-t border-line-soft p-5">
        <Field label="Topic" htmlFor="s-topic" hint="What is the video about? Be specific: the more context, the better the script."><Textarea id="s-topic" rows={2} value={c.topic} onChange={set("topic")} placeholder="e.g. 3 mistakes beginners make with their first espresso machine" /></Field>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Platform" htmlFor="s-plat"><Select id="s-plat" value={c.platform} onChange={set("platform")}>{PLATFORMS.map((p) => <option key={p}>{p}</option>)}</Select></Field>
          <Field label="Length" htmlFor="s-len"><Select id="s-len" value={c.lengthSeconds} onChange={set("lengthSeconds")}>{[[15, "15 seconds"], [30, "30 seconds"], [45, "45 seconds"], [60, "60 seconds"], [90, "90 seconds"], [180, "3 minutes"], [480, "8 minutes"], [720, "12 minutes"], [1200, "20 minutes"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></Field>
          <Field label="Language" htmlFor="s-lang"><Select id="s-lang" value={c.language} onChange={set("language")}>{["English", "French", "Arabic", "Spanish", "German", "Portuguese", "Italian", "Turkish"].map((l) => <option key={l}>{l}</option>)}</Select></Field>
          <Field label="Tone" htmlFor="s-tone"><Select id="s-tone" value={c.tone} onChange={set("tone")}>{TONES.map((t) => <option key={t}>{t}</option>)}</Select></Field>
          <Field label="Style" htmlFor="s-style"><Select id="s-style" value={c.contentStyle} onChange={set("contentStyle")}>{STYLES.map((t) => <option key={t}>{t}</option>)}</Select></Field>
          <Field label="Goal" htmlFor="s-goal"><Select id="s-goal" value={c.goal} onChange={set("goal")}>{GOALS.map((t) => <option key={t}>{t}</option>)}</Select></Field>
          <Field label="Hook type" htmlFor="s-hook"><Select id="s-hook" value={c.hookType} onChange={set("hookType")}>{HOOKS.map((t) => <option key={t}>{t}</option>)}</Select></Field>
          <Field label="Call to action" htmlFor="s-cta"><Input id="s-cta" value={c.ctaType} onChange={set("ctaType")} /></Field>
          <Field label="Reading level" htmlFor="s-read"><Select id="s-read" value={c.readingLevel} onChange={set("readingLevel")}><option value="simple">Simple</option><option value="standard">Standard</option><option value="advanced">Advanced</option></Select></Field>
        </div>
        <Field label="Audience" htmlFor="s-aud" hint={me?.niche ? `Defaults to your niche: ${me.niche}` : undefined}><Input id="s-aud" value={c.audience} onChange={set("audience")} placeholder="Who is watching?" /></Field>
      </div>
      <div className="border-t border-line-soft px-5 pt-4">
        <Tabs value={tab} onValueChange={setTab} items={[{ value: "script", label: "Full script" }, { value: "hooks", label: "Hooks only" }, { value: "assets", label: "Titles, captions and more" }]}>
          <TabPanel value="script" className="pb-5"><Button variant="primary" size="lg" onClick={() => gen.mutate(undefined)} loading={gen.isPending} disabled={!topicOk}><Sparkles /> Generate script</Button></TabPanel>
          <TabPanel value="hooks" className="pb-5">
            <Button onClick={() => hooks.mutate(undefined)} loading={hooks.isPending} disabled={!topicOk}><MessageSquareQuote /> Generate 12 hooks</Button>
            {hooks.data && (
              <div className="mt-4 grid gap-3 md:grid-cols-2">
                {hooks.data.hooks.map((h, i) => (
                  <div key={i} className="rounded-md border border-line-soft bg-ink-2 p-3">
                    <div className="mb-1 flex items-center justify-between"><Badge tone="violet">{h.type}</Badge><CopyBtn text={h.text} /></div>
                    <p className="text-[13.5px]">{h.text}</p><p className="mt-1 text-xs text-muted">{h.whyItWorks}</p>
                  </div>
                ))}
              </div>
            )}
          </TabPanel>
          <TabPanel value="assets" className="pb-5">
            <div className="flex flex-wrap gap-2">
              <Select value={assetKind} onChange={(e) => setAssetKind(e.target.value)} className="w-48" aria-label="What to generate">{[["titles", "Title variations"], ["descriptions", "Descriptions"], ["captions", "Caption ideas"], ["hashtags", "Hashtags"], ["pinned_comments", "Pinned comments"], ["ctas", "Calls to action"], ["repurposing", "Repurposing ideas"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
              <Button onClick={() => assets.mutate(undefined)} loading={assets.isPending} disabled={!topicOk}><Wand2 /> Generate</Button>
            </div>
            {assets.data && <ul className="mt-4 divide-y divide-line-soft rounded-md border border-line-soft">{assets.data.items.map((t, i) => <li key={i} className="flex items-start justify-between gap-3 px-3 py-2 text-[13.5px]"><span>{assetKind === "hashtags" ? `#${t.replace(/^#/, "")}` : t}</span><CopyBtn text={t} /></li>)}</ul>}
          </TabPanel>
        </Tabs>
      </div>
      {err && <><NotConfigured error={err} title="Script generation needs an AI provider" />{!(err as { notConfigured?: boolean }).notConfigured && <ErrorState error={err} />}</>}
    </Panel>
  );
}

function downloadFile(url: string) {
  const a = document.createElement("a");
  a.href = url;
  a.download = "";
  a.click();
}

function CopyBtn({ text, label }: { text: string; label?: string }) {
  const [done, setDone] = React.useState(false);
  return (
    <Button size={label ? "sm" : "icon"} variant="ghost" className={label ? "" : "size-7"} aria-label={label ?? "Copy"} onClick={async () => { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500); }}>
      {done ? <Check className="text-success" /> : <Copy />}{label}
    </Button>
  );
}

function scriptText(title: string, c: Content) {
  return [title, "", `HOOK: ${c.hook}`, "", ...c.scenes.flatMap((s, i) => [`SCENE ${i + 1}: ${s.title}`, `VO: ${s.voiceover}`, `VISUAL: ${s.visual}`, `ON-SCREEN: ${s.onScreenText}`, s.broll ? `B-ROLL: ${s.broll}` : "", ""]), `CTA: ${c.cta}`, "", `CAPTION: ${c.caption}`, c.hashtags.map((h) => `#${h.replace(/^#/, "")}`).join(" ")].filter((l) => l !== undefined).join("\n");
}

type SaveState = "saved" | "saving" | "dirty" | "error";

function Editor({ id, onDeleted }: { id: string; onDeleted: () => void }) {
  const script = useApiQuery<Script>(["script", id], `/api/v1/scripts/${id}`);
  if (script.error) return <Panel><ErrorState error={script.error} onRetry={() => script.refetch()} /></Panel>;
  if (script.isLoading || !script.data) return <Panel><SkeletonRows rows={8} /></Panel>;
  return <EditorInner id={id} s={script.data} onDeleted={onDeleted} />;
}

function EditorInner({ id, s, onDeleted }: { id: string; s: Script; onDeleted: () => void }) {
  const qc = useQueryClient();
  const [content, setContent] = React.useState<Content>(s.content);
  const [title, setTitle] = React.useState(s.title);
  const [state, setState] = React.useState<SaveState>("saved");
  const [versionsOpen, setVersionsOpen] = React.useState(false);
  const [variationsOpen, setVariationsOpen] = React.useState(false);
  const [confirm, setConfirm] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = React.useRef<{ content: Content; title: string } | null>(null);

  const persist = React.useCallback(async (reason: "autosave" | "ai_edit" | "restore" = "autosave") => {
    if (!latest.current) return;
    setState("saving");
    try {
      await api.put(`/api/v1/scripts/${id}`, { content: latest.current.content, title: latest.current.title, reason });
      setState("saved");
      qc.invalidateQueries({ queryKey: ["scripts"] });
    } catch (err) {
      setState("error");
      toast.error(`Autosave failed: ${errorText(err)}`);
    }
  }, [id, qc]);

  const update = (next: Content, nextTitle = title, immediate?: "ai_edit" | "restore") => {
    setContent(next);
    setTitle(nextTitle);
    latest.current = { content: next, title: nextTitle };
    setState("dirty");
    if (timer.current) clearTimeout(timer.current);
    if (immediate) void persist(immediate);
    else timer.current = setTimeout(() => void persist(), 1200);
  };
  React.useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  React.useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (state === "dirty" || state === "saving") e.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [state]);

  const remove = useAction(() => api.del(`/api/v1/scripts/${id}`), { invalidate: [["scripts"]], success: "Script deleted", onSuccess: onDeleted });

  const lang = String(s.controls.language ?? "English");
  const setScene = (i: number, patch: Partial<Scene>) => update({ ...content, scenes: content.scenes.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
  const totalSeconds = content.scenes.reduce((a, x) => a + (x.durationSeconds ?? 0), 0);
  const words = [content.hook, ...content.scenes.map((x) => x.voiceover), content.cta].join(" ").split(/\s+/).filter(Boolean).length;

  return (
    <div className="space-y-4">
      <Panel className="sticky top-16 z-10 flex flex-wrap items-center gap-3 px-4 py-3">
        <Input value={title} onChange={(e) => update(content, e.target.value)} className="h-9 min-w-0 flex-1 border-transparent bg-transparent text-[16px] font-semibold focus:bg-ink-2" aria-label="Script title" />
        <span className="flex items-center gap-1.5 text-xs text-muted" aria-live="polite">
          {state === "saving" ? <><Loader2 className="size-3.5 animate-spin" />Saving</> : state === "dirty" ? "Unsaved changes" : state === "error" ? <span className="text-danger">Not saved</span> : <><Check className="size-3.5 text-success" />Saved, v{s.version}</>}
        </span>
        <CopyBtn text={scriptText(title, content)} label="Copy" />
        <Menu trigger={<Button size="sm"><Download /> Export</Button>} items={(["md", "txt", "json"] as const).map((f) => ({ label: f === "md" ? "Markdown (.md)" : f === "txt" ? "Plain text (.txt)" : "JSON", onSelect: () => downloadFile(`/api/v1/scripts/${id}/export?format=${f}`) }))} />
        <Button size="sm" variant="ghost" onClick={() => setVariationsOpen(true)}><Shuffle /> Variations</Button>
        <Button size="sm" variant="ghost" onClick={() => setVersionsOpen(true)}><History /> History</Button>
        <Button size="icon" variant="ghost" aria-label="Delete script" onClick={() => setConfirm(true)}><Trash2 /></Button>
      </Panel>

      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <Badge>{s.platform}</Badge><Badge>{lang}</Badge><Badge>{String(s.controls.tone ?? "")}</Badge>
        <span>{content.scenes.length} scenes, ~{totalSeconds || "?"}s, {words} spoken words</span>
        {s.generatedBy && <SourceTag source="ai_estimate" />}
      </div>

      <Panel>
        <PanelHeader title="Hook" description="The first 1–3 seconds. Make it honest and specific." />
        <div className="px-5 pb-5"><TextSection value={content.hook} onChange={(v) => update({ ...content, hook: v })} onAi={(v) => update({ ...content, hook: v }, title, "ai_edit")} language={lang} isHook context={String(s.controls.topic ?? "")} rows={2} /></div>
      </Panel>

      <Panel>
        <PanelHeader title="Scenes" description="Voiceover, visual direction, on-screen text, B-roll and transitions." actions={<Button size="sm" variant="ghost" onClick={() => update({ ...content, scenes: [...content.scenes, { title: "New scene", voiceover: "", visual: "", onScreenText: "", broll: "", transition: "", durationSeconds: 5 }] })}><Plus /> Add scene</Button>} />
        <ol className="divide-y divide-line-soft border-t border-line-soft">
          {content.scenes.map((sc, i) => (
            <li key={i} className="grid gap-3 p-5 xl:grid-cols-[180px_1fr]">
              <div className="space-y-2">
                <p className="text-xs text-faint">Scene {i + 1}</p>
                <Input value={sc.title} onChange={(e) => setScene(i, { title: e.target.value })} aria-label={`Scene ${i + 1} title`} className="font-medium" />
                <div className="flex items-center gap-2"><Input type="number" min={1} max={600} value={sc.durationSeconds ?? ""} onChange={(e) => setScene(i, { durationSeconds: Number(e.target.value) || undefined })} aria-label="Duration in seconds" className="w-20" /><span className="text-xs text-muted">seconds</span></div>
                <Button size="sm" variant="ghost" onClick={() => update({ ...content, scenes: content.scenes.filter((_, j) => j !== i) })} disabled={content.scenes.length <= 1}><Trash2 /> Remove</Button>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <div className="md:col-span-2"><p className="mb-1 flex items-center gap-1.5 text-xs text-muted"><Mic className="size-3.5" />Voiceover</p><TextSection value={sc.voiceover} onChange={(v) => setScene(i, { voiceover: v })} onAi={(v) => { const next = { ...content, scenes: content.scenes.map((x, j) => (j === i ? { ...x, voiceover: v } : x)) }; update(next, title, "ai_edit"); }} language={lang} context={`Hook: ${content.hook}`} rows={3} /></div>
                <div><p className="mb-1 text-xs text-muted">Visual direction</p><Textarea rows={2} value={sc.visual} onChange={(e) => setScene(i, { visual: e.target.value })} aria-label="Visual direction" /></div>
                <div><p className="mb-1 text-xs text-muted">On-screen text</p><Textarea rows={2} value={sc.onScreenText} onChange={(e) => setScene(i, { onScreenText: e.target.value })} aria-label="On-screen text" /></div>
                <div><p className="mb-1 text-xs text-muted">B-roll</p><Textarea rows={2} value={sc.broll ?? ""} onChange={(e) => setScene(i, { broll: e.target.value })} aria-label="B-roll" /></div>
                <div><p className="mb-1 text-xs text-muted">Transition</p><Input value={sc.transition ?? ""} onChange={(e) => setScene(i, { transition: e.target.value })} aria-label="Transition" /></div>
              </div>
            </li>
          ))}
        </ol>
      </Panel>

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel><PanelHeader title="Editing instructions" /><div className="px-5 pb-5"><TextSection value={content.editingInstructions} onChange={(v) => update({ ...content, editingInstructions: v })} onAi={(v) => update({ ...content, editingInstructions: v }, title, "ai_edit")} language={lang} rows={4} /></div></Panel>
        <Panel><PanelHeader title="Call to action" /><div className="px-5 pb-5"><TextSection value={content.cta} onChange={(v) => update({ ...content, cta: v })} onAi={(v) => update({ ...content, cta: v }, title, "ai_edit")} language={lang} rows={2} /></div></Panel>
        <Panel><PanelHeader title="Caption" actions={<span className="text-xs tabular-nums text-faint">{content.caption.length}/2200</span>} /><div className="px-5 pb-5"><TextSection value={content.caption} onChange={(v) => update({ ...content, caption: v })} onAi={(v) => update({ ...content, caption: v }, title, "ai_edit")} language={lang} rows={4} /></div></Panel>
        <Panel>
          <PanelHeader title="Hashtags" actions={<CopyBtn text={content.hashtags.map((h) => `#${h.replace(/^#/, "")}`).join(" ")} />} />
          <div className="px-5 pb-5"><Textarea rows={3} value={content.hashtags.map((h) => `#${h.replace(/^#/, "")}`).join(" ")} onChange={(e) => update({ ...content, hashtags: e.target.value.split(/[\s,]+/).map((h) => h.replace(/^#+/, "")).filter(Boolean) })} aria-label="Hashtags" /></div>
        </Panel>
        <Panel>
          <PanelHeader title="Title options" />
          <ul className="space-y-2 px-5 pb-5">
            {content.titleOptions.map((t, i) => (
              <li key={i} className="flex items-center gap-2">
                <Input value={t} onChange={(e) => update({ ...content, titleOptions: content.titleOptions.map((x, j) => (j === i ? e.target.value : x)) })} aria-label={`Title option ${i + 1}`} />
                <span className={cn("w-10 shrink-0 text-right text-xs tabular-nums", t.length > 100 ? "text-danger" : "text-faint")}>{t.length}</span>
                <Tooltip content="Use as script title"><Button size="icon" variant="ghost" aria-label="Use as title" onClick={() => update(content, t)}><Check /></Button></Tooltip>
              </li>
            ))}
          </ul>
        </Panel>
        <Panel><PanelHeader title="Description" /><div className="px-5 pb-5"><TextSection value={content.description ?? ""} onChange={(v) => update({ ...content, description: v })} onAi={(v) => update({ ...content, description: v }, title, "ai_edit")} language={lang} rows={4} /></div></Panel>
        <Panel><PanelHeader title="Pinned comment" /><div className="px-5 pb-5"><TextSection value={content.pinnedComment ?? ""} onChange={(v) => update({ ...content, pinnedComment: v })} onAi={(v) => update({ ...content, pinnedComment: v }, title, "ai_edit")} language={lang} rows={2} /></div></Panel>
        {!!content.repurposingIdeas?.length && <Panel><PanelHeader title="Repurposing ideas" /><ul className="list-disc space-y-1 px-5 pb-5 pl-9 text-[13.5px] text-muted">{content.repurposingIdeas.map((r) => <li key={r}>{r}</li>)}</ul></Panel>}
      </div>

      <VersionsDialog open={versionsOpen} onOpenChange={setVersionsOpen} scriptId={id} onRestore={(c) => { update(c, title, "restore"); setVersionsOpen(false); toast.success("Version restored"); }} />
      <VariationsDialog open={variationsOpen} onOpenChange={setVariationsOpen} controls={s.controls} onUse={(c) => { update(c, title, "ai_edit"); setVariationsOpen(false); toast.success("Variation applied. The previous version is in History."); }} />
      <ConfirmDialog open={confirm} onOpenChange={setConfirm} title="Delete this script?" description="All versions are deleted too." confirmLabel="Delete script" onConfirm={() => remove.mutate(undefined)} loading={remove.isPending} />
    </div>
  );
}

/** Editable text with AI operations for the selected section. */
function TextSection({ value, onChange, onAi, language, isHook, context, rows = 3 }: { value: string; onChange: (v: string) => void; onAi: (v: string) => void; language: string; isHook?: boolean; context?: string; rows?: number }) {
  const [busy, setBusy] = React.useState<string | null>(null);
  const [instr, setInstr] = React.useState<{ op: "change_tone" | "translate" | "rewrite"; value: string } | null>(null);
  const run = async (op: string, extra: Record<string, string> = {}) => {
    if (!value.trim()) return toast.info("Write something first, or generate a full script.");
    setBusy(op);
    try {
      const r = await api.post<{ text: string }>("/api/v1/ai/edit", { op, text: value, language, context, ...extra });
      onAi(r.text);
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setBusy(null);
    }
  };
  const tools = [
    { op: "regenerate", label: "Regenerate", icon: RotateCcw },
    { op: "shorten", label: "Shorten", icon: Scissors },
    { op: "expand", label: "Expand", icon: Expand },
    ...(isHook ? [{ op: "improve_hook", label: "Improve hook", icon: Sparkles }] : []),
    { op: "make_natural", label: "Make natural", icon: MessageSquareQuote },
  ];
  return (
    <div>
      <Textarea rows={rows} value={value} onChange={(e) => onChange(e.target.value)} />
      <div className="mt-1.5 flex flex-wrap gap-1" role="toolbar" aria-label="AI editing tools">
        {tools.map((t) => (
          <Button key={t.op} size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => run(t.op)} loading={busy === t.op} disabled={!!busy}><t.icon />{t.label}</Button>
        ))}
        <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setInstr({ op: "change_tone", value: "more energetic" })} disabled={!!busy}><Wand2 />Change tone</Button>
        <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setInstr({ op: "translate", value: "Spanish" })} disabled={!!busy}><Languages />Translate</Button>
        <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setInstr({ op: "rewrite", value: "" })} disabled={!!busy}><PenLine />Rewrite</Button>
      </div>
      <Dialog open={!!instr} onOpenChange={(o) => !o && setInstr(null)} title={instr?.op === "translate" ? "Translate to" : instr?.op === "change_tone" ? "Change tone" : "Rewrite with instruction"} footer={<Button variant="primary" loading={!!busy} onClick={async () => { if (!instr) return; const extra: Record<string, string> = instr.op === "translate" ? { language: instr.value } : instr.op === "change_tone" ? { tone: instr.value } : { instruction: instr.value }; await run(instr.op, extra); setInstr(null); }}>Apply</Button>}>
        <Input autoFocus value={instr?.value ?? ""} onChange={(e) => instr && setInstr({ ...instr, value: e.target.value })} placeholder={instr?.op === "rewrite" ? "e.g. make it funnier and mention the price" : ""} aria-label="Instruction" />
      </Dialog>
    </div>
  );
}

function VersionsDialog({ open, onOpenChange, scriptId, onRestore }: { open: boolean; onOpenChange: (o: boolean) => void; scriptId: string; onRestore: (c: Content) => void }) {
  const versions = useApiQuery<{ id: string; version: number; content: Content; reason: string | null; createdAt: string }[]>(["script-versions", scriptId], open ? `/api/v1/scripts/${scriptId}/versions` : null);
  const [preview, setPreview] = React.useState<string | null>(null);
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Version history" description="The last 50 versions are kept." wide>
      {versions.isLoading ? <SkeletonRows /> : (
        <ul className="divide-y divide-line-soft rounded-md border border-line-soft">
          {versions.data?.map((v) => (
            <li key={v.id} className="px-3 py-2">
              <div className="flex items-center gap-3">
                <span className="text-[13px] font-medium">v{v.version}</span>
                <Badge>{(v.reason ?? "edit").replace("_", " ")}</Badge>
                <span className="flex-1 text-xs text-muted">{fmtRelative(v.createdAt)}</span>
                <Button size="sm" variant="ghost" onClick={() => setPreview(preview === v.id ? null : v.id)}>{preview === v.id ? "Hide" : "Preview"}</Button>
                <Button size="sm" onClick={() => onRestore(v.content)}>Restore</Button>
              </div>
              {preview === v.id && <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap rounded bg-ink-2 p-3 text-xs text-muted">{scriptText("", v.content)}</pre>}
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}

function VariationsDialog({ open, onOpenChange, controls, onUse }: { open: boolean; onOpenChange: (o: boolean) => void; controls: Record<string, unknown>; onUse: (c: Content) => void }) {
  const gen = useAction(() => api.post<{ variations: { label: string; content: Content }[] }>("/api/v1/ai/variations", controls), { silentError: true });
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Script variations" description="Three different structures for the same brief. Using one replaces the current script; the old one stays in History." wide footer={<Button variant="primary" onClick={() => gen.mutate(undefined)} loading={gen.isPending}><Shuffle /> {gen.data ? "Generate again" : "Generate variations"}</Button>}>
      {gen.error && <><NotConfigured error={gen.error} />{!(gen.error as { notConfigured?: boolean }).notConfigured && <ErrorState error={gen.error} />}</>}
      {gen.isPending && <SkeletonRows rows={4} />}
      {gen.data && (
        <div className="grid gap-3 md:grid-cols-3">
          {gen.data.variations.map((v, i) => (
            <div key={i} className="flex flex-col rounded-md border border-line-soft bg-ink-2 p-3">
              <Badge tone="violet">{v.label}</Badge>
              <p className="mt-2 text-[13.5px] font-medium">{v.content.hook}</p>
              <p className="mt-1 flex-1 text-xs text-muted">{v.content.scenes.length} scenes: {v.content.scenes.map((s) => s.title).join(", ")}</p>
              <Button size="sm" className="mt-3" onClick={() => onUse(v.content)}>Use this version</Button>
            </div>
          ))}
        </div>
      )}
      {!gen.data && !gen.isPending && !gen.error && <p className="text-[13px] text-muted">Generate to compare alternative hooks and structures.</p>}
    </Dialog>
  );
}
