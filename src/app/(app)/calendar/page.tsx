"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { addDays, addMonths, addWeeks, endOfMonth, endOfWeek, format, isSameDay, isSameMonth, startOfMonth, startOfWeek } from "date-fns";
import { fromZonedTime, toZonedTime } from "date-fns-tz";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { api } from "@/lib/client/api";
import { useAction, useApiQuery, useMe } from "@/lib/client/hooks";
import { Button, PageHeader, Panel, Skeleton, ErrorState } from "@/components/ui/primitives";
import { PlatformMark } from "@/components/ui/domain";
import { cn, statusLabel } from "@/lib/client/utils";

type Post = { id: string; title: string; status: string; scheduledAt: string | null; createdAt: string; targets: { id: string; platform: string; status: string; publishedAt: string | null }[] };

const STATUS_BAR: Record<string, string> = { scheduled: "border-l-violet", published: "border-l-success", failed: "border-l-danger", draft: "border-l-faint", queued: "border-l-cyan", processing: "border-l-cyan", uploading: "border-l-cyan", requires_user_action: "border-l-warning", platform_approval_required: "border-l-warning", ready: "border-l-cyan", needs_review: "border-l-warning", cancelled: "border-l-line" };
const MOVABLE = ["scheduled", "draft", "needs_review", "ready", "cancelled"];

export default function CalendarPage() {
  const router = useRouter();
  const { data: me } = useMe();
  const tz = me?.timezone ?? "UTC";
  const [view, setView] = React.useState<"month" | "week">("month");
  const [cursor, setCursor] = React.useState(() => new Date());
  const [drag, setDrag] = React.useState<string | null>(null);
  const [now] = React.useState(() => new Date());
  const start = view === "month" ? startOfWeek(startOfMonth(cursor), { weekStartsOn: 1 }) : startOfWeek(cursor, { weekStartsOn: 1 });
  const end = view === "month" ? endOfWeek(endOfMonth(cursor), { weekStartsOn: 1 }) : endOfWeek(cursor, { weekStartsOn: 1 });
  const posts = useApiQuery<Post[]>(["posts", "calendar", start.toISOString()], `/api/v1/posts?from=${addDays(start, -1).toISOString()}&to=${addDays(end, 2).toISOString()}`);
  const reschedule = useAction(({ id, at }: { id: string; at: string }) => api.post(`/api/v1/posts/${id}/reschedule`, { scheduledAt: at }), { invalidate: [["posts"]], success: "Rescheduled" });

  const days: Date[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) days.push(d);

  // Each post appears on the day it was scheduled, or the day it was published/created.
  const when = (p: Post) => toZonedTime(new Date(p.scheduledAt ?? p.targets.find((t) => t.publishedAt)?.publishedAt ?? p.createdAt), tz);
  const byDay = (d: Date) => (posts.data ?? []).filter((p) => isSameDay(when(p), d)).sort((a, b) => +when(a) - +when(b));

  const dropOn = (day: Date) => {
    const p = posts.data?.find((x) => x.id === drag);
    setDrag(null);
    if (!p || !MOVABLE.includes(p.status)) return;
    const prev = when(p);
    const local = `${format(day, "yyyy-MM-dd")}T${format(prev, "HH:mm")}`;
    const at = fromZonedTime(local, tz);
    if (p.status === "scheduled" && at.getTime() < now.getTime()) return;
    reschedule.mutate({ id: p.id, at: at.toISOString() });
  };
  const today = toZonedTime(now, tz);

  return (
    <div>
      <PageHeader
        title="Content Calendar"
        description={`Scheduled, draft and published posts in your timezone (${tz}). Drag a scheduled post or draft to another day to move it; the time of day is kept.`}
        actions={
          <>
            <div className="flex rounded-md border border-line p-0.5" role="group" aria-label="Calendar view">{(["month", "week"] as const).map((v) => <button key={v} onClick={() => setView(v)} aria-pressed={view === v} className={cn("rounded-sm px-2.5 py-1 text-xs capitalize", view === v ? "bg-raised" : "text-muted")}>{v}</button>)}</div>
            <Button variant="primary" onClick={() => router.push("/publishing?new=1")}><Plus /> Schedule post</Button>
          </>
        }
      />
      <Panel>
        <div className="flex items-center gap-2 border-b border-line-soft px-4 py-3">
          <Button size="icon" variant="ghost" aria-label="Previous" onClick={() => setCursor(view === "month" ? addMonths(cursor, -1) : addWeeks(cursor, -1))}><ChevronLeft /></Button>
          <Button size="icon" variant="ghost" aria-label="Next" onClick={() => setCursor(view === "month" ? addMonths(cursor, 1) : addWeeks(cursor, 1))}><ChevronRight /></Button>
          <h2 className="text-[15px] font-semibold">{view === "month" ? format(cursor, "MMMM yyyy") : `${format(start, "MMM d")} to ${format(end, "MMM d, yyyy")}`}</h2>
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setCursor(new Date())}>Today</Button>
        </div>
        {posts.error ? <ErrorState error={posts.error} onRetry={() => posts.refetch()} /> : (
          <div className="overflow-x-auto">
            <div className="grid min-w-[760px] grid-cols-7" role="grid" aria-label="Calendar">
              {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => <div key={d} role="columnheader" className="border-b border-line-soft px-3 py-2 text-xs text-muted">{d}</div>)}
              {days.map((d) => {
                const items = byDay(d);
                const outside = view === "month" && !isSameMonth(d, cursor);
                return (
                  <div key={d.toISOString()} role="gridcell" aria-label={format(d, "EEEE MMMM d")} onDragOver={(e) => e.preventDefault()} onDrop={() => dropOn(d)} className={cn("border-b border-r border-line-soft p-1.5 [&:nth-child(7n)]:border-r-0", view === "month" ? "min-h-28" : "min-h-80", outside && "bg-ink-2/50", drag && "hover:bg-violet/5")}>
                    <p className={cn("mb-1 grid size-6 place-items-center rounded-full text-xs tabular-nums", isSameDay(d, today) ? "bg-violet font-semibold text-white" : outside ? "text-faint" : "text-muted")}>{format(d, "d")}</p>
                    {posts.isLoading ? <Skeleton className="h-6 w-full" /> : (
                      <ul className="space-y-1">
                        {items.slice(0, view === "month" ? 3 : 20).map((p) => (
                          <li key={p.id} draggable={MOVABLE.includes(p.status)} onDragStart={() => setDrag(p.id)} onDragEnd={() => setDrag(null)}>
                            <button onClick={() => router.push(`/publishing?post=${p.id}`)} className={cn("w-full rounded border-l-2 bg-raised/70 px-1.5 py-1 text-left hover:bg-raised", STATUS_BAR[p.status] ?? "border-l-line", MOVABLE.includes(p.status) && "cursor-grab")} title={`${p.title}: ${statusLabel(p.status)}`}>
                              <span className="flex items-center gap-1 text-[11px] text-muted">{format(when(p), "HH:mm")}{p.targets.slice(0, 3).map((t) => <PlatformMark key={t.id} platform={t.platform} className="size-4 rounded-[3px] text-[6.5px]" />)}</span>
                              <span className="line-clamp-1 text-[12px]">{p.title}</span>
                            </button>
                          </li>
                        ))}
                        {view === "month" && items.length > 3 && <li className="px-1 text-[11px] text-faint">+{items.length - 3} more</li>}
                      </ul>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
        <div className="flex flex-wrap gap-4 border-t border-line-soft px-4 py-2.5 text-xs text-muted">
          {[["border-l-violet", "Scheduled"], ["border-l-cyan", "Queued or processing"], ["border-l-success", "Published"], ["border-l-warning", "Needs attention"], ["border-l-danger", "Failed"], ["border-l-faint", "Draft"]].map(([c, l]) => <span key={l} className="flex items-center gap-1.5"><span className={cn("h-3 border-l-2", c)} />{l}</span>)}
        </div>
      </Panel>
    </div>
  );
}
