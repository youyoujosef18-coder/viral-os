"use client";

export class ClientApiError extends Error {
  constructor(public status: number, message: string, public code?: string, public details?: unknown) {
    super(message);
  }
  get notConfigured() {
    return this.code === "not_configured";
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const isForm = typeof FormData !== "undefined" && body instanceof FormData;
  const res = await fetch(url, {
    method,
    headers: body && !isForm ? { "Content-Type": "application/json" } : undefined,
    body: body ? (isForm ? (body as FormData) : JSON.stringify(body)) : undefined,
    credentials: "same-origin",
  });
  if (res.status === 401 && typeof window !== "undefined" && !url.startsWith("/api/auth")) {
    // Full reload on purpose: clears all client caches after the session ends.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.href = `/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`;
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const e = data?.error ?? {};
    throw new ClientApiError(res.status, e.message ?? `Request failed (${res.status})`, e.code, e.details);
  }
  return data as T;
}

export const api = {
  get: <T>(url: string) => request<T>("GET", url),
  post: <T>(url: string, body?: unknown) => request<T>("POST", url, body ?? {}),
  put: <T>(url: string, body: unknown) => request<T>("PUT", url, body),
  patch: <T>(url: string, body: unknown) => request<T>("PATCH", url, body),
  del: <T>(url: string, body?: unknown) => request<T>("DELETE", url, body),
  upload: <T>(url: string, form: FormData) => request<T>("POST", url, form),
};

/** Human-readable error text including validation detail lists. */
export function errorText(err: unknown): string {
  if (err instanceof ClientApiError) {
    if (Array.isArray(err.details) && err.details.length && typeof err.details[0] === "string") return `${err.message} ${(err.details as string[]).join(" ")}`;
    if (err.code === "validation" && Array.isArray(err.details)) {
      return (err.details as { path: (string | number)[]; message: string }[]).map((d) => `${d.path.join(".") || "input"}: ${d.message}`).join("; ");
    }
    return err.message;
  }
  return err instanceof Error ? err.message : "Something went wrong";
}
