"use client";

import * as React from "react";
import { Bot, Plus, Play, Trash2, Pencil, Copy } from "lucide-react";
import { api } from "@/lib/client/api";
import { useAction, useApiQuery } from "@/lib/client/hooks";
import { Badge, Button, ConfirmDialog, Dialog, EmptyState, ErrorState, Field, Input, PageHeader, Panel, PanelHeader, Select, SkeletonRows, SourceTag, Switch, Textarea } from "@/components/ui/primitives";
import { NotConfigured, StatusBadge } from "@/components/ui/domain";
import { cn, fmtRelative } from "@/lib/client/utils";

type Agent = { id: string; name: string; role: string; instructions: string; outputFormat: string; temperature: number; enabled: boolean; updatedAt: string };
type Template = { name: string; role: string; instructions: string; outputFormat: string };
type Run = { id: string; input: string; output: string | null; status: string; error: string | null; createdAt: string };

export default function AgentsPage() {
  const data = useApiQuery<{ agents: Agent[]; templates: Template[] }>(["agents"], "/api/v1/agents");
  const [editing, setEditing] = React.useState<Partial<Agent> | null>(null);
  const [selected, setSelected] = React.useState<string | null>(null);
  const agents = data.data?.agents ?? [];
  const current = agents.find((a) => a.id === selected) ?? agents[0];

  return (
    <div>
      <PageHeader title="AI Agents" description="Reusable AI assistants with their own instructions. Run them here or as a step in an automation." actions={<Button variant="primary" onClick={() => setEditing({ name: "", role: "assistant", instructions: "", outputFormat: "markdown", temperature: 0.7, enabled: true })}><Plus /> New agent</Button>} />
      {data.isLoading ? <Panel><SkeletonRows /></Panel> : data.error ? <Panel><ErrorState error={data.error} /></Panel> : !agents.length ? (
        <Panel>
          <EmptyState icon={Bot} title="No agents yet" description="Start from a template. You can edit its instructions afterwards." />
          <div className="grid gap-3 border-t border-line-soft p-5 md:grid-cols-2">
            {data.data?.templates.map((t) => <button key={t.name} onClick={() => setEditing({ ...t, temperature: 0.7, enabled: true })} className="rounded-md border border-line-soft bg-ink-2 p-4 text-left hover:border-line"><p className="text-[13.5px] font-medium">{t.name}</p><p className="mt-1 line-clamp-2 text-xs text-muted">{t.instructions}</p></button>)}
          </div>
        </Panel>
      ) : (
        <div className="grid gap-5 lg:grid-cols-[280px_1fr]">
          <Panel as="div" className="h-fit p-2">
            <ul>{agents.map((a) => <li key={a.id}><button onClick={() => setSelected(a.id)} className={cn("flex w-full items-center gap-2 rounded-md px-3 py-2 text-left", current?.id === a.id ? "bg-raised" : "hover:bg-raised/50")}><Bot className="size-4 text-faint" /><span className="flex-1 truncate text-[13.5px]">{a.name}</span>{!a.enabled && <Badge>off</Badge>}</button></li>)}</ul>
            <details className="mt-2 px-3 pb-2 text-xs text-muted"><summary className="cursor-pointer">Add from template</summary><ul className="mt-2 space-y-1">{data.data?.templates.map((t) => <li key={t.name}><button className="hover:text-fg" onClick={() => setEditing({ ...t, temperature: 0.7, enabled: true })}>{t.name}</button></li>)}</ul></details>
          </Panel>
          {current && <AgentRunner key={current.id} agent={current} onEdit={() => setEditing(current)} />}
        </div>
      )}
      {editing && <AgentEditor agent={editing} onClose={() => setEditing(null)} onSaved={(id) => setSelected(id)} />}
    </div>
  );
}

function AgentRunner({ agent, onEdit }: { agent: Agent; onEdit: () => void }) {
  const [input, setInput] = React.useState("");
  const [confirm, setConfirm] = React.useState(false);
  const runs = useApiQuery<Run[]>(["agent-runs", agent.id], `/api/v1/agents/${agent.id}/runs`);
  const run = useAction(() => api.post<Run>(`/api/v1/agents/${agent.id}/run`, { input }), { invalidate: [["agent-runs", agent.id]], silentError: true, onSuccess: () => setInput("") });
  const toggle = useAction((enabled: boolean) => api.patch(`/api/v1/agents/${agent.id}`, { enabled }), { invalidate: [["agents"]] });
  const remove = useAction(() => api.del(`/api/v1/agents/${agent.id}`), { invalidate: [["agents"]], success: "Agent deleted" });
  return (
    <div className="min-w-0 space-y-4">
      <Panel>
        <PanelHeader title={agent.name} description={`${agent.role}, ${agent.outputFormat} output`} actions={<><label className="flex items-center gap-2 text-[13px] text-muted"><Switch checked={agent.enabled} onCheckedChange={(v) => toggle.mutate(v)} label="Enabled" />Enabled</label><Button size="sm" variant="ghost" onClick={onEdit}><Pencil /> Edit</Button><Button size="icon" variant="ghost" aria-label="Delete agent" onClick={() => setConfirm(true)}><Trash2 /></Button></>} />
        <p className="border-t border-line-soft px-5 py-3 text-[13px] text-muted">{agent.instructions}</p>
        <div className="border-t border-line-soft p-5">
          <Field label="Input" htmlFor="ag-in" hint="Paste a script, transcript, comments or goals for the agent to work on."><Textarea id="ag-in" rows={5} value={input} onChange={(e) => setInput(e.target.value)} /></Field>
          <Button variant="primary" className="mt-3" onClick={() => run.mutate(undefined)} loading={run.isPending} disabled={!input.trim() || !agent.enabled}><Play /> Run agent</Button>
          {run.error && <div className="-mx-5 -mb-5 mt-2"><NotConfigured error={run.error} title="Agents need an AI provider" />{!(run.error as { notConfigured?: boolean }).notConfigured && <ErrorState error={run.error} />}</div>}
        </div>
      </Panel>
      <Panel>
        <PanelHeader title="Runs" />
        {runs.isLoading ? <SkeletonRows /> : !runs.data?.length ? <p className="px-5 pb-5 text-[13px] text-muted">No runs yet.</p> : (
          <ul className="divide-y divide-line-soft border-t border-line-soft">
            {runs.data.map((r) => (
              <li key={r.id} className="px-5 py-4">
                <div className="mb-2 flex items-center gap-2"><StatusBadge status={r.status} /><span className="text-xs text-faint">{fmtRelative(r.createdAt)}</span>{r.output && <><SourceTag source="ai_estimate" /><Button size="sm" variant="ghost" className="ml-auto" onClick={() => navigator.clipboard.writeText(r.output ?? "")}><Copy /> Copy</Button></>}</div>
                <p className="mb-2 line-clamp-2 text-xs text-muted">Input: {r.input}</p>
                {r.output && <div className="whitespace-pre-wrap rounded-md bg-ink-2 p-3 text-[13px] leading-relaxed">{r.output}</div>}
                {r.error && <p className="text-[13px] text-danger">{r.error}</p>}
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <ConfirmDialog open={confirm} onOpenChange={setConfirm} title={`Delete ${agent.name}?`} description="Automations that use this agent will fail at that step." confirmLabel="Delete agent" onConfirm={() => remove.mutate(undefined)} loading={remove.isPending} />
    </div>
  );
}

function AgentEditor({ agent, onClose, onSaved }: { agent: Partial<Agent>; onClose: () => void; onSaved: (id: string) => void }) {
  const [f, setF] = React.useState({ name: agent.name ?? "", role: agent.role ?? "assistant", instructions: agent.instructions ?? "", outputFormat: agent.outputFormat ?? "markdown", temperature: agent.temperature ?? 0.7, enabled: agent.enabled ?? true });
  const save = useAction(() => (agent.id ? api.patch<Agent>(`/api/v1/agents/${agent.id}`, f) : api.post<Agent>("/api/v1/agents", f)), { invalidate: [["agents"]], success: "Agent saved", onSuccess: (a) => { onSaved(a.id); onClose(); } });
  const instrErr = f.instructions.trim().length > 0 && f.instructions.trim().length < 20 ? "Write at least a sentence (20+ characters)." : undefined;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={agent.id ? "Edit agent" : "New agent"} wide footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => save.mutate(undefined)} loading={save.isPending} disabled={!f.name.trim() || f.instructions.trim().length < 20}>Save agent</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" htmlFor="ag-n"><Input id="ag-n" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Role" htmlFor="ag-r"><Input id="ag-r" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })} /></Field>
        <Field label="Instructions" htmlFor="ag-i" className="sm:col-span-2" error={instrErr}><Textarea id="ag-i" rows={6} value={f.instructions} onChange={(e) => setF({ ...f, instructions: e.target.value })} placeholder="What does this agent do, and how should it respond?" /></Field>
        <Field label="Output format" htmlFor="ag-o"><Select id="ag-o" value={f.outputFormat} onChange={(e) => setF({ ...f, outputFormat: e.target.value })}>{["markdown", "plain text", "bullet list", "JSON"].map((o) => <option key={o}>{o}</option>)}</Select></Field>
        <Field label={`Creativity (${f.temperature.toFixed(1)})`} htmlFor="ag-t" hint="Applies to providers that support it."><input id="ag-t" type="range" min={0} max={1} step={0.1} value={f.temperature} onChange={(e) => setF({ ...f, temperature: Number(e.target.value) })} className="w-full accent-violet" /></Field>
      </div>
    </Dialog>
  );
}
