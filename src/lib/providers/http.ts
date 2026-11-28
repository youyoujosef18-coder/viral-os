/** Error raised by provider adapters. `retryable` drives the publishing backoff policy. */
export class ProviderError extends Error {
  constructor(
    message: string,
    public opts: {
      status?: number;
      code?: string;
      retryable?: boolean;
      /** The user must fix something (reconnect, change privacy, etc.) */
      userAction?: boolean;
      /** Blocked by a platform review/audit requirement */
      approvalRequired?: boolean;
      /** Token is invalid/revoked: connection must be re-authorized */
      reauth?: boolean;
      raw?: unknown;
    } = {},
  ) {
    super(message);
  }
}

import { recordUsage, youtubeCost } from "../usage";

export type FetchLike = typeof fetch;
let fetchImpl: FetchLike = (...args) => fetch(...args);

/** Tests inject a mock transport so no real API calls are made. */
export function setFetchForTests(f: FetchLike | null) {
  fetchImpl = f ?? ((...args) => fetch(...args));
}

export async function http(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  const { timeoutMs = 60_000, ...rest } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { ...rest, signal: controller.signal });
    // Meter YouTube Data API quota per user (Google charges a call whatever its outcome).
    const cost = youtubeCost(url, rest.method ?? "GET");
    if (cost) await recordUsage("youtube_units", cost.units, { detail: { bucket: cost.bucket, path: new URL(url).pathname } });
    return res;
  } catch (err) {
    throw new ProviderError(`Network error calling ${new URL(url).host}: ${(err as Error).message}`, { retryable: true });
  } finally {
    clearTimeout(timer);
  }
}

export async function readJson<T = unknown>(res: Response): Promise<T> {
  const text = await res.text();
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ProviderError(`Unexpected non-JSON response (${res.status})`, { status: res.status, retryable: res.status >= 500, raw: text.slice(0, 500) });
  }
}

/** Default classification for HTTP failures. */
export function classifyStatus(status: number) {
  return {
    retryable: status === 429 || status >= 500,
    reauth: status === 401,
  };
}
