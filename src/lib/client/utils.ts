import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));

export const fmtNum = (n: number | null | undefined, opts: Intl.NumberFormatOptions = {}) =>
  n === null || n === undefined || Number.isNaN(n) ? "—" : new Intl.NumberFormat("en", { notation: Math.abs(n) >= 10000 ? "compact" : "standard", maximumFractionDigits: 1, ...opts }).format(n);

export const fmtPct = (n: number | null | undefined, digits = 1) => (n === null || n === undefined ? "—" : `${(n * 100).toFixed(digits)}%`);

export function fmtDate(d: string | Date | null | undefined, withTime = false, timeZone?: string) {
  if (!d) return "—";
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", ...(withTime ? { timeStyle: "short" } : {}), ...(timeZone ? { timeZone } : {}) }).format(new Date(d));
}

export function fmtRelative(d: string | Date | null | undefined) {
  if (!d) return "never";
  const diff = (Date.now() - new Date(d).getTime()) / 1000;
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  if (abs < 60) return rtf.format(-Math.round(diff), "second");
  if (abs < 3600) return rtf.format(-Math.round(diff / 60), "minute");
  if (abs < 86400) return rtf.format(-Math.round(diff / 3600), "hour");
  return rtf.format(-Math.round(diff / 86400), "day");
}

export const fmtBytes = (b: number) => (b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : b < 1073741824 ? `${(b / 1048576).toFixed(1)} MB` : `${(b / 1073741824).toFixed(2)} GB`);

export const PLATFORM_LABEL: Record<string, string> = { youtube: "YouTube", tiktok: "TikTok", instagram: "Instagram" };
export const statusLabel = (s: string) => s.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
