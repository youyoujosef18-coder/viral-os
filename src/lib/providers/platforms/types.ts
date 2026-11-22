export type Platform = "youtube" | "tiktok" | "instagram";

export type TokenSet = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
  refreshExpiresAt?: Date;
  scopes: string[];
};

export type AccountInfo = {
  externalAccountId: string;
  name: string;
  handle?: string;
  avatarUrl?: string;
  metadata?: Record<string, unknown>;
};

export type MediaSource = {
  mimeType: string;
  sizeBytes: number;
  kind: "video" | "image" | "audio" | "document";
  /** Inclusive range read. */
  readRange(start: number, end: number): Promise<Buffer>;
  readAll(): Promise<Buffer>;
  /** Time-limited URL fetchable by the platform (required by Instagram). */
  publicUrl(ttlSeconds: number): Promise<string>;
};

export type PublishInput = {
  accessToken: string;
  account: { externalAccountId: string; metadata: Record<string, unknown> };
  title: string | null;
  caption: string;
  hashtags: string[];
  privacy: string;
  options: Record<string, unknown>;
  media: MediaSource;
  thumbnail?: MediaSource | null;
  /** Upload state persisted from a previous attempt, enabling resume/idempotency. */
  uploadRef: Record<string, unknown> | null;
  /** Persist intermediate upload state immediately (e.g. resumable session URL). */
  saveUploadRef(ref: Record<string, unknown>): Promise<void>;
};

export type PublishOutcome =
  | { state: "processing"; uploadRef: Record<string, unknown>; message: string; pollAfterMs: number }
  | {
      state: "published";
      providerPostId: string;
      url: string | null;
      uploadRef: Record<string, unknown>;
      warnings?: string[];
    };

export type ContentMetrics = {
  externalId: string;
  title: string | null;
  url: string | null;
  thumbnailUrl: string | null;
  publishedAt: Date | null;
  metrics: Record<string, number>;
};

export type AnalyticsResult = {
  account: Record<string, number>;
  content: ContentMetrics[];
  daily: { date: string; metrics: Record<string, number> }[];
};

export interface PlatformAdapter {
  platform: Platform;
  displayName: string;
  isConfigured(): boolean;
  setupInstructions: string;
  usesPkce: boolean;
  buildAuthUrl(p: { state: string; redirectUri: string; codeChallenge?: string }): string;
  exchangeCode(p: { code: string; redirectUri: string; codeVerifier?: string }): Promise<TokenSet>;
  refresh(refreshToken: string, current: TokenSet): Promise<TokenSet>;
  fetchAccount(accessToken: string): Promise<AccountInfo>;
  revoke(accessToken: string): Promise<void>;
  publish(input: PublishInput): Promise<PublishOutcome>;
  checkStatus(input: PublishInput): Promise<PublishOutcome>;
  fetchAnalytics(p: { accessToken: string; externalAccountId: string; days: number }): Promise<AnalyticsResult>;
  /** Validate per-platform constraints before queueing. Returns human-readable problems. */
  validate(p: { media: { mimeType: string; sizeBytes: number; kind: string; durationSeconds?: number | null }; title: string | null; caption: string; privacy: string }): string[];
}
