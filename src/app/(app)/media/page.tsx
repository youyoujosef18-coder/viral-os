"use client";

import * as React from "react";
import { FolderOpen, Upload, Trash2, Download, Film, ImageIcon, FileText, Music, Pencil } from "lucide-react";
import { api } from "@/lib/client/api";
import { useAction, useApiQuery, type MediaAsset } from "@/lib/client/hooks";
import { Badge, Button, ConfirmDialog, Dialog, EmptyState, ErrorState, Field, Input, PageHeader, Panel, Select, SkeletonRows } from "@/components/ui/primitives";
import { MediaThumb } from "@/components/ui/media-picker";
import { UploadDialog } from "@/components/shell/upload-dialog";
import { cn, fmtBytes, fmtDate } from "@/lib/client/utils";

type Page = { items: MediaAsset[]; total: number; page: number; pageSize: number; folders: string[] };
const KIND_ICON = { video: Film, image: ImageIcon, audio: Music, document: FileText };

export default function MediaPage() {
  const [kind, setKind] = React.useState("");
  const [folder, setFolder] = React.useState("");
  const [q, setQ] = React.useState("");
  const [page, setPage] = React.useState(1);
  const [upload, setUpload] = React.useState(false);
  const [preview, setPreview] = React.useState<MediaAsset | null>(null);
  const [del, setDel] = React.useState<MediaAsset | null>(null);
  const url = `/api/v1/media?page=${page}&pageSize=24${kind ? `&kind=${kind}` : ""}${folder ? `&folder=${encodeURIComponent(folder)}` : ""}${q ? `&q=${encodeURIComponent(q)}` : ""}`;
  const data = useApiQuery<Page>(["media", url], url);
  const remove = useAction((id: string) => api.del(`/api/v1/media/${id}`), { invalidate: [["media"]], success: "File deleted", onSuccess: () => { setDel(null); setPreview(null); } });
  const pages = data.data ? Math.max(1, Math.ceil(data.data.total / data.data.pageSize)) : 1;

  return (
    <div>
      <PageHeader title="Media Library" description="Everything you upload or generate, stored privately. Use files in posts, thumbnails and the Video Analyzer." actions={<Button variant="primary" onClick={() => setUpload(true)}><Upload /> Upload</Button>} />
      <div className="mb-4 flex flex-wrap gap-2">
        <Input value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Search by filename" className="w-64" aria-label="Search media" />
        <Select value={kind} onChange={(e) => { setKind(e.target.value); setPage(1); }} className="w-36" aria-label="File type"><option value="">All types</option><option value="video">Videos</option><option value="image">Images</option><option value="audio">Audio</option><option value="document">Documents</option></Select>
        <Select value={folder} onChange={(e) => { setFolder(e.target.value); setPage(1); }} className="w-44" aria-label="Folder"><option value="">All folders</option>{data.data?.folders.map((f) => <option key={f}>{f}</option>)}</Select>
        {data.data && <span className="self-center text-xs text-muted">{data.data.total} files</span>}
      </div>
      {data.isLoading ? <Panel><SkeletonRows /></Panel> : data.error ? <Panel><ErrorState error={data.error} onRetry={() => data.refetch()} /></Panel> : !data.data?.items.length ? (
        <Panel><EmptyState icon={FolderOpen} title={q || kind || folder ? "No files match these filters" : "Your library is empty"} description="Upload videos for publishing and analysis, images for thumbnails, or documents for reference." action={<Button variant="primary" onClick={() => setUpload(true)}>Upload files</Button>} /></Panel>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
            {data.data.items.map((a) => {
              const Icon = KIND_ICON[a.kind];
              return (
                <button key={a.id} onClick={() => setPreview(a)} className="overflow-hidden rounded-md border border-line-soft bg-panel text-left transition-colors hover:border-line focus-visible:border-violet">
                  <MediaThumb asset={a} className="aspect-video w-full" />
                  <div className="p-2.5"><p className="truncate text-[13px]">{a.filename}</p><p className="mt-0.5 flex items-center gap-1 text-[11px] text-faint"><Icon className="size-3" />{fmtBytes(a.sizeBytes)}, {a.folder}</p></div>
                </button>
              );
            })}
          </div>
          {pages > 1 && <div className="mt-4 flex items-center justify-center gap-2"><Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button><span className="text-xs tabular-nums text-muted">Page {page} of {pages}</span><Button size="sm" variant="ghost" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</Button></div>}
        </>
      )}
      <UploadDialog open={upload} onOpenChange={setUpload} folder={folder} />
      {preview && <PreviewDialog asset={preview} onClose={() => setPreview(null)} onDelete={() => setDel(preview)} />}
      <ConfirmDialog open={!!del} onOpenChange={(o) => !o && setDel(null)} title={`Delete ${del?.filename}?`} description="Posts using this file will no longer be publishable until you attach another." confirmLabel="Delete file" onConfirm={() => del && remove.mutate(del.id)} loading={remove.isPending} />
    </div>
  );
}

function PreviewDialog({ asset, onClose, onDelete }: { asset: MediaAsset; onClose: () => void; onDelete: () => void }) {
  const [edit, setEdit] = React.useState(false);
  const [f, setF] = React.useState({ filename: asset.filename, folder: asset.folder, tags: asset.tags.join(", ") });
  const save = useAction(() => api.patch(`/api/v1/media/${asset.id}`, { filename: f.filename, folder: f.folder, tags: f.tags.split(",").map((t) => t.trim()).filter(Boolean) }), { invalidate: [["media"]], success: "Details saved", onSuccess: () => setEdit(false) });
  const src = `/api/v1/media/${asset.id}/file`;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={asset.filename} description={`${asset.mimeType}, ${fmtBytes(asset.sizeBytes)}, uploaded ${fmtDate(asset.createdAt)}`} wide footer={<><Button variant="ghost" onClick={onDelete}><Trash2 /> Delete</Button><a href={`${src}?download=1`}><Button><Download /> Download</Button></a><Button variant="primary" onClick={() => (edit ? save.mutate(undefined) : setEdit(true))} loading={save.isPending}>{edit ? "Save details" : <><Pencil /> Edit details</>}</Button></>}>
      <div className={cn("overflow-hidden rounded-md bg-black", asset.kind === "audio" || asset.kind === "document" ? "p-4" : "")}>
        {asset.kind === "video" && <video src={src} controls className="max-h-[50vh] w-full" />}
        {asset.kind === "image" && <img src={src} alt={asset.filename} className="max-h-[50vh] w-full object-contain" />}
        {asset.kind === "audio" && <audio src={src} controls className="w-full" />}
        {asset.kind === "document" && <a href={src} target="_blank" rel="noreferrer" className="text-violet-soft underline">Open document</a>}
      </div>
      {edit ? (
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <Field label="Filename" htmlFor="m-fn"><Input id="m-fn" value={f.filename} onChange={(e) => setF({ ...f, filename: e.target.value })} /></Field>
          <Field label="Folder" htmlFor="m-fo"><Input id="m-fo" value={f.folder} onChange={(e) => setF({ ...f, folder: e.target.value })} /></Field>
          <Field label="Tags" htmlFor="m-tg" hint="Comma separated"><Input id="m-tg" value={f.tags} onChange={(e) => setF({ ...f, tags: e.target.value })} /></Field>
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted">{asset.width && <span>{asset.width}×{asset.height}</span>}<Badge>{asset.folder}</Badge>{asset.tags.map((t) => <Badge key={t} tone="cyan">{t}</Badge>)}</div>
      )}
    </Dialog>
  );
}
