"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Ban, CheckCircle2, Eye, FileVideo, ImageIcon, Trash2, ShieldCheck } from "lucide-react";
import { api } from "@/lib/client/api";
import { useAction, useApiQuery, useMe } from "@/lib/client/hooks";
import { Badge, Button, ConfirmDialog, Dialog, EmptyState, ErrorState, Field, HelpTip, Input, Panel, PanelHeader, SkeletonRows, Tabs } from "@/components/ui/primitives";
import { DataTable, type Column } from "@/components/ui/data-table";
import { StatusBadge } from "@/components/ui/domain";
import { fmtBytes, fmtDate, fmtNum, fmtRelative } from "@/lib/client/utils";
import { AuditTable, type AdminUser, type AuditEntry } from "../page";

type Detail = AdminUser & {
  postsByStatus: { status: string; n: number }[];
  connections: { platform: string; accountName: string | null; status: string; createdAt: string }[];
  aiByDay: { day: string; calls: number; tokens: number }[];
  youtubeByBucket: { bucket: string; units: number; calls: number }[];
};
type PostItem = { id: string; title: string; caption: string; status: string; mediaAssetId: string | null; scheduledAt: string | null; createdAt: string; targets: { id: string; platform: string; status: string; publicationUrl: string | null; lastError: string | null }[] };
type ClipJobItem = { id: string; sourceType: string; title: string; youtubeVideoId: string | null; status: string; createdAt: string; clips: { id: string; rank: number; title: string; startSec: number; endSec: number; status: string; assetId: string | null }[] };
type MediaItem = { id: string; filename: string; kind: string; mimeType: string; sizeBytes: number; folder: string; createdAt: string };

const fileUrl = (assetId: string) => `/api/v1/admin/media/${assetId}/file`;

/** Like Stat, but the secondary number is visible text instead of a hover tooltip. */
function UsageStat({ label, value, sub, tip }: { label: string; value: React.ReactNode; sub?: string; tip?: string }) {
  return (
    <div className="min-w-0 px-5 py-4">
      <p className="flex items-center gap-1.5 text-[12.5px] text-muted">{label}{tip && <HelpTip text={tip} />}</p>
      <p className="mt-1 text-[24px] font-semibold tracking-[-0.02em] tabular-nums">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-muted tabular-nums">{sub}</p>}
    </div>
  );
}

export default function AdminUserPage() {
  const id = useSearchParams().get("id") ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(id)) return <ErrorState error={new Error("This user link is incomplete. Open the user from Owner console.")} />;
  return <AdminUserView id={id} />;
}

function AdminUserView({ id }: { id: string }) {
  const router = useRouter();
  const { data: me } = useMe();
  const detail = useApiQuery<Detail>(["admin-user", id], `/api/v1/admin/users/${id}`);
  const [confirmDisable, setConfirmDisable] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const [tab, setTab] = React.useState("usage");
  const inv = [["admin-user", id], ["admin-users"], ["admin-audit"], ["admin-audit", id]];
  const toggle = useAction((disabled: boolean) => api.patch(`/api/v1/admin/users/${id}`, { disabled }), { invalidate: inv, success: (r) => ((r as AdminUser).disabledAt ? "Account disabled" : "Account re-enabled"), onSuccess: () => setConfirmDisable(false) });

  if (detail.isLoading) return <SkeletonRows />;
  if (detail.error) return <ErrorState error={detail.error} />;
  const u = detail.data!;
  const self = me?.id === u.id;
  const protectedAccount = self || u.role === "owner";
  const yt = Object.fromEntries(u.youtubeByBucket.map((b) => [b.bucket, b]));

  return (
    <div className="space-y-4">
      <Link href="/admin" className="inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-fg"><ArrowLeft className="size-4" /> Owner console</Link>
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="flex flex-wrap items-center gap-2 text-2xl font-semibold tracking-[-0.02em]">
            {u.displayName || u.email}
            {u.role === "owner" && <Badge tone="violet">Owner</Badge>}
            {u.disabledAt && <Badge tone="danger">Disabled {fmtRelative(u.disabledAt)}</Badge>}
          </h1>
          <p className="mt-1 text-[13.5px] text-muted">{u.email}. Joined {fmtDate(u.createdAt)}. Last active {u.lastSeenAt ? fmtRelative(u.lastSeenAt) : "never"}.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {protectedAccount ? (
            <p className="flex items-center gap-1.5 text-xs text-muted"><ShieldCheck className="size-4" />{self ? "This is your account." : "Owner accounts are managed with the make-owner script."}</p>
          ) : (
            <>
              {u.disabledAt ? (
                <Button onClick={() => toggle.mutate(false)} loading={toggle.isPending}><CheckCircle2 /> Re-enable account</Button>
              ) : (
                <Button onClick={() => setConfirmDisable(true)}><Ban /> Disable account</Button>
              )}
              <Button variant="danger" onClick={() => setDeleting(true)}><Trash2 /> Delete account</Button>
            </>
          )}
        </div>
      </header>

      <Tabs value={tab} onValueChange={setTab} items={[{ value: "usage", label: "Usage" }, { value: "posts", label: "Posts" }, { value: "clips", label: "Clips" }, { value: "media", label: "Media" }, { value: "log", label: "Access log" }]}>
        {tab === "usage" && (
          <div className="space-y-4">
            <Panel>
              <div className="grid grid-cols-2 divide-line-soft sm:grid-cols-3 lg:grid-cols-6 lg:divide-x">
                <UsageStat label="Posts" value={fmtNum(u.usage.posts)} sub={`${fmtNum(u.usage.published)} published`} />
                <UsageStat label="Clips rendered" value={fmtNum(u.usage.clipsRendered)} sub={`${fmtNum(u.usage.clipJobs)} clip ${u.usage.clipJobs === 1 ? "job" : "jobs"}`} />
                <UsageStat label="Media" value={fmtBytes(u.usage.mediaBytes)} sub={`${fmtNum(u.usage.mediaCount)} ${u.usage.mediaCount === 1 ? "file" : "files"}`} />
                <UsageStat label="Connected accounts" value={fmtNum(u.usage.connections)} />
                <UsageStat label="AI calls, 30 days" value={fmtNum(u.usage.aiCalls30d)} sub={`${fmtNum(u.usage.aiTokens30d)} tokens`} tip="Tokens are the counts the AI provider reports for each call." />
                <UsageStat label="YouTube units, 30 days" value={fmtNum(u.usage.youtubeUnits30d)} sub={`${fmtNum(yt["search.list"]?.calls ?? 0)} searches, ${fmtNum(yt["videos.insert"]?.calls ?? 0)} uploads`} tip="Units are counted from Google's published cost per API call. Searches and uploads have their own daily call limits, so they're counted separately." />
              </div>
            </Panel>
            <div className="grid gap-4 lg:grid-cols-2">
              <Panel>
                <PanelHeader title="Posts by status" />
                <ul className="divide-y divide-line-soft border-t border-line-soft">
                  {u.postsByStatus.length ? u.postsByStatus.map((p) => <li key={p.status} className="flex items-center justify-between px-5 py-2.5 text-[13.5px]"><StatusBadge status={p.status} /><span className="tabular-nums">{fmtNum(p.n)}</span></li>) : <li className="px-5 py-4 text-[13px] text-muted">No posts yet.</li>}
                </ul>
              </Panel>
              <Panel>
                <PanelHeader title="Connected accounts" />
                <ul className="divide-y divide-line-soft border-t border-line-soft">
                  {u.connections.length ? u.connections.map((c, i) => <li key={i} className="flex items-center justify-between gap-3 px-5 py-2.5 text-[13.5px]"><span className="truncate capitalize">{c.platform}: {c.accountName ?? "Unnamed"}</span><StatusBadge status={c.status} /></li>) : <li className="px-5 py-4 text-[13px] text-muted">None connected.</li>}
                </ul>
              </Panel>
            </div>
          </div>
        )}
        {tab === "posts" && <PostsView userId={id} />}
        {tab === "clips" && <ClipsView userId={id} />}
        {tab === "media" && <MediaView userId={id} />}
        {tab === "log" && <UserAudit userId={id} />}
      </Tabs>

      <ConfirmDialog
        open={confirmDisable}
        onOpenChange={setConfirmDisable}
        title={`Disable ${u.email}?`}
        description="They are signed out everywhere and can't sign in until you re-enable the account. Their data is kept. Posts they already scheduled still publish."
        confirmLabel="Disable account"
        onConfirm={() => toggle.mutate(true)}
        loading={toggle.isPending}
      />
      {deleting && <DeleteDialog user={u} onClose={() => setDeleting(false)} onDeleted={() => router.push("/admin")} />}
    </div>
  );
}

function DeleteDialog({ user, onClose, onDeleted }: { user: AdminUser; onClose: () => void; onDeleted: () => void }) {
  const [typed, setTyped] = React.useState("");
  const qc = useQueryClient();
  const del = useAction(() => api.del<{ files: number; filesRemoved: number }>(`/api/v1/admin/users/${user.id}`, { confirmEmail: typed }), {
    invalidate: [["admin-users"], ["admin-audit"]],
    success: (r) => `Account deleted with ${r.filesRemoved} of ${r.files} files`,
    onSuccess: () => {
      // Drop the account from the cached list right away so it never flashes back while the list refetches.
      qc.setQueryData<{ items: AdminUser[] }>(["admin-users"], (prev) => (prev ? { ...prev, items: prev.items.filter((x) => x.id !== user.id) } : prev));
      onDeleted();
    },
  });
  const matches = typed.trim().toLowerCase() === user.email.toLowerCase();
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Delete this account permanently?"
      description="This removes the account and everything it owns: posts, clips, uploaded files, connected accounts, analytics and history. It can't be undone."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="danger" disabled={!matches} loading={del.isPending} onClick={() => del.mutate(undefined)}>Delete account</Button></>}
    >
      <Field label={`Type ${user.email} to confirm`} htmlFor="del-confirm"><Input id="del-confirm" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" /></Field>
    </Dialog>
  );
}

function ViewNotice() {
  return <p className="mb-3 flex items-center gap-1.5 text-xs text-muted"><Eye className="size-3.5" />Read-only. Opening this list is recorded in the access log.</p>;
}

function PostsView({ userId }: { userId: string }) {
  const data = useApiQuery<{ items: PostItem[] }>(["admin-content", userId, "posts"], `/api/v1/admin/users/${userId}/content?type=posts`);
  const cols: Column<PostItem>[] = [
    { key: "title", header: "Post", cell: (p) => <div className="min-w-0 max-w-md"><p className="truncate font-medium">{p.title}</p><p className="line-clamp-2 text-xs text-muted">{p.caption}</p></div>, sortValue: (p) => p.title },
    { key: "status", header: "Status", cell: (p) => <StatusBadge status={p.status} />, sortValue: (p) => p.status },
    { key: "targets", header: "Platforms", cell: (p) => <div className="flex flex-wrap gap-1">{p.targets.map((t) => (t.publicationUrl ? <a key={t.id} href={t.publicationUrl} target="_blank" rel="noopener noreferrer"><Badge tone="cyan">{t.platform}: {t.status}</Badge></a> : <Badge key={t.id} title={t.lastError ?? undefined}>{t.platform}: {t.status}</Badge>))}</div> },
    { key: "media", header: "Media", cell: (p) => (p.mediaAssetId ? <a className="text-xs text-violet-soft hover:underline" href={fileUrl(p.mediaAssetId)} target="_blank" rel="noopener noreferrer">Open file</a> : <span className="text-xs text-muted">None</span>) },
    { key: "created", header: "Created", cell: (p) => <span className="text-xs text-muted">{fmtDate(p.createdAt, true)}</span>, sortValue: (p) => p.createdAt },
  ];
  return (
    <Panel className="pt-4">
      <div className="px-5"><ViewNotice /></div>
      {data.isLoading ? <SkeletonRows /> : data.error ? <ErrorState error={data.error} /> : <DataTable rows={data.data?.items ?? []} columns={cols} rowKey={(p) => p.id} searchable={(p) => `${p.title} ${p.caption}`} initialSort={{ key: "created", dir: "desc" }} empty={<EmptyState title="No posts" />} />}
    </Panel>
  );
}

function ClipsView({ userId }: { userId: string }) {
  const data = useApiQuery<{ items: ClipJobItem[] }>(["admin-content", userId, "clips"], `/api/v1/admin/users/${userId}/content?type=clips`);
  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  return (
    <Panel className="p-5">
      <ViewNotice />
      {data.isLoading ? <SkeletonRows /> : data.error ? <ErrorState error={data.error} /> : !data.data?.items.length ? <EmptyState title="No clip jobs" /> : (
        <ul className="space-y-3">
          {data.data.items.map((j) => (
            <li key={j.id} className="rounded-md border border-line-soft p-3">
              <p className="flex flex-wrap items-center gap-2 text-[13.5px] font-medium">{j.title}<Badge>{j.sourceType === "youtube" ? "YouTube link" : "File"}</Badge><StatusBadge status={j.status} /><span className="text-xs font-normal text-muted">{fmtDate(j.createdAt, true)}</span></p>
              <ul className="mt-2 space-y-1">
                {j.clips.map((c) => (
                  <li key={c.id} className="flex flex-wrap items-center gap-2 text-[13px]">
                    <span className="tabular-nums text-muted">#{c.rank} {fmt(c.startSec)}–{fmt(c.endSec)}</span>
                    <span className="truncate">{c.title}</span>
                    {c.assetId ? <a className="text-xs text-violet-soft hover:underline" href={fileUrl(c.assetId)} target="_blank" rel="noopener noreferrer">Open clip</a> : j.youtubeVideoId ? <a className="text-xs text-violet-soft hover:underline" href={`https://www.youtube.com/watch?v=${j.youtubeVideoId}&t=${Math.floor(c.startSec)}s`} target="_blank" rel="noopener noreferrer">Watch on YouTube</a> : null}
                  </li>
                ))}
                {!j.clips.length && <li className="text-xs text-muted">No clips.</li>}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function MediaView({ userId }: { userId: string }) {
  const data = useApiQuery<{ items: MediaItem[] }>(["admin-content", userId, "media"], `/api/v1/admin/users/${userId}/content?type=media`);
  const [open, setOpen] = React.useState<MediaItem | null>(null);
  const cols: Column<MediaItem>[] = [
    { key: "name", header: "File", cell: (m) => <button type="button" onClick={() => setOpen(m)} className="flex items-center gap-2 text-left hover:text-violet-soft">{m.kind === "video" ? <FileVideo className="size-4 text-faint" /> : <ImageIcon className="size-4 text-faint" />}<span className="truncate">{m.filename}</span></button>, sortValue: (m) => m.filename },
    { key: "folder", header: "Folder", cell: (m) => <span className="text-xs text-muted">{m.folder}</span>, sortValue: (m) => m.folder },
    { key: "size", header: "Size", cell: (m) => <span className="tabular-nums text-xs">{fmtBytes(m.sizeBytes)}</span>, sortValue: (m) => m.sizeBytes },
    { key: "created", header: "Uploaded", cell: (m) => <span className="text-xs text-muted">{fmtDate(m.createdAt, true)}</span>, sortValue: (m) => m.createdAt },
  ];
  return (
    <Panel className="pt-4">
      <div className="px-5"><ViewNotice /></div>
      {data.isLoading ? <SkeletonRows /> : data.error ? <ErrorState error={data.error} /> : <DataTable rows={data.data?.items ?? []} columns={cols} rowKey={(m) => m.id} searchable={(m) => m.filename} initialSort={{ key: "created", dir: "desc" }} empty={<EmptyState title="No files" />} />}
      {open && (
        <Dialog open onOpenChange={(o) => !o && setOpen(null)} title={open.filename} description={`${fmtBytes(open.sizeBytes)}. Opening the file is recorded in the access log.`} wide>
          {open.kind === "video" ? <video src={fileUrl(open.id)} controls className="max-h-[60vh] w-full rounded-md bg-black" /> : open.kind === "image" ? <img src={fileUrl(open.id)} alt={open.filename} className="max-h-[60vh] w-full rounded-md object-contain" /> : <a className="text-violet-soft underline" href={`${fileUrl(open.id)}?download=1`}>Download file</a>}
        </Dialog>
      )}
    </Panel>
  );
}

function UserAudit({ userId }: { userId: string }) {
  const data = useApiQuery<{ items: AuditEntry[] }>(["admin-audit", userId], `/api/v1/admin/audit?userId=${userId}`);
  return <Panel className="pt-4">{data.isLoading ? <SkeletonRows /> : data.error ? <ErrorState error={data.error} /> : <AuditTable rows={data.data?.items ?? []} />}</Panel>;
}
