"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Button, Field, Input } from "@/components/ui/primitives";
import { api, errorText } from "@/lib/client/api";
import { safeLocalPath } from "@/lib/http-utils";

const loginSchema = z.object({ email: z.string().trim().email("Enter a valid email address"), password: z.string().min(1, "Enter your password") });
const signupSchema = z.object({
  displayName: z.string().trim().min(1, "Enter your name").max(80),
  email: z.string().trim().email("Enter a valid email address"),
  password: z.string().min(10, "Use at least 10 characters"),
});

export function AuthForm({ mode }: { mode: "login" | "signup" }) {
  const router = useRouter();
  const params = useSearchParams();
  const [error, setError] = React.useState<string | null>(params.get("error") ? "That sign-in link is invalid or expired." : null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const schema = mode === "login" ? loginSchema : signupSchema;
  const { register, handleSubmit, formState, setValue } = useForm<z.infer<typeof signupSchema>>({ resolver: zodResolver(schema as typeof signupSchema) });
  // Sign-up control set by the workspace owner: open, invite only, or closed.
  const [signupMode, setSignupMode] = React.useState<"open" | "invite" | "closed" | null>(null);
  const urlInvite = params.get("invite");
  const [inviteInput, setInviteInput] = React.useState("");
  const [invite, setInvite] = React.useState<{ valid: boolean; email: string | null } | null>(null);
  const inviteToken = urlInvite ?? (inviteInput.trim() ? (/[?&]invite=([^&\s]+)/.exec(inviteInput)?.[1] ?? inviteInput.trim()) : null);

  React.useEffect(() => {
    let live = true;
    fetch("/api/auth/signup-mode")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { mode?: "open" | "invite" | "closed" } | null) => live && setSignupMode(d?.mode ?? "open"))
      .catch(() => live && setSignupMode("open"));
    return () => {
      live = false;
    };
  }, []);

  React.useEffect(() => {
    if (mode !== "signup" || !urlInvite) return;
    let live = true;
    fetch(`/api/auth/invite?token=${encodeURIComponent(urlInvite)}`)
      .then((r) => (r.ok ? r.json() : { valid: false, email: null }))
      .then((d: { valid: boolean; email: string | null }) => {
        if (!live) return;
        setInvite(d);
        if (d.email) setValue("email", d.email);
      })
      .catch(() => live && setInvite({ valid: false, email: null }));
    return () => {
      live = false;
    };
  }, [mode, urlInvite, setValue]);

  const onSubmit = handleSubmit(async (values) => {
    setError(null);
    try {
      if (mode === "login") {
        await api.post("/api/auth/login", values);
      } else {
        const r = await api.post<{ requiresEmailConfirmation: boolean }>("/api/auth/signup", { ...values, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, inviteToken: inviteToken ?? undefined });
        if (r.requiresEmailConfirmation) {
          setNotice("Check your inbox to confirm your email, then sign in.");
          return;
        }
      }
      const next = params.get("next");
      router.push(safeLocalPath(next, "/overview"));
      router.refresh();
    } catch (err) {
      setError(errorText(err));
    }
  });

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      {mode === "signup" && urlInvite && invite && (
        <p role="status" className={`rounded-md border px-3 py-2 text-[13px] ${invite.valid ? "border-success/30 bg-success/5 text-success" : "border-danger/30 bg-danger/5 text-danger"}`}>
          {invite.valid ? (invite.email ? `You're invited. This invite is for ${invite.email}.` : "You're invited. Create your account below.") : "This invite link is invalid, expired or already used. Ask the workspace owner for a new one."}
        </p>
      )}
      {mode === "signup" && !urlInvite && signupMode === "closed" && (
        <p role="status" className="rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-[13px] text-warning">Sign-up is closed. Only the workspace owner can create an account here.</p>
      )}
      {mode === "signup" && !urlInvite && signupMode === "invite" && (
        <Field label="Invite link" htmlFor="invite" hint="Sign-up is by invitation. Paste the invite link you were sent.">
          <Input id="invite" value={inviteInput} onChange={(e) => setInviteInput(e.target.value)} autoComplete="off" />
        </Field>
      )}
      {mode === "signup" && (
        <Field label="Name" htmlFor="displayName" error={formState.errors.displayName?.message}>
          <Input id="displayName" autoComplete="name" aria-invalid={!!formState.errors.displayName} {...register("displayName")} />
        </Field>
      )}
      <Field label="Email" htmlFor="email" error={formState.errors.email?.message}>
        <Input id="email" type="email" autoComplete="email" readOnly={mode === "signup" && !!invite?.email} aria-invalid={!!formState.errors.email} {...register("email")} />
      </Field>
      <Field label="Password" htmlFor="password" error={formState.errors.password?.message} hint={mode === "signup" ? "At least 10 characters." : undefined}>
        <Input id="password" type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} aria-invalid={!!formState.errors.password} {...register("password")} />
      </Field>
      {error && <p role="alert" className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-[13px] text-danger">{error}</p>}
      {notice && <p role="status" className="rounded-md border border-success/30 bg-success/5 px-3 py-2 text-[13px] text-success">{notice}</p>}
      <Button type="submit" variant="primary" size="lg" className="w-full" loading={formState.isSubmitting}>
        {mode === "login" ? "Sign in" : "Create account"}
      </Button>
      {(mode === "signup" || signupMode !== "closed") && (
        <p className="text-center text-[13px] text-muted">
          {mode === "login" ? "New to VIRAL OS? " : "Already have an account? "}
          <Link href={mode === "login" ? "/signup" : "/login"} className="text-violet-soft hover:underline">
            {mode === "login" ? (signupMode === "invite" ? "Have an invite? Create an account" : "Create an account") : "Sign in"}
          </Link>
        </p>
      )}
    </form>
  );
}

export function AuthFrame({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="grid min-h-screen lg:grid-cols-[1.1fr_1fr]">
      <div className="relative hidden overflow-hidden border-r border-line-soft bg-ink-2 lg:flex lg:flex-col lg:justify-between lg:p-12">
        <span className="text-[15px] font-semibold tracking-[-0.02em]">VIRAL OS</span>
        <div aria-hidden className="select-none">
          {["Research.", "Create.", "Publish.", "Grow."].map((w, i) => (
            <p key={w} className="text-[clamp(3rem,6vw,5.5rem)] font-semibold leading-[0.95] tracking-[-0.045em]" style={{ color: i === 3 ? undefined : `rgb(236 238 247 / ${0.18 + i * 0.16})` }}>
              {i === 3 ? <span className="bg-gradient-to-r from-violet to-cyan bg-clip-text text-transparent">{w}</span> : w}
            </p>
          ))}
        </div>
        <p className="max-w-sm text-[13px] leading-relaxed text-muted">One workspace for researching ideas, writing scripts, publishing to YouTube, TikTok and Instagram, and learning from verified results.</p>
      </div>
      <div className="flex items-center justify-center px-6 py-12">
        <div className="w-full max-w-sm">
          <h1 className="mb-6 text-2xl font-semibold tracking-[-0.02em]">{title}</h1>
          {children}
        </div>
      </div>
    </div>
  );
}
