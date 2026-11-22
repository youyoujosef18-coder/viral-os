import { env } from "../../env";
import { ProviderError, http, readJson } from "../http";
import type { AnalyticsResult, PlatformAdapter, PublishInput, PublishOutcome, TokenSet } from "./types";

/**
 * Official TikTok Content Posting API (Direct Post) + Display API.
 * Docs: https://developers.tiktok.com/doc/content-posting-api-reference-direct-post
 *       https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide
 */
const AUTH_URL = "https://www.tiktok.com/v2/auth/authorize/";
const API = "https://open.tiktokapis.com/v2";
export const TIKTOK_SCOPES = ["user.info.basic", "user.info.stats", "video.publish", "video.upload", "video.list"];

const MB = 1024 * 1024;
const MIN_CHUNK = 5 * MB;
const MAX_CHUNK = 64 * MB;
export const TIKTOK_PRIVACY = ["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR", "SELF_ONLY"] as const;

type TikTokEnvelope<T> = { data?: T; error?: { code?: string; message?: string; log_id?: string; logid?: string } };

/**
 * Chunk plan per the Media Transfer Guide: chunks 5–64 MB, files under 5 MB
 * uploaded whole, chunk count = floor(size / chunk), remainder in the last chunk
 * (which may be up to 128 MB), at most 1000 chunks, uploaded sequentially.
 */
export function tiktokChunkPlan(size: number, preferred = 10 * MB) {
  if (size <= 0) throw new ProviderError("Video file is empty", { userAction: true });
  const chunkSize = Math.min(MAX_CHUNK, Math.max(MIN_CHUNK, preferred));
  // Files smaller than one chunk are sent whole (chunk_size = video_size).
  if (size <= chunkSize) return { chunkSize: size, totalChunks: 1 };
  const totalChunks = Math.max(1, Math.floor(size / chunkSize));
  if (totalChunks > 1000) throw new ProviderError("Video too large for TikTok chunking limits", { userAction: true });
  return { chunkSize, totalChunks };
}

export function tiktokChunkRanges(size: number, plan: { chunkSize: number; totalChunks: number }) {
  const ranges: { start: number; end: number }[] = [];
  for (let i = 0; i < plan.totalChunks; i++) {
    const start = i * plan.chunkSize;
    const end = i === plan.totalChunks - 1 ? size - 1 : start + plan.chunkSize - 1;
    ranges.push({ start, end });
  }
  return ranges;
}

function ttError(status: number, body: TikTokEnvelope<unknown>, context: string) {
  const code = body.error?.code;
  const message = body.error?.message || `HTTP ${status}`;
  return new ProviderError(`TikTok ${context}: ${message}${code ? ` (${code})` : ""}`, {
    status,
    code,
    retryable: status === 429 || status >= 500 || code === "rate_limit_exceeded",
    reauth: code === "access_token_invalid" || status === 401,
    approvalRequired: code === "unaudited_client_can_only_post_to_private_accounts",
    userAction:
      code === "scope_not_authorized" ||
      code === "privacy_level_option_mismatch" ||
      code === "spam_risk_too_many_posts" ||
      code === "spam_risk_user_banned_from_posting" ||
      code === "reached_active_user_cap" ||
      code === "url_ownership_unverified",
    raw: body,
  });
}

async function call<T>(path: string, accessToken: string, body: unknown, context: string): Promise<T> {
  const res = await http(`${API}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json; charset=UTF-8" },
    body: JSON.stringify(body ?? {}),
  });
  const json = await readJson<TikTokEnvelope<T>>(res);
  if (!res.ok || (json.error?.code && json.error.code !== "ok")) throw ttError(res.status, json, context);
  return json.data as T;
}

async function tokenRequest(params: Record<string, string>, context: string, prev?: TokenSet): Promise<TokenSet> {
  const res = await http(`${API}/oauth/token/`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Cache-Control": "no-cache" },
    body: new URLSearchParams({ client_key: env().TIKTOK_CLIENT_KEY ?? "", client_secret: env().TIKTOK_CLIENT_SECRET ?? "", ...params }),
  });
  const body = await readJson<{ access_token?: string; refresh_token?: string; expires_in?: number; refresh_expires_in?: number; scope?: string; open_id?: string; error?: string; error_description?: string }>(res);
  if (!res.ok || !body.access_token) {
    throw new ProviderError(`TikTok ${context}: ${body.error_description ?? body.error ?? res.status}`, {
      status: res.status,
      code: body.error,
      reauth: body.error === "invalid_grant",
      retryable: res.status >= 500,
    });
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? prev?.refreshToken,
    expiresAt: body.expires_in ? new Date(Date.now() + body.expires_in * 1000) : undefined,
    refreshExpiresAt: body.refresh_expires_in ? new Date(Date.now() + body.refresh_expires_in * 1000) : prev?.refreshExpiresAt,
    scopes: body.scope ? body.scope.split(",") : prev?.scopes ?? [],
  };
}

type CreatorInfo = { privacy_level_options?: string[]; max_video_post_duration_sec?: number; comment_disabled?: boolean; duet_disabled?: boolean; stitch_disabled?: boolean; creator_username?: string };

async function pollStatus(input: PublishInput, publishId: string): Promise<PublishOutcome> {
  const data = await call<{ status?: string; fail_reason?: string; publicaly_available_post_id?: (string | number)[]; uploaded_bytes?: number }>(
    "/post/publish/status/fetch/",
    input.accessToken,
    { publish_id: publishId },
    "status fetch",
  );
  const ref = { ...(input.uploadRef ?? {}), publishId, platformStatus: data.status };
  if (data.status === "FAILED") {
    throw new ProviderError(`TikTok could not publish the video: ${data.fail_reason ?? "unknown reason"}`, { userAction: true, code: data.fail_reason });
  }
  if (data.status === "PUBLISH_COMPLETE") {
    const postId = data.publicaly_available_post_id?.[0];
    const handle = input.account.metadata.username as string | undefined;
    const url = postId && handle ? `https://www.tiktok.com/@${handle}/video/${postId}` : null;
    const warnings = postId ? [] : ["TikTok confirmed publication. A public post ID appears only after the post is public and passes moderation (private posts never get one)."];
    return { state: "published", providerPostId: String(postId ?? publishId), url, uploadRef: ref, warnings };
  }
  return { state: "processing", uploadRef: ref, message: `TikTok status: ${data.status ?? "processing"}`, pollAfterMs: 20_000 };
}

export const tiktokAdapter: PlatformAdapter = {
  platform: "tiktok",
  displayName: "TikTok",
  usesPkce: false,
  setupInstructions:
    "Register an app at developers.tiktok.com, add Login Kit and Content Posting API (Direct Post), request the scopes user.info.basic, user.info.stats, video.publish, video.upload, video.list, add the redirect URI shown in Settings, and set TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET. Until TikTok audits the app, posts are restricted to SELF_ONLY (private) visibility.",
  isConfigured: () => !!env().TIKTOK_CLIENT_KEY && !!env().TIKTOK_CLIENT_SECRET,

  buildAuthUrl({ state, redirectUri }) {
    const p = new URLSearchParams({
      client_key: env().TIKTOK_CLIENT_KEY ?? "",
      scope: TIKTOK_SCOPES.join(","),
      response_type: "code",
      redirect_uri: redirectUri,
      state,
    });
    return `${AUTH_URL}?${p}`;
  },

  exchangeCode({ code, redirectUri }) {
    return tokenRequest({ code, grant_type: "authorization_code", redirect_uri: redirectUri }, "token exchange");
  },

  refresh(refreshToken, current) {
    return tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken }, "token refresh", current);
  },

  async fetchAccount(accessToken) {
    const res = await http(`${API}/user/info/?fields=open_id,avatar_url,display_name,username`, { headers: { Authorization: `Bearer ${accessToken}` } });
    const json = await readJson<TikTokEnvelope<{ user?: { open_id: string; avatar_url?: string; display_name?: string; username?: string } }>>(res);
    if (!res.ok || (json.error?.code && json.error.code !== "ok")) throw ttError(res.status, json, "user info");
    const u = json.data?.user;
    if (!u) throw new ProviderError("TikTok returned no user profile", { retryable: true });
    return { externalAccountId: u.open_id, name: u.display_name ?? u.username ?? "TikTok account", handle: u.username, avatarUrl: u.avatar_url, metadata: { username: u.username } };
  },

  async revoke(accessToken) {
    await http(`${API}/oauth/revoke/`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_key: env().TIKTOK_CLIENT_KEY ?? "", client_secret: env().TIKTOK_CLIENT_SECRET ?? "", token: accessToken }),
    });
  },

  validate({ media, caption, privacy }) {
    const problems: string[] = [];
    if (media.kind !== "video") problems.push("TikTok Direct Post in VIRAL OS supports video files only.");
    if (!["video/mp4", "video/quicktime", "video/webm"].includes(media.mimeType)) problems.push("TikTok accepts MP4, MOV (QuickTime) or WebM video.");
    if (media.sizeBytes > 4 * 1024 ** 3) problems.push("TikTok's maximum video size is 4 GB.");
    if (caption.length > 2200) problems.push("TikTok captions are limited to 2,200 characters.");
    if (!TIKTOK_PRIVACY.includes(privacy as (typeof TIKTOK_PRIVACY)[number])) problems.push(`TikTok privacy must be one of ${TIKTOK_PRIVACY.join(", ")}.`);
    return problems;
  },

  async publish(input) {
    const ref = { ...(input.uploadRef ?? {}) } as { publishId?: string; uploaded?: boolean };
    if (ref.publishId && ref.uploaded) return pollStatus(input, ref.publishId);
    if (ref.publishId && !ref.uploaded) {
      // Upload URLs are single-use/time-limited; a partial upload cannot be resumed safely.
      await input.saveUploadRef({});
    }

    const creator = await call<CreatorInfo>("/post/publish/creator_info/query/", input.accessToken, {}, "creator info");
    const allowed = creator.privacy_level_options ?? [];
    if (!allowed.includes(input.privacy)) {
      const onlyPrivate = allowed.length === 1 && allowed[0] === "SELF_ONLY";
      throw new ProviderError(
        onlyPrivate
          ? "This TikTok app/account can only post privately (SELF_ONLY) until the app passes TikTok's audit. Change privacy to SELF_ONLY or complete app review."
          : `TikTok does not allow privacy "${input.privacy}" for this account. Allowed: ${allowed.join(", ") || "none returned"}.`,
        { approvalRequired: onlyPrivate, userAction: !onlyPrivate, code: "privacy_level_option_mismatch" },
      );
    }
    const caption = [input.caption, input.hashtags.map((h) => (h.startsWith("#") ? h : `#${h}`)).join(" ")].filter(Boolean).join(" ").slice(0, 2200);
    const plan = tiktokChunkPlan(input.media.sizeBytes);
    const init = await call<{ publish_id: string; upload_url?: string }>(
      "/post/publish/video/init/",
      input.accessToken,
      {
        post_info: {
          title: caption,
          privacy_level: input.privacy,
          disable_comment: Boolean(input.options.disableComment ?? creator.comment_disabled ?? false),
          disable_duet: Boolean(input.options.disableDuet ?? creator.duet_disabled ?? false),
          disable_stitch: Boolean(input.options.disableStitch ?? creator.stitch_disabled ?? false),
          brand_content_toggle: Boolean(input.options.brandContent ?? false),
          brand_organic_toggle: Boolean(input.options.brandOrganic ?? false),
          is_aigc: Boolean(input.options.isAiGenerated ?? false),
        },
        source_info: { source: "FILE_UPLOAD", video_size: input.media.sizeBytes, chunk_size: plan.chunkSize, total_chunk_count: plan.totalChunks },
      },
      "video init",
    );
    if (!init.upload_url) throw new ProviderError("TikTok did not return an upload URL", { retryable: true });
    await input.saveUploadRef({ publishId: init.publish_id, uploaded: false });

    for (const { start, end } of tiktokChunkRanges(input.media.sizeBytes, plan)) {
      const chunk = await input.media.readRange(start, end);
      const res = await http(init.upload_url, {
        method: "PUT",
        headers: {
          "Content-Type": input.media.mimeType,
          "Content-Length": String(chunk.length),
          "Content-Range": `bytes ${start}-${end}/${input.media.sizeBytes}`,
        },
        body: new Uint8Array(chunk),
        timeoutMs: 10 * 60_000,
      });
      if (!(res.status === 201 || res.status === 206 || res.ok)) {
        throw new ProviderError(`TikTok chunk upload failed (HTTP ${res.status})`, { status: res.status, retryable: res.status >= 500 || res.status === 429 });
      }
    }
    await input.saveUploadRef({ publishId: init.publish_id, uploaded: true });
    return { state: "processing", uploadRef: { publishId: init.publish_id, uploaded: true }, message: "Uploaded to TikTok; waiting for TikTok to process.", pollAfterMs: 15_000 };
  },

  async checkStatus(input) {
    const publishId = (input.uploadRef as { publishId?: string } | null)?.publishId;
    if (!publishId) return tiktokAdapter.publish(input);
    return pollStatus(input, publishId);
  },

  async fetchAnalytics({ accessToken }): Promise<AnalyticsResult> {
    const res = await http(`${API}/user/info/?fields=follower_count,following_count,likes_count,video_count`, { headers: { Authorization: `Bearer ${accessToken}` } });
    const json = await readJson<TikTokEnvelope<{ user?: Record<string, number> }>>(res);
    if (!res.ok || (json.error?.code && json.error.code !== "ok")) throw ttError(res.status, json, "user stats");
    const u = json.data?.user ?? {};
    const account = { followers: Number(u.follower_count ?? 0), likes: Number(u.likes_count ?? 0), videos: Number(u.video_count ?? 0) };
    const list = await call<{ videos?: { id: string; title?: string; video_description?: string; create_time?: number; cover_image_url?: string; share_url?: string; view_count?: number; like_count?: number; comment_count?: number; share_count?: number; duration?: number }[] }>(
      "/video/list/?fields=id,title,video_description,create_time,cover_image_url,share_url,view_count,like_count,comment_count,share_count,duration",
      accessToken,
      { max_count: 20 },
      "video list",
    );
    const content = (list.videos ?? []).map((v) => ({
      externalId: v.id,
      title: v.title || v.video_description || null,
      url: v.share_url ?? null,
      thumbnailUrl: v.cover_image_url ?? null,
      publishedAt: v.create_time ? new Date(v.create_time * 1000) : null,
      metrics: { views: v.view_count ?? 0, likes: v.like_count ?? 0, comments: v.comment_count ?? 0, shares: v.share_count ?? 0, durationSeconds: v.duration ?? 0 },
    }));
    return { account, content, daily: [] };
  },
};
