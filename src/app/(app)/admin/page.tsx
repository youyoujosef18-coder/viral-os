"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ShieldCheck, Users, Link2, Copy, Ban, History } from "lucide-react";
import { api } from "@/lib/client/api";
import { useAction, useApiQuery } from "@/lib/client/hooks";
import { Badge, Button, Dialog, EmptyState, ErrorState, Field, Input, PageHeader, Panel, PanelHeader, Select, SkeletonRows, Tabs } from "@/components/ui/primitives";
import { DataTable, type Column } from "@/components/ui/data-table";
import { fmtBytes, fmtDate, fmtNum, fmtRelative } from "@/lib/client/utils";

export type AdminUser = {
  id: string;
  email: string;
  displayName: string | null;
  role: string;
  disabledAt: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  usage: { posts: number; published: number; clipJobs: number; clipsRendered: number; mediaCount: number; mediaBytes: number; connections: number; aiCalls30d: number; aiTokens30d: number; youtubeUnits30d: number };
};
type Invite = { id: string; email: string | null; note: string | null; createdAt: string; expiresAt: string; usedAt: string | null; usedByEmail: string | null; status: "active" | "used" | "revoked" | "expired"; url?: string };
export type AuditEntry = { id: string; action: string; actorEmail: string | null; targetEmail: string | null; detail: Record<string, unknown>; createdAt: string };

export const ACTION_LABEL: Record<string, string> = {
  signup_mode_changed: "Changed sign-up mode",
  invite_created: "Created an invite",
  invite_revoked: "Revoked an invite",
  user_viewed: "Opened a user's overview",
  content_viewed: "Viewed a user's content",
  media_opened: "Opened a user's file",
  user_disabled: "Disabled an account",
  user_enabled: "Re-enabled an account",
  user_deleted: "Deleted an account",
  owner_granted: "Became owner",
  owner_revoked: "Owner role removed",
};

export function auditDetail(a: AuditEntry) {
  const d = a.detail as Record<string, string | number | undefined>;
  if (a.action === "signup_mode_changed") return `${d.from} → ${d.to}`;
  if (a.action === "content_viewed") return `${d.type} (${d.count} ${d.count === 1 ? "item" : "items"})`;
  if (a.action === "media_opened") return String(d.filename ?? "");
  if (a.action === "invite_created") return d.email ? `for ${d.email}` : "open invite";
  if (a.action === "owner_granted") return `via ${d.via}`;
  if (a.action === "user_deleted") return `${d.filesRemoved ?? 0} of ${d.files ?? 0} files removed`;
  return "";
}

const MODE_COPY = {
  open: { label: "Open", text: "Anyone with the link can create an account." },
  invite: { label: "Invite only", text: "People need an invite link from you. Each link works once." },
  closed: { label: "Closed", text: "Nobody can sign up. Existing accounts keep working." },
} as const;

export default function AdminPage() {
  // Own cache key: the top bar loads ["me"] outside this page's Suspense boundary, and branching the first
  // render on that shared entry would differ from the server HTML when it resolves first (hydration mismatch).
  const { data: me, isLoading } = useApiQuery<{ role?: string }>(["me", "owner-gate"], "/api/v1/me");
  const [tab, setTab] = React.useState("users");
  if (isLoading) return <SkeletonRows />;
  if (me?.role !== "owner") {
    return (
      <Panel>
        <EmptyState icon={ShieldCheck} title="Owner only" description="This page is for the workspace owner. Ask the owner if you need access." />
      </Panel>
    );
  }
  return (
    <div>
      <PageHeader title="Owner console" description="Control who can join, manage accounts and see how the workspace is used. Everything you do here, including every look at someone's content, is recorded in the access log." />
      <Tabs value={tab} onValueChange={setTab} items={[{ value: "users", label: "Users" }, { value: "signup", label: "Sign-up and invites" }, { value: "log", label: "Access log" }]}>
        {tab === "users" && <UsersTab />}
        {tab === "signup" && <SignupTab />}
        {tab === "log" && <AuditTab />}
      </Tabs>
    </div>
  );
}

function UsersTab() {
  const router = useRouter();
  const data = useApiQuery<{ items: AdminUser[]; signupMode: string }>(["admin-users"], "/api/v1/admin/users");
  const cols: Column<AdminUser>[] = [
    {
      key: "user",
      header: "Account",
      cell: (u) => (
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 truncate font-medium">
            {u.displayName || u.email}
            {u.role === "owner" && <Badge tone="violet">Owner</Badge>}
            {u.disabledAt && <Badge tone="danger">Disabled</Badge>}
          </p>
          <p className="truncate text-xs text-muted">{u.email}</p>
        </div>
      ),
      sortValue: (u) => u.email,
    },
    { key: "joined", header: "Joined", cell: (u) => <span className="text-xs text-muted">{fmtDate(u.createdAt)}</span>, sortValue: (u) => u.createdAt },
    { key: "seen", header: "Last active", cell: (u) => <span className="text-xs text-muted">{u.lastSeenAt ? fmtRelative(u.lastSeenAt) : "Never"}</span>, sortValue: (u) => u.lastSeenAt ?? "" },
    { key: "posts", header: "Posts", cell: (u) => <span className="tabular-nums">{fmtNum(u.usage.posts)}</span>, sortValue: (u) => u.usage.posts },
    { key: "clips", header: "Clips", cell: (u) => <span className="tabular-nums">{fmtNum(u.usage.clipsRendered)}</span>, sortValue: (u) => u.usage.clipsRendered },
    { key: "storage", header: "Storage", cell: (u) => <span className="tabular-nums">{fmtBytes(u.usage.mediaBytes)}</span>, sortValue: (u) => u.usage.mediaBytes },
    { key: "ai", header: "AI calls (30 days)", cell: (u) => <span className="tabular-nums">{fmtNum(u.usage.aiCalls30d)}</span>, sortValue: (u) => u.usage.aiCalls30d },
    { key: "yt", header: "YouTube units (30 days)", cell: (u) => <span className="tabular-nums">{fmtNum(u.usage.youtubeUnits30d)}</span>, sortValue: (u) => u.usage.youtubeUnits30d },
  ];
  return (
    <Panel className="pt-4">
      {data.isLoading ? (
        <SkeletonRows />
      ) : data.error ? (
        <ErrorState error={data.error} />
      ) : (
        <DataTable
          rows={data.data?.items ?? []}
          columns={cols}
          rowKey={(u) => u.id}
          searchable={(u) => `${u.email} ${u.displayName ?? ""}`}
          searchPlaceholder="Find by name or email"
          initialSort={{ key: "joined", dir: "desc" }}
          onRowClick={(u) => router.push(`/admin/user?id=${u.id}`)}
          empty={<EmptyState icon={Users} title="No accounts yet" />}
        />
      )}
    </Panel>
  );
}

function SignupTab() {
  const settings = useApiQuery<{ signupMode: keyof typeof MODE_COPY; ownerEmails: string[] }>(["admin-settings"], "/api/v1/admin/settings");
  const invites = useApiQuery<{ items: Invite[] }>(["admin-invites"], "/api/v1/admin/invites");
  const setMode = useAction((mode: string) => api.patch("/api/v1/admin/settings", { signupMode: mode }), { invalidate: [["admin-settings"], ["admin-users"]], success: "Sign-up setting saved" });
  const revoke = useAction((id: string) => api.del(`/api/v1/admin/invites/${id}`), { invalidate: [["admin-invites"]], success: "Invite revoked" });
  const [creating, setCreating] = React.useState(false);
  const mode = settings.data?.signupMode;

  const cols: Column<Invite>[] = [
    { key: "for", header: "For", cell: (i) => <span>{i.email ?? <span className="text-muted">Anyone with the link</span>}{i.note && <span className="block text-xs text-muted">{i.note}</span>}</span>, sortValue: (i) => i.email ?? "" },
    { key: "status", header: "Status", cell: (i) => <Badge tone={i.status === "active" ? "success" : i.status === "used" ? "cyan" : "neutral"}>{i.status === "used" ? `Used${i.usedByEmail ? ` by ${i.usedByEmail}` : ""}` : i.status[0].toUpperCase() + i.status.slice(1)}</Badge>, sortValue: (i) => i.status },
    { key: "created", header: "Created", cell: (i) => <span className="text-xs text-muted">{fmtDate(i.createdAt, true)}</span>, sortValue: (i) => i.createdAt },
    { key: "expires", header: "Expires", cell: (i) => <span className="text-xs text-muted">{fmtDate(i.expiresAt, true)}</span>, sortValue: (i) => i.expiresAt },
    { key: "actions", header: "", cell: (i) => (i.status === "active" ? <Button size="sm" variant="ghost" onClick={() => revoke.mutate(i.id)} loading={revoke.isPending && revoke.variables === i.id}><Ban /> Revoke</Button> : null) },
  ];

  return (
    <div className="space-y-4">
      <Panel>
        <PanelHeader title="Who can sign up" description={settings.data?.ownerEmails.length ? `Owner emails (${settings.data.ownerEmails.join(", ")}) can always sign up, so you can't lock yourself out.` : "Choose how new people get an account."} />
        <div className="grid gap-2 border-t border-line-soft p-5 sm:grid-cols-3" role="radiogroup" aria-label="Sign-up mode">
          {(Object.keys(MODE_COPY) as (keyof typeof MODE_COPY)[]).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              disabled={!mode || setMode.isPending}
              onClick={() => mode !== m && setMode.mutate(m)}
              className={`rounded-md border p-3 text-left disabled:opacity-60 ${mode === m ? "border-violet bg-violet/10" : "border-line hover:border-faint"}`}
            >
              <p className="text-[13.5px] font-medium">{MODE_COPY[m].label}</p>
              <p className="mt-0.5 text-xs text-muted">{MODE_COPY[m].text}</p>
            </button>
          ))}
        </div>
      </Panel>
      <Panel>
        <PanelHeader title="Invite links" description="An invite link works once. Links you create are shown only once, so copy them right away." actions={<Button variant="primary" size="sm" onClick={() => setCreating(true)}><Link2 /> Create invite</Button>} />
        <div className="border-t border-line-soft pt-2">
          {invites.isLoading ? <SkeletonRows /> : invites.error ? <ErrorState error={invites.error} /> : <DataTable rows={invites.data?.items ?? []} columns={cols} rowKey={(i) => i.id} initialSort={{ key: "created", dir: "desc" }} empty={<EmptyState icon={Link2} title="No invites yet" description={mode === "invite" ? "Create one to let someone join." : "Invites are needed when sign-up is invite only."} />} />}
        </div>
      </Panel>
      {creating && <CreateInviteDialog onClose={() => setCreating(false)} />}
    </div>
  );
}

function CreateInviteDialog({ onClose }: { onClose: () => void }) {
  const [email, setEmail] = React.useState("");
  const [note, setNote] = React.useState("");
  const [days, setDays] = React.useState(7);
  const [created, setCreated] = React.useState<Invite | null>(null);
  const create = useAction(() => api.post<Invite>("/api/v1/admin/invites", { email, note: note || undefined, expiresInDays: days }), { invalidate: [["admin-invites"]], onSuccess: (inv) => setCreated(inv) });
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(created!.url!);
      toast.success("Invite link copied");
    } catch {
      toast.error("Couldn't copy. Select the link and copy it yourself.");
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={created ? "Invite created" : "Create invite"}
      description={created ? "Send this link to the person you're inviting. It's shown only now and works once." : "Optionally limit the invite to one email address."}
      footer={created ? <Button variant="primary" onClick={onClose}>Done</Button> : <><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => create.mutate(undefined)} loading={create.isPending}>Create invite</Button></>}
    >
      {created ? (
        <div className="space-y-3">
          <Input readOnly value={created.url} aria-label="Invite link" onFocus={(e) => e.currentTarget.select()} />
          <Button onClick={copy}><Copy /> Copy link</Button>
          <p className="text-xs text-muted">Expires {fmtDate(created.expiresAt, true)}{created.email ? `. Only ${created.email} can use it.` : "."}</p>
        </div>
      ) : (
        <div className="space-y-4">
          <Field label="Email (optional)" htmlFor="inv-email" hint="Leave empty to let anyone with the link join."><Input id="inv-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" /></Field>
          <Field label="Note (optional)" htmlFor="inv-note"><Input id="inv-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder="e.g. Editor for the cooking channel" /></Field>
          <Field label="Expires after" htmlFor="inv-days"><Select id="inv-days" value={days} onChange={(e) => setDays(Number(e.target.value))}>{[1, 7, 30, 90].map((d) => <option key={d} value={d}>{d === 1 ? "1 day" : `${d} days`}</option>)}</Select></Field>
        </div>
      )}
    </Dialog>
  );
}

function AuditTab() {
  const data = useApiQuery<{ items: AuditEntry[] }>(["admin-audit"], "/api/v1/admin/audit");
  return (
    <Panel className="pt-4">
      {data.isLoading ? <SkeletonRows /> : data.error ? <ErrorState error={data.error} /> : <AuditTable rows={data.data?.items ?? []} />}
    </Panel>
  );
}

export function AuditTable({ rows }: { rows: AuditEntry[] }) {
  const cols: Column<AuditEntry>[] = [
    { key: "what", header: "What", cell: (a) => <span>{ACTION_LABEL[a.action] ?? a.action}<span className="block text-xs text-muted">{auditDetail(a)}</span></span>, sortValue: (a) => a.action },
    { key: "who", header: "By", cell: (a) => <span className="text-xs">{a.actorEmail ?? "Removed account"}</span>, sortValue: (a) => a.actorEmail ?? "" },
    { key: "target", header: "Account", cell: (a) => <span className="text-xs">{a.targetEmail ?? "—"}</span>, sortValue: (a) => a.targetEmail ?? "" },
    { key: "when", header: "When", cell: (a) => <span className="text-xs text-muted">{fmtDate(a.createdAt, true)}</span>, sortValue: (a) => a.createdAt },
  ];
  return <DataTable rows={rows} columns={cols} rowKey={(a) => a.id} searchable={(a) => `${a.action} ${a.actorEmail} ${a.targetEmail}`} initialSort={{ key: "when", dir: "desc" }} empty={<EmptyState icon={History} title="Nothing recorded yet" />} />;
}
