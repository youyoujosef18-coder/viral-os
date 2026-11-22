"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useForm, useFieldArray } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Clapperboard, Plus, Copy, Trash2, History, LayoutList, Columns3, X, PenLine, Send, Link2 } from "lucide-react";
import { api } from "@/lib/client/api";
import { useAction, useApiQuery, type MediaAsset } from "@/lib/client/hooks";
import { Badge, Button, ConfirmDialog, Dialog, EmptyState, ErrorState, Field, Input, PageHeader, Panel, Select, SkeletonRows, Textarea } from "@/components/ui/primitives";
import { PlatformMark, StatusBadge } from "@/components/ui/domain";
import { DataTable, type Column } from "@/components/ui/data-table";
import { MediaThumb } from "@/components/ui/media-picker";
import { UploadDialog } from "@/components/shell/upload-dialog";
import { PROJECT_STATUSES, CONTENT_FORMATS } from "@/lib/validation/projects";
import { cn, fmtDate, fmtRelative } from "@/lib/client/utils";

type Project = { id: string; title: string; description: string | null; status: (typeof PROJECT_STATUSES)[number]; format: string; platforms: string[]; audience: string | null; language: string; tone: string | null; referenceLinks: string[]; assetIds: string[]; notes: string | null; dueDate: string | null; updatedAt: string; createdAt: string };
type ProjectDetail = Project & { scripts: { id: string; title: string; updatedAt: string }[]; posts: { id: string; title: string; status: string }[]; versions: { id: string; label: string | null; createdAt: string }[] };

const STAGE_LABEL: Record<string, string> = { idea: "Idea", research: "Research", scripting: "Scripting", production: "Production", editing: "Editing", ready: "Ready", published: "Published", archived: "Archived" };
const LANGS = ["en", "fr", "ar", "es", "de", "pt", "it", "tr"];
const TONES = ["Conversational", "Energetic", "Authoritative", "Playful", "Calm", "Inspirational", "Humorous", "Professional"];

const formSchema = z.object({
  title: z.string().trim().min(1, "Give the project a title").max(200),
  description: z.string().max(5000).optional(),
  status: z.enum(PROJECT_STATUSES),
  format: z.enum(CONTENT_FORMATS),
  platforms: z.array(z.enum(["youtube", "tiktok", "instagram"])),
  audience: z.string().max(300).optional(),
  language: z.string(),
  tone: z.string().optional(),
  links: z.array(z.object({ url: z.string().trim().url("Enter a full URL starting with https://") })).max(20),
  notes: z.string().max(20000).optional(),
  dueDate: z.string().optional(),
});
type FormValues = z.infer<typeof formSchema>;

export default function StudioPage() {
  const params = useSearchParams();
  const router = useRouter();
  const [view, setView] = React.useState<"board" | "list">("board");
  const [editing, setEditing] = React.useState<Project | "new" | null>(params.get("new") ? "new" : null);
  const [openId, setOpenId] = React.useState<string | null>(params.get("project"));
  const projects = useApiQuery<Project[]>(["projects"], "/api/v1/projects");
  const move = useAction(({ id, status }: { id: string; status: string }) => api.patch(`/api/v1/projects/${id}`, { status }), { invalidate: [["projects"]] });
  const [dragId, setDragId] = React.useState<string | null>(null);
  const rows = projects.data ?? [];

  const cols: Column<Project>[] = [
    { key: "title", header: "Project", cell: (p) => <span className="font-medium">{p.title}</span>, sortValue: (p) => p.title },
    { key: "status", header: "Stage", cell: (p) => <Badge tone="violet">{STAGE_LABEL[p.status]}</Badge>, sortValue: (p) => PROJECT_STATUSES.indexOf(p.status) },
    { key: "format", header: "Format", cell: (p) => <span className="text-muted">{p.format}</span>, sortValue: (p) => p.format },
    { key: "platforms", header: "Platforms", cell: (p) => <span className="flex gap-1">{p.platforms.map((x) => <PlatformMark key={x} platform={x} className="size-5 text-[8px]" />)}</span> },
    { key: "due", header: "Due", cell: (p) => <span className="text-xs text-muted">{fmtDate(p.dueDate)}</span>, sortValue: (p) => p.dueDate },
    { key: "updated", header: "Updated", cell: (p) => <span className="text-xs text-muted">{fmtRelative(p.updatedAt)}</span>, sortValue: (p) => p.updatedAt },
  ];

  return (
    <div>
      <PageHeader
        title="Content Studio"
        description="Every piece of content as a project moving through your pipeline. Drag cards between stages; open one to see its scripts, posts and version history."
        actions={
          <>
            <div className="flex rounded-md border border-line p-0.5" role="group" aria-label="View">
              <button onClick={() => setView("board")} aria-pressed={view === "board"} className={cn("flex items-center gap-1.5 rounded-sm px-2.5 py-1 text-xs", view === "board" ? "bg-raised" : "text-muted")}><Columns3 className="size-3.5" />Pipeline</button>
              <button onClick={() => setView("list")} aria-pressed={view === "list"} className={cn("flex items-center gap-1.5 rounded-sm px-2.5 py-1 text-xs", view === "list" ? "bg-raised" : "text-muted")}><LayoutList className="size-3.5" />List</button>
            </div>
            <Button variant="primary" onClick={() => setEditing("new")}><Plus /> New project</Button>
          </>
        }
      />
      {projects.isLoading ? <Panel><SkeletonRows /></Panel> : projects.error ? <Panel><ErrorState error={projects.error} onRetry={() => projects.refetch()} /></Panel> : !rows.length ? (
        <Panel><EmptyState icon={Clapperboard} title="Start your first project" description="Projects hold the brief, target platforms, references, assets, scripts and posts for one piece of content." action={<Button variant="primary" onClick={() => setEditing("new")}>New project</Button>} /></Panel>
      ) : view === "list" ? (
        <Panel className="pt-4"><DataTable rows={rows} columns={cols} rowKey={(p) => p.id} searchable={(p) => `${p.title} ${p.format} ${p.description ?? ""}`} onRowClick={(p) => setOpenId(p.id)} /></Panel>
      ) : (
        <div className="-mx-4 overflow-x-auto px-4 pb-2 md:-mx-8 md:px-8">
          <div className="flex min-w-max gap-3">
            {PROJECT_STATUSES.map((stage) => {
              const items = rows.filter((p) => p.status === stage);
              return (
                <section
                  key={stage}
                  aria-label={`${STAGE_LABEL[stage]} stage`}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => { if (dragId) move.mutate({ id: dragId, status: stage }); setDragId(null); }}
                  className={cn("flex w-64 flex-col rounded-lg border border-line-soft bg-ink-2/60", dragId && "border-dashed border-line")}
                >
                  <header className="flex items-center justify-between px-3 py-2.5 text-[13px]"><span className="font-medium">{STAGE_LABEL[stage]}</span><span className="text-xs tabular-nums text-faint">{items.length}</span></header>
                  <ul className="flex min-h-24 flex-1 flex-col gap-2 px-2 pb-2">
                    {items.map((p) => (
                      <li key={p.id} draggable onDragStart={() => setDragId(p.id)} onDragEnd={() => setDragId(null)}>
                        <button onClick={() => setOpenId(p.id)} className="w-full rounded-md border border-line-soft bg-panel p-3 text-left transition-colors hover:border-line focus-visible:border-violet">
                          <p className="line-clamp-2 text-[13.5px] font-medium">{p.title}</p>
                          <p className="mt-1 text-xs text-muted">{p.format}</p>
                          <div className="mt-2 flex items-center justify-between">
                            <span className="flex gap-1">{p.platforms.map((x) => <PlatformMark key={x} platform={x} className="size-5 text-[8px]" />)}</span>
                            {p.dueDate && <span className={cn("text-[11px]", new Date(p.dueDate) < new Date() && p.status !== "published" ? "text-danger" : "text-faint")}>Due {fmtDate(p.dueDate)}</span>}
                          </div>
                        </button>
                        <label className="sr-only" htmlFor={`stage-${p.id}`}>Move {p.title} to stage</label>
                        <select id={`stage-${p.id}`} className="sr-only" value={p.status} onChange={(e) => move.mutate({ id: p.id, status: e.target.value })}>{PROJECT_STATUSES.map((s) => <option key={s} value={s}>{STAGE_LABEL[s]}</option>)}</select>
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
        </div>
      )}
      {editing && <ProjectForm project={editing === "new" ? null : editing} onClose={() => { setEditing(null); if (params.get("new")) router.replace("/studio"); }} onSaved={(id) => setOpenId(id)} />}
      {openId && <ProjectDrawer id={openId} onClose={() => { setOpenId(null); if (params.get("project")) router.replace("/studio"); }} onEdit={(p) => setEditing(p)} />}
    </div>
  );
}

function ProjectForm({ project, onClose, onSaved }: { project: Project | null; onClose: () => void; onSaved: (id: string) => void }) {
  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      title: project?.title ?? "", description: project?.description ?? "", status: project?.status ?? "idea", format: (project?.format as FormValues["format"]) ?? "Short-form video",
      platforms: (project?.platforms as FormValues["platforms"]) ?? [], audience: project?.audience ?? "", language: project?.language ?? "en", tone: project?.tone ?? "",
      links: (project?.referenceLinks ?? []).map((url) => ({ url })), notes: project?.notes ?? "", dueDate: project?.dueDate?.slice(0, 10) ?? "",
    },
  });
  const links = useFieldArray({ control: form.control, name: "links" });
  const save = useAction(
    (v: FormValues) => {
      const body = { title: v.title, description: v.description || null, status: v.status, format: v.format, platforms: v.platforms, audience: v.audience || null, language: v.language, tone: v.tone || null, referenceLinks: v.links.map((l) => l.url), notes: v.notes || null, dueDate: v.dueDate ? new Date(`${v.dueDate}T12:00:00`).toISOString() : null };
      return project ? api.patch<Project>(`/api/v1/projects/${project.id}`, body) : api.post<Project>("/api/v1/projects", body);
    },
    { invalidate: [["projects"], ["project"]], success: project ? "Project saved" : "Project created", onSuccess: (p) => { onClose(); onSaved(p.id); } },
  );
  const e = form.formState.errors;
  const platforms = form.watch("platforms");
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={project ? "Edit project" : "New content project"} wide footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={form.handleSubmit((v) => save.mutate(v))} loading={save.isPending}>{project ? "Save project" : "Create project"}</Button></>}>
      <form className="grid gap-4 sm:grid-cols-2" onSubmit={form.handleSubmit((v) => save.mutate(v))}>
        <Field label="Title" htmlFor="p-title" error={e.title?.message} className="sm:col-span-2"><Input id="p-title" aria-invalid={!!e.title} {...form.register("title")} /></Field>
        <Field label="Brief" htmlFor="p-desc" className="sm:col-span-2"><Textarea id="p-desc" rows={3} placeholder="What is this piece about, and why will people care?" {...form.register("description")} /></Field>
        <Field label="Format" htmlFor="p-format"><Select id="p-format" {...form.register("format")}>{CONTENT_FORMATS.map((f) => <option key={f}>{f}</option>)}</Select></Field>
        <Field label="Stage" htmlFor="p-status"><Select id="p-status" {...form.register("status")}>{PROJECT_STATUSES.map((s) => <option key={s} value={s}>{STAGE_LABEL[s]}</option>)}</Select></Field>
        <fieldset className="sm:col-span-2">
          <legend className="mb-1.5 text-[13px] font-medium">Target platforms</legend>
          <div className="flex flex-wrap gap-2">
            {(["youtube", "tiktok", "instagram"] as const).map((p) => (
              <label key={p} className={cn("flex cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5 text-[13px]", platforms.includes(p) ? "border-violet bg-violet/10" : "border-line")}>
                <input type="checkbox" value={p} className="sr-only" {...form.register("platforms")} />
                <PlatformMark platform={p} className="size-5 text-[8px]" />{p === "youtube" ? "YouTube" : p === "tiktok" ? "TikTok" : "Instagram"}
              </label>
            ))}
          </div>
        </fieldset>
        <Field label="Target audience" htmlFor="p-aud"><Input id="p-aud" {...form.register("audience")} /></Field>
        <Field label="Tone" htmlFor="p-tone"><Select id="p-tone" {...form.register("tone")}><option value="">Not set</option>{TONES.map((t) => <option key={t}>{t}</option>)}</Select></Field>
        <Field label="Language" htmlFor="p-lang"><Select id="p-lang" {...form.register("language")}>{LANGS.map((l) => <option key={l} value={l}>{new Intl.DisplayNames(["en"], { type: "language" }).of(l)}</option>)}</Select></Field>
        <Field label="Due date" htmlFor="p-due"><Input id="p-due" type="date" className="[color-scheme:dark]" {...form.register("dueDate")} /></Field>
        <div className="sm:col-span-2">
          <p className="mb-1.5 text-[13px] font-medium">Reference links</p>
          <div className="space-y-2">
            {links.fields.map((f, i) => (
              <div key={f.id}>
                <div className="flex gap-2"><Input aria-label={`Reference link ${i + 1}`} placeholder="https://" aria-invalid={!!e.links?.[i]?.url} {...form.register(`links.${i}.url`)} /><Button type="button" size="icon" variant="ghost" onClick={() => links.remove(i)} aria-label="Remove link"><X /></Button></div>
                {e.links?.[i]?.url && <p className="mt-1 text-xs text-danger">{e.links[i]?.url?.message}</p>}
              </div>
            ))}
            <Button type="button" size="sm" variant="ghost" onClick={() => links.append({ url: "" })}><Link2 /> Add link</Button>
          </div>
        </div>
        <Field label="Notes" htmlFor="p-notes" className="sm:col-span-2"><Textarea id="p-notes" rows={3} {...form.register("notes")} /></Field>
      </form>
    </Dialog>
  );
}

function ProjectDrawer({ id, onClose, onEdit }: { id: string; onClose: () => void; onEdit: (p: Project) => void }) {
  const router = useRouter();
  const detail = useApiQuery<ProjectDetail>(["project", id], `/api/v1/projects/${id}`);
  const assets = useApiQuery<{ items: MediaAsset[] }>(["media", "project-assets"], "/api/v1/media?pageSize=100");
  const [confirm, setConfirm] = React.useState(false);
  const [upload, setUpload] = React.useState(false);
  const duplicate = useAction(() => api.post<Project>(`/api/v1/projects/${id}/duplicate`), { invalidate: [["projects"]], success: "Project duplicated", onSuccess: onClose });
  const remove = useAction(() => api.del(`/api/v1/projects/${id}`), { invalidate: [["projects"]], success: "Project deleted", onSuccess: onClose });
  const restore = useAction((versionId: string) => api.post(`/api/v1/projects/${id}/versions`, { versionId }), { invalidate: [["projects"], ["project", id]], success: "Version restored" });
  const setAssets = useAction((assetIds: string[]) => api.patch(`/api/v1/projects/${id}`, { assetIds }), { invalidate: [["project", id]] });
  const p = detail.data;
  const projectAssets = (assets.data?.items ?? []).filter((a) => p?.assetIds.includes(a.id));

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={p?.title ?? "Project"} description={p ? `${STAGE_LABEL[p.status]} stage, ${p.format}` : undefined} wide footer={p && <><Button variant="ghost" onClick={() => setConfirm(true)}><Trash2 /> Delete</Button><Button variant="ghost" onClick={() => duplicate.mutate(undefined)} loading={duplicate.isPending}><Copy /> Duplicate</Button><Button variant="primary" onClick={() => onEdit(p)}>Edit project</Button></>}>
      {!p ? <SkeletonRows /> : (
        <div className="space-y-5 text-[13.5px]">
          {p.description && <p className="leading-relaxed text-fg/90">{p.description}</p>}
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div><dt className="text-xs text-muted">Audience</dt><dd>{p.audience ?? "—"}</dd></div>
            <div><dt className="text-xs text-muted">Tone</dt><dd>{p.tone ?? "—"}</dd></div>
            <div><dt className="text-xs text-muted">Language</dt><dd>{new Intl.DisplayNames(["en"], { type: "language" }).of(p.language)}</dd></div>
            <div><dt className="text-xs text-muted">Due</dt><dd>{fmtDate(p.dueDate)}</dd></div>
          </dl>
          {!!p.referenceLinks.length && <div><p className="mb-1 text-xs text-muted">References</p><ul className="space-y-0.5">{p.referenceLinks.map((l) => <li key={l}><a href={l} target="_blank" rel="noreferrer" className="break-all text-violet-soft hover:underline">{l}</a></li>)}</ul></div>}
          <div>
            <div className="mb-2 flex items-center justify-between"><p className="text-xs text-muted">Assets</p><Button size="sm" variant="ghost" onClick={() => setUpload(true)}><Plus /> Add asset</Button></div>
            {projectAssets.length ? <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">{projectAssets.map((a) => <div key={a.id} className="group relative overflow-hidden rounded-md border border-line-soft"><MediaThumb asset={a} className="aspect-video w-full" /><button onClick={() => setAssets.mutate(p.assetIds.filter((x) => x !== a.id))} className="absolute right-1 top-1 rounded bg-ink/80 p-0.5 opacity-0 group-hover:opacity-100 focus:opacity-100" aria-label={`Remove ${a.filename}`}><X className="size-3" /></button></div>)}</div> : <p className="text-muted">No assets attached.</p>}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <div className="mb-1 flex items-center justify-between"><p className="text-xs text-muted">Scripts</p><Button size="sm" variant="ghost" onClick={() => router.push(`/scripts?new=1&project=${p.id}`)}><PenLine /> Write script</Button></div>
              {p.scripts.length ? <ul className="space-y-1">{p.scripts.map((s) => <li key={s.id}><Link href={`/scripts?id=${s.id}`} className="hover:text-violet-soft">{s.title}</Link></li>)}</ul> : <p className="text-muted">None yet.</p>}
            </div>
            <div>
              <div className="mb-1 flex items-center justify-between"><p className="text-xs text-muted">Posts</p><Button size="sm" variant="ghost" onClick={() => router.push(`/publishing?new=1&project=${p.id}`)}><Send /> Create post</Button></div>
              {p.posts.length ? <ul className="space-y-1">{p.posts.map((s) => <li key={s.id} className="flex items-center justify-between gap-2"><Link href={`/publishing?post=${s.id}`} className="truncate hover:text-violet-soft">{s.title}</Link><StatusBadge status={s.status} /></li>)}</ul> : <p className="text-muted">None yet.</p>}
            </div>
          </div>
          {p.notes && <div><p className="mb-1 text-xs text-muted">Notes</p><p className="whitespace-pre-wrap text-muted">{p.notes}</p></div>}
          <div>
            <p className="mb-1 flex items-center gap-1.5 text-xs text-muted"><History className="size-3.5" /> Version history</p>
            {p.versions.length ? <ul className="divide-y divide-line-soft rounded-md border border-line-soft">{p.versions.slice(0, 10).map((v) => <li key={v.id} className="flex items-center justify-between px-3 py-2"><span className="text-xs">Saved {fmtDate(v.createdAt, true)}</span><Button size="sm" variant="ghost" onClick={() => restore.mutate(v.id)} loading={restore.isPending && restore.variables === v.id}>Restore</Button></li>)}</ul> : <p className="text-muted">A version is saved automatically each time you edit.</p>}
          </div>
        </div>
      )}
      <ConfirmDialog open={confirm} onOpenChange={setConfirm} title="Delete this project?" description="Linked scripts and posts are kept but unlinked." confirmLabel="Delete project" onConfirm={() => remove.mutate(undefined)} loading={remove.isPending} />
      <UploadDialog open={upload} onOpenChange={setUpload} onUploaded={(a) => p && setAssets.mutate([...p.assetIds, a.id])} />
    </Dialog>
  );
}
