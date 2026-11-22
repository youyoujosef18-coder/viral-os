"use client";

import * as React from "react";
import Link from "next/link";
import { PlugZap } from "lucide-react";
import { Badge, type Tone } from "./primitives";
import { ClientApiError } from "@/lib/client/api";
import { cn, statusLabel } from "@/lib/client/utils";

const STATUS_TONE: Record<string, Tone> = {
  draft: "neutral", needs_review: "warning", ready: "cyan", scheduled: "violet", queued: "violet", uploading: "cyan", processing: "cyan",
  published: "success", failed: "danger", cancelled: "neutral", requires_user_action: "warning", platform_approval_required: "warning",
  active: "success", expired: "warning", revoked: "danger", error: "danger", requires_reauth: "warning",
  running: "cyan", succeeded: "success", completed: "success",
};

export function StatusBadge({ status }: { status: string }) {
  const live = ["uploading", "processing", "queued", "running"].includes(status);
  return (
    <Badge tone={STATUS_TONE[status] ?? "neutral"}>
      {live && <span className="size-1.5 animate-pulse rounded-full bg-current" aria-hidden />}
      {statusLabel(status)}
    </Badge>
  );
}

/** Simple, original platform glyphs (not the platforms' logos). */
export function PlatformMark({ platform, className }: { platform: string; className?: string }) {
  const map: Record<string, { bg: string; letter: string; name: string }> = {
    youtube: { bg: "bg-[#ff3b3b]/15 text-[#ff6b6b] border-[#ff3b3b]/30", letter: "YT", name: "YouTube" },
    tiktok: { bg: "bg-cyan/10 text-cyan border-cyan/30", letter: "TT", name: "TikTok" },
    instagram: { bg: "bg-[#e1306c]/15 text-[#f06292] border-[#e1306c]/30", letter: "IG", name: "Instagram" },
  };
  const m = map[platform] ?? { bg: "bg-raised text-muted border-line", letter: "?", name: platform };
  return (
    <span title={m.name} aria-label={m.name} className={cn("inline-grid size-6 shrink-0 place-items-center rounded-md border text-[9.5px] font-bold tracking-tight", m.bg, className)}>
      {m.letter}
    </span>
  );
}

/** Shown in place of a feature when its integration isn't configured. Explains exactly what to do. */
export function NotConfigured({ error, title }: { error: unknown; title?: string }) {
  if (!(error instanceof ClientApiError) || !error.notConfigured) return null;
  return (
    <div className="m-5 flex gap-3 rounded-md border border-warning/30 bg-warning/5 p-4">
      <PlugZap className="mt-0.5 size-5 shrink-0 text-warning" />
      <div className="text-[13px]">
        <p className="font-medium text-fg">{title ?? "This feature needs an integration"}</p>
        <p className="mt-1 leading-relaxed text-muted">{error.message}</p>
        <Link href="/settings?tab=integrations" className="mt-2 inline-block text-violet-soft hover:underline">
          Open integration setup
        </Link>
      </div>
    </div>
  );
}
