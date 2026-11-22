import { env } from "../../env";
import { ProviderError, classifyStatus, http, readJson } from "../http";
import type { AnalyticsResult, ContentMetrics, PlatformAdapter, PublishInput, PublishOutcome, TokenSet } from "./types";

/**
 * Official YouTube Data API v3 + YouTube Analytics API v2.
 * Docs: https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol
 */
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const API = "https://www.googleapis.com/youtube/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/youtube/v3";
const ANALYTICS_API = "https://youtubeanalytics.googleapis.com/v2/reports";

export const YOUTUBE_SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/yt-analytics.readonly",
];

/** Lets Clip Studio list and download caption tracks of the user's own videos (captions.list / captions.download). */
export const YOUTUBE_CAPTION_SCOPE = "https://www.googleapis.com/auth/youtube.force-ssl";

export function youtubeScopes(): string[] {
  return env().YOUTUBE_CAPTION_ACCESS === "true" ? [...YOUTUBE_SCOPES, YOUTUBE_CAPTION_SCOPE] : YOUTUBE_SCOPES;
}

/** Chunks must be multiples of 256 KiB (except the last). 8 MiB balances memory and request count. */
export const YT_CHUNK_SIZE = 256 * 1024 * 32;

type GoogleError = { error?: { code?: number; message?: string; errors?: { reason?: string }[] } | string; error_description?: string };

function ytError(status: number, body: GoogleError, context: string): ProviderError {
  const err = typeof body.error === "object" ? body.error : undefined;
  const reason = err?.errors?.[0]?.reason ?? (typeof body.error === "string" ? body.error : undefined);
  const message = err?.message ?? body.error_description ?? `HTTP ${status}`;
  const base = classifyStatus(status);
  const quota = reason === "quotaExceeded" || reason === "rateLimitExceeded" || reason === "userRateLimitExceeded";
  return new ProviderError(`YouTube ${context}: ${message}`, {
    status,
    code: reason,
    retryable: base.retryable || quota,
    reauth: base.reauth || reason === "invalid_grant",
    userAction: reason === "uploadLimitExceeded" || reason === "forbidden" || reason === "youtubeSignupRequired",
    raw: body,
  });
}

async function authed<T>(url: string, accessToken: string, context: string, init: RequestInit = {}): Promise<T> {
  const res = await http(url, { ...init, headers: { Authorization: `Bearer ${accessToken}`, ...(init.headers ?? {}) } });
  const body = await readJson<T & GoogleError>(res);
  if (!res.ok) throw ytError(res.status, body, context);
  return body;
}

function tokenSetFrom(body: { access_token: string; refresh_token?: string; expires_in?: number; scope?: string }, prev?: TokenSet): TokenSet {
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? prev?.refreshToken,
    expiresAt: body.expires_in ? new Date(Date.now() + body.expires_in * 1000) : undefined,
    scopes: body.scope ? body.scope.split(" ") : prev?.scopes ?? [],
  };
}

/** Parse the `Range: bytes=0-12345` header of a 308 Resume Incomplete response. */
export function nextOffsetFromRange(range: string | null): number {
  if (!range) return 0;
  const m = /bytes=0-(\d+)/.exec(range);
  return m ? Number(m[1]) + 1 : 0;
}

function parseIsoDuration(iso: string | undefined): number | null {
  if (!iso) return null;
  const m = /P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso);
  if (!m) return null;
  return Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0);
}

async function pollVideo(input: PublishInput, videoId: string): Promise<PublishOutcome> {
  const data = await authed<{ items?: { status?: { uploadStatus?: string; failureReason?: string; rejectionReason?: string; privacyStatus?: string }; processingDetails?: { processingStatus?: string } }[] }>(
    `${API}/videos?part=status,processingDetails&id=${encodeURIComponent(videoId)}`,
    input.accessToken,
    "status check",
  );
  const item = data.items?.[0];
  if (!item) throw new ProviderError("YouTube reports the uploaded video no longer exists (deleted or not visible).", { userAction: true });
  const status = item.status?.uploadStatus;
  const ref: Record<string, unknown> = { ...(input.uploadRef ?? {}), videoId, uploadStatus: status };
  if (status === "failed" || status === "rejected" || status === "deleted") {
    throw new ProviderError(
      `YouTube ${status} the video: ${item.status?.failureReason ?? item.status?.rejectionReason ?? "no reason given"}`,
      { userAction: true, code: status },
    );
  }
  if (status === "processed") {
    const warnings = Array.isArray(ref.warnings) ? (ref.warnings as string[]) : [];
    return { state: "published", providerPostId: videoId, url: `https://www.youtube.com/watch?v=${videoId}`, uploadRef: ref, warnings };
  }
  return { state: "processing", uploadRef: ref, message: `YouTube is processing the video (${status ?? "uploaded"}).`, pollAfterMs: 30_000 };
}

export const youtubeAdapter: PlatformAdapter = {
  platform: "youtube",
  displayName: "YouTube",
  usesPkce: true,
  setupInstructions:
    "Create an OAuth client (Web application) in Google Cloud Console, enable YouTube Data API v3 and YouTube Analytics API, add the redirect URI shown in Settings, then set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET. Add yourself as a test user on the OAuth consent screen until Google verifies the app.",
  isConfigured: () => !!env().GOOGLE_CLIENT_ID && !!env().GOOGLE_CLIENT_SECRET,

  buildAuthUrl({ state, redirectUri, codeChallenge }) {
    const p = new URLSearchParams({
      client_id: env().GOOGLE_CLIENT_ID ?? "",
      redirect_uri: redirectUri,
      response_type: "code",
      scope: youtubeScopes().join(" "),
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      state,
    });
    if (codeChallenge) {
      p.set("code_challenge", codeChallenge);
      p.set("code_challenge_method", "S256");
    }
    return `${AUTH_URL}?${p}`;
  },

  async exchangeCode({ code, redirectUri, codeVerifier }) {
    const res = await http(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: env().GOOGLE_CLIENT_ID ?? "",
        client_secret: env().GOOGLE_CLIENT_SECRET ?? "",
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
        ...(codeVerifier ? { code_verifier: codeVerifier } : {}),
      }),
    });
    const body = await readJson<{ access_token: string; refresh_token?: string; expires_in?: number; scope?: string } & GoogleError>(res);
    if (!res.ok) throw ytError(res.status, body, "token exchange");
    return tokenSetFrom(body);
  },

  async refresh(refreshToken, current) {
    const res = await http(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env().GOOGLE_CLIENT_ID ?? "",
        client_secret: env().GOOGLE_CLIENT_SECRET ?? "",
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    });
    const body = await readJson<{ access_token: string; expires_in?: number; scope?: string } & GoogleError>(res);
    if (!res.ok) throw ytError(res.status, body, "token refresh");
    return tokenSetFrom(body, current);
  },

  async fetchAccount(accessToken) {
    const data = await authed<{ items?: { id: string; snippet: { title: string; customUrl?: string; thumbnails?: { default?: { url: string } } }; statistics?: Record<string, string>; contentDetails?: { relatedPlaylists?: { uploads?: string } } }[] }>(
      `${API}/channels?part=snippet,statistics,contentDetails&mine=true`,
      accessToken,
      "channel lookup",
    );
    const ch = data.items?.[0];
    if (!ch) throw new ProviderError("This Google account has no YouTube channel. Create a channel first.", { userAction: true });
    return {
      externalAccountId: ch.id,
      name: ch.snippet.title,
      handle: ch.snippet.customUrl,
      avatarUrl: ch.snippet.thumbnails?.default?.url,
      metadata: { uploadsPlaylistId: ch.contentDetails?.relatedPlaylists?.uploads },
    };
  },

  async revoke(accessToken) {
    await http(`${REVOKE_URL}?token=${encodeURIComponent(accessToken)}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" } });
  },

  validate({ media, title, privacy }) {
    const problems: string[] = [];
    if (media.kind !== "video") problems.push("YouTube requires a video file.");
    if (!title || title.trim().length === 0) problems.push("YouTube requires a title.");
    if (title && title.length > 100) problems.push("YouTube titles are limited to 100 characters.");
    if (/[<>]/.test(title ?? "")) problems.push("YouTube titles cannot contain < or >.");
    if (!["private", "unlisted", "public"].includes(privacy)) problems.push("YouTube privacy must be private, unlisted or public.");
    if (media.sizeBytes > 256 * 1024 ** 3) problems.push("YouTube's maximum file size is 256 GB.");
    return problems;
  },

  async publish(input) {
    const ref = { ...(input.uploadRef ?? {}) } as { sessionUrl?: string; videoId?: string; offset?: number; warnings?: string[] };
    if (ref.videoId) return pollVideo(input, ref.videoId); // idempotent: upload already completed

    const total = input.media.sizeBytes;
    if (!ref.sessionUrl) {
      const description = [input.caption, input.hashtags.map((h) => (h.startsWith("#") ? h : `#${h}`)).join(" ")].filter(Boolean).join("\n\n");
      const metadata = {
        snippet: {
          title: input.title ?? "Untitled",
          description: description.slice(0, 5000),
          tags: (input.options.tags as string[] | undefined) ?? input.hashtags.map((h) => h.replace(/^#/, "")).slice(0, 30),
          categoryId: String(input.options.categoryId ?? "22"),
        },
        status: {
          privacyStatus: input.privacy,
          selfDeclaredMadeForKids: Boolean(input.options.madeForKids ?? false),
        },
      };
      const res = await http(`${UPLOAD_API}/videos?uploadType=resumable&part=snippet,status`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${input.accessToken}`,
          "Content-Type": "application/json; charset=UTF-8",
          "X-Upload-Content-Length": String(total),
          "X-Upload-Content-Type": input.media.mimeType,
        },
        body: JSON.stringify(metadata),
      });
      if (!res.ok) throw ytError(res.status, await readJson<GoogleError>(res), "upload init");
      const location = res.headers.get("location");
      if (!location) throw new ProviderError("YouTube did not return a resumable upload URL.", { retryable: true });
      ref.sessionUrl = location;
      ref.offset = 0;
      await input.saveUploadRef(ref);
    } else {
      // Resume: ask YouTube how many bytes it already has.
      const res = await http(ref.sessionUrl, {
        method: "PUT",
        headers: { Authorization: `Bearer ${input.accessToken}`, "Content-Length": "0", "Content-Range": `bytes */${total}` },
      });
      if (res.status === 200 || res.status === 201) {
        const video = await readJson<{ id: string }>(res);
        ref.videoId = video.id;
        await input.saveUploadRef(ref);
        return finishUpload(input, ref);
      }
      if (res.status === 404 || res.status === 410) {
        // Session expired: restart from scratch on next attempt.
        await input.saveUploadRef({});
        throw new ProviderError("YouTube upload session expired; restarting upload.", { retryable: true, code: "session_expired" });
      }
      if (res.status !== 308) throw ytError(res.status, await readJson<GoogleError>(res), "upload resume");
      ref.offset = nextOffsetFromRange(res.headers.get("range"));
    }

    let offset = ref.offset ?? 0;
    while (offset < total) {
      const end = Math.min(offset + YT_CHUNK_SIZE, total) - 1;
      const chunk = await input.media.readRange(offset, end);
      const res = await http(ref.sessionUrl!, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${input.accessToken}`,
          "Content-Length": String(chunk.length),
          "Content-Range": `bytes ${offset}-${end}/${total}`,
        },
        body: new Uint8Array(chunk),
        timeoutMs: 10 * 60_000,
      });
      if (res.status === 308) {
        offset = nextOffsetFromRange(res.headers.get("range"));
        ref.offset = offset;
        await input.saveUploadRef(ref);
        continue;
      }
      if (res.status === 200 || res.status === 201) {
        const video = await readJson<{ id: string }>(res);
        ref.videoId = video.id;
        ref.offset = total;
        await input.saveUploadRef(ref);
        return finishUpload(input, ref);
      }
      throw ytError(res.status, await readJson<GoogleError>(res), "chunk upload");
    }
    throw new ProviderError("Upload finished without a video id from YouTube.", { retryable: true });
  },

  async checkStatus(input) {
    const videoId = (input.uploadRef as { videoId?: string } | null)?.videoId;
    if (!videoId) return youtubeAdapter.publish(input);
    return pollVideo(input, videoId);
  },

  async fetchAnalytics({ accessToken, days }): Promise<AnalyticsResult> {
    const channel = await authed<{ items?: { id: string; statistics?: Record<string, string>; contentDetails?: { relatedPlaylists?: { uploads?: string } } }[] }>(
      `${API}/channels?part=statistics,contentDetails&mine=true`,
      accessToken,
      "channel statistics",
    );
    const ch = channel.items?.[0];
    const stats = ch?.statistics ?? {};
    const account = {
      subscribers: Number(stats.subscriberCount ?? 0),
      views: Number(stats.viewCount ?? 0),
      videos: Number(stats.videoCount ?? 0),
    };

    const content: ContentMetrics[] = [];
    const uploads = ch?.contentDetails?.relatedPlaylists?.uploads;
    if (uploads) {
      const pl = await authed<{ items?: { contentDetails: { videoId: string } }[] }>(
        `${API}/playlistItems?part=contentDetails&maxResults=50&playlistId=${encodeURIComponent(uploads)}`,
        accessToken,
        "uploads list",
      );
      const ids = (pl.items ?? []).map((i) => i.contentDetails.videoId);
      if (ids.length) {
        const vids = await authed<{ items?: { id: string; snippet: { title: string; publishedAt: string; thumbnails?: { medium?: { url: string } } }; statistics?: Record<string, string>; contentDetails?: { duration?: string } }[] }>(
          `${API}/videos?part=snippet,statistics,contentDetails&id=${ids.join(",")}`,
          accessToken,
          "video statistics",
        );
        for (const v of vids.items ?? []) {
          content.push({
            externalId: v.id,
            title: v.snippet.title,
            url: `https://www.youtube.com/watch?v=${v.id}`,
            thumbnailUrl: v.snippet.thumbnails?.medium?.url ?? null,
            publishedAt: new Date(v.snippet.publishedAt),
            metrics: {
              views: Number(v.statistics?.viewCount ?? 0),
              likes: Number(v.statistics?.likeCount ?? 0),
              comments: Number(v.statistics?.commentCount ?? 0),
              durationSeconds: parseIsoDuration(v.contentDetails?.duration) ?? 0,
            },
          });
        }
      }
    }

    const daily: AnalyticsResult["daily"] = [];
    const end = new Date();
    const start = new Date(Date.now() - days * 86400_000);
    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    try {
      const report = await authed<{ columnHeaders?: { name: string }[]; rows?: (string | number)[][] }>(
        `${ANALYTICS_API}?ids=channel==MINE&startDate=${fmt(start)}&endDate=${fmt(end)}&metrics=views,estimatedMinutesWatched,averageViewDuration,subscribersGained,subscribersLost,likes,comments,shares&dimensions=day&sort=day`,
        accessToken,
        "analytics report",
      );
      const headers = (report.columnHeaders ?? []).map((h) => h.name);
      for (const row of report.rows ?? []) {
        const metrics: Record<string, number> = {};
        headers.forEach((h, i) => {
          if (h !== "day") metrics[h] = Number(row[i]);
        });
        daily.push({ date: String(row[headers.indexOf("day")]), metrics });
      }
    } catch (err) {
      // Analytics API may be disabled for the project; channel/video stats still sync.
      if (!(err instanceof ProviderError) || err.opts.reauth) throw err;
    }
    return { account, content, daily };
  },
};

async function finishUpload(input: PublishInput, ref: { videoId?: string; warnings?: string[] }): Promise<PublishOutcome> {
  const videoId = ref.videoId!;
  if (input.thumbnail && !(ref as { thumbnailSet?: boolean }).thumbnailSet) {
    try {
      const img = await input.thumbnail.readAll();
      const res = await http(`${UPLOAD_API}/thumbnails/set?videoId=${encodeURIComponent(videoId)}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${input.accessToken}`, "Content-Type": input.thumbnail.mimeType },
        body: new Uint8Array(img),
      });
      if (!res.ok) {
        const body = await readJson<GoogleError>(res);
        const msg = typeof body.error === "object" ? body.error?.message : body.error;
        ref.warnings = [...(ref.warnings ?? []), `Custom thumbnail was not applied: ${msg ?? res.status}. Custom thumbnails require a verified YouTube account.`];
      } else {
        (ref as { thumbnailSet?: boolean }).thumbnailSet = true;
      }
    } catch (err) {
      ref.warnings = [...(ref.warnings ?? []), `Custom thumbnail failed: ${(err as Error).message}`];
    }
    await input.saveUploadRef(ref);
  }
  return pollVideo({ ...input, uploadRef: ref }, videoId);
}

// ------------------------------------------------------------------ public data (API key)

export type PublicVideo = {
  id: string;
  title: string;
  channelId: string;
  channelTitle: string;
  publishedAt: string;
  thumbnailUrl: string | null;
  categoryId?: string;
  tags?: string[];
  description?: string;
  durationSeconds: number | null;
  views: number;
  likes: number;
  comments: number;
};

function apiKey(): string {
  const k = env().YOUTUBE_API_KEY;
  if (!k) throw new ProviderError("YOUTUBE_API_KEY is not configured", { userAction: true, code: "not_configured" });
  return k;
}

async function publicGet<T>(path: string, params: Record<string, string>): Promise<T> {
  const url = `${API}/${path}?${new URLSearchParams({ ...params, key: apiKey() })}`;
  const res = await http(url);
  const body = await readJson<T & GoogleError>(res);
  if (!res.ok) throw ytError(res.status, body, path);
  return body;
}

type RawVideo = {
  id: string;
  snippet: { title: string; channelId: string; channelTitle: string; publishedAt: string; categoryId?: string; tags?: string[]; description?: string; thumbnails?: { medium?: { url: string }; high?: { url: string } } };
  statistics?: Record<string, string>;
  contentDetails?: { duration?: string };
};

function mapVideo(v: RawVideo): PublicVideo {
  return {
    id: v.id,
    title: v.snippet.title,
    channelId: v.snippet.channelId,
    channelTitle: v.snippet.channelTitle,
    publishedAt: v.snippet.publishedAt,
    thumbnailUrl: v.snippet.thumbnails?.high?.url ?? v.snippet.thumbnails?.medium?.url ?? null,
    categoryId: v.snippet.categoryId,
    tags: v.snippet.tags,
    description: v.snippet.description,
    durationSeconds: parseIsoDuration(v.contentDetails?.duration),
    views: Number(v.statistics?.viewCount ?? 0),
    likes: Number(v.statistics?.likeCount ?? 0),
    comments: Number(v.statistics?.commentCount ?? 0),
  };
}

export const youtubePublic = {
  /** videos.list chart=mostPopular — 1 quota unit. */
  async mostPopular(regionCode: string, categoryId?: string, maxResults = 50): Promise<PublicVideo[]> {
    const data = await publicGet<{ items?: RawVideo[] }>("videos", {
      part: "snippet,statistics,contentDetails",
      chart: "mostPopular",
      regionCode,
      maxResults: String(maxResults),
      ...(categoryId ? { videoCategoryId: categoryId } : {}),
    });
    return (data.items ?? []).map(mapVideo);
  },

  async videoCategories(regionCode: string): Promise<{ id: string; title: string }[]> {
    const data = await publicGet<{ items?: { id: string; snippet: { title: string; assignable: boolean } }[] }>("videoCategories", { part: "snippet", regionCode });
    return (data.items ?? []).filter((c) => c.snippet.assignable).map((c) => ({ id: c.id, title: c.snippet.title }));
  },

  /** search.list has a separate bucket of 100 calls/day per project: callers must cache results. */
  async search(q: string, opts: { maxResults?: number; order?: string; publishedAfter?: string; regionCode?: string } = {}) {
    const data = await publicGet<{ pageInfo?: { totalResults?: number }; items?: { id: { videoId?: string } }[] }>("search", {
      part: "id",
      type: "video",
      q,
      maxResults: String(opts.maxResults ?? 25),
      order: opts.order ?? "relevance",
      ...(opts.publishedAfter ? { publishedAfter: opts.publishedAfter } : {}),
      ...(opts.regionCode ? { regionCode: opts.regionCode } : {}),
    });
    const ids = (data.items ?? []).map((i) => i.id.videoId).filter((x): x is string => !!x);
    const videos = ids.length ? await this.videos(ids) : [];
    return { totalResults: data.pageInfo?.totalResults ?? null, videos };
  },

  async videos(ids: string[]): Promise<PublicVideo[]> {
    const out: PublicVideo[] = [];
    for (let i = 0; i < ids.length; i += 50) {
      const data = await publicGet<{ items?: RawVideo[] }>("videos", { part: "snippet,statistics,contentDetails", id: ids.slice(i, i + 50).join(",") });
      out.push(...(data.items ?? []).map(mapVideo));
    }
    return out;
  },

  async channel(input: string) {
    const trimmed = input.trim();
    const handleMatch = /(?:youtube\.com\/)?@([\w.-]+)/.exec(trimmed);
    const idMatch = /(UC[\w-]{22})/.exec(trimmed);
    const params: Record<string, string> = { part: "snippet,statistics,contentDetails" };
    if (idMatch) params.id = idMatch[1];
    else params.forHandle = handleMatch ? `@${handleMatch[1]}` : trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
    const data = await publicGet<{ items?: { id: string; snippet: { title: string; description: string; customUrl?: string; thumbnails?: { default?: { url: string } } }; statistics?: Record<string, string>; contentDetails?: { relatedPlaylists?: { uploads?: string } } }[] }>("channels", params);
    const ch = data.items?.[0];
    if (!ch) return null;
    return {
      id: ch.id,
      name: ch.snippet.title,
      handle: ch.snippet.customUrl ?? null,
      description: ch.snippet.description,
      avatarUrl: ch.snippet.thumbnails?.default?.url ?? null,
      subscriberCount: ch.statistics?.hiddenSubscriberCount ? null : Number(ch.statistics?.subscriberCount ?? 0),
      videoCount: Number(ch.statistics?.videoCount ?? 0),
      viewCount: Number(ch.statistics?.viewCount ?? 0),
      uploadsPlaylistId: ch.contentDetails?.relatedPlaylists?.uploads ?? null,
    };
  },

  async recentUploads(uploadsPlaylistId: string, max = 50): Promise<PublicVideo[]> {
    const pl = await publicGet<{ items?: { contentDetails: { videoId: string } }[] }>("playlistItems", {
      part: "contentDetails",
      playlistId: uploadsPlaylistId,
      maxResults: String(Math.min(50, max)),
    });
    return this.videos((pl.items ?? []).map((i) => i.contentDetails.videoId));
  },
};

// ------------------------------------------------------------------ clip data (official APIs only; never the media itself)

const dataBase = () => env().YOUTUBE_API_BASE_URL ?? API;
const analyticsBase = () => env().YOUTUBE_ANALYTICS_BASE_URL ?? ANALYTICS_API;

export type ClipVideoDetails = PublicVideo & { embeddable: boolean; privacyStatus: string | null; liveBroadcastContent: string | null };

type Auth = { accessToken?: string };

/** API key when configured, otherwise the user's OAuth token (both are accepted by these read endpoints). */
async function clipGet<T>(path: string, params: Record<string, string>, auth: Auth, context: string): Promise<T> {
  const key = env().YOUTUBE_API_KEY;
  if (!key && !auth.accessToken) throw new ProviderError("Set YOUTUBE_API_KEY or connect a YouTube channel to read YouTube video data.", { userAction: true, code: "not_configured" });
  const qs = new URLSearchParams(auth.accessToken ? params : { ...params, key: key! });
  const res = await http(`${dataBase()}/${path}?${qs}`, auth.accessToken ? { headers: { Authorization: `Bearer ${auth.accessToken}` } } : {});
  const body = await readJson<T & GoogleError>(res);
  if (!res.ok) throw ytError(res.status, body, context);
  return body;
}

export const youtubeClipData = {
  /** videos.list (1 unit): snippet, contentDetails, status (embeddable), statistics. */
  async video(videoId: string, auth: Auth = {}): Promise<ClipVideoDetails | null> {
    const data = await clipGet<{ items?: (RawVideo & { status?: { embeddable?: boolean; privacyStatus?: string }; snippet: RawVideo["snippet"] & { liveBroadcastContent?: string } })[] }>(
      "videos",
      { part: "snippet,contentDetails,status,statistics", id: videoId },
      auth,
      "video lookup",
    );
    const v = data.items?.[0];
    if (!v) return null;
    return { ...mapVideo(v), embeddable: v.status?.embeddable !== false, privacyStatus: v.status?.privacyStatus ?? null, liveBroadcastContent: v.snippet.liveBroadcastContent ?? null };
  },

  /**
   * commentThreads.list (1 unit per page, up to 100 threads each), most relevant first, plain text.
   * Returns { disabled: true } when the video has comments turned off.
   */
  async comments(videoId: string, pages: number, auth: Auth = {}) {
    const out: { text: string; likes: number; publishedAt: string }[] = [];
    let pageToken: string | undefined;
    let calls = 0;
    for (let i = 0; i < pages; i++) {
      try {
        const data = await clipGet<{ nextPageToken?: string; items?: { snippet?: { topLevelComment?: { snippet?: { textDisplay?: string; likeCount?: number; publishedAt?: string } } } }[] }>(
          "commentThreads",
          { part: "snippet", videoId, maxResults: "100", order: "relevance", textFormat: "plainText", ...(pageToken ? { pageToken } : {}) },
          auth,
          "comments",
        );
        calls++;
        for (const it of data.items ?? []) {
          const c = it.snippet?.topLevelComment?.snippet;
          if (c?.textDisplay) out.push({ text: c.textDisplay, likes: Number(c.likeCount ?? 0), publishedAt: c.publishedAt ?? "" });
        }
        pageToken = data.nextPageToken;
        if (!pageToken) break;
      } catch (err) {
        if (err instanceof ProviderError && err.opts.code === "commentsDisabled") return { comments: out, disabled: true, calls: calls + 1 };
        throw err;
      }
    }
    return { comments: out, disabled: false, calls };
  },

  /** captions.list (50 units). Requires the youtube.force-ssl scope and edit rights on the video. */
  async captionTracks(videoId: string, accessToken: string) {
    const data = await authed<{ items?: { id: string; snippet?: { language?: string; name?: string; trackKind?: string; isDraft?: boolean; status?: string } }[] }>(
      `${dataBase()}/captions?${new URLSearchParams({ part: "snippet", videoId })}`,
      accessToken,
      "caption tracks",
    );
    return (data.items ?? []).map((t) => ({ id: t.id, language: t.snippet?.language ?? "", name: t.snippet?.name ?? "", kind: (t.snippet?.trackKind ?? "standard").toLowerCase(), isDraft: !!t.snippet?.isDraft, status: t.snippet?.status ?? null }));
  },

  /** captions.download (200 units) as WebVTT text. */
  async downloadCaption(trackId: string, accessToken: string): Promise<string> {
    const res = await http(`${dataBase()}/captions/${encodeURIComponent(trackId)}?tfmt=vtt`, { headers: { Authorization: `Bearer ${accessToken}` } });
    const text = await res.text();
    if (!res.ok) {
      let body: GoogleError = {};
      try {
        body = JSON.parse(text) as GoogleError;
      } catch {
        // non-JSON error body
      }
      throw ytError(res.status, body, "caption download");
    }
    return text;
  },

  /**
   * Audience retention report (YouTube Analytics): dimension elapsedVideoTimeRatio, one video per request.
   * Returns the raw report; parse it with parseRetention().
   */
  async retention(videoId: string, startDate: string, endDate: string, accessToken: string, metrics = "audienceWatchRatio,relativeRetentionPerformance") {
    const qs = new URLSearchParams({ ids: "channel==MINE", startDate, endDate, metrics, dimensions: "elapsedVideoTimeRatio", filters: `video==${videoId}` });
    return authed<{ columnHeaders?: { name: string }[]; rows?: (number | string)[][] }>(`${analyticsBase()}?${qs}`, accessToken, "audience retention");
  },
};
