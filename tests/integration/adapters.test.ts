import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { setFetchForTests, ProviderError } from "@/lib/providers/http";
import { youtubeAdapter, YT_CHUNK_SIZE } from "@/lib/providers/platforms/youtube";
import { tiktokAdapter } from "@/lib/providers/platforms/tiktok";
import { instagramAdapter } from "@/lib/providers/platforms/instagram";
import type { MediaSource, PublishInput } from "@/lib/providers/platforms/types";
import { getValidAccessToken } from "@/lib/services/connections";
import { decryptSecret } from "@/lib/crypto";
import { schema, serviceDb } from "@/lib/db/client";
import { createConnection, createUser } from "../helpers";

type Call = { url: string; method: string; headers: Record<string, string>; body?: unknown };

function mockFetch(handler: (c: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  setFetchForTests(async (input, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const call = { url: String(input), method: init?.method ?? "GET", headers, body: init?.body };
    calls.push(call);
    return handler(call);
  });
  return calls;
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function media(size: number, kind: "video" | "image" = "video", mimeType = "video/mp4"): MediaSource {
  const data = Buffer.alloc(size, 3);
  return { mimeType, sizeBytes: size, kind, readRange: async (s, e) => data.subarray(s, e + 1), readAll: async () => data, publicUrl: async () => "https://cdn.test/media.mp4" };
}

function input(over: Partial<PublishInput> = {}): PublishInput & { saved: Record<string, unknown>[] } {
  const saved: Record<string, unknown>[] = [];
  const base: PublishInput = {
    accessToken: "tok",
    account: { externalAccountId: "acct-1", metadata: { username: "creator" } },
    title: "Title",
    caption: "Caption",
    hashtags: ["a", "#b"],
    privacy: "private",
    options: {},
    media: media(100),
    thumbnail: null,
    uploadRef: null,
    saveUploadRef: async (r) => {
      saved.push(r);
      base.uploadRef = r;
    },
    ...over,
  };
  return Object.assign(base, { saved });
}

afterEach(() => setFetchForTests(null));

describe("YouTube adapter (resumable upload protocol)", () => {
  it("initiates, uploads in 256KiB-aligned chunks, and waits for processing", async () => {
    const size = YT_CHUNK_SIZE + 1000;
    let received = 0;
    const calls = mockFetch((c) => {
      if (c.url.includes("uploadType=resumable")) return new Response(null, { status: 200, headers: { location: "https://upload.test/session-1" } });
      if (c.url === "https://upload.test/session-1") {
        const len = Number(c.headers["content-length"]);
        received += len;
        if (received < size) return new Response(null, { status: 308, headers: { range: `bytes=0-${received - 1}` } });
        return json({ id: "vid123" }, 201);
      }
      if (c.url.includes("/videos?part=status")) return json({ items: [{ status: { uploadStatus: "uploaded" } }] });
      throw new Error(`unexpected ${c.url}`);
    });
    const inp = input({ media: media(size) });
    const out = await youtubeAdapter.publish(inp);
    expect(out.state).toBe("processing");
    const init = calls[0];
    expect(init.headers["x-upload-content-length"]).toBe(String(size));
    const metadata = JSON.parse(String(init.body));
    expect(metadata.status.privacyStatus).toBe("private");
    expect(metadata.snippet.description).toContain("#a #b");
    const puts = calls.filter((c) => c.url === "https://upload.test/session-1");
    expect(puts).toHaveLength(2);
    expect(puts[0].headers["content-range"]).toBe(`bytes 0-${YT_CHUNK_SIZE - 1}/${size}`);
    expect(YT_CHUNK_SIZE % (256 * 1024)).toBe(0);
    // Session URL was persisted before uploading bytes (resumability).
    expect(inp.saved[0]).toMatchObject({ sessionUrl: "https://upload.test/session-1" });
    expect(inp.saved.at(-1)).toMatchObject({ videoId: "vid123" });
  });

  it("resumes an interrupted upload from the server-reported offset", async () => {
    const size = 2 * YT_CHUNK_SIZE;
    const calls = mockFetch((c) => {
      if (c.headers["content-range"] === `bytes */${size}`) return new Response(null, { status: 308, headers: { range: `bytes=0-${YT_CHUNK_SIZE - 1}` } });
      if (c.url === "https://upload.test/s") return json({ id: "resumed" }, 200);
      if (c.url.includes("/videos?part=status")) return json({ items: [{ status: { uploadStatus: "processed", privacyStatus: "private" } }] });
      throw new Error(`unexpected ${c.url}`);
    });
    const out = await youtubeAdapter.publish(input({ media: media(size), uploadRef: { sessionUrl: "https://upload.test/s", offset: 0 } }));
    expect(out).toMatchObject({ state: "published", providerPostId: "resumed", url: "https://www.youtube.com/watch?v=resumed" });
    const dataPut = calls.find((c) => c.headers["content-range"]?.startsWith("bytes " + YT_CHUNK_SIZE));
    expect(dataPut).toBeTruthy();
    expect(calls.some((c) => c.url.includes("uploadType=resumable"))).toBe(false); // no new session → no duplicate video
  });

  it("is idempotent once a video id exists and classifies quota errors as retryable", async () => {
    mockFetch(() => json({ error: { code: 403, message: "quota", errors: [{ reason: "quotaExceeded" }] } }, 403));
    const err = await youtubeAdapter.publish(input({ uploadRef: { videoId: "v" } })).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.opts.retryable).toBe(true);
  });

  it("reports rejected videos as needing user action", async () => {
    mockFetch(() => json({ items: [{ status: { uploadStatus: "rejected", rejectionReason: "copyright" } }] }));
    const err = await youtubeAdapter.checkStatus(input({ uploadRef: { videoId: "v" } })).catch((e) => e);
    expect(err.opts.userAction).toBe(true);
    expect(err.message).toContain("copyright");
  });
});

describe("TikTok adapter (Content Posting API)", () => {
  it("blocks non-private posts for unaudited apps as platform approval required", async () => {
    mockFetch(() => json({ data: { privacy_level_options: ["SELF_ONLY"] }, error: { code: "ok" } }));
    const err = await tiktokAdapter.publish(input({ privacy: "PUBLIC_TO_EVERYONE" })).catch((e) => e);
    expect(err.opts.approvalRequired).toBe(true);
  });

  it("inits FILE_UPLOAD, PUTs chunks, then confirms via status fetch", async () => {
    const calls = mockFetch((c) => {
      if (c.url.endsWith("/creator_info/query/")) return json({ data: { privacy_level_options: ["SELF_ONLY", "PUBLIC_TO_EVERYONE"] }, error: { code: "ok" } });
      if (c.url.endsWith("/video/init/")) return json({ data: { publish_id: "p_1", upload_url: "https://open-upload.test/u" }, error: { code: "ok" } });
      if (c.url === "https://open-upload.test/u") return new Response(null, { status: 201 });
      if (c.url.endsWith("/status/fetch/")) return json({ data: { status: "PUBLISH_COMPLETE", publicaly_available_post_id: [7712345] }, error: { code: "ok" } });
      throw new Error(`unexpected ${c.url}`);
    });
    const inp = input({ privacy: "SELF_ONLY" });
    const first = await tiktokAdapter.publish(inp);
    expect(first.state).toBe("processing");
    const init = JSON.parse(String(calls.find((c) => c.url.endsWith("/video/init/"))!.body));
    expect(init.source_info).toEqual({ source: "FILE_UPLOAD", video_size: 100, chunk_size: 100, total_chunk_count: 1 });
    expect(init.post_info.privacy_level).toBe("SELF_ONLY");
    expect(calls.find((c) => c.url === "https://open-upload.test/u")!.headers["content-range"]).toBe("bytes 0-99/100");
    const done = await tiktokAdapter.checkStatus(inp);
    expect(done).toMatchObject({ state: "published", providerPostId: "7712345", url: "https://www.tiktok.com/@creator/video/7712345" });
  });

  it("surfaces FAILED status with the fail reason", async () => {
    mockFetch(() => json({ data: { status: "FAILED", fail_reason: "file_format_check_failed" }, error: { code: "ok" } }));
    const err = await tiktokAdapter.checkStatus(input({ uploadRef: { publishId: "p", uploaded: true } })).catch((e) => e);
    expect(err.message).toContain("file_format_check_failed");
  });
});

describe("Instagram adapter (container → status → media_publish)", () => {
  it("creates a REELS container from a public URL and publishes exactly once", async () => {
    let status = "IN_PROGRESS";
    const calls = mockFetch((c) => {
      if (c.url.includes("/acct-1/media?")) return json({ id: "container-9" });
      if (c.url.includes("/container-9?")) return json({ status_code: status });
      if (c.url.includes("/media_publish?")) return json({ id: "media-77" });
      if (c.url.includes("/media-77?")) return json({ permalink: "https://www.instagram.com/reel/xyz/" });
      throw new Error(`unexpected ${c.url}`);
    });
    const inp = input();
    const created = await instagramAdapter.publish(inp);
    expect(created.state).toBe("processing");
    const create = new URL(calls[0].url);
    expect(create.searchParams.get("media_type")).toBe("REELS");
    expect(create.searchParams.get("video_url")).toBe("https://cdn.test/media.mp4");
    expect(create.searchParams.get("caption")).toContain("#a #b");
    expect(await instagramAdapter.checkStatus(inp)).toMatchObject({ state: "processing" });
    status = "FINISHED";
    const done = await instagramAdapter.checkStatus(inp);
    expect(done).toMatchObject({ state: "published", providerPostId: "media-77", url: "https://www.instagram.com/reel/xyz/" });
    // A repeated check after publish must not publish again.
    await instagramAdapter.checkStatus(inp);
    expect(calls.filter((c) => c.url.includes("/media_publish?"))).toHaveLength(1);
  });
});

describe("token management", () => {
  it("refreshes expiring tokens and stores the new token encrypted", async () => {
    const user = await createUser();
    const conn = await createConnection(user.id, "youtube", 60_000); // expires in 1 minute
    mockFetch((c) => {
      expect(c.url).toBe("https://oauth2.googleapis.com/token");
      expect(String(c.body)).toContain("grant_type=refresh_token");
      return json({ access_token: "new-access", expires_in: 3600, scope: "a b" });
    });
    expect(await getValidAccessToken(conn)).toBe("new-access");
    const [row] = await serviceDb().select().from(schema.platformConnections).where(eq(schema.platformConnections.id, conn.id));
    expect(decryptSecret(row.accessTokenEnc)).toBe("new-access");
    expect(decryptSecret(row.refreshTokenEnc!)).toBe("refresh-456"); // Google omits refresh_token on refresh; keep the old one
  });

  it("marks the connection for re-auth on invalid_grant and notifies the user", async () => {
    const user = await createUser();
    const conn = await createConnection(user.id, "youtube", -1000);
    mockFetch(() => json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, 400));
    await expect(getValidAccessToken(conn)).rejects.toThrow(/revoked/);
    const [row] = await serviceDb().select().from(schema.platformConnections).where(eq(schema.platformConnections.id, conn.id));
    expect(row.status).toBe("requires_reauth");
    const notes = await serviceDb().select().from(schema.notifications).where(eq(schema.notifications.userId, user.id));
    expect(notes[0].title).toMatch(/reconnected/);
  });
});
