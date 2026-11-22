"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Workflow, Plus, Play, Trash2, ChevronUp, ChevronDown, X, Pencil, CheckCircle2, XCircle } from "lucide-react";
import { api } from "@/lib/client/api";
import { useAction, useApiQuery, useMe } from "@/lib/client/hooks";
import { Badge, Button, ConfirmDialog, Dialog, EmptyState, ErrorState, Field, Input, PageHeader, Panel, Select, SkeletonRows, Switch, Textarea } from "@/components/ui/primitives";
import { StatusBadge } from "@/components/ui/domain";
import { fmtDate, fmtRelative } from "@/lib/client/utils";

type Trigger = { type: "schedule"; cron: string; timezone: string } | { type: "post_published" | "post_failed"; platform?: string } | { type: "trend_alert"; watchlistId?: string } | { type: "manual" };
type Step = { type: "notify"; title: string; body?: string } | { type: "sync_analytics" } | { type: "refresh_trends"; region?: string } | { type: "generate_ideas"; niche: string; count: number } | { type: "run_agent"; agentId: string; input: string } | { type: "retry_failed_posts" };
type WorkflowRow = { id: string; name: string; description: string | null; enabled: boolean; trigger: Trigger; steps: Step[]; lastRunAt: string | null; nextRunAt: string | null };
type Run = { id: string; status: string; triggeredBy: string; log: { at: string; step: string; message: string; ok: boolean }[]; error: string | null; startedAt: string | null; finishedAt: string | null; createdAt: string };

const STEP_LABEL: Record<Step["type"], string> = { notify: "Send me a notification", sync_analytics: "Sync analytics from all accounts", refresh_trends: "Refresh Trend Radar", generate_ideas: "Generate scored ideas", run_agent: "Run an AI agent", retry_failed_posts: "Retry failed posts" };
const SCHEDULES = [["0 9 * * 1", "Every Monday at 09:00"], ["0 8 * * *", "Every day at 08:00"], ["0 */6 * * *", "Every 6 hours"], ["0 18 * * 5", "Every Friday at 18:00"], ["custom", "Custom cron expression"]];

const TEMPLATES: { name: string; description: string; trigger: Trigger; steps: Step[] }[] = [
  { name: "Monday idea batch", description: "Fresh scored ideas waiting every Monday.", trigger: { type: "schedule", cron: "0 9 * * 1", timezone: "UTC" }, steps: [{ type: "refresh_trends", region: "US" }, { type: "generate_ideas", niche: "my niche", count: 8 }, { type: "notify", title: "Your weekly ideas are ready" }] },
  { name: "Daily analytics refresh", description: "Keep dashboards current every morning.", trigger: { type: "schedule", cron: "0 7 * * *", timezone: "UTC" }, steps: [{ type: "sync_analytics" }] },
  { name: "Alert on failed posts", description: "Get notified and retry when a publish fails.", trigger: { type: "post_failed" }, steps: [{ type: "notify", title: "A post failed to publish", body: "Check the Publishing Center." }] },
];

function triggerText(t: Trigger) {
  if (t.type === "schedule") return `${SCHEDULES.find((s) => s[0] === t.cron)?.[1] ?? `Cron ${t.cron}`} (${t.timezone})`;
  if (t.type === "post_published") return `When a post is published${t.platform ? ` on ${t.platform}` : ""}`;
  if (t.type === "post_failed") return `When a post fails${t.platform ? ` on ${t.platform}` : ""}`;
  if (t.type === "trend_alert") return "When a trend watchlist matches";
  return "Run manually";
}

export default function AutomationPage() {
  const params = useSearchParams();
  const router = useRouter();
  const flows = useApiQuery<WorkflowRow[]>(["workflows"], "/api/v1/workflows");
  const [editing, setEditing] = React.useState<WorkflowRow | Partial<WorkflowRow> | null>(params.get("new") ? { name: "", trigger: { type: "manual" }, steps: [{ type: "notify", title: "" }], enabled: true } : null);
  const [runsFor, setRunsFor] = React.useState<WorkflowRow | null>(null);
  const [del, setDel] = React.useState<WorkflowRow | null>(null);
  const toggle = useAction(({ id, enabled }: { id: string; enabled: boolean }) => api.patch(`/api/v1/workflows/${id}`, { enabled }), { invalidate: [["workflows"]] });
  const run = useAction((id: string) => api.post<Run>(`/api/v1/workflows/${id}/run`), { invalidate: [["workflows"], ["workflow-runs"], ["notifications"]], success: (r) => (r.status === "succeeded" ? "Automation ran successfully" : r.status === "failed" ? `Automation failed: ${r.error}` : "Automation queued") });
  const remove = useAction((id: string) => api.del(`/api/v1/workflows/${id}`), { invalidate: [["workflows"]], success: "Automation deleted", onSuccess: () => setDel(null) });
  const { data: me } = useMe();

  return (
    <div>
      <PageHeader title="Automation Workflows" description="Chain steps that run on a schedule or when something happens: a post publishes or fails, or a trend matches your watchlist. Scheduled runs need the background worker." actions={<Button variant="primary" onClick={() => setEditing({ name: "", trigger: { type: "manual" }, steps: [{ type: "notify", title: "" }], enabled: true })}><Plus /> New automation</Button>} />
      {flows.isLoading ? <Panel><SkeletonRows /></Panel> : flows.error ? <Panel><ErrorState error={flows.error} /></Panel> : !flows.data?.length ? (
        <Panel>
          <EmptyState icon={Workflow} title="No automations yet" description="Start from a template or build your own." />
          <div className="grid gap-3 border-t border-line-soft p-5 md:grid-cols-3">
            {TEMPLATES.map((t) => <button key={t.name} onClick={() => setEditing({ ...t, enabled: true, trigger: t.trigger.type === "schedule" ? { ...t.trigger, timezone: me?.timezone ?? "UTC" } : t.trigger, steps: t.steps.map((s) => (s.type === "generate_ideas" ? { ...s, niche: me?.niche ?? s.niche } : s)) })} className="rounded-md border border-line-soft bg-ink-2 p-4 text-left hover:border-line"><p className="text-[13.5px] font-medium">{t.name}</p><p className="mt-1 text-xs text-muted">{t.description}</p></button>)}
          </div>
        </Panel>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {flows.data.map((w) => (
            <Panel key={w.id} className="flex flex-col p-5">
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1"><h2 className="text-[15px] font-semibold">{w.name}</h2>{w.description && <p className="mt-0.5 text-[13px] text-muted">{w.description}</p>}</div>
                <Switch checked={w.enabled} onCheckedChange={(v) => toggle.mutate({ id: w.id, enabled: v })} label={`${w.enabled ? "Disable" : "Enable"} ${w.name}`} />
              </div>
              <p className="mt-3 text-[13px]"><span className="text-muted">Trigger: </span>{triggerText(w.trigger)}</p>
              <ol className="mt-2 space-y-1 text-[13px]">{w.steps.map((s, i) => <li key={i} className="flex gap-2"><span className="w-4 text-right text-faint tabular-nums">{i + 1}</span>{STEP_LABEL[s.type]}{s.type === "notify" && s.title ? `: "${s.title}"` : ""}</li>)}</ol>
              <p className="mt-3 text-xs text-faint">Last run {fmtRelative(w.lastRunAt)}{w.nextRunAt && w.enabled ? `, next ${fmtDate(w.nextRunAt, true, me?.timezone)}` : ""}</p>
              <div className="mt-auto flex flex-wrap gap-2 pt-4">
                <Button size="sm" variant="primary" onClick={() => run.mutate(w.id)} loading={run.isPending && run.variables === w.id}><Play /> Run now</Button>
                <Button size="sm" onClick={() => setRunsFor(w)}>Run history</Button>
                <Button size="sm" variant="ghost" onClick={() => setEditing(w)}><Pencil /> Edit</Button>
                <Button size="icon" variant="ghost" aria-label="Delete automation" onClick={() => setDel(w)}><Trash2 /></Button>
              </div>
            </Panel>
          ))}
        </div>
      )}
      {editing && <WorkflowEditor initial={editing} onClose={() => { setEditing(null); if (params.get("new")) router.replace("/automation"); }} />}
      {runsFor && <RunsDialog w={runsFor} onClose={() => setRunsFor(null)} />}
      <ConfirmDialog open={!!del} onOpenChange={(o) => !o && setDel(null)} title={`Delete “${del?.name}”?`} description="Its run history is deleted too." confirmLabel="Delete automation" onConfirm={() => del && remove.mutate(del.id)} loading={remove.isPending} />
    </div>
  );
}

function WorkflowEditor({ initial, onClose }: { initial: Partial<WorkflowRow>; onClose: () => void }) {
  const { data: me } = useMe();
  const agents = useApiQuery<{ agents: { id: string; name: string }[] }>(["agents"], "/api/v1/agents");
  const watchlists = useApiQuery<{ id: string; name: string }[]>(["watchlists"], "/api/v1/trends/watchlists");
  const [name, setName] = React.useState(initial.name ?? "");
  const [description, setDescription] = React.useState(initial.description ?? "");
  const [trigger, setTrigger] = React.useState<Trigger>(initial.trigger ?? { type: "manual" });
  const [steps, setSteps] = React.useState<Step[]>(initial.steps ?? []);
  const [customCron, setCustomCron] = React.useState(trigger.type === "schedule" && !SCHEDULES.some((s) => s[0] === trigger.cron));
  const save = useAction(() => {
    const body = { name, description: description || null, enabled: initial.enabled ?? true, trigger, steps };
    return initial.id ? api.patch(`/api/v1/workflows/${initial.id}`, body) : api.post("/api/v1/workflows", body);
  }, { invalidate: [["workflows"]], success: "Automation saved", onSuccess: onClose });
  const setStep = (i: number, s: Step) => setSteps(steps.map((x, j) => (j === i ? s : x)));
  const move = (i: number, d: number) => { const n = [...steps]; const j = i + d; if (j < 0 || j >= n.length) return; [n[i], n[j]] = [n[j], n[i]]; setSteps(n); };
  const newStep = (type: Step["type"]): Step => type === "notify" ? { type, title: "" } : type === "refresh_trends" ? { type, region: "US" } : type === "generate_ideas" ? { type, niche: me?.niche ?? "", count: 8 } : type === "run_agent" ? { type, agentId: agents.data?.agents[0]?.id ?? "", input: "" } : { type } as Step;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={initial.id ? "Edit automation" : "New automation"} wide footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => save.mutate(undefined)} loading={save.isPending} disabled={!name.trim() || !steps.length}>Save automation</Button></>}>
      <div className="space-y-5">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" htmlFor="w-name"><Input id="w-name" value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Description" htmlFor="w-desc"><Input id="w-desc" value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
        </div>
        <fieldset className="rounded-md border border-line-soft p-4">
          <legend className="px-1 text-[13px] font-medium">When</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Trigger" htmlFor="w-trig"><Select id="w-trig" value={trigger.type} onChange={(e) => { const t = e.target.value as Trigger["type"]; setTrigger(t === "schedule" ? { type: t, cron: "0 9 * * 1", timezone: me?.timezone ?? "UTC" } : ({ type: t } as Trigger)); }}><option value="manual">Manually</option><option value="schedule">On a schedule</option><option value="post_published">When a post is published</option><option value="post_failed">When a post fails</option><option value="trend_alert">When a trend watchlist matches</option></Select></Field>
            {trigger.type === "schedule" && (
              <>
                <Field label="Schedule" htmlFor="w-sched"><Select id="w-sched" value={customCron ? "custom" : trigger.cron} onChange={(e) => { if (e.target.value === "custom") setCustomCron(true); else { setCustomCron(false); setTrigger({ ...trigger, cron: e.target.value }); } }}>{SCHEDULES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></Field>
                {customCron && <Field label="Cron expression" htmlFor="w-cron" hint="5 fields: minute hour day month weekday"><Input id="w-cron" value={trigger.cron} onChange={(e) => setTrigger({ ...trigger, cron: e.target.value })} /></Field>}
                <Field label="Timezone" htmlFor="w-tz"><Select id="w-tz" value={trigger.timezone} onChange={(e) => setTrigger({ ...trigger, timezone: e.target.value })}>{Intl.supportedValuesOf("timeZone").map((z) => <option key={z}>{z}</option>)}</Select></Field>
              </>
            )}
            {(trigger.type === "post_published" || trigger.type === "post_failed") && <Field label="Platform" htmlFor="w-plat"><Select id="w-plat" value={trigger.platform ?? ""} onChange={(e) => setTrigger({ ...trigger, platform: e.target.value || undefined })}><option value="">Any platform</option><option value="youtube">YouTube</option><option value="tiktok">TikTok</option><option value="instagram">Instagram</option></Select></Field>}
            {trigger.type === "trend_alert" && <Field label="Watchlist" htmlFor="w-wl"><Select id="w-wl" value={trigger.watchlistId ?? ""} onChange={(e) => setTrigger({ ...trigger, watchlistId: e.target.value || undefined })}><option value="">Any watchlist</option>{watchlists.data?.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</Select></Field>}
          </div>
        </fieldset>
        <fieldset className="rounded-md border border-line-soft p-4">
          <legend className="px-1 text-[13px] font-medium">Then, in order</legend>
          <ol className="space-y-3">
            {steps.map((s, i) => (
              <li key={i} className="rounded-md border border-line-soft bg-ink-2 p-3">
                <div className="flex items-center gap-2">
                  <span className="w-5 text-right text-xs tabular-nums text-faint">{i + 1}</span>
                  <Select value={s.type} onChange={(e) => setStep(i, newStep(e.target.value as Step["type"]))} aria-label={`Step ${i + 1} action`} className="flex-1">{(Object.keys(STEP_LABEL) as Step["type"][]).map((t) => <option key={t} value={t}>{STEP_LABEL[t]}</option>)}</Select>
                  <Button size="icon" variant="ghost" className="size-7" aria-label="Move step up" onClick={() => move(i, -1)}><ChevronUp /></Button>
                  <Button size="icon" variant="ghost" className="size-7" aria-label="Move step down" onClick={() => move(i, 1)}><ChevronDown /></Button>
                  <Button size="icon" variant="ghost" className="size-7" aria-label="Remove step" onClick={() => setSteps(steps.filter((_, j) => j !== i))}><X /></Button>
                </div>
                <div className="mt-2 grid gap-2 pl-7 sm:grid-cols-2">
                  {s.type === "notify" && <><Input aria-label="Notification title" placeholder="Notification title" value={s.title} onChange={(e) => setStep(i, { ...s, title: e.target.value })} /><Input aria-label="Notification body" placeholder="Details (optional)" value={s.body ?? ""} onChange={(e) => setStep(i, { ...s, body: e.target.value })} /></>}
                  {s.type === "refresh_trends" && <Input aria-label="Region code" maxLength={2} value={s.region ?? "US"} onChange={(e) => setStep(i, { ...s, region: e.target.value.toUpperCase() })} />}
                  {s.type === "generate_ideas" && <><Input aria-label="Niche" placeholder="Niche" value={s.niche} onChange={(e) => setStep(i, { ...s, niche: e.target.value })} /><Select aria-label="Idea count" value={s.count} onChange={(e) => setStep(i, { ...s, count: Number(e.target.value) })}>{[3, 5, 8, 10, 15].map((n) => <option key={n} value={n}>{n} ideas</option>)}</Select></>}
                  {s.type === "run_agent" && (agents.data?.agents.length ? <><Select aria-label="Agent" value={s.agentId} onChange={(e) => setStep(i, { ...s, agentId: e.target.value })}>{agents.data.agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select><Textarea aria-label="Agent input" rows={2} placeholder="What should the agent do?" value={s.input} onChange={(e) => setStep(i, { ...s, input: e.target.value })} /></> : <p className="text-xs text-warning">Create an agent in AI Agents first.</p>)}
                </div>
              </li>
            ))}
          </ol>
          <Button size="sm" variant="ghost" className="mt-3" onClick={() => setSteps([...steps, { type: "notify", title: "" }])} disabled={steps.length >= 20}><Plus /> Add step</Button>
        </fieldset>
      </div>
    </Dialog>
  );
}

function RunsDialog({ w, onClose }: { w: WorkflowRow; onClose: () => void }) {
  const runs = useApiQuery<Run[]>(["workflow-runs", w.id], `/api/v1/workflows/${w.id}/runs`, { refetchInterval: 5000 });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={`Run history: ${w.name}`} wide>
      {runs.isLoading ? <SkeletonRows /> : !runs.data?.length ? <p className="text-[13px] text-muted">This automation hasn&apos;t run yet.</p> : (
        <ul className="space-y-3">
          {runs.data.map((r) => (
            <li key={r.id} className="rounded-md border border-line-soft bg-ink-2 p-3">
              <div className="flex flex-wrap items-center gap-2 text-[13px]"><StatusBadge status={r.status} /><Badge>{r.triggeredBy}</Badge><span className="text-xs text-faint">{fmtDate(r.createdAt, true)}</span></div>
              {r.log.length > 0 && <ul className="mt-2 space-y-1">{r.log.map((l, i) => <li key={i} className="flex gap-2 text-[13px]">{l.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" /> : <XCircle className="mt-0.5 size-4 shrink-0 text-danger" />}<span><span className="text-muted">{l.step}:</span> {l.message}</span></li>)}</ul>}
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
