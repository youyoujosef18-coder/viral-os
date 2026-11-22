"use client";

import * as React from "react";
import { FlaskConical, Plus, Trash2, Download, Trophy, X } from "lucide-react";
import { api } from "@/lib/client/api";
import { useAction, useApiQuery } from "@/lib/client/hooks";
import { Badge, Button, ConfirmDialog, Dialog, EmptyState, ErrorState, Field, HelpTip, Input, PageHeader, Panel, PanelHeader, Select, SkeletonRows, SourceTag, Textarea } from "@/components/ui/primitives";
import { StatusBadge } from "@/components/ui/domain";
import { BarsChart } from "@/components/charts";
import { cn, fmtDate, fmtNum } from "@/lib/client/utils";

type Variant = { id: string; label: string; value: string; reference?: string; metrics: Record<string, number> };
type Experiment = { id: string; name: string; hypothesis: string | null; type: string; platform: string | null; status: string; primaryMetric: string; variants: Variant[]; winnerVariantId: string | null; conclusion: string | null; startedAt: string | null; endedAt: string | null; createdAt: string };

const TYPES = [["title", "Title"], ["thumbnail", "Thumbnail"], ["hook", "Hook"], ["caption", "Caption"], ["posting_time", "Posting time"], ["format", "Format"]];
const METRICS = [["views", "Views"], ["likes", "Likes"], ["comments", "Comments"], ["shares", "Shares"], ["engagement_rate", "Engagement rate"], ["ctr", "Click-through rate"], ["avg_view_duration", "Avg. view duration"]];
const metricLabel = (m: string) => METRICS.find((x) => x[0] === m)?.[1] ?? m;

export default function ExperimentsPage() {
  const list = useApiQuery<Experiment[]>(["experiments"], "/api/v1/experiments");
  const [creating, setCreating] = React.useState(false);
  const [selected, setSelected] = React.useState<string | null>(null);
  const current = list.data?.find((e) => e.id === selected) ?? list.data?.[0];

  return (
    <div>
      <PageHeader title="Experiments" description="Test titles, thumbnails, hooks, captions and timing. Link each variant to its published content to pull verified metrics, or enter numbers you read from platform analytics." actions={<Button variant="primary" onClick={() => setCreating(true)}><Plus /> New experiment</Button>} />
      {list.isLoading ? <Panel><SkeletonRows /></Panel> : list.error ? <Panel><ErrorState error={list.error} /></Panel> : !list.data?.length ? (
        <Panel><EmptyState icon={FlaskConical} title="No experiments yet" description="Example: publish the same short with two hooks a week apart and compare views after 72 hours." action={<Button variant="primary" onClick={() => setCreating(true)}>New experiment</Button>} /></Panel>
      ) : (
        <div className="grid gap-5 lg:grid-cols-[280px_1fr]">
          <Panel as="div" className="h-fit p-2">
            <ul>{list.data.map((e) => <li key={e.id}><button onClick={() => setSelected(e.id)} className={cn("w-full rounded-md px-3 py-2 text-left", current?.id === e.id ? "bg-raised" : "hover:bg-raised/50")}><span className="block truncate text-[13.5px]">{e.name}</span><span className="mt-1 flex items-center gap-2 text-xs text-faint"><StatusBadge status={e.status} />{TYPES.find((t) => t[0] === e.type)?.[1]}</span></button></li>)}</ul>
          </Panel>
          {current && <ExperimentDetail key={current.id} e={current} />}
        </div>
      )}
      {creating && <CreateDialog onClose={() => setCreating(false)} onCreated={(id) => setSelected(id)} />}
    </div>
  );
}

function ExperimentDetail({ e }: { e: Experiment }) {
  const [variants, setVariants] = React.useState(e.variants);
  const [conclusion, setConclusion] = React.useState(e.conclusion ?? "");
  const [confirm, setConfirm] = React.useState(false);
  const save = useAction((body: Record<string, unknown>) => api.patch<Experiment>(`/api/v1/experiments/${e.id}`, body), { invalidate: [["experiments"]], success: "Experiment saved" });
  const pull = useAction(() => api.post<{ experiment: Experiment; report: { variant: string; matched: boolean }[] }>(`/api/v1/experiments/${e.id}/pull-metrics`), {
    invalidate: [["experiments"]],
    onSuccess: (r) => setVariants(r.experiment.variants),
    success: (r) => { const m = r.report.filter((x) => x.matched).length; return m ? `Pulled verified metrics for ${m} of ${r.report.length} variants` : "No synced content matched the variant references. Sync analytics first, then use the content URL or ID."; },
  });
  const remove = useAction(() => api.del(`/api/v1/experiments/${e.id}`), { invalidate: [["experiments"]], success: "Experiment deleted" });
  const pm = e.primaryMetric;
  const values = variants.map((v) => v.metrics[pm] ?? null);
  const best = Math.max(...values.map((v) => v ?? -Infinity));
  const leader = variants.find((v) => (v.metrics[pm] ?? null) === best && best > -Infinity);
  const baseline = values[0];
  const setMetric = (id: string, val: string) => setVariants(variants.map((v) => (v.id === id ? { ...v, metrics: { ...v.metrics, [pm]: val === "" ? 0 : Number(val) } } : v)));

  return (
    <div className="min-w-0 space-y-4">
      <Panel>
        <PanelHeader title={e.name} description={e.hypothesis ?? undefined} actions={
          <>
            <Select value={e.status} onChange={(ev) => save.mutate({ status: ev.target.value })} className="w-36" aria-label="Experiment status"><option value="draft">Draft</option><option value="running">Running</option><option value="completed">Completed</option></Select>
            <Button size="icon" variant="ghost" aria-label="Delete experiment" onClick={() => setConfirm(true)}><Trash2 /></Button>
          </>
        } />
        <p className="px-5 pb-4 text-xs text-muted">Primary metric: {metricLabel(pm)}{e.startedAt ? `, started ${fmtDate(e.startedAt)}` : ""}{e.endedAt ? `, ended ${fmtDate(e.endedAt)}` : ""}</p>
      </Panel>
      <Panel>
        <PanelHeader title="Variants" tooltip="Reference: the published content URL or platform ID. 'Pull metrics' fills numbers from your latest analytics sync (verified). Otherwise enter numbers manually." actions={<><Button size="sm" onClick={() => pull.mutate(undefined)} loading={pull.isPending}><Download /> Pull metrics</Button><Button size="sm" variant="primary" onClick={() => save.mutate({ variants })} loading={save.isPending}>Save variants</Button></>} />
        <div className="overflow-x-auto border-t border-line-soft">
          <table className="w-full min-w-[640px] text-[13.5px]">
            <thead><tr className="border-b border-line-soft text-left text-xs text-muted"><th className="px-5 py-2 font-medium">Variant</th><th className="px-3 py-2 font-medium">Reference</th><th className="px-3 py-2 text-right font-medium">{metricLabel(pm)}</th><th className="px-3 py-2 text-right font-medium">vs A <HelpTip text="Relative difference from the first variant. Small samples can mislead; look for large, repeated differences." /></th><th className="px-5 py-2" /></tr></thead>
            <tbody>
              {variants.map((v, i) => {
                const val = v.metrics[pm];
                const lift = i > 0 && baseline && val !== undefined ? (val - baseline) / baseline : null;
                const isWinner = e.winnerVariantId === v.id;
                return (
                  <tr key={v.id} className="border-b border-line-soft/60 last:border-0">
                    <td className="px-5 py-3"><p className="flex items-center gap-2 font-medium">{v.label}{isWinner && <Badge tone="success"><Trophy className="size-3" />Winner</Badge>}</p><p className="text-xs text-muted">{v.value}</p></td>
                    <td className="px-3 py-3"><Input value={v.reference ?? ""} onChange={(ev) => setVariants(variants.map((x) => (x.id === v.id ? { ...x, reference: ev.target.value } : x)))} placeholder="URL or content ID" aria-label={`${v.label} reference`} className="h-8" /></td>
                    <td className="px-3 py-3 text-right"><Input type="number" min={0} step="any" value={val ?? ""} onChange={(ev) => setMetric(v.id, ev.target.value)} className="ml-auto h-8 w-28 text-right" aria-label={`${v.label} ${metricLabel(pm)}`} /></td>
                    <td className={cn("px-3 py-3 text-right tabular-nums", lift === null ? "text-faint" : lift >= 0 ? "text-success" : "text-danger")}>{lift === null ? "—" : `${lift >= 0 ? "+" : ""}${(lift * 100).toFixed(1)}%`}</td>
                    <td className="px-5 py-3 text-right"><Button size="sm" variant={isWinner ? "secondary" : "ghost"} onClick={() => save.mutate({ winnerVariantId: isWinner ? null : v.id })}>{isWinner ? "Unset" : "Pick winner"}</Button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {variants.some((v) => v.metrics[pm] !== undefined) && <div className="border-t border-line-soft px-3 py-4"><BarsChart data={variants.map((v) => ({ name: v.label, value: v.metrics[pm] ?? 0 }))} dataKey="value" xKey="name" nameLabel={metricLabel(pm)} height={180} /></div>}
        {leader && !e.winnerVariantId && <p className="border-t border-line-soft px-5 py-3 text-[13px] text-muted">Current leader on {metricLabel(pm).toLowerCase()}: <span className="text-fg">{leader.label}</span> ({fmtNum(leader.metrics[pm])}). <SourceTag source={variants.some((v) => v.reference) ? "platform_api" : "user_input"} /></p>}
      </Panel>
      <Panel className="p-5">
        <Field label="Conclusion" htmlFor="concl" hint="What did you learn, and what will you do differently?"><Textarea id="concl" rows={3} value={conclusion} onChange={(ev) => setConclusion(ev.target.value)} /></Field>
        <Button size="sm" className="mt-3" onClick={() => save.mutate({ conclusion })} loading={save.isPending}>Save conclusion</Button>
      </Panel>
      <ConfirmDialog open={confirm} onOpenChange={setConfirm} title="Delete this experiment?" description="Variants and results are deleted." confirmLabel="Delete experiment" onConfirm={() => remove.mutate(undefined)} loading={remove.isPending} />
    </div>
  );
}

function CreateDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [f, setF] = React.useState({ name: "", hypothesis: "", type: "title", platform: "", primaryMetric: "views" });
  const [variants, setVariants] = React.useState([{ label: "A", value: "" }, { label: "B", value: "" }]);
  const create = useAction(() => api.post<Experiment>("/api/v1/experiments", { ...f, platform: f.platform || null, hypothesis: f.hypothesis || null, variants }), { invalidate: [["experiments"]], success: "Experiment created", onSuccess: (e) => { onCreated(e.id); onClose(); } });
  const ok = f.name.trim() && variants.every((v) => v.value.trim());
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="New experiment" wide footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => create.mutate(undefined)} loading={create.isPending} disabled={!ok}>Create experiment</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" htmlFor="x-name" className="sm:col-span-2"><Input id="x-name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Hypothesis" htmlFor="x-h" className="sm:col-span-2"><Textarea id="x-h" rows={2} value={f.hypothesis} onChange={(e) => setF({ ...f, hypothesis: e.target.value })} placeholder="e.g. A question-style hook will increase average view duration." /></Field>
        <Field label="What are you testing?" htmlFor="x-type"><Select id="x-type" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>{TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></Field>
        <Field label="Primary metric" htmlFor="x-m"><Select id="x-m" value={f.primaryMetric} onChange={(e) => setF({ ...f, primaryMetric: e.target.value })}>{METRICS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></Field>
        <Field label="Platform" htmlFor="x-p"><Select id="x-p" value={f.platform} onChange={(e) => setF({ ...f, platform: e.target.value })}><option value="">Any</option><option value="youtube">YouTube</option><option value="tiktok">TikTok</option><option value="instagram">Instagram</option></Select></Field>
      </div>
      <div className="mt-4 space-y-2">
        <p className="text-[13px] font-medium">Variants</p>
        {variants.map((v, i) => (
          <div key={i} className="flex gap-2">
            <Input value={v.label} onChange={(e) => setVariants(variants.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} className="w-20" aria-label={`Variant ${i + 1} label`} />
            <Input value={v.value} onChange={(e) => setVariants(variants.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} placeholder="The title, hook, caption or time being tested" aria-label={`Variant ${i + 1} value`} />
            <Button size="icon" variant="ghost" aria-label="Remove variant" onClick={() => setVariants(variants.filter((_, j) => j !== i))} disabled={variants.length <= 2}><X /></Button>
          </div>
        ))}
        <Button size="sm" variant="ghost" onClick={() => setVariants([...variants, { label: String.fromCharCode(65 + variants.length), value: "" }])} disabled={variants.length >= 6}><Plus /> Add variant</Button>
      </div>
    </Dialog>
  );
}
