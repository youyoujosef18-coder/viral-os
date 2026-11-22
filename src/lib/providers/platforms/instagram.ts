import { env } from "../../env";
import { ProviderError, http, readJson } from "../http";
import type { AnalyticsResult, PlatformAdapter, PublishInput, PublishOutcome, TokenSet } from "./types";

/**
 * Instagram API with Instagram Login (graph.instagram.com).
 * Docs: https://developers.facebook.com/docs/instagram-platform/content-publishing
 * Publishing flow: create container -> poll status_code -> media_publish.
 * Meta fetches the media from a public URL, so APP_URL (or Supabase Storage) must be reachable from the internet.
 */
const AUTH_URL = "https://www.instagram.com/oauth/authorize";
const SHORT_TOKEN_URL = "https://api.instagram.com/oauth/access_token";
const GRAPH = "https://graph.instagram.com";
export const INSTAGRAM_SCOPES = ["instagram_business_basic", "instagram_business_content_publish", "instagram_business_manage_insights"];

const v = () => env().INSTAGRAM_GRAPH_VERSION;
type GraphError = { error?: { message?: string; type?: string; code?: number; error_subcode?: number; is_transient?: boolean } };

function igError(status: number, body: GraphError, context: string) {
  const e = body.error ?? {};
  const code = e.code;
  return new ProviderError(`Instagram ${context}: ${e.message ?? `HTTP ${status}`}`, {
    status,
    code: code ? String(code) : undefined,
    // 4/17/32/613 are Graph API rate limiting codes; is_transient marks retryable failures.
    retryable: status >= 500 || e.is_transient === true || [4, 17, 32, 613].includes(code ?? -1),
    reauth: code === 190 || status === 401,
    userAction: code === 10 || code === 200 || code === 100,
    raw: body,
  });
}

async function graph<T>(path: string, accessToken: string, context: string, init: RequestInit = {}, params: Record<string, string> = {}): Promise<T> {
  const url = `${GRAPH}/${v()}/${path}?${new URLSearchParams({ ...params, access_token: accessToken })}`;
  const res = await http(url, init);
  const body = await readJson<T & GraphError>(res);
  if (!res.ok || body.error) throw igError(res.status, body, context);
  return body;
}

async function longLived(shortToken: string): Promise<TokenSet> {
  const res = await http(`${GRAPH}/access_token?${new URLSearchParams({ grant_type: "ig_exchange_token", client_secret: env().INSTAGRAM_APP_SECRET ?? "", access_token: shortToken })}`);
  const body = await readJson<{ access_token?: string; expires_in?: number } & GraphError>(res);
  if (!res.ok || !body.access_token) throw igError(res.status, body, "long-lived token exchange");
  return { accessToken: body.access_token, expiresAt: body.expires_in ? new Date(Date.now() + body.expires_in * 1000) : undefined, scopes: INSTAGRAM_SCOPES };
}

async function pollContainer(input: PublishInput, containerId: string, igUserId: string): Promise<PublishOutcome> {
  const status = await graph<{ status_code?: string; status?: string }>(containerId, input.accessToken, "container status", {}, { fields: "status_code,status" });
  const ref = { ...(input.uploadRef ?? {}), containerId, containerStatus: status.status_code };
  if (status.status_code === "ERROR" || status.status_code === "EXPIRED") {
    await input.saveUploadRef({}); // a new container is required next attempt
    throw new ProviderError(`Instagram media container ${status.status_code}: ${status.status ?? "no details"}`, {
      userAction: status.status_code === "ERROR",
      retryable: status.status_code === "EXPIRED",
      code: status.status_code,
    });
  }
  if (status.status_code === "IN_PROGRESS") {
    return { state: "processing", uploadRef: ref, message: "Instagram is processing the media.", pollAfterMs: 60_000 };
  }
  // FINISHED (or PUBLISHED from an earlier attempt): publish exactly once.
  let mediaId = (input.uploadRef as { mediaId?: string } | null)?.mediaId;
  if (!mediaId) {
    const published = await graph<{ id: string }>(`${igUserId}/media_publish`, input.accessToken, "media_publish", { method: "POST" }, { creation_id: containerId });
    mediaId = published.id;
    await input.saveUploadRef({ ...ref, mediaId });
  }
  const media = await graph<{ permalink?: string }>(mediaId, input.accessToken, "permalink lookup", {}, { fields: "permalink" });
  return { state: "published", providerPostId: mediaId, url: media.permalink ?? null, uploadRef: { ...ref, mediaId } };
}

export const instagramAdapter: PlatformAdapter = {
  platform: "instagram",
  displayName: "Instagram",
  usesPkce: false,
  setupInstructions:
    "Create a Meta app with the Instagram product (API setup with Instagram login), add the redirect URI shown in Settings, request instagram_business_basic, instagram_business_content_publish and instagram_business_manage_insights, then set INSTAGRAM_APP_ID / INSTAGRAM_APP_SECRET. The Instagram account must be a Professional (Business or Creator) account. Media must be reachable at a public URL, so deploy with a public APP_URL or Supabase Storage. Advanced access requires Meta App Review.",
  isConfigured: () => !!env().INSTAGRAM_APP_ID && !!env().INSTAGRAM_APP_SECRET,

  buildAuthUrl({ state, redirectUri }) {
    const p = new URLSearchParams({
      client_id: env().INSTAGRAM_APP_ID ?? "",
      redirect_uri: redirectUri,
      response_type: "code",
      scope: INSTAGRAM_SCOPES.join(","),
      state,
    });
    return `${AUTH_URL}?${p}`;
  },

  async exchangeCode({ code, redirectUri }) {
    const res = await http(SHORT_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env().INSTAGRAM_APP_ID ?? "",
        client_secret: env().INSTAGRAM_APP_SECRET ?? "",
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
        code: code.replace(/#_$/, ""),
      }),
    });
    const body = await readJson<{ access_token?: string; data?: { access_token: string }[]; error_message?: string } & GraphError>(res);
    const short = body.access_token ?? body.data?.[0]?.access_token;
    if (!res.ok || !short) throw new ProviderError(`Instagram token exchange failed: ${body.error_message ?? body.error?.message ?? res.status}`, { status: res.status });
    return longLived(short);
  },

  async refresh(_refreshToken, current) {
    // Long-lived Instagram tokens (60 days) are refreshed with the token itself.
    const res = await http(`${GRAPH}/refresh_access_token?${new URLSearchParams({ grant_type: "ig_refresh_token", access_token: current.accessToken })}`);
    const body = await readJson<{ access_token?: string; expires_in?: number } & GraphError>(res);
    if (!res.ok || !body.access_token) throw igError(res.status, body, "token refresh");
    return { accessToken: body.access_token, expiresAt: body.expires_in ? new Date(Date.now() + body.expires_in * 1000) : undefined, scopes: current.scopes };
  },

  async fetchAccount(accessToken) {
    const me = await graph<{ user_id?: string; id?: string; username?: string; name?: string; profile_picture_url?: string; account_type?: string }>(
      "me",
      accessToken,
      "profile lookup",
      {},
      { fields: "user_id,username,name,profile_picture_url,account_type" },
    );
    const id = me.user_id ?? me.id;
    if (!id) throw new ProviderError("Instagram returned no account id", { retryable: true });
    return { externalAccountId: id, name: me.name ?? me.username ?? "Instagram account", handle: me.username, avatarUrl: me.profile_picture_url, metadata: { accountType: me.account_type, username: me.username } };
  },

  async revoke() {
    // Instagram Login has no token revocation endpoint; the user removes access in Instagram settings.
  },

  validate({ media, caption }) {
    const problems: string[] = [];
    if (media.kind === "video" && !["video/mp4", "video/quicktime"].includes(media.mimeType)) problems.push("Instagram Reels require MP4 or MOV video.");
    if (media.kind === "image" && media.mimeType !== "image/jpeg") problems.push("Instagram image posts require JPEG images.");
    if (media.kind !== "video" && media.kind !== "image") problems.push("Instagram supports video (Reels) or JPEG image posts.");
    if (caption.length > 2200) problems.push("Instagram captions are limited to 2,200 characters.");
    if ((caption.match(/#\w+/g) ?? []).length > 30) problems.push("Instagram allows at most 30 hashtags.");
    if (media.durationSeconds && media.durationSeconds > 15 * 60) problems.push("Instagram Reels published via API are limited to 15 minutes.");
    return problems;
  },

  async publish(input) {
    const igUserId = input.account.externalAccountId;
    const ref = { ...(input.uploadRef ?? {}) } as { containerId?: string; mediaId?: string };
    if (ref.containerId) return pollContainer(input, ref.containerId, igUserId);

    const caption = [input.caption, input.hashtags.map((h) => (h.startsWith("#") ? h : `#${h}`)).join(" ")].filter(Boolean).join("\n\n").slice(0, 2200);
    const mediaUrl = await input.media.publicUrl(6 * 3600);
    const params: Record<string, string> = { caption };
    if (input.media.kind === "video") {
      params.media_type = "REELS";
      params.video_url = mediaUrl;
      params.share_to_feed = String(input.options.shareToFeed ?? true);
      if (input.thumbnail) params.cover_url = await input.thumbnail.publicUrl(6 * 3600);
    } else {
      params.image_url = mediaUrl;
    }
    const container = await graph<{ id: string }>(`${igUserId}/media`, input.accessToken, "create container", { method: "POST" }, params);
    await input.saveUploadRef({ containerId: container.id });
    return { state: "processing", uploadRef: { containerId: container.id }, message: "Instagram media container created; waiting for processing.", pollAfterMs: input.media.kind === "video" ? 60_000 : 5_000 };
  },

  async checkStatus(input) {
    const containerId = (input.uploadRef as { containerId?: string } | null)?.containerId;
    if (!containerId) return instagramAdapter.publish(input);
    return pollContainer(input, containerId, input.account.externalAccountId);
  },

  async fetchAnalytics({ accessToken, externalAccountId }): Promise<AnalyticsResult> {
    const profile = await graph<{ followers_count?: number; follows_count?: number; media_count?: number }>(externalAccountId, accessToken, "account stats", {}, { fields: "followers_count,follows_count,media_count" });
    const account = { followers: profile.followers_count ?? 0, following: profile.follows_count ?? 0, posts: profile.media_count ?? 0 };
    const media = await graph<{ data?: { id: string; caption?: string; permalink?: string; timestamp?: string; media_type?: string; thumbnail_url?: string; media_url?: string; like_count?: number; comments_count?: number }[] }>(
      `${externalAccountId}/media`,
      accessToken,
      "media list",
      {},
      { fields: "id,caption,permalink,timestamp,media_type,thumbnail_url,media_url,like_count,comments_count", limit: "25" },
    );
    const content = [];
    for (const m of media.data ?? []) {
      const metrics: Record<string, number> = { likes: m.like_count ?? 0, comments: m.comments_count ?? 0 };
      try {
        const insights = await graph<{ data?: { name: string; values?: { value: number }[]; total_value?: { value: number } }[] }>(
          `${m.id}/insights`,
          accessToken,
          "media insights",
          {},
          { metric: "views,reach,saved,shares" },
        );
        for (const d of insights.data ?? []) metrics[d.name] = d.total_value?.value ?? d.values?.[0]?.value ?? 0;
      } catch (err) {
        if (err instanceof ProviderError && err.opts.reauth) throw err; // otherwise insights unavailable for this media type
      }
      content.push({
        externalId: m.id,
        title: m.caption?.slice(0, 120) ?? null,
        url: m.permalink ?? null,
        thumbnailUrl: m.thumbnail_url ?? (m.media_type === "IMAGE" ? m.media_url ?? null : null),
        publishedAt: m.timestamp ? new Date(m.timestamp) : null,
        metrics,
      });
    }
    return { account, content, daily: [] };
  },
};
