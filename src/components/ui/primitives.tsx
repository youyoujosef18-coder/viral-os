"use client";

import * as React from "react";
import { Dialog as D, Tooltip as T, Tabs as Tb, Switch as Sw, DropdownMenu as DM } from "radix-ui";
import { cva, type VariantProps } from "class-variance-authority";
import { Loader2, X, Info } from "lucide-react";
import { cn } from "@/lib/client/utils";

// ------------------------------------------------------------ Button

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary: "bg-violet text-white hover:bg-[#6d4cf5] shadow-[inset_0_1px_0_rgb(255_255_255/0.15)]",
        secondary: "bg-raised text-fg border border-line hover:border-faint",
        ghost: "text-muted hover:text-fg hover:bg-raised",
        danger: "bg-danger/15 text-danger border border-danger/30 hover:bg-danger/25",
        link: "text-violet-soft hover:text-fg underline-offset-4 hover:underline px-0",
      },
      size: { sm: "h-8 px-3 text-[13px] rounded-sm", md: "h-9 px-4 text-sm rounded-md", lg: "h-11 px-5 text-[15px] rounded-md", icon: "size-9 rounded-md" },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants> & { loading?: boolean };

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, loading, children, disabled, ...props }, ref) => (
  <button ref={ref} className={cn(buttonVariants({ variant, size }), className)} disabled={disabled || loading} aria-busy={loading || undefined} {...props}>
    {loading && <Loader2 className="animate-spin" aria-hidden />}
    {children}
  </button>
));
Button.displayName = "Button";

// ------------------------------------------------------------ Form fields

const fieldBase = "w-full rounded-md border border-line bg-ink-2 px-3 text-sm text-fg placeholder:text-faint transition-colors focus:border-violet focus:outline-none focus-visible:shadow-[var(--shadow-glow)] disabled:opacity-60 aria-[invalid=true]:border-danger";

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(({ className, ...p }, ref) => <input ref={ref} className={cn(fieldBase, "h-9", className)} {...p} />);
Input.displayName = "Input";

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...p }, ref) => <textarea ref={ref} className={cn(fieldBase, "py-2 min-h-20 leading-relaxed", className)} {...p} />);
Textarea.displayName = "Textarea";

export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(({ className, children, ...p }, ref) => (
  <select ref={ref} className={cn(fieldBase, "h-9 pr-8 appearance-none bg-[url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' fill='none' stroke='%238d93ad' stroke-width='2'%3E%3Cpath d='M3 4.5 6 7.5 9 4.5'/%3E%3C/svg%3E\")] bg-[right_10px_center] bg-no-repeat", className)} {...p}>
    {children}
  </select>
));
Select.displayName = "Select";

export function Field({ label, hint, error, children, htmlFor, className }: { label: string; hint?: string; error?: string; children: React.ReactNode; htmlFor?: string; className?: string }) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <label htmlFor={htmlFor} className="block text-[13px] font-medium text-fg/90">
        {label}
      </label>
      {children}
      {error ? <p className="text-xs text-danger" role="alert">{error}</p> : hint ? <p className="text-xs text-muted">{hint}</p> : null}
    </div>
  );
}

export function Switch({ checked, onCheckedChange, label, disabled }: { checked: boolean; onCheckedChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <Sw.Root checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} aria-label={label} className="relative h-5 w-9 shrink-0 rounded-full bg-line transition-colors data-[state=checked]:bg-violet disabled:opacity-50">
      <Sw.Thumb className="block size-4 translate-x-0.5 rounded-full bg-white transition-transform data-[state=checked]:translate-x-[18px]" />
    </Sw.Root>
  );
}

// ------------------------------------------------------------ Surfaces

export function Panel({ className, children, as: As = "section", ...p }: React.HTMLAttributes<HTMLElement> & { as?: "section" | "div" | "article" }) {
  return (
    <As className={cn("rounded-lg border border-line-soft bg-panel", className)} {...p}>
      {children}
    </As>
  );
}

export function PanelHeader({ title, description, actions, className, tooltip }: { title: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode; className?: string; tooltip?: string }) {
  return (
    <div className={cn("flex flex-wrap items-start justify-between gap-3 px-5 pt-4 pb-3", className)}>
      <div className="min-w-0">
        <h2 className="flex items-center gap-1.5 text-[15px] font-semibold tracking-[-0.01em]">
          {title}
          {tooltip && <HelpTip text={tooltip} />}
        </h2>
        {description && <p className="mt-0.5 text-[13px] text-muted">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: React.ReactNode }) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="max-w-2xl">
        <h1 className="text-[26px] font-semibold leading-tight tracking-[-0.025em]">{title}</h1>
        {description && <p className="mt-1.5 text-[14px] leading-relaxed text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

const badgeTone = {
  neutral: "bg-raised text-muted border-line",
  violet: "bg-violet/15 text-violet-soft border-violet/30",
  cyan: "bg-cyan/10 text-cyan border-cyan/25",
  success: "bg-success/10 text-success border-success/25",
  warning: "bg-warning/10 text-warning border-warning/25",
  danger: "bg-danger/10 text-danger border-danger/25",
};
export type Tone = keyof typeof badgeTone;

export function Badge({ tone = "neutral", children, className, title }: { tone?: Tone; children: React.ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11.5px] font-medium leading-4", badgeTone[tone], className)}>
      {children}
    </span>
  );
}

/** Marks where a number came from. Verified platform data vs AI estimate vs computed vs user input. */
export function SourceTag({ source, at }: { source: "platform_api" | "ai_estimate" | "computed" | "user_input" | string; at?: string | Date | null }) {
  const map: Record<string, { tone: Tone; label: string; tip: string }> = {
    platform_api: { tone: "success", label: "Verified", tip: "Retrieved from the platform's official API." },
    ai_estimate: { tone: "violet", label: "AI estimate", tip: "Generated by the AI model. An assessment, not measured data." },
    computed: { tone: "cyan", label: "Computed", tip: "Calculated from verified data with a documented formula." },
    user_input: { tone: "neutral", label: "Manual", tip: "Entered by you." },
  };
  const m = map[source] ?? { tone: "neutral" as Tone, label: source, tip: source };
  return (
    <Tooltip content={`${m.tip}${at ? ` Retrieved ${new Date(at).toLocaleString()}.` : ""}`}>
      <span tabIndex={0}>
        <Badge tone={m.tone}>{m.label}</Badge>
      </span>
    </Tooltip>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("skeleton rounded-md", className)} aria-hidden />;
}

export function SkeletonRows({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-2 p-5" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-9 w-full" />
      ))}
    </div>
  );
}

export function EmptyState({ icon: Icon, title, description, action, className }: { icon?: React.ComponentType<{ className?: string }>; title: string; description?: string; action?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col items-center justify-center px-6 py-12 text-center", className)}>
      {Icon && (
        <div className="mb-3 grid size-11 place-items-center rounded-full border border-line bg-raised text-muted">
          <Icon className="size-5" />
        </div>
      )}
      <p className="text-[15px] font-medium">{title}</p>
      {description && <p className="mt-1 max-w-md text-[13px] leading-relaxed text-muted">{description}</p>}
      {action && <div className="mt-4 flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const msg = error instanceof Error ? error.message : "Something went wrong.";
  return (
    <div role="alert" className="m-5 rounded-md border border-danger/30 bg-danger/5 p-4 text-[13px]">
      <p className="font-medium text-danger">Couldn&apos;t load this data</p>
      <p className="mt-1 text-muted">{msg}</p>
      {onRetry && (
        <Button size="sm" className="mt-3" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

// ------------------------------------------------------------ Tooltip

export function Tooltip({ content, children, side = "top" }: { content: React.ReactNode; children: React.ReactNode; side?: "top" | "bottom" | "left" | "right" }) {
  return (
    <T.Root delayDuration={200}>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal>
        <T.Content side={side} sideOffset={6} className="z-50 max-w-xs rounded-md border border-line bg-raised px-2.5 py-1.5 text-xs leading-relaxed text-fg shadow-lg">
          {content}
        </T.Content>
      </T.Portal>
    </T.Root>
  );
}

export function HelpTip({ text }: { text: string }) {
  return (
    <Tooltip content={text}>
      <button type="button" className="text-faint hover:text-muted" aria-label={`Help: ${text}`}>
        <Info className="size-3.5" />
      </button>
    </Tooltip>
  );
}

export const TooltipProvider = T.Provider;

// ------------------------------------------------------------ Dialog

export function Dialog({ open, onOpenChange, title, description, children, footer, wide }: { open: boolean; onOpenChange: (o: boolean) => void; title: string; description?: string; children: React.ReactNode; footer?: React.ReactNode; wide?: boolean }) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-[#070912]/75 backdrop-blur-[2px] data-[state=open]:animate-in" />
        <D.Content className={cn("fixed left-1/2 top-1/2 z-50 flex max-h-[88vh] w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border border-line bg-panel shadow-2xl", wide ? "max-w-3xl" : "max-w-lg")}>
          <div className="flex items-start justify-between gap-4 border-b border-line-soft px-5 py-4">
            <div>
              <D.Title className="text-base font-semibold">{title}</D.Title>
              {description ? <D.Description className="mt-0.5 text-[13px] text-muted">{description}</D.Description> : <D.Description className="sr-only">{title}</D.Description>}
            </div>
            <D.Close className="rounded-sm p-1 text-muted hover:bg-raised hover:text-fg" aria-label="Close">
              <X className="size-4" />
            </D.Close>
          </div>
          <div className="overflow-y-auto px-5 py-4">{children}</div>
          {footer && <div className="flex justify-end gap-2 border-t border-line-soft px-5 py-3">{footer}</div>}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

export function ConfirmDialog({ open, onOpenChange, title, description, confirmLabel, onConfirm, loading, danger = true }: { open: boolean; onOpenChange: (o: boolean) => void; title: string; description: string; confirmLabel: string; onConfirm: () => void; loading?: boolean; danger?: boolean }) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Keep it
          </Button>
          <Button variant={danger ? "danger" : "primary"} onClick={onConfirm} loading={loading}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="text-sm text-muted">{description}</p>
    </Dialog>
  );
}

// ------------------------------------------------------------ Tabs

export function Tabs({ value, onValueChange, items, children, className }: { value: string; onValueChange: (v: string) => void; items: { value: string; label: React.ReactNode }[]; children: React.ReactNode; className?: string }) {
  return (
    <Tb.Root value={value} onValueChange={onValueChange} className={className}>
      <Tb.List className="mb-5 flex gap-1 overflow-x-auto border-b border-line-soft" aria-label="Sections">
        {items.map((i) => (
          <Tb.Trigger key={i.value} value={i.value} className="relative -mb-px whitespace-nowrap border-b-2 border-transparent px-3 pb-2.5 pt-1 text-[13.5px] font-medium text-muted transition-colors hover:text-fg data-[state=active]:border-violet data-[state=active]:text-fg">
            {i.label}
          </Tb.Trigger>
        ))}
      </Tb.List>
      {children}
    </Tb.Root>
  );
}
export const TabPanel = Tb.Content;

// ------------------------------------------------------------ Dropdown

export function Menu({ trigger, items, align = "end" }: { trigger: React.ReactNode; items: ({ label: string; icon?: React.ComponentType<{ className?: string }>; onSelect: () => void; danger?: boolean; disabled?: boolean } | "separator")[]; align?: "start" | "end" }) {
  return (
    <DM.Root>
      <DM.Trigger asChild>{trigger}</DM.Trigger>
      <DM.Portal>
        <DM.Content align={align} sideOffset={6} className="z-50 min-w-44 rounded-md border border-line bg-raised p-1 shadow-xl">
          {items.map((it, i) =>
            it === "separator" ? (
              <DM.Separator key={i} className="my-1 h-px bg-line" />
            ) : (
              <DM.Item key={it.label} disabled={it.disabled} onSelect={it.onSelect} className={cn("flex cursor-pointer select-none items-center gap-2 rounded-sm px-2.5 py-1.5 text-[13px] outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-line", it.danger ? "text-danger" : "text-fg")}>
                {it.icon && <it.icon className="size-4 text-muted" />}
                {it.label}
              </DM.Item>
            ),
          )}
        </DM.Content>
      </DM.Portal>
    </DM.Root>
  );
}

// ------------------------------------------------------------ Signal meter (the signature score element)

/**
 * Segmented meter for every 0–100 score in the product. The segment gradient (violet → cyan)
 * is reserved for scores, so color always means "this is a score".
 */
export function SignalMeter({ value, label, size = "md", source }: { value: number | null | undefined; label?: string; size?: "sm" | "md" | "lg"; source?: string }) {
  const segments = 10;
  const v = value === null || value === undefined ? null : Math.max(0, Math.min(100, Math.round(value)));
  const lit = v === null ? 0 : Math.round((v / 100) * segments);
  const h = size === "lg" ? "h-3" : size === "sm" ? "h-1.5" : "h-2";
  return (
    <div className="min-w-0" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={v ?? undefined} aria-label={label ?? "Score"}>
      {(label || size === "lg") && (
        <div className="mb-1 flex items-baseline justify-between gap-2">
          {label && <span className="truncate text-[12.5px] text-muted">{label}</span>}
          <span className={cn("font-semibold tabular-nums", size === "lg" ? "text-2xl tracking-tight" : "text-[13px]")}>{v ?? "—"}</span>
        </div>
      )}
      <div className="flex gap-[3px]">
        {Array.from({ length: segments }, (_, i) => (
          <span
            key={i}
            className={cn("flex-1 rounded-[2px]", h, i < lit ? "" : "bg-line")}
            style={i < lit ? { background: `color-mix(in oklab, #7c5cff ${100 - (i / (segments - 1)) * 100}%, #22d3ee)` } : undefined}
          />
        ))}
      </div>
      {source && <span className="sr-only">Source: {source}</span>}
    </div>
  );
}

export function Stat({ label, value, delta, hint, loading }: { label: string; value: React.ReactNode; delta?: number | null; hint?: string; loading?: boolean }) {
  return (
    <div className="min-w-0 px-5 py-4">
      <p className="flex items-center gap-1.5 text-[12.5px] text-muted">
        {label}
        {hint && <HelpTip text={hint} />}
      </p>
      {loading ? <Skeleton className="mt-2 h-7 w-24" /> : <p className="mt-1 text-[24px] font-semibold tracking-[-0.02em] tabular-nums">{value}</p>}
      {delta !== undefined && delta !== null && !loading && (
        <p className={cn("mt-0.5 text-xs tabular-nums", delta > 0 ? "text-success" : delta < 0 ? "text-danger" : "text-muted")}>
          {delta > 0 ? "+" : ""}
          {(delta * 100).toFixed(1)}% vs previous period
        </p>
      )}
    </div>
  );
}
