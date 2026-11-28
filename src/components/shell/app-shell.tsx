"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Command } from "cmdk";
import { Popover } from "radix-ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Bell, Plus, Search, Upload, Menu as MenuIcon, X, LogOut, User, History, HelpCircle, Sparkles, Loader2, CheckCheck, Clapperboard, PenLine, Send, Microscope, Workflow,
} from "lucide-react";
import { NAV, ALL_NAV, OWNER_NAV } from "@/lib/client/nav";
import { cn, fmtRelative } from "@/lib/client/utils";
import { api, errorText } from "@/lib/client/api";
import { useConnections, useMe } from "@/lib/client/hooks";
import { Button, Menu, Skeleton, Tooltip } from "@/components/ui/primitives";
import { PlatformMark } from "@/components/ui/domain";
import { UploadDialog } from "./upload-dialog";

function Brand() {
  return (
    <Link href="/overview" className="flex items-center gap-2.5 px-2" aria-label="VIRAL OS home">
      <svg viewBox="0 0 28 28" className="size-7" aria-hidden>
        <rect x="1" y="1" width="26" height="26" rx="8" fill="#161b2e" stroke="#2a3150" />
        <path d="M7 9.5 12.2 19 14 15.5M15.5 12.5 17.6 8.5h3.4L15.4 19" fill="none" stroke="url(#vg)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        <defs>
          <linearGradient id="vg" x1="7" y1="8" x2="21" y2="19" gradientUnits="userSpaceOnUse">
            <stop stopColor="#7c5cff" />
            <stop offset="1" stopColor="#22d3ee" />
          </linearGradient>
        </defs>
      </svg>
      <span className="text-[15px] font-semibold tracking-[-0.02em]">VIRAL OS</span>
    </Link>
  );
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const { data: me } = useMe();
  const groups = me?.role === "owner" ? [...NAV, { group: "Owner", items: [OWNER_NAV] }] : NAV;
  return (
    <nav aria-label="Main" className="flex h-full flex-col gap-5 overflow-y-auto px-3 pb-6 pt-4">
      <Brand />
      {groups.map((g) => (
        <div key={g.group || "home"}>
          {g.group && <p className="mb-1 px-2.5 text-[12px] font-medium text-faint">{g.group}</p>}
          <ul className="space-y-0.5">
            {g.items.map((item) => {
              const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={onNavigate}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "group relative flex items-center gap-2.5 rounded-md px-2.5 py-[7px] text-[13.5px] transition-colors",
                      active ? "bg-raised text-fg" : "text-muted hover:bg-raised/60 hover:text-fg",
                    )}
                  >
                    {active && <span className="absolute -left-3 top-1.5 bottom-1.5 w-[3px] rounded-r bg-violet shadow-[0_0_10px_#7c5cff]" aria-hidden />}
                    <item.icon className={cn("size-4 shrink-0", active ? "text-violet-soft" : "text-faint group-hover:text-muted")} />
                    <span className="truncate">{item.label}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

type SearchResult = { id: string; title: string; type: string; href: string };

function CommandPanel({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const router = useRouter();
  const [q, setQ] = React.useState("");
  const [answer, setAnswer] = React.useState<string | null>(null);
  const [asking, setAsking] = React.useState(false);
  const debounced = useDebounced(q, 200);
  const { data } = useQuery({ queryKey: ["search", debounced], queryFn: () => api.get<{ results: SearchResult[] }>(`/api/v1/search?q=${encodeURIComponent(debounced)}`), enabled: open && debounced.trim().length >= 2 });


  const setOpen = (o: boolean) => {
    if (!o) {
      setQ("");
      setAnswer(null);
    }
    onOpenChange(o);
  };
  const go = (href: string) => {
    setOpen(false);
    router.push(href);
  };
  const ask = async () => {
    if (!q.trim()) return;
    setAsking(true);
    setAnswer(null);
    try {
      const r = await api.post<{ text: string }>("/api/v1/ai/assistant", { message: q });
      setAnswer(r.text);
    } catch (err) {
      setAnswer(`⚠ ${errorText(err)}`);
    } finally {
      setAsking(false);
    }
  };

  return (
    <Command.Dialog open={open} onOpenChange={setOpen} label="Search and commands" shouldFilter={false} className="fixed left-1/2 top-[12vh] z-50 w-[calc(100vw-2rem)] max-w-xl -translate-x-1/2 overflow-hidden rounded-lg border border-line bg-panel shadow-2xl" overlayClassName="fixed inset-0 z-40 bg-[#070912]/70">
      <div className="flex items-center gap-2 border-b border-line-soft px-4">
        <Search className="size-4 text-faint" />
        <Command.Input value={q} onValueChange={setQ} placeholder="Search your workspace, jump to a section, or ask the AI…" className="h-12 flex-1 bg-transparent text-sm outline-none placeholder:text-faint" />
      </div>
      <Command.List className="max-h-[60vh] overflow-y-auto p-2">
        {q.trim() && (
          <Command.Group heading="AI assistant" className="text-[12px] text-faint [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5">
            <Command.Item onSelect={ask} className="flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-[13.5px] text-fg data-[selected=true]:bg-raised">
              {asking ? <Loader2 className="size-4 animate-spin text-violet-soft" /> : <Sparkles className="size-4 text-violet-soft" />}
              Ask AI: <span className="truncate text-muted">{q}</span>
            </Command.Item>
            {answer && <div className="mx-2 mb-2 whitespace-pre-wrap rounded-md border border-line-soft bg-ink-2 p-3 text-[13px] leading-relaxed text-fg">{answer}</div>}
          </Command.Group>
        )}
        {data?.results?.length ? (
          <Command.Group heading="Workspace" className="text-[12px] text-faint [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5">
            {data.results.map((r) => (
              <Command.Item key={`${r.type}-${r.id}`} value={`${r.type}-${r.id}`} onSelect={() => go(r.href)} className="flex cursor-pointer items-center justify-between gap-2 rounded-md px-2.5 py-2 text-[13.5px] text-fg data-[selected=true]:bg-raised">
                <span className="truncate">{r.title}</span>
                <span className="text-xs text-faint">{r.type}</span>
              </Command.Item>
            ))}
          </Command.Group>
        ) : null}
        {ALL_NAV.some((n) => !q || n.label.toLowerCase().includes(q.toLowerCase())) && <Command.Group heading="Go to" className="text-[12px] text-faint [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5">
          {ALL_NAV.filter((n) => !q || n.label.toLowerCase().includes(q.toLowerCase())).map((n) => (
            <Command.Item key={n.href} value={n.href} onSelect={() => go(n.href)} className="flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-[13.5px] text-fg data-[selected=true]:bg-raised">
              <n.icon className="size-4 text-faint" />
              {n.label}
              <span className="ml-auto truncate text-xs text-faint">{n.description}</span>
            </Command.Item>
          ))}
        </Command.Group>}
      </Command.List>
    </Command.Dialog>
  );
}

function useDebounced<T>(v: T, ms: number) {
  const [d, setD] = React.useState(v);
  React.useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}

type Notification = { id: string; type: string; title: string; body: string | null; link: string | null; readAt: string | null; createdAt: string };

function Notifications() {
  const qc = useQueryClient();
  const router = useRouter();
  const { data } = useQuery({ queryKey: ["notifications"], queryFn: () => api.get<{ items: Notification[]; unread: number }>("/api/v1/notifications"), refetchInterval: 30_000 });
  const markAll = async () => {
    await api.post("/api/v1/notifications/read", {});
    qc.invalidateQueries({ queryKey: ["notifications"] });
  };
  const open = async (n: Notification) => {
    if (!n.readAt) await api.post("/api/v1/notifications/read", { ids: [n.id] }).catch(() => {});
    qc.invalidateQueries({ queryKey: ["notifications"] });
    if (n.link) router.push(n.link);
  };
  const dot: Record<string, string> = { success: "bg-success", error: "bg-danger", warning: "bg-warning", info: "bg-cyan" };
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <Button variant="ghost" size="icon" aria-label={`Notifications${data?.unread ? `, ${data.unread} unread` : ""}`} className="relative">
          <Bell />
          {!!data?.unread && <span className="absolute right-1.5 top-1.5 grid min-w-4 place-items-center rounded-full bg-violet px-1 text-[10px] font-semibold text-white">{data.unread > 9 ? "9+" : data.unread}</span>}
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={8} className="z-50 w-[22rem] rounded-lg border border-line bg-panel shadow-2xl">
          <div className="flex items-center justify-between border-b border-line-soft px-4 py-3">
            <p className="text-sm font-semibold">Notifications</p>
            <Button variant="ghost" size="sm" onClick={markAll} disabled={!data?.unread}>
              <CheckCheck /> Mark all read
            </Button>
          </div>
          <ul className="max-h-96 overflow-y-auto">
            {!data?.items.length && <li className="px-4 py-8 text-center text-[13px] text-muted">You&apos;re all caught up. Publishing results, trend alerts and automation failures show up here.</li>}
            {data?.items.map((n) => (
              <li key={n.id}>
                <button onClick={() => open(n)} className={cn("flex w-full gap-3 px-4 py-3 text-left hover:bg-raised/60", !n.readAt && "bg-violet/[0.04]")}>
                  <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", n.readAt ? "bg-line" : dot[n.type] ?? "bg-cyan")} />
                  <span className="min-w-0">
                    <span className="block text-[13px] font-medium">{n.title}</span>
                    {n.body && <span className="mt-0.5 line-clamp-2 block text-xs text-muted">{n.body}</span>}
                    <span className="mt-1 block text-[11px] text-faint">{fmtRelative(n.createdAt)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function ConnectionHealth() {
  const { data } = useConnections();
  if (!data) return null;
  if (!data.length)
    return (
      <Link href="/settings?tab=connections" className="hidden items-center gap-1.5 rounded-md border border-dashed border-line px-2.5 py-1.5 text-xs text-muted hover:text-fg md:flex">
        Connect an account
      </Link>
    );
  const bad = data.filter((c) => c.status !== "active");
  return (
    <Tooltip content={bad.length ? `${bad.length} account(s) need attention: ${bad.map((b) => b.accountName).join(", ")}` : "All connected accounts are healthy"}>
      <Link href="/settings?tab=connections" className="hidden items-center gap-1 md:flex" aria-label="Connected account status">
        {data.slice(0, 4).map((c) => (
          <span key={c.id} className="relative">
            <PlatformMark platform={c.platform} />
            <span className={cn("absolute -bottom-0.5 -right-0.5 size-2 rounded-full ring-2 ring-ink", c.status === "active" ? "bg-success" : "bg-warning")} />
          </span>
        ))}
      </Link>
    </Tooltip>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [cmdOpen, setCmdOpen] = React.useState(false);
  const [uploadOpen, setUploadOpen] = React.useState(false);
  const [mobileNav, setMobileNav] = React.useState(false);
  const { data: me } = useMe();

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCmdOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const logout = async () => {
    try {
      await api.post("/api/auth/logout");
      router.push("/login");
      router.refresh();
    } catch (err) {
      toast.error(errorText(err));
    }
  };

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[248px_1fr]">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-violet focus:px-3 focus:py-2 focus:text-white">
        Skip to content
      </a>
      <div className="hidden border-r border-line-soft bg-ink-2 lg:block">
        <aside className="sticky top-0 h-screen">
          <Sidebar />
        </aside>
      </div>
      {mobileNav && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <button className="absolute inset-0 bg-[#070912]/70" aria-label="Close navigation" onClick={() => setMobileNav(false)} />
          <aside className="relative h-full w-72 border-r border-line bg-ink-2">
            <button className="absolute right-3 top-4 rounded-md p-1 text-muted hover:text-fg" onClick={() => setMobileNav(false)} aria-label="Close navigation">
              <X className="size-5" />
            </button>
            <Sidebar onNavigate={() => setMobileNav(false)} />
          </aside>
        </div>
      )}
      <div className="min-w-0">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-line-soft bg-ink/85 px-4 backdrop-blur-md md:px-6">
          <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setMobileNav(true)} aria-label="Open navigation">
            <MenuIcon />
          </Button>
          <button onClick={() => setCmdOpen(true)} className="flex h-9 w-full max-w-md items-center gap-2 rounded-md border border-line bg-ink-2 px-3 text-left text-[13px] text-faint transition-colors hover:border-faint">
            <Search className="size-4" />
            <span className="flex-1 truncate">Search or ask AI</span>
            <kbd className="hidden rounded border border-line px-1.5 text-[11px] text-muted sm:inline">Ctrl K</kbd>
          </button>
          <div className="ml-auto flex items-center gap-1.5">
            <ConnectionHealth />
            <Tooltip content="Upload media">
              <Button variant="ghost" size="icon" onClick={() => setUploadOpen(true)} aria-label="Upload media">
                <Upload />
              </Button>
            </Tooltip>
            <Notifications />
            <Menu
              trigger={
                <Button variant="primary" size="sm" aria-label="Quick create">
                  <Plus /> <span className="hidden sm:inline">Create</span>
                </Button>
              }
              items={[
                { label: "Content project", icon: Clapperboard, onSelect: () => router.push("/studio?new=1") },
                { label: "Script", icon: PenLine, onSelect: () => router.push("/scripts?new=1") },
                { label: "Post", icon: Send, onSelect: () => router.push("/publishing?new=1") },
                { label: "Research run", icon: Microscope, onSelect: () => router.push("/research") },
                { label: "Automation", icon: Workflow, onSelect: () => router.push("/automation?new=1") },
                "separator",
                { label: "Upload media", icon: Upload, onSelect: () => setUploadOpen(true) },
              ]}
            />
            <Menu
              trigger={
                <button className="ml-1 grid size-8 place-items-center rounded-full border border-line bg-raised text-[12px] font-semibold uppercase" aria-label="Account menu">
                  {(me?.displayName ?? me?.email ?? "?").slice(0, 1)}
                </button>
              }
              items={[
                { label: me?.email ?? "Profile", icon: User, onSelect: () => router.push("/settings") },
                { label: "Activity history", icon: History, onSelect: () => router.push("/activity") },
                { label: "Help and documentation", icon: HelpCircle, onSelect: () => router.push("/help") },
                "separator",
                { label: "Sign out", icon: LogOut, onSelect: logout },
              ]}
            />
          </div>
        </header>
        <main id="main" className="mx-auto w-full max-w-[1400px] px-4 py-6 md:px-8 md:py-8">
          <React.Suspense fallback={<div className="space-y-3"><Skeleton className="h-8 w-64" /><Skeleton className="h-40 w-full" /></div>}>{children}</React.Suspense>
        </main>
      </div>
      <CommandPanel open={cmdOpen} onOpenChange={setCmdOpen} />
      <UploadDialog open={uploadOpen} onOpenChange={setUploadOpen} />
    </div>
  );
}
