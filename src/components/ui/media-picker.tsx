"use client";

import * as React from "react";
import { Film, ImageIcon, Upload, X } from "lucide-react";
import { useApiQuery, type MediaAsset } from "@/lib/client/hooks";
import { Button, Dialog, Input } from "./primitives";
import { UploadDialog } from "@/components/shell/upload-dialog";
import { cn, fmtBytes } from "@/lib/client/utils";

export function MediaThumb({ asset, className }: { asset: MediaAsset; className?: string }) {
  if (asset.kind === "image") return <img src={`/api/v1/media/${asset.id}/file`} alt={asset.filename} className={cn("object-cover", className)} loading="lazy" />;
  if (asset.kind === "video") return <video src={`/api/v1/media/${asset.id}/file#t=0.5`} className={cn("object-cover", className)} preload="metadata" muted aria-label={asset.filename} />;
  return <div className={cn("grid place-items-center bg-raised text-xs text-muted", className)}>{asset.mimeType.split("/")[1]}</div>;
}

/** Choose an existing asset or upload a new one. */
export function MediaPicker({ value, onChange, kind, label = "Choose media" }: { value: string | null | undefined; onChange: (id: string | null, asset?: MediaAsset) => void; kind?: "video" | "image"; label?: string }) {
  const [open, setOpen] = React.useState(false);
  const [upload, setUpload] = React.useState(false);
  const [q, setQ] = React.useState("");
  const { data } = useApiQuery<{ items: MediaAsset[] }>(["media", kind ?? "all", q], `/api/v1/media?pageSize=100${kind ? `&kind=${kind}` : ""}${q ? `&q=${encodeURIComponent(q)}` : ""}`);
  const { data: all } = useApiQuery<{ items: MediaAsset[] }>(["media", "all-lookup"], value ? `/api/v1/media?pageSize=100` : null);
  const selected = all?.items.find((a) => a.id === value) ?? data?.items.find((a) => a.id === value);
  const Icon = kind === "image" ? ImageIcon : Film;

  return (
    <div>
      {selected ? (
        <div className="flex items-center gap-3 rounded-md border border-line bg-ink-2 p-2">
          <MediaThumb asset={selected} className="h-12 w-20 rounded-sm" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px]">{selected.filename}</p>
            <p className="text-xs text-faint">{fmtBytes(selected.sizeBytes)}</p>
          </div>
          <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>Change</Button>
          <Button size="icon" variant="ghost" onClick={() => onChange(null)} aria-label="Remove media"><X /></Button>
        </div>
      ) : (
        <div className="flex gap-2">
          <Button onClick={() => setOpen(true)}><Icon /> {label}</Button>
          <Button variant="ghost" onClick={() => setUpload(true)}><Upload /> Upload new</Button>
        </div>
      )}
      <Dialog open={open} onOpenChange={setOpen} title={label} wide footer={<Button variant="ghost" onClick={() => { setOpen(false); setUpload(true); }}><Upload /> Upload new</Button>}>
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by filename" className="mb-3" aria-label="Search media" />
        {!data?.items.length ? (
          <p className="py-8 text-center text-sm text-muted">No {kind ?? "media"} files yet. Upload one to continue.</p>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {data.items.map((a) => (
              <button key={a.id} onClick={() => { onChange(a.id, a); setOpen(false); }} className={cn("overflow-hidden rounded-md border text-left transition-colors hover:border-violet", a.id === value ? "border-violet" : "border-line")}>
                <MediaThumb asset={a} className="aspect-video w-full" />
                <p className="truncate px-2 py-1.5 text-xs">{a.filename}</p>
              </button>
            ))}
          </div>
        )}
      </Dialog>
      <UploadDialog open={upload} onOpenChange={setUpload} accept={kind === "image" ? "image/jpeg,image/png,image/webp" : kind === "video" ? "video/mp4,video/quicktime,video/webm" : undefined} onUploaded={(a) => { onChange(a.id, a); setUpload(false); }} />
    </div>
  );
}
