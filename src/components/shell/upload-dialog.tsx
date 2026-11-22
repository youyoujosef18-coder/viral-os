"use client";

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { UploadCloud, FileCheck2, AlertCircle } from "lucide-react";
import { Button, Dialog, Field, Input } from "@/components/ui/primitives";
import { cn, fmtBytes } from "@/lib/client/utils";
import type { MediaAsset } from "@/lib/client/hooks";

type Item = { file: File; progress: number; status: "pending" | "uploading" | "done" | "error"; error?: string; asset?: MediaAsset };

function xhrPut(url: string, file: File, onProgress: (p: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    xhr.setRequestHeader("x-upsert", "false");
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      let message = `Storage upload failed (${xhr.status})`;
      try {
        message = (JSON.parse(xhr.responseText) as { error?: { message?: string } })?.error?.message ?? message;
      } catch {
        // storage providers may answer with non-JSON bodies
      }
      reject(new Error(message));
    };
    xhr.onerror = () => reject(new Error("Network error during upload"));
    xhr.send(file);
  });
}

/**
 * Upload with real progress. When cloud storage is configured the browser sends the file straight
 * to storage via a signed URL (no serverless body-size limit), then the server verifies it.
 * With local storage the signed URL is this app's own streaming upload endpoint (no in-memory buffering).
 */
export async function uploadWithProgress(file: File, folder: string, onProgress: (p: number) => void): Promise<MediaAsset> {
  const plan = await fetch("/api/v1/media/upload-url", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filename: file.name, size: file.size }) }).then(async (r) => {
    const body = await r.json();
    if (!r.ok) throw new Error(body?.error?.message ?? `Upload failed (${r.status})`);
    return body as { mode: "direct"; key: string; url: string } | { mode: "multipart" };
  });
  if (plan.mode === "direct") {
    await xhrPut(plan.url, file, onProgress);
    const r = await fetch("/api/v1/media/complete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: plan.key, filename: file.name, folder: folder || undefined }) });
    const body = await r.json();
    if (!r.ok) throw new Error(body?.error?.message ?? `Upload failed (${r.status})`);
    return body as MediaAsset;
  }
  return multipartUpload(file, folder, onProgress);
}

function multipartUpload(file: File, folder: string, onProgress: (p: number) => void): Promise<MediaAsset> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const form = new FormData();
    form.append("file", file);
    if (folder) form.append("folder", folder);
    xhr.open("POST", "/api/v1/media");
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      const body = xhr.responseText ? JSON.parse(xhr.responseText) : null;
      if (xhr.status >= 200 && xhr.status < 300) resolve(body);
      else reject(new Error(body?.error?.message ?? `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("Network error during upload"));
    xhr.send(form);
  });
}

export function UploadDialog({ open, onOpenChange, onUploaded, accept, folder: initialFolder = "" }: { open: boolean; onOpenChange: (o: boolean) => void; onUploaded?: (a: MediaAsset) => void; accept?: string; folder?: string }) {
  const qc = useQueryClient();
  const [items, setItems] = React.useState<Item[]>([]);
  const [folder, setFolder] = React.useState(initialFolder);
  const [drag, setDrag] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (!open) setItems([]);
  }, [open]);

  const add = (files: FileList | null) => {
    if (!files) return;
    setItems((cur) => [...cur, ...Array.from(files).map((file) => ({ file, progress: 0, status: "pending" as const }))]);
  };

  const start = async () => {
    for (let i = 0; i < items.length; i++) {
      if (items[i].status !== "pending") continue;
      setItems((c) => c.map((it, j) => (j === i ? { ...it, status: "uploading" } : it)));
      try {
        const asset = await uploadWithProgress(items[i].file, folder.trim(), (p) => setItems((c) => c.map((it, j) => (j === i ? { ...it, progress: p } : it))));
        setItems((c) => c.map((it, j) => (j === i ? { ...it, status: "done", progress: 1, asset } : it)));
        onUploaded?.(asset);
      } catch (err) {
        setItems((c) => c.map((it, j) => (j === i ? { ...it, status: "error", error: (err as Error).message } : it)));
      }
    }
    qc.invalidateQueries({ queryKey: ["media"] });
    toast.success("Upload finished");
  };

  const busy = items.some((i) => i.status === "uploading");
  const pending = items.filter((i) => i.status === "pending").length;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !busy && onOpenChange(o)}
      title="Upload media"
      description="Videos, images, audio and documents up to 1 GB each. Files are stored privately."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Close
          </Button>
          <Button variant="primary" onClick={start} disabled={!pending} loading={busy}>
            Upload {pending ? `${pending} file${pending > 1 ? "s" : ""}` : ""}
          </Button>
        </>
      }
    >
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          add(e.dataTransfer.files);
        }}
        className={cn("flex flex-col items-center justify-center rounded-md border border-dashed px-4 py-8 text-center transition-colors", drag ? "border-violet bg-violet/5" : "border-line")}
      >
        <UploadCloud className="mb-2 size-7 text-faint" />
        <p className="text-sm">Drop files here</p>
        <Button variant="link" size="sm" onClick={() => inputRef.current?.click()}>
          or browse your device
        </Button>
        <input ref={inputRef} type="file" multiple className="hidden" accept={accept ?? "video/mp4,video/quicktime,video/webm,image/jpeg,image/png,image/webp,audio/mpeg,audio/wav,application/pdf,text/plain"} onChange={(e) => add(e.target.files)} />
      </div>
      <Field label="Folder" hint="Optional. Groups files in the Media Library." className="mt-4">
        <Input value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="e.g. Raw footage" />
      </Field>
      {items.length > 0 && (
        <ul className="mt-4 space-y-2">
          {items.map((it, i) => (
            <li key={i} className="rounded-md border border-line-soft bg-ink-2 px-3 py-2">
              <div className="flex items-center gap-2 text-[13px]">
                {it.status === "done" ? <FileCheck2 className="size-4 text-success" /> : it.status === "error" ? <AlertCircle className="size-4 text-danger" /> : null}
                <span className="flex-1 truncate">{it.file.name}</span>
                <span className="text-xs text-faint">{fmtBytes(it.file.size)}</span>
              </div>
              {it.status === "uploading" && (
                <div className="mt-2 h-1 overflow-hidden rounded bg-line" role="progressbar" aria-valuenow={Math.round(it.progress * 100)} aria-valuemin={0} aria-valuemax={100}>
                  <div className="h-full bg-violet transition-[width]" style={{ width: `${it.progress * 100}%` }} />
                </div>
              )}
              {it.error && <p className="mt-1 text-xs text-danger">{it.error}</p>}
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
