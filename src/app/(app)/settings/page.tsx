"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { CheckCircle2, CircleDashed, Copy, RefreshCw, Unplug, PlugZap, LogOut } from "lucide-react";
import { api } from "@/lib/client/api";
import { useAction, useApiQuery, useConnections, useMe } from "@/lib/client/hooks";
import { Badge, Button, ConfirmDialog, Field, Input, PageHeader, Panel, PanelHeader, Select, SkeletonRows, TabPanel, Tabs } from "@/components/ui/primitives";
import { PlatformMark, StatusBadge } from "@/components/ui/domain";
import { fmtDate, fmtRelative, PLATFORM_LABEL } from "@/lib/client/utils";

type Integrations = {
  status: Record<string, boolean>;
  aiProvider: string | null;
  aiModel: string | null;
  ffmpeg: boolean;
  platforms: { platform: string; name: string; configured: boolean; redirectUri: string; setup: string }[];
  setup: Record<string, string>;
};

export default function SettingsPage() {
  const params = useSearchParams();
  const router = useRouter();
  const [tab, setTab] = React.useState(params.get("tab") ?? "profile");
  React.useEffect(() => {
    const err = params.get("error");
    const ok = params.get("connected");
    if (err) toast.error(err);
    if (ok) toast.success(`${PLATFORM_LABEL[ok] ?? ok} connected`);
    if (err || ok) router.replace(`/settings?tab=${params.get("tab") ?? "connections"}`);
  }, [params, router]);
  return (
    <div>
      <PageHeader title="Settings" description="Your profile, connected accounts and the integrations this workspace uses." />
      <Tabs value={tab} onValueChange={(v) => { setTab(v); router.replace(`/settings?tab=${v}`); }} items={[{ value: "profile", label: "Profile" }, { value: "connections", label: "Connections" }, { value: "integrations", label: "Integrations" }, { value: "account", label: "Account" }]}>
        <TabPanel value="profile"><ProfileTab /></TabPanel>
        <TabPanel value="connections"><ConnectionsTab /></TabPanel>
        <TabPanel value="integrations"><IntegrationsTab /></TabPanel>
        <TabPanel value="account"><AccountTab /></TabPanel>
      </Tabs>
    </div>
  );
}

const profileSchema = z.object({ displayName: z.string().trim().min(1, "Enter a name").max(80), timezone: z.string(), niche: z.string().max(200), defaultLanguage: z.string() });

function ProfileTab() {
  const { data: me, isLoading } = useMe();
  const form = useForm<z.infer<typeof profileSchema>>({ resolver: zodResolver(profileSchema), values: me ? { displayName: me.displayName ?? "", timezone: me.timezone, niche: me.niche ?? "", defaultLanguage: me.defaultLanguage } : undefined });
  const save = useAction((v: z.infer<typeof profileSchema>) => api.patch("/api/v1/me", { ...v, niche: v.niche || null }), { invalidate: [["me"]], success: "Profile saved" });
  if (isLoading) return <Panel><SkeletonRows /></Panel>;
  return (
    <Panel className="max-w-2xl p-5">
      <form className="grid gap-4 sm:grid-cols-2" onSubmit={form.handleSubmit((v) => save.mutate(v))}>
        <Field label="Name" htmlFor="pf-n" error={form.formState.errors.displayName?.message}><Input id="pf-n" {...form.register("displayName")} /></Field>
        <Field label="Email" htmlFor="pf-e"><Input id="pf-e" value={me?.email ?? ""} disabled /></Field>
        <Field label="Timezone" htmlFor="pf-tz" hint="Used for scheduling and the calendar."><Select id="pf-tz" {...form.register("timezone")}>{Intl.supportedValuesOf("timeZone").map((z) => <option key={z}>{z}</option>)}</Select></Field>
        <Field label="Default content language" htmlFor="pf-l"><Select id="pf-l" {...form.register("defaultLanguage")}>{["en", "fr", "ar", "es", "de", "pt", "it", "tr"].map((l) => <option key={l} value={l}>{new Intl.DisplayNames(["en"], { type: "language" }).of(l)}</option>)}</Select></Field>
        <Field label="Your niche" htmlFor="pf-ni" hint="Personalizes research, ideas and recommendations." className="sm:col-span-2"><Input id="pf-ni" placeholder="e.g. budget travel for students" {...form.register("niche")} /></Field>
        <div className="sm:col-span-2"><Button type="submit" variant="primary" loading={save.isPending}>Save profile</Button></div>
      </form>
    </Panel>
  );
}

function ConnectionsTab() {
  const { data: connections, isLoading } = useConnections();
  const integ = useApiQuery<Integrations>(["integrations"], "/api/v1/integrations");
  const [disc, setDisc] = React.useState<string | null>(null);
  const sync = useAction((id: string) => api.post(`/api/v1/connections/${id}/sync`), { invalidate: [["connections"], ["overview"]], success: "Synced" });
  const disconnect = useAction((id: string) => api.del(`/api/v1/connections/${id}`), { invalidate: [["connections"]], success: "Disconnected", onSuccess: () => setDisc(null) });
  if (isLoading || integ.isLoading) return <Panel><SkeletonRows /></Panel>;
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      {integ.data?.platforms.map((p) => {
        const mine = (connections ?? []).filter((c) => c.platform === p.platform);
        return (
          <Panel key={p.platform} className="flex flex-col">
            <PanelHeader title={<span className="flex items-center gap-2"><PlatformMark platform={p.platform} />{p.name}</span>} actions={p.configured ? <Badge tone="success">Available</Badge> : <Badge tone="warning">Needs setup</Badge>} />
            <div className="flex flex-1 flex-col border-t border-line-soft p-5">
              {mine.length ? (
                <ul className="mb-4 space-y-3">
                  {mine.map((c) => (
                    <li key={c.id} className="rounded-md border border-line-soft bg-ink-2 p-3">
                      <div className="flex items-center gap-2">{c.avatarUrl && <img src={c.avatarUrl} alt="" className="size-7 rounded-full" />}<span className="min-w-0 flex-1"><span className="block truncate text-[13.5px] font-medium">{c.accountName}</span><span className="text-xs text-faint">{c.accountHandle}</span></span><StatusBadge status={c.status} /></div>
                      <p className="mt-2 text-xs text-muted">Synced {fmtRelative(c.lastSyncedAt)}{c.tokenExpiresAt ? `. Token renews before ${fmtDate(c.tokenExpiresAt, true)}` : ""}</p>
                      {c.lastError && <p className="mt-1 text-xs text-danger">{c.lastError}</p>}
                      <div className="mt-2 flex gap-1">
                        <Button size="sm" variant="ghost" onClick={() => sync.mutate(c.id)} loading={sync.isPending && sync.variables === c.id}><RefreshCw /> Sync</Button>
                        {c.status !== "active" && <a href={`/api/oauth/${p.platform}/start`}><Button size="sm"><PlugZap /> Reconnect</Button></a>}
                        <Button size="sm" variant="ghost" onClick={() => setDisc(c.id)}><Unplug /> Disconnect</Button>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : <p className="mb-4 text-[13px] text-muted">No {p.name} account connected.</p>}
              {p.configured ? (
                <a href={`/api/oauth/${p.platform}/start`} className="mt-auto"><Button variant={mine.length ? "secondary" : "primary"} className="w-full"><PlugZap /> {mine.length ? "Connect another account" : `Connect ${p.name}`}</Button></a>
              ) : (
                <div className="mt-auto rounded-md border border-warning/30 bg-warning/5 p-3 text-xs leading-relaxed text-muted">
                  <p className="mb-1 font-medium text-fg">Setup required by the workspace owner</p>{p.setup}
                  <p className="mt-2 flex items-center gap-1">Redirect URI: <code className="break-all text-fg">{p.redirectUri}</code><Button size="icon" variant="ghost" className="size-6" aria-label="Copy redirect URI" onClick={() => { navigator.clipboard.writeText(p.redirectUri); toast.success("Copied"); }}><Copy /></Button></p>
                </div>
              )}
            </div>
          </Panel>
        );
      })}
      <ConfirmDialog open={!!disc} onOpenChange={(o) => !o && setDisc(null)} title="Disconnect this account?" description="VIRAL OS revokes its access where the platform supports it and deletes the stored tokens. Scheduled posts to this account will fail until you reconnect." confirmLabel="Disconnect" onConfirm={() => disc && disconnect.mutate(disc)} loading={disconnect.isPending} />
    </div>
  );
}

function IntegrationsTab() {
  const integ = useApiQuery<Integrations>(["integrations"], "/api/v1/integrations");
  if (integ.isLoading || !integ.data) return <Panel><SkeletonRows /></Panel>;
  const s = integ.data.status;
  const items: [string, boolean, string, string][] = [
    ["AI provider", s.ai, integ.data.aiProvider ? `${integ.data.aiProvider} (${integ.data.aiModel})` : "Research, scripts, concepts, analyzer and agents", integ.data.setup.ai],
    ["YouTube Data API key", s.youtube_public, "Trend Radar, keyword competition, competitor lookups", integ.data.setup.youtubePublic],
    ["Background queue (Redis)", s.queue, "Durable publishing, retries and scheduled automations", integ.data.setup.queue],
    ["Image generation", s.image, "Thumbnail images from concepts", integ.data.setup.image],
    ["Token encryption key", s.token_encryption, "Required to store OAuth tokens", "Set TOKEN_ENCRYPTION_KEY to 32 random bytes, base64 encoded (openssl rand -base64 32)."],
    ["Supabase Storage", s.supabase_storage, "Cloud media storage with public signed URLs (needed for Instagram)", "Set STORAGE_PROVIDER=supabase, NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, and create a private bucket named in SUPABASE_STORAGE_BUCKET."],
    ["ffmpeg", integ.data.ffmpeg, "Measured video pacing in the Video Analyzer", "Install ffmpeg on the server or set FFMPEG_PATH and FFPROBE_PATH."],
  ];
  return (
    <div className="space-y-4">
      <Panel>
        <ul className="divide-y divide-line-soft">
          {items.map(([name, ok, what, how]) => (
            <li key={name} className="grid gap-2 px-5 py-4 md:grid-cols-[24px_220px_1fr]">
              {ok ? <CheckCircle2 className="size-5 text-success" aria-label="Configured" /> : <CircleDashed className="size-5 text-warning" aria-label="Not configured" />}
              <div><p className="text-[13.5px] font-medium">{name}</p><p className="text-xs text-muted">{what}</p></div>
              <p className="text-[13px] text-muted">{ok ? "Configured." : how}</p>
            </li>
          ))}
        </ul>
      </Panel>
      <Panel className="p-5 text-[13px] text-muted"><p className="font-medium text-fg">Search volume</p><p className="mt-1">{integ.data.setup.searchVolume}</p></Panel>
    </div>
  );
}

function AccountTab() {
  const router = useRouter();
  const [confirm, setConfirm] = React.useState(false);
  const logout = useAction(() => api.post("/api/auth/logout"), { onSuccess: () => { router.push("/login"); router.refresh(); } });
  return (
    <Panel className="max-w-2xl p-5">
      <h2 className="text-[15px] font-semibold">Sign out</h2>
      <p className="mt-1 text-[13px] text-muted">Ends your session on this device. Scheduled posts and automations keep running.</p>
      <Button className="mt-3" onClick={() => setConfirm(true)}><LogOut /> Sign out</Button>
      <ConfirmDialog open={confirm} onOpenChange={setConfirm} title="Sign out of VIRAL OS?" description="You can sign back in anytime." confirmLabel="Sign out" danger={false} onConfirm={() => logout.mutate(undefined)} loading={logout.isPending} />
    </Panel>
  );
}
