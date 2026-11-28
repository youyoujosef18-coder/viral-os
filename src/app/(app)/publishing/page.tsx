"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { fromZonedTime, toZonedTime, format as fmtTz } from "date-fns-tz";
import { toast } from "sonner";
import { Send, Plus, CalendarClock, Save, Copy, Trash2, RotateCw, Ban, ExternalLink, Pencil, Repeat2, PlugZap, Eye } from "lucide-react";
import { api, errorText } from "@/lib/client/api";
import { useAction, useApiQuery, useConnections, useMe, type Connection, type MediaAsset } from "@/lib/client/hooks";
import { Badge, Button, ConfirmDialog, Dialog, EmptyState, ErrorState, Field, Input, PageHeader, Panel, Select, SkeletonRows, Switch, TabPanel, Tabs, Textarea } from "@/components/ui/primitives";
import { PlatformMark, StatusBadge } from "@/components/ui/domain";
import { DataTable, type Column } from "@/components/ui/data-table";
import { MediaPicker } from "@/components/ui/media-picker";
import { CaptionEditor } from "@/components/ui/caption-editor";
import { cn, fmtDate, fmtRelative, statusLabel, PLATFORM_LABEL } from "@/lib/client/utils";

type Target = { id: string; postId: string; connectionId: string | null; platform: string; title: string | null; caption: string; hashtags: string[]; privacy: string; options: Record<string, unknown>; thumbnailAssetId: string | null; status: string; scheduledAt: string | null; attempts: number; nextAttemptAt: string | null; providerPostId: string | null; publicationUrl: string | null; publishedAt: string | null; lastError: string | null; lastErrorCode: string | null; idempotencyKey: string };
type Post = { id: string; title: string; baseCaption: string; projectId: string | null; mediaAssetId: string | null; thumbnailAssetId: string | null; status: string; scheduledAt: string | null; timezone: string; updatedAt: string; createdAt: string; targets: Target[] };
type PostDetail = Post & { events: { id: string; targetId: string; status: string; message: string; createdAt: string }[] };

const ACTIVE = ["queued", "uploading", "processing", "scheduled"];
const PRIVACY: Record<string, { value: string; label: string }[]> = {
  youtube: [{ value: "private", label: "Private" }, { value: "unlisted", label: "Unlisted" }, { value: "public", label: "Public" }],
  tiktok: [{ value: "SELF_ONLY", label: "Only me" }, { value: "MUTUAL_FOLLOW_FRIENDS", label: "Friends" }, { value: "FOLLOWER_OF_CREATOR", label: "Followers" }, { value: "PUBLIC_TO_EVERYONE", label: "Everyone" }],
  instagram: [{ value: "public", label: "Public (account visibility applies)" }],
};
const CAPTION_LIMIT: Record<string, number> = { youtube: 5000, tiktok: 2200, instagram: 2200 };
const YT_CATEGORIES = [["22", "People & Blogs"], ["27", "Education"], ["24", "Entertainment"], ["26", "Howto & Style"], ["28", "Science & Technology"], ["20", "Gaming"], ["10", "Music"], ["17", "Sports"], ["19", "Travel & Events"], ["1", "Film & Animation"], ["2", "Autos & Vehicles"], ["15", "Pets & Animals"], ["25", "News & Politics"], ["23", "Comedy"], ["29", "Nonprofits & Activism"]];
const TIMEZONES = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : ["UTC"];

export default function PublishingPage() {
  const params = useSearchParams();
  const router = useRouter();
  const [composer, setComposer] = React.useState<Post | "new" | null>(params.get("new") ? "new" : null);
  const [detailId, setDetailId] = React.useState<string | null>(params.get("post"));
  const [statusFilter, setStatusFilter] = React.useState("");
  const posts = useApiQuery<Post[]>(["posts"], "/api/v1/posts?limit=500", { refetchInterval: 15_000 });
  const rows = (posts.data ?? []).filter((p) => !statusFilter || p.status === statusFilter);
  const counts = (posts.data ?? []).flatMap((p) => p.targets).reduce<Record<string, number>>((a, t) => ((a[t.status] = (a[t.status] ?? 0) + 1), a), {});

  const cols: Column<Post>[] = [
    { key: "title", header: "Post", cell: (p) => <span className="font-medium">{p.title}</span>, sortValue: (p) => p.title },
    { key: "targets", header: "Destinations", cell: (p) => <span className="flex items-center gap-1.5">{p.targets.map((t) => <span key={t.id} title={`${PLATFORM_LABEL[t.platform]}: ${statusLabel(t.status)}`} className="relative"><PlatformMark platform={t.platform} /><span className={cn("absolute -bottom-0.5 -right-0.5 size-2 rounded-full ring-2 ring-panel", t.status === "published" ? "bg-success" : ["failed", "requires_user_action", "platform_approval_required"].includes(t.status) ? "bg-danger" : ACTIVE.includes(t.status) ? "bg-cyan" : "bg-faint")} /></span>)}{!p.targets.length && <span className="text-xs text-faint">None</span>}</span> },
    { key: "status", header: "Status", cell: (p) => <StatusBadge status={p.status} />, sortValue: (p) => p.status },
    { key: "when", header: "Scheduled / updated", cell: (p) => <span className="text-xs text-muted">{p.scheduledAt ? fmtDate(p.scheduledAt, true, p.timezone) : `Edited ${fmtRelative(p.updatedAt)}`}</span>, sortValue: (p) => p.scheduledAt ?? p.updatedAt },
  ];

  return (
    <div>
      <PageHeader title="Unified Publishing Center" description="Compose once, customize per platform, then publish now or schedule. A post is only marked published after the platform confirms it." actions={<Button variant="primary" onClick={() => setComposer("new")}><Plus /> New post</Button>} />
      <div className="mb-5 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8" role="group" aria-label="Filter by status">
        {(["", "draft", "scheduled", "queued", "processing", "published", "failed", "requires_user_action"] as const).map((s) => {
          const n = s ? (s === "processing" ? (counts.processing ?? 0) + (counts.uploading ?? 0) : counts[s] ?? 0) : (posts.data?.length ?? 0);
          return (
            <button key={s || "all"} onClick={() => setStatusFilter(s)} aria-pressed={statusFilter === s} className={cn("rounded-md border px-3 py-2 text-left transition-colors", statusFilter === s ? "border-violet bg-violet/10" : "border-line-soft bg-panel hover:border-line")}>
              <span className="block text-lg font-semibold tabular-nums">{n}</span>
              <span className="text-xs text-muted">{s ? statusLabel(s) : "All posts"}</span>
            </button>
          );
        })}
      </div>
      <Panel className="pt-4">
        {posts.isLoading ? <SkeletonRows /> : posts.error ? <ErrorState error={posts.error} onRetry={() => posts.refetch()} /> : (
          <DataTable rows={rows} columns={cols} rowKey={(p) => p.id} searchable={(p) => `${p.title} ${p.baseCaption}`} onRowClick={(p) => setDetailId(p.id)} initialSort={{ key: "when", dir: "desc" }} empty={<EmptyState icon={Send} title={statusFilter ? `No ${statusLabel(statusFilter).toLowerCase()} posts` : "No posts yet"} description="Create a post, attach a video or image, choose your connected accounts and publish or schedule." action={<Button variant="primary" onClick={() => setComposer("new")}>New post</Button>} />} />
        )}
      </Panel>
      {composer && <Composer post={composer === "new" ? null : composer} projectId={params.get("project")} onClose={() => { setComposer(null); if (params.get("new")) router.replace("/publishing"); }} onSaved={(id) => setDetailId(id)} />}
      {detailId && <PostDetailDialog id={detailId} onClose={() => { setDetailId(null); if (params.get("post")) router.replace("/publishing"); }} onEdit={(p) => { setDetailId(null); setComposer(p); }} />}
    </div>
  );
}

type TargetDraft = { connectionId: string; platform: string; title: string; caption: string; hashtags: string; privacy: string; options: Record<string, unknown>; thumbnailAssetId: string | null; customCaption: boolean };

function defaultsFor(c: Connection): TargetDraft {
  return { connectionId: c.id, platform: c.platform, title: "", caption: "", hashtags: "", privacy: c.platform === "tiktok" ? "SELF_ONLY" : c.platform === "youtube" ? "private" : "public", options: c.platform === "youtube" ? { categoryId: "22", madeForKids: false } : c.platform === "instagram" ? { shareToFeed: true } : { disableComment: false, disableDuet: false, disableStitch: false, isAiGenerated: false }, thumbnailAssetId: null, customCaption: false };
}

function Composer({ post, projectId, onClose, onSaved }: { post: Post | null; projectId: string | null; onClose: () => void; onSaved: (id: string) => void }) {
  const { data: me } = useMe();
  const { data: connections } = useConnections();
  const [title, setTitle] = React.useState(post?.title ?? "");
  const [caption, setCaption] = React.useState(post?.baseCaption ?? "");
  const [mediaId, setMediaId] = React.useState<string | null>(post?.mediaAssetId ?? null);
  const [media, setMedia] = React.useState<MediaAsset | null>(null);
  const [thumbId, setThumbId] = React.useState<string | null>(post?.thumbnailAssetId ?? null);
  const [targets, setTargets] = React.useState<TargetDraft[]>(
    post?.targets.filter((t) => t.connectionId).map((t) => ({ connectionId: t.connectionId!, platform: t.platform, title: t.title ?? "", caption: t.caption, hashtags: t.hashtags.map((h) => `#${h}`).join(" "), privacy: t.privacy, options: t.options, thumbnailAssetId: t.thumbnailAssetId, customCaption: !!t.caption && t.caption !== post.baseCaption })) ?? [],
  );
  const [tab, setTab] = React.useState("content");
  // Editing a scheduled post keeps it scheduled at its saved time unless the user changes that.
  const wasScheduled = post?.status === "scheduled" && !!post.scheduledAt;
  const [mode, setMode] = React.useState<"draft" | "now" | "schedule">(wasScheduled ? "schedule" : "draft");
  const [tzOverride, setTimezone] = React.useState<string | null>(post?.timezone ?? null);
  const timezone = tzOverride ?? me?.timezone ?? "UTC";
  const tz = timezone;
  const wallTime = (d: Date, zone: string) => fmtTz(toZonedTime(d, zone), "yyyy-MM-dd'T'HH:mm", { timeZone: zone });
  const [when, setWhenRaw] = React.useState(() => wallTime(wasScheduled ? new Date(post!.scheduledAt!) : new Date(Date.now() + 3600_000), tz));
  const whenTouched = React.useRef(wasScheduled);
  const setWhen = (v: string) => {
    whenTouched.current = true;
    setWhenRaw(v);
  };
  // The profile timezone can arrive after the first render; recompute the default time in it.
  React.useEffect(() => {
    if (!whenTouched.current) setWhenRaw(wallTime(new Date(Date.now() + 3600_000), tz));
  }, [tz]);
  // Only review states are editable here; a scheduled, failed or cancelled post is saved back as a draft.
  const REVIEW_STATES = ["draft", "needs_review", "ready"] as const;
  const [reviewStatus, setReviewStatus] = React.useState<"draft" | "needs_review" | "ready">(REVIEW_STATES.find((st) => st === post?.status) ?? "draft");
  const [errors, setErrors] = React.useState<string[]>([]);
  const [busy, setBusy] = React.useState(false);

  const active = (connections ?? []).filter((c) => c.status === "active" || c.status === "error");
  const toggle = (c: Connection) => setTargets((t) => (t.some((x) => x.connectionId === c.id) ? t.filter((x) => x.connectionId !== c.id) : [...t, defaultsFor(c)]));
  const patch = (id: string, p: Partial<TargetDraft>) => setTargets((t) => t.map((x) => (x.connectionId === id ? { ...x, ...p } : x)));

  const localProblems = () => {
    const p: string[] = [];
    if (!title.trim()) p.push("Add a title.");
    if (mode !== "draft") {
      if (!mediaId) p.push("Attach a video or image.");
      if (!targets.length) p.push("Select at least one connected account.");
      for (const t of targets) {
        const cap = t.customCaption ? t.caption : caption;
        if (cap.length > CAPTION_LIMIT[t.platform]) p.push(`${PLATFORM_LABEL[t.platform]} caption is over ${CAPTION_LIMIT[t.platform]} characters.`);
        if (t.platform === "youtube" && (t.title || title).length > 100) p.push("YouTube titles are limited to 100 characters.");
      }
      if (mode === "schedule") {
        const at = fromZonedTime(when, timezone);
        if (Number.isNaN(at.getTime())) p.push("Pick a valid date and time.");
        else if (at.getTime() < Date.now()) p.push("The scheduled time is in the past.");
      }
    }
    return p;
  };

  const submit = async () => {
    const p = localProblems();
    setErrors(p);
    if (p.length) return;
    setBusy(true);
    try {
      const body = {
        title: title.trim(),
        baseCaption: caption,
        projectId: post?.projectId ?? projectId ?? null,
        mediaAssetId: mediaId,
        thumbnailAssetId: thumbId,
        timezone,
        status: reviewStatus,
        targets: targets.map((t) => ({ connectionId: t.connectionId, title: t.platform === "youtube" ? t.title || title : null, caption: t.customCaption ? t.caption : caption, hashtags: t.hashtags.split(/[\s,]+/).map((h) => h.replace(/^#+/, "")).filter(Boolean), privacy: t.privacy, options: t.options, thumbnailAssetId: t.thumbnailAssetId })),
      };
      const saved = post ? await api.put<Post>(`/api/v1/posts/${post.id}`, body) : await api.post<Post>("/api/v1/posts", body);
      if (mode !== "draft") {
        const scheduledAt = mode === "schedule" ? fromZonedTime(when, timezone).toISOString() : null;
        try {
          await api.post(`/api/v1/posts/${saved.id}/publish`, { scheduledAt });
        } catch (err) {
          setErrors([errorText(err)]);
          toast.error("Saved as draft, but not queued. Fix the issues listed.");
          setBusy(false);
          return;
        }
      }
      toast.success(mode === "draft" ? "Draft saved" : mode === "now" ? "Queued for publishing" : "Post scheduled");
      onClose();
      onSaved(saved.id);
    } catch (err) {
      setErrors([errorText(err)]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()} title={post ? "Edit post" : "New post"} wide footer={
      <>
        <Select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)} className="mr-auto w-44" aria-label="Publishing mode"><option value="draft">Save as draft</option><option value="now">Publish now</option><option value="schedule">Schedule</option></Select>
        <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button variant="primary" onClick={submit} loading={busy}>{mode === "draft" ? <><Save /> Save draft</> : mode === "now" ? <><Send /> Publish now</> : <><CalendarClock /> Schedule post</>}</Button>
      </>
    }>
      {errors.length > 0 && <div role="alert" className="mb-4 rounded-md border border-danger/30 bg-danger/5 p-3 text-[13px] text-danger"><ul className="list-disc space-y-0.5 pl-4">{errors.map((e) => <li key={e}>{e}</li>)}</ul></div>}
      <Tabs value={tab} onValueChange={setTab} items={[{ value: "content", label: "Content" }, { value: "platforms", label: `Platforms${targets.length ? ` (${targets.length})` : ""}` }, { value: "preview", label: "Preview" }, { value: "timing", label: "Timing" }]}>
        <TabPanel value="content" className="space-y-4">
          <Field label="Title" htmlFor="c-title" hint="Used as the YouTube title unless you override it per platform."><Input id="c-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} /></Field>
          <Field label="Caption"><CaptionEditor value={caption} onChange={setCaption} limit={2200} /></Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Media"><MediaPicker value={mediaId} onChange={(id, a) => { setMediaId(id); setMedia(a ?? null); }} label="Choose video or image" /></Field>
            <Field label="Thumbnail / cover" hint="Optional. YouTube custom thumbnails need a verified account."><MediaPicker value={thumbId} onChange={(id) => setThumbId(id)} kind="image" label="Choose image" /></Field>
          </div>
          <Field label="Review status" htmlFor="c-review"><Select id="c-review" value={reviewStatus} onChange={(e) => setReviewStatus(e.target.value as typeof reviewStatus)} className="w-56"><option value="draft">Draft</option><option value="needs_review">Needs review</option><option value="ready">Ready</option></Select></Field>
        </TabPanel>

        <TabPanel value="platforms" className="space-y-4">
          {!active.length ? (
            <EmptyState icon={PlugZap} title="No connected accounts" description="Connect YouTube, TikTok or Instagram to publish. Drafts can still be saved." action={<Link href="/settings?tab=connections"><Button>Connect an account</Button></Link>} />
          ) : (
            <>
              <div className="flex flex-wrap gap-2">
                {active.map((c) => {
                  const on = targets.some((t) => t.connectionId === c.id);
                  return <button key={c.id} onClick={() => toggle(c)} aria-pressed={on} className={cn("flex items-center gap-2 rounded-md border px-3 py-2 text-[13px] transition-colors", on ? "border-violet bg-violet/10" : "border-line hover:border-faint")}><PlatformMark platform={c.platform} />{c.accountName}{c.status !== "active" && <Badge tone="warning">check</Badge>}</button>;
                })}
              </div>
              {targets.map((t) => {
                const conn = active.find((c) => c.id === t.connectionId);
                return (
                  <section key={t.connectionId} className="rounded-md border border-line-soft bg-ink-2 p-4" aria-label={`${PLATFORM_LABEL[t.platform]} settings`}>
                    <p className="mb-3 flex items-center gap-2 text-[13.5px] font-medium"><PlatformMark platform={t.platform} />{conn?.accountName}</p>
                    <div className="grid gap-3 sm:grid-cols-2">
                      {t.platform === "youtube" && <Field label="YouTube title" htmlFor={`yt-${t.connectionId}`} hint={`${(t.title || title).length}/100`}><Input id={`yt-${t.connectionId}`} value={t.title} placeholder={title} onChange={(e) => patch(t.connectionId, { title: e.target.value })} /></Field>}
                      <Field label="Privacy" htmlFor={`pv-${t.connectionId}`} hint={t.platform === "tiktok" ? "Unaudited TikTok apps can only post as 'Only me'." : undefined}><Select id={`pv-${t.connectionId}`} value={t.privacy} onChange={(e) => patch(t.connectionId, { privacy: e.target.value })}>{PRIVACY[t.platform].map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select></Field>
                      <Field label="Hashtags" htmlFor={`ht-${t.connectionId}`} className="sm:col-span-2"><Input id={`ht-${t.connectionId}`} value={t.hashtags} onChange={(e) => patch(t.connectionId, { hashtags: e.target.value })} placeholder="#tag #another" /></Field>
                      {t.platform === "youtube" && <Field label="Category" htmlFor={`cat-${t.connectionId}`}><Select id={`cat-${t.connectionId}`} value={String(t.options.categoryId ?? "22")} onChange={(e) => patch(t.connectionId, { options: { ...t.options, categoryId: e.target.value } })}>{YT_CATEGORIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></Field>}
                      {t.platform === "youtube" && <label className="flex items-center gap-2 self-end pb-2 text-[13px]"><Switch checked={!!t.options.madeForKids} onCheckedChange={(v) => patch(t.connectionId, { options: { ...t.options, madeForKids: v } })} label="Made for kids" />Made for kids</label>}
                      {t.platform === "tiktok" && (["disableComment", "disableDuet", "disableStitch", "isAiGenerated", "brandContent"] as const).map((k) => <label key={k} className="flex items-center gap-2 text-[13px]"><Switch checked={!!t.options[k]} onCheckedChange={(v) => patch(t.connectionId, { options: { ...t.options, [k]: v } })} label={k} />{{ disableComment: "Turn off comments", disableDuet: "Turn off Duet", disableStitch: "Turn off Stitch", isAiGenerated: "Label as AI-generated", brandContent: "Paid partnership (branded content)" }[k]}</label>)}
                      {t.platform === "instagram" && <label className="flex items-center gap-2 text-[13px]"><Switch checked={t.options.shareToFeed !== false} onCheckedChange={(v) => patch(t.connectionId, { options: { ...t.options, shareToFeed: v } })} label="Share Reel to feed" />Also share Reel to feed</label>}
                    </div>
                    <label className="mt-3 flex items-center gap-2 text-[13px]"><Switch checked={t.customCaption} onCheckedChange={(v) => patch(t.connectionId, { customCaption: v, caption: v ? t.caption || caption : "" })} label="Custom caption" />Use a custom caption for {PLATFORM_LABEL[t.platform]}</label>
                    {t.customCaption && <div className="mt-2"><CaptionEditor value={t.caption} onChange={(v) => patch(t.connectionId, { caption: v })} limit={CAPTION_LIMIT[t.platform]} ariaLabel={`${PLATFORM_LABEL[t.platform]} caption`} /></div>}
                    <div className="mt-3"><Field label={`${PLATFORM_LABEL[t.platform]} thumbnail`} hint="Optional per-platform override."><MediaPicker value={t.thumbnailAssetId} onChange={(id) => patch(t.connectionId, { thumbnailAssetId: id })} kind="image" label="Choose image" /></Field></div>
                  </section>
                );
              })}
            </>
          )}
        </TabPanel>

        <TabPanel value="preview">
          {!targets.length ? <p className="text-[13px] text-muted">Select accounts on the Platforms tab to preview each post.</p> : (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {targets.map((t) => {
                const cap = t.customCaption ? t.caption : caption;
                const tags = t.hashtags.split(/[\s,]+/).filter(Boolean).map((h) => `#${h.replace(/^#+/, "")}`).join(" ");
                const vertical = t.platform !== "youtube";
                return (
                  <div key={t.connectionId} className="rounded-md border border-line-soft bg-ink-2 p-3">
                    <p className="mb-2 flex items-center gap-2 text-xs text-muted"><PlatformMark platform={t.platform} className="size-5 text-[8px]" /><Eye className="size-3.5" />Preview, approximate layout</p>
                    <div className={cn("relative overflow-hidden rounded-md bg-black", vertical ? "mx-auto aspect-[9/16] w-48" : "aspect-video w-full")}>
                      {mediaId && media?.kind !== "image" ? <video src={`/api/v1/media/${mediaId}/file`} className="size-full object-cover" muted controls preload="metadata" /> : mediaId ? <img src={`/api/v1/media/${mediaId}/file`} alt="" className="size-full object-cover" /> : <div className="grid size-full place-items-center text-xs text-faint">No media</div>}
                      {vertical && <p className="pointer-events-none absolute inset-x-0 bottom-0 line-clamp-3 bg-gradient-to-t from-black/80 p-2 text-[11px] text-white">{cap} {tags}</p>}
                    </div>
                    {!vertical && <><p className="mt-2 line-clamp-2 text-[13.5px] font-medium">{t.title || title || "Untitled"}</p><p className="mt-1 line-clamp-3 whitespace-pre-wrap text-xs text-muted">{cap}{tags ? `\n${tags}` : ""}</p></>}
                    <p className="mt-2 text-xs text-faint">Visibility: {PRIVACY[t.platform].find((o) => o.value === t.privacy)?.label}</p>
                  </div>
                );
              })}
            </div>
          )}
        </TabPanel>

        <TabPanel value="timing" className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            {(["draft", "now", "schedule"] as const).map((m) => <button key={m} onClick={() => setMode(m)} aria-pressed={mode === m} className={cn("rounded-md border p-3 text-left", mode === m ? "border-violet bg-violet/10" : "border-line")}><p className="text-[13.5px] font-medium">{m === "draft" ? "Save as draft" : m === "now" ? "Publish now" : "Schedule"}</p><p className="mt-0.5 text-xs text-muted">{m === "draft" ? "Nothing is sent to platforms." : m === "now" ? "Queued immediately; the worker uploads it." : "Sent at an exact time in your timezone."}</p></button>)}
          </div>
          {mode === "schedule" && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Date and time" htmlFor="c-when"><Input id="c-when" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} className="[color-scheme:dark]" /></Field>
              <Field label="Timezone" htmlFor="c-tz"><Select id="c-tz" value={timezone} onChange={(e) => setTimezone(e.target.value)}>{TIMEZONES.map((z) => <option key={z}>{z}</option>)}</Select></Field>
              <p className="text-xs text-muted sm:col-span-2">{(() => { try { return `Publishes at ${fromZonedTime(when, timezone).toLocaleString()} your device time (${fromZonedTime(when, timezone).toISOString()} UTC).`; } catch { return ""; } })()}</p>
            </div>
          )}
        </TabPanel>
      </Tabs>
    </Dialog>
  );
}

function PostDetailDialog({ id, onClose, onEdit }: { id: string; onClose: () => void; onEdit: (p: Post) => void }) {
  const detail = useApiQuery<PostDetail>(["post", id], `/api/v1/posts/${id}`, { refetchInterval: 5000 });
  const [confirmDel, setConfirmDel] = React.useState(false);
  const inv = [["post", id], ["posts"], ["notifications"]];
  const retry = useAction((tid: string) => api.post(`/api/v1/targets/${tid}/retry`), { invalidate: inv, success: "Retry queued" });
  const cancelT = useAction((tid: string) => api.post(`/api/v1/targets/${tid}/cancel`), { invalidate: inv, success: "Cancelled" });
  const cancelAll = useAction(() => api.post(`/api/v1/posts/${id}/cancel`), { invalidate: inv, success: "Post cancelled" });
  const dup = useAction(() => api.post<Post>(`/api/v1/posts/${id}/duplicate`), { invalidate: [["posts"]], success: "Duplicated as a draft" });
  const del = useAction(() => api.del(`/api/v1/posts/${id}`), { invalidate: [["posts"]], success: "Post deleted", onSuccess: onClose });
  const p = detail.data;
  const editable = p?.targets.every((t) => ["draft", "needs_review", "ready", "scheduled", "failed", "requires_user_action", "platform_approval_required", "cancelled"].includes(t.status));
  const published = p?.targets.some((t) => t.status === "published");
  const repost = async () => {
    const copy = await dup.mutateAsync(undefined);
    const full = await api.get<PostDetail>(`/api/v1/posts/${copy.id}`);
    onEdit(full);
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={p?.title ?? "Post"} description={p ? `Created ${fmtDate(p.createdAt, true)}` : undefined} wide footer={p && (
      <>
        <Button variant="ghost" onClick={() => setConfirmDel(true)}><Trash2 /> Delete</Button>
        <Button variant="ghost" onClick={() => cancelAll.mutate(undefined)} loading={cancelAll.isPending} disabled={!p.targets.some((t) => ["scheduled", "queued", "draft", "ready", "needs_review"].includes(t.status))}><Ban /> Cancel queued</Button>
        <Button variant="ghost" onClick={() => dup.mutate(undefined)} loading={dup.isPending && !published}><Copy /> Duplicate</Button>
        {published && <Button onClick={repost}><Repeat2 /> Repost</Button>}
        {editable && <Button variant="primary" onClick={() => onEdit(p)}><Pencil /> Edit</Button>}
      </>
    )}>
      {!p ? <SkeletonRows /> : (
        <div className="space-y-5">
          {p.scheduledAt && <p className="flex items-center gap-2 text-[13px] text-muted"><CalendarClock className="size-4" />Scheduled for {fmtDate(p.scheduledAt, true, p.timezone)} ({p.timezone})</p>}
          <ul className="space-y-3">
            {p.targets.map((t) => (
              <li key={t.id} className="rounded-md border border-line-soft bg-ink-2 p-4">
                <div className="flex flex-wrap items-center gap-3">
                  <PlatformMark platform={t.platform} />
                  <span className="text-[13.5px] font-medium">{PLATFORM_LABEL[t.platform]}</span>
                  <StatusBadge status={t.status} />
                  {t.attempts > 0 && <span className="text-xs text-faint">{t.attempts} attempt{t.attempts > 1 ? "s" : ""}</span>}
                  <span className="ml-auto flex gap-1">
                    {t.publicationUrl && <a href={t.publicationUrl} target="_blank" rel="noreferrer"><Button size="sm" variant="ghost"><ExternalLink /> View post</Button></a>}
                    {["failed", "requires_user_action", "platform_approval_required", "cancelled"].includes(t.status) && <Button size="sm" onClick={() => retry.mutate(t.id)} loading={retry.isPending && retry.variables === t.id}><RotateCw /> Retry</Button>}
                    {["scheduled", "queued", "draft", "ready", "needs_review"].includes(t.status) && <Button size="sm" variant="ghost" onClick={() => cancelT.mutate(t.id)}><Ban /> Cancel</Button>}
                  </span>
                </div>
                {t.lastError && <p className="mt-2 rounded border border-danger/20 bg-danger/5 px-3 py-2 text-[13px] text-danger">{t.lastError}{t.status === "queued" && t.nextAttemptAt ? ` Next attempt ${fmtRelative(t.nextAttemptAt).replace("ago", "from now")}.` : ""}</p>}
                {t.status === "platform_approval_required" && <p className="mt-2 text-xs text-muted">The platform requires an app review before this visibility is allowed. Change privacy (Edit) or complete the platform&apos;s review, then retry.</p>}
                {t.providerPostId && <p className="mt-2 text-xs text-faint">Platform post ID: {t.providerPostId}{t.publishedAt ? `, confirmed ${fmtDate(t.publishedAt, true)}` : ""}</p>}
              </li>
            ))}
            {!p.targets.length && <li className="text-[13px] text-muted">No destinations selected. Edit the post to choose accounts.</li>}
          </ul>
          <div>
            <h3 className="mb-2 text-[13.5px] font-semibold">Publishing history</h3>
            {p.events.length ? (
              <ol className="relative space-y-3 border-l border-line pl-4">
                {p.events.map((e) => {
                  const t = p.targets.find((x) => x.id === e.targetId);
                  return <li key={e.id} className="text-[13px]"><span className={cn("absolute -left-[5px] mt-1.5 size-2.5 rounded-full", e.status === "published" ? "bg-success" : ["failed", "requires_user_action", "platform_approval_required"].includes(e.status) ? "bg-danger" : "bg-violet")} /><p className="flex flex-wrap items-center gap-2">{t && <PlatformMark platform={t.platform} className="size-5 text-[8px]" />}<span className="font-medium">{statusLabel(e.status)}</span><span className="text-xs text-faint">{fmtDate(e.createdAt, true)}</span></p><p className="text-muted">{e.message}</p></li>;
                })}
              </ol>
            ) : <p className="text-[13px] text-muted">Events appear once the post is queued.</p>}
          </div>
          {p.baseCaption && <div><h3 className="mb-1 text-[13.5px] font-semibold">Caption</h3><Textarea readOnly value={p.baseCaption} rows={3} aria-label="Caption" /></div>}
        </div>
      )}
      <ConfirmDialog open={confirmDel} onOpenChange={setConfirmDel} title="Delete this post?" description="Already-published content stays live on the platforms; only the VIRAL OS record is removed." confirmLabel="Delete post" onConfirm={() => del.mutate(undefined)} loading={del.isPending} />
    </Dialog>
  );
}
