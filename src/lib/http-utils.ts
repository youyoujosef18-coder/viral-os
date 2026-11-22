/**
 * Small, dependency-free HTTP helpers. Safe to import from client and server code.
 */

const LOCAL_BASE = "http://local.invalid";

/**
 * Returns `input` only when it is a path on this site (e.g. "/settings?tab=x"); otherwise `fallback`.
 * Rejects protocol-relative ("//evil.com"), backslash ("/\evil.com") and control-character tricks that
 * browsers normalize into another origin.
 */
export function safeLocalPath(input: string | null | undefined, fallback: string): string {
  if (typeof input !== "string" || !input.startsWith("/") || input.startsWith("//")) return fallback;
  if (input.includes("\\") || /[\u0000-\u001f\u007f]/.test(input)) return fallback;
  try {
    const u = new URL(input, LOCAL_BASE);
    if (u.origin !== LOCAL_BASE) return fallback;
    return `${u.pathname}${u.search}${u.hash}`;
  } catch {
    return fallback;
  }
}

export type ByteRange = { start: number; end: number };

/**
 * Parse a single-range `Range: bytes=…` header against a resource of `size` bytes.
 * - null: no usable range header (serve the whole resource; multi-range requests are served whole too)
 * - "unsatisfiable": respond 416
 * Supports "a-b", "a-" and suffix "-n" forms.
 */
export function parseRange(header: string | null | undefined, size: number): ByteRange | "unsatisfiable" | null {
  if (!header) return null;
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
  if (!m || (!m[1] && !m[2])) return null;
  if (size <= 0) return "unsatisfiable";
  if (!m[1]) {
    const n = Number(m[2]);
    if (n === 0) return "unsatisfiable";
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  if (start >= size || end < start) return "unsatisfiable";
  return { start, end };
}

/** RFC 6266 attachment header that works for any filename (Arabic, accents, emoji) without breaking the header. */
export function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "").trim() || "download";
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/**
 * Client IP for rate limiting. With `trustedHeader` (a header your host sets itself and clients can't
 * forge, e.g. "x-real-ip" behind nginx) that value is used. Otherwise the LAST X-Forwarded-For entry is used:
 * it is the one added by the nearest proxy (Vercel overwrites the header entirely). The FIRST entry is
 * whatever the client claims and must never be trusted.
 */
export function clientIp(headers: Headers, trustedHeader?: string): string {
  if (trustedHeader) {
    const v = headers.get(trustedHeader)?.split(",")[0]?.trim();
    if (v) return v;
  }
  const chain = headers.get("x-forwarded-for")?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
  return chain.length ? chain[chain.length - 1] : "local";
}
