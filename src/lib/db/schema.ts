import {
  pgTable,
  pgEnum,
  uuid,
  text,
  timestamp,
  integer,
  bigint,
  boolean,
  jsonb,
  real,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

const id = () => uuid("id").primaryKey().default(sql`gen_random_uuid()`);
const userId = () => uuid("user_id").notNull();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

export const platformEnum = pgEnum("platform", ["youtube", "tiktok", "instagram"]);
export const connectionStatusEnum = pgEnum("connection_status", [
  "active",
  "expired",
  "revoked",
  "error",
  "requires_reauth",
]);
export const publishStatusEnum = pgEnum("publish_status", [
  "draft",
  "needs_review",
  "ready",
  "scheduled",
  "queued",
  "uploading",
  "processing",
  "published",
  "failed",
  "cancelled",
  "requires_user_action",
  "platform_approval_required",
]);
export const projectStatusEnum = pgEnum("project_status", [
  "idea",
  "research",
  "scripting",
  "production",
  "editing",
  "ready",
  "published",
  "archived",
]);
export const mediaKindEnum = pgEnum("media_kind", ["video", "image", "audio", "document"]);
export const dataSourceEnum = pgEnum("data_source", [
  "platform_api",
  "ai_estimate",
  "user_input",
  "computed",
]);

// ---------------------------------------------------------------- identity

export const profiles = pgTable("profiles", {
  id: uuid("id").primaryKey(), // equals auth user id (Supabase auth.users.id or local user id)
  email: text("email").notNull(),
  displayName: text("display_name"),
  avatarUrl: text("avatar_url"),
  timezone: text("timezone").notNull().default("UTC"),
  niche: text("niche"),
  defaultLanguage: text("default_language").notNull().default("en"),
  dashboardLayout: jsonb("dashboard_layout").$type<string[]>(),
  preferences: jsonb("preferences").$type<Record<string, unknown>>().notNull().default({}),
  /** "user" | "owner". Only the server (service role) can change it: see the column grants in the migrations. */
  role: text("role").notNull().default("user"),
  /** Set by the owner to block sign-in. */
  disabledAt: timestamp("disabled_at", { withTimezone: true }),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// --------------------------------------------------------------------- owner console (service role only)

/** Workspace-wide settings, e.g. signup_mode = "open" | "invite" | "closed". */
export const appSettings = pgTable("app_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<unknown>().notNull(),
  updatedBy: uuid("updated_by"),
  updatedAt: updatedAt(),
});

export const invites = pgTable(
  "invites",
  {
    id: id(),
    /** sha256 of the invite token; the token itself is only shown once, when created. */
    tokenHash: text("token_hash").notNull().unique(),
    /** When set, only this email can use the invite. */
    email: text("email"),
    note: text("note"),
    createdBy: uuid("created_by").notNull(),
    createdAt: createdAt(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    usedBy: uuid("used_by"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [index("invites_created_idx").on(t.createdAt)],
);

/** Everything the owner does in the console, including every look at a user's content. */
export const adminAuditLog = pgTable(
  "admin_audit_log",
  {
    id: id(),
    actorId: uuid("actor_id").notNull(),
    action: text("action").notNull(),
    targetUserId: uuid("target_user_id"),
    detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index("admin_audit_created_idx").on(t.createdAt), index("admin_audit_target_idx").on(t.targetUserId, t.createdAt)],
);

/** Metered usage per user: AI calls (with tokens when the provider reports them) and YouTube API units. */
export const usageEvents = pgTable(
  "usage_events",
  {
    id: id(),
    userId: userId(),
    /** "ai_call" | "youtube_units" */
    kind: text("kind").notNull(),
    units: integer("units").notNull().default(1),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index("usage_events_user_idx").on(t.userId, t.createdAt)],
);

/** Credentials for the LOCAL auth provider only (development / self-hosting without Supabase). */
export const localAuthUsers = pgTable("local_auth_users", {
  id: id(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  createdAt: createdAt(),
});

export const sessions = pgTable(
  "sessions",
  {
    tokenHash: text("token_hash").primaryKey(),
    userId: userId(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

// ---------------------------------------------------------------- platform connections

export const platformConnections = pgTable(
  "platform_connections",
  {
    id: id(),
    userId: userId(),
    platform: platformEnum("platform").notNull(),
    externalAccountId: text("external_account_id").notNull(),
    accountName: text("account_name"),
    accountHandle: text("account_handle"),
    avatarUrl: text("avatar_url"),
    accessTokenEnc: text("access_token_enc").notNull(),
    refreshTokenEnc: text("refresh_token_enc"),
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scopes: text("scopes").array().notNull().default(sql`'{}'::text[]`),
    status: connectionStatusEnum("status").notNull().default("active"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    lastError: text("last_error"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("platform_connections_unique").on(t.userId, t.platform, t.externalAccountId)],
);

export const oauthStates = pgTable("oauth_states", {
  state: text("state").primaryKey(),
  userId: userId(),
  platform: platformEnum("platform").notNull(),
  codeVerifier: text("code_verifier"),
  redirectTo: text("redirect_to"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: createdAt(),
});

// ---------------------------------------------------------------- media

export const mediaAssets = pgTable(
  "media_assets",
  {
    id: id(),
    userId: userId(),
    kind: mediaKindEnum("kind").notNull(),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    storageKey: text("storage_key").notNull(),
    width: integer("width"),
    height: integer("height"),
    durationSeconds: real("duration_seconds"),
    checksum: text("checksum"),
    folder: text("folder").notNull().default("Uncategorized"),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    createdAt: createdAt(),
  },
  (t) => [index("media_assets_user_idx").on(t.userId, t.createdAt), uniqueIndex("media_assets_storage_key_uq").on(t.storageKey)],
);

// ---------------------------------------------------------------- content projects

export const contentProjects = pgTable(
  "content_projects",
  {
    id: id(),
    userId: userId(),
    title: text("title").notNull(),
    description: text("description"),
    status: projectStatusEnum("status").notNull().default("idea"),
    format: text("format").notNull().default("Short-form video"),
    platforms: text("platforms").array().notNull().default(sql`'{}'::text[]`),
    audience: text("audience"),
    language: text("language").notNull().default("en"),
    tone: text("tone"),
    referenceLinks: jsonb("reference_links").$type<string[]>().notNull().default([]),
    assetIds: uuid("asset_ids").array().notNull().default(sql`'{}'::uuid[]`),
    notes: text("notes"),
    dueDate: timestamp("due_date", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("content_projects_user_idx").on(t.userId, t.updatedAt)],
);

export const projectVersions = pgTable("project_versions", {
  id: id(),
  userId: userId(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => contentProjects.id, { onDelete: "cascade" }),
  label: text("label"),
  snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
  createdAt: createdAt(),
});

// ---------------------------------------------------------------- scripts

export type ScriptContent = {
  hook: string;
  scenes: {
    title: string;
    voiceover: string;
    visual: string;
    onScreenText: string;
    broll?: string;
    transition?: string;
    durationSeconds?: number;
  }[];
  editingInstructions: string;
  cta: string;
  caption: string;
  hashtags: string[];
  titleOptions: string[];
  description?: string;
  pinnedComment?: string;
  repurposingIdeas?: string[];
};

export const scripts = pgTable(
  "scripts",
  {
    id: id(),
    userId: userId(),
    projectId: uuid("project_id").references(() => contentProjects.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    platform: text("platform").notNull(),
    controls: jsonb("controls").$type<Record<string, unknown>>().notNull().default({}),
    content: jsonb("content").$type<ScriptContent>().notNull(),
    version: integer("version").notNull().default(1),
    generatedBy: text("generated_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("scripts_user_idx").on(t.userId, t.updatedAt)],
);

export const scriptVersions = pgTable("script_versions", {
  id: id(),
  userId: userId(),
  scriptId: uuid("script_id")
    .notNull()
    .references(() => scripts.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  content: jsonb("content").$type<ScriptContent>().notNull(),
  reason: text("reason"),
  createdAt: createdAt(),
});

// ---------------------------------------------------------------- research & ideas

export const researchRuns = pgTable(
  "research_runs",
  {
    id: id(),
    userId: userId(),
    kind: text("kind").notNull(),
    input: jsonb("input").$type<Record<string, unknown>>().notNull(),
    output: jsonb("output").$type<Record<string, unknown>>().notNull(),
    provider: text("provider").notNull(),
    model: text("model"),
    sources: jsonb("sources").$type<{ label: string; url?: string; retrievedAt: string }[]>().notNull().default([]),
    createdAt: createdAt(),
  },
  (t) => [index("research_runs_user_idx").on(t.userId, t.createdAt)],
);

export const ideas = pgTable(
  "ideas",
  {
    id: id(),
    userId: userId(),
    title: text("title").notNull(),
    angle: text("angle"),
    format: text("format"),
    sourceType: text("source_type").notNull(), // research | trend | keyword | competitor | manual
    sourceRef: text("source_ref"),
    score: integer("score"),
    scoreBreakdown: jsonb("score_breakdown").$type<Record<string, { score: number; reason: string }>>(),
    confidence: text("confidence"),
    scoreSource: dataSourceEnum("score_source").notNull().default("ai_estimate"),
    status: text("status").notNull().default("new"), // new | saved | in_production | dismissed
    projectId: uuid("project_id").references(() => contentProjects.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("ideas_user_idx").on(t.userId, t.createdAt)],
);

// ---------------------------------------------------------------- keywords

export const keywordLists = pgTable("keyword_lists", {
  id: id(),
  userId: userId(),
  name: text("name").notNull(),
  createdAt: createdAt(),
});

export const keywords = pgTable(
  "keywords",
  {
    id: id(),
    userId: userId(),
    listId: uuid("list_id").references(() => keywordLists.id, { onDelete: "set null" }),
    keyword: text("keyword").notNull(),
    seed: text("seed"),
    intent: text("intent"),
    cluster: text("cluster"),
    isQuestion: boolean("is_question").notNull().default(false),
    /** Search volume only when a legitimate provider supplies it; otherwise null. */
    searchVolume: integer("search_volume"),
    volumeSource: text("volume_source"),
    /** 0-100. Computed from YouTube search competition when available, else AI estimate. */
    difficulty: integer("difficulty"),
    difficultySource: dataSourceEnum("difficulty_source"),
    opportunity: integer("opportunity"),
    competitionData: jsonb("competition_data").$type<Record<string, unknown>>(),
    retrievedAt: timestamp("retrieved_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("keywords_user_idx").on(t.userId, t.createdAt)],
);

// ---------------------------------------------------------------- trends

export const trendItems = pgTable(
  "trend_items",
  {
    id: id(),
    userId: userId(),
    source: text("source").notNull(), // youtube_most_popular | ...
    externalId: text("external_id").notNull(),
    title: text("title").notNull(),
    channelTitle: text("channel_title"),
    category: text("category"),
    region: text("region"),
    thumbnailUrl: text("thumbnail_url"),
    url: text("url"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    /** Raw verified metrics from the source (views, likes, comments) */
    metrics: jsonb("metrics").$type<Record<string, number>>().notNull().default({}),
    /** Computed from successive snapshots: views gained per hour since last retrieval */
    momentum: real("momentum"),
    opportunityScore: integer("opportunity_score"),
    estimatedExpiry: timestamp("estimated_expiry", { withTimezone: true }),
    history: jsonb("history").$type<{ at: string; views: number }[]>().notNull().default([]),
    saved: boolean("saved").notNull().default(false),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    retrievedAt: timestamp("retrieved_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("trend_items_unique").on(t.userId, t.source, t.externalId, t.region)],
);

export const trendWatchlists = pgTable("trend_watchlists", {
  id: id(),
  userId: userId(),
  name: text("name").notNull(),
  keywords: text("keywords").array().notNull(),
  region: text("region").notNull().default("US"),
  alertsEnabled: boolean("alerts_enabled").notNull().default(true),
  lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
  createdAt: createdAt(),
});

// ---------------------------------------------------------------- competitors

export const competitors = pgTable(
  "competitors",
  {
    id: id(),
    userId: userId(),
    platform: platformEnum("platform").notNull(),
    externalId: text("external_id").notNull(),
    handle: text("handle"),
    name: text("name").notNull(),
    avatarUrl: text("avatar_url"),
    description: text("description"),
    subscriberCount: bigint("subscriber_count", { mode: "number" }),
    videoCount: integer("video_count"),
    viewCount: bigint("view_count", { mode: "number" }),
    uploadsPlaylistId: text("uploads_playlist_id"),
    analysis: jsonb("analysis").$type<Record<string, unknown>>(),
    analysisAt: timestamp("analysis_at", { withTimezone: true }),
    retrievedAt: timestamp("retrieved_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("competitors_unique").on(t.userId, t.platform, t.externalId)],
);

export const competitorContent = pgTable(
  "competitor_content",
  {
    id: id(),
    userId: userId(),
    competitorId: uuid("competitor_id")
      .notNull()
      .references(() => competitors.id, { onDelete: "cascade" }),
    externalId: text("external_id").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    thumbnailUrl: text("thumbnail_url"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    durationSeconds: integer("duration_seconds"),
    viewCount: bigint("view_count", { mode: "number" }),
    likeCount: bigint("like_count", { mode: "number" }),
    commentCount: bigint("comment_count", { mode: "number" }),
    retrievedAt: timestamp("retrieved_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("competitor_content_unique").on(t.competitorId, t.externalId)],
);

// ---------------------------------------------------------------- thumbnails & analyzer

export const thumbnails = pgTable("thumbnails", {
  id: id(),
  userId: userId(),
  projectId: uuid("project_id").references(() => contentProjects.id, { onDelete: "set null" }),
  assetId: uuid("asset_id").references(() => mediaAssets.id, { onDelete: "set null" }),
  kind: text("kind").notNull(), // concept | upload | generated
  title: text("title").notNull(),
  overlayText: text("overlay_text"),
  prompt: text("prompt"),
  concept: jsonb("concept").$type<Record<string, unknown>>(),
  analysis: jsonb("analysis").$type<Record<string, unknown>>(),
  createdAt: createdAt(),
});

export const videoAnalyses = pgTable("video_analyses", {
  id: id(),
  userId: userId(),
  assetId: uuid("asset_id").references(() => mediaAssets.id, { onDelete: "set null" }),
  projectId: uuid("project_id").references(() => contentProjects.id, { onDelete: "set null" }),
  platform: text("platform").notNull(),
  input: jsonb("input").$type<Record<string, unknown>>().notNull(),
  technical: jsonb("technical").$type<Record<string, unknown>>(),
  result: jsonb("result").$type<Record<string, unknown>>().notNull(),
  overallScore: integer("overall_score"),
  confidence: text("confidence"),
  createdAt: createdAt(),
});

// ---------------------------------------------------------------- publishing

export const posts = pgTable(
  "posts",
  {
    id: id(),
    userId: userId(),
    projectId: uuid("project_id").references(() => contentProjects.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    baseCaption: text("base_caption").notNull().default(""),
    mediaAssetId: uuid("media_asset_id").references(() => mediaAssets.id, { onDelete: "set null" }),
    thumbnailAssetId: uuid("thumbnail_asset_id").references(() => mediaAssets.id, { onDelete: "set null" }),
    status: publishStatusEnum("status").notNull().default("draft"),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    timezone: text("timezone").notNull().default("UTC"),
    duplicatedFrom: uuid("duplicated_from"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("posts_user_idx").on(t.userId, t.scheduledAt)],
);

export const postTargets = pgTable(
  "post_targets",
  {
    id: id(),
    userId: userId(),
    postId: uuid("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id").references(() => platformConnections.id, { onDelete: "set null" }),
    platform: platformEnum("platform").notNull(),
    title: text("title"),
    caption: text("caption").notNull().default(""),
    hashtags: text("hashtags").array().notNull().default(sql`'{}'::text[]`),
    privacy: text("privacy").notNull().default("private"),
    options: jsonb("options").$type<Record<string, unknown>>().notNull().default({}),
    thumbnailAssetId: uuid("thumbnail_asset_id").references(() => mediaAssets.id, { onDelete: "set null" }),
    status: publishStatusEnum("status").notNull().default("draft"),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    idempotencyKey: text("idempotency_key").notNull(),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    providerUploadRef: jsonb("provider_upload_ref").$type<Record<string, unknown>>(),
    providerPostId: text("provider_post_id"),
    publicationUrl: text("publication_url"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    lastError: text("last_error"),
    lastErrorCode: text("last_error_code"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("post_targets_idem").on(t.idempotencyKey),
    index("post_targets_due_idx").on(t.status, t.scheduledAt),
    index("post_targets_post_idx").on(t.postId),
  ],
);

export const publishEvents = pgTable(
  "publish_events",
  {
    id: id(),
    userId: userId(),
    targetId: uuid("target_id")
      .notNull()
      .references(() => postTargets.id, { onDelete: "cascade" }),
    status: publishStatusEnum("status").notNull(),
    message: text("message").notNull(),
    detail: jsonb("detail").$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (t) => [index("publish_events_target_idx").on(t.targetId, t.createdAt)],
);

// ---------------------------------------------------------------- automation & agents

export type WorkflowTrigger =
  | { type: "schedule"; cron: string; timezone: string }
  | { type: "post_published"; platform?: string }
  | { type: "post_failed"; platform?: string }
  | { type: "trend_alert"; watchlistId?: string }
  | { type: "manual" };

export type WorkflowStep =
  | { type: "notify"; title: string; body?: string }
  | { type: "sync_analytics" }
  | { type: "refresh_trends"; region?: string }
  | { type: "generate_ideas"; niche: string; count: number }
  | { type: "run_agent"; agentId: string; input: string }
  | { type: "retry_failed_posts" };

export const workflows = pgTable("workflows", {
  id: id(),
  userId: userId(),
  name: text("name").notNull(),
  description: text("description"),
  enabled: boolean("enabled").notNull().default(true),
  trigger: jsonb("trigger").$type<WorkflowTrigger>().notNull(),
  steps: jsonb("steps").$type<WorkflowStep[]>().notNull(),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  nextRunAt: timestamp("next_run_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const workflowRuns = pgTable(
  "workflow_runs",
  {
    id: id(),
    userId: userId(),
    workflowId: uuid("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    status: text("status").notNull(), // queued | running | succeeded | failed
    triggeredBy: text("triggered_by").notNull(),
    log: jsonb("log").$type<{ at: string; step: string; message: string; ok: boolean }[]>().notNull().default([]),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("workflow_runs_wf_idx").on(t.workflowId, t.createdAt)],
);

export const agents = pgTable("agents", {
  id: id(),
  userId: userId(),
  name: text("name").notNull(),
  role: text("role").notNull(),
  instructions: text("instructions").notNull(),
  outputFormat: text("output_format").notNull().default("markdown"),
  temperature: real("temperature").notNull().default(0.7),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const agentRuns = pgTable("agent_runs", {
  id: id(),
  userId: userId(),
  agentId: uuid("agent_id")
    .notNull()
    .references(() => agents.id, { onDelete: "cascade" }),
  input: text("input").notNull(),
  output: text("output"),
  status: text("status").notNull(),
  error: text("error"),
  createdAt: createdAt(),
});

// ---------------------------------------------------------------- analytics & experiments

export const metricSnapshots = pgTable(
  "metric_snapshots",
  {
    id: id(),
    userId: userId(),
    connectionId: uuid("connection_id").references(() => platformConnections.id, { onDelete: "cascade" }),
    platform: platformEnum("platform").notNull(),
    scope: text("scope").notNull(), // account | content | daily
    externalId: text("external_id").notNull(),
    title: text("title"),
    url: text("url"),
    thumbnailUrl: text("thumbnail_url"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    /** For scope=daily: the calendar day the metrics describe */
    metricDate: timestamp("metric_date", { withTimezone: true }),
    metrics: jsonb("metrics").$type<Record<string, number>>().notNull(),
    source: dataSourceEnum("source").notNull().default("platform_api"),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("metric_snapshots_user_idx").on(t.userId, t.platform, t.scope, t.capturedAt),
    uniqueIndex("metric_snapshots_daily_unique").on(t.connectionId, t.scope, t.externalId, t.metricDate),
  ],
);

export type ExperimentVariant = {
  id: string;
  label: string;
  value: string;
  reference?: string;
  metrics: Record<string, number>;
};

export const experiments = pgTable("experiments", {
  id: id(),
  userId: userId(),
  name: text("name").notNull(),
  hypothesis: text("hypothesis"),
  type: text("type").notNull(), // title | thumbnail | hook | caption | posting_time | format
  platform: text("platform"),
  status: text("status").notNull().default("draft"), // draft | running | completed
  primaryMetric: text("primary_metric").notNull().default("views"),
  variants: jsonb("variants").$type<ExperimentVariant[]>().notNull(),
  winnerVariantId: text("winner_variant_id"),
  conclusion: text("conclusion"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// ---------------------------------------------------------------- notifications & activity

export const notifications = pgTable(
  "notifications",
  {
    id: id(),
    userId: userId(),
    type: text("type").notNull(), // info | success | warning | error
    title: text("title").notNull(),
    body: text("body"),
    link: text("link"),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("notifications_user_idx").on(t.userId, t.createdAt)],
);

export const activityLog = pgTable(
  "activity_log",
  {
    id: id(),
    userId: userId(),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    summary: text("summary").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (t) => [index("activity_log_user_idx").on(t.userId, t.createdAt)],
);

// ---------------------------------------------------------------- clipping

export const clipJobs = pgTable(
  "clip_jobs",
  {
    id: id(),
    userId: userId(),
    /** upload: a file in the media library | youtube: a YouTube video read only through the official APIs */
    sourceType: text("source_type").notNull().default("upload"),
    youtubeVideoId: text("youtube_video_id"),
    sourceAssetId: uuid("source_asset_id").references(() => mediaAssets.id, { onDelete: "set null" }),
    projectId: uuid("project_id").references(() => contentProjects.id, { onDelete: "set null" }),
    /** queued | analyzing | transcribing | scoring | rendering | completed | failed */
    status: text("status").notNull().default("queued"),
    progress: integer("progress").notNull().default(0),
    stage: text("stage"),
    settings: jsonb("settings").$type<Record<string, unknown>>().notNull(),
    /** provided | openai | none */
    transcriptSource: text("transcript_source").notNull().default("none"),
    transcript: jsonb("transcript").$type<{ start: number; end: number; text: string }[]>(),
    source: jsonb("source").$type<Record<string, unknown>>(),
    signals: jsonb("signals").$type<Record<string, unknown>>(),
    notes: jsonb("notes").$type<string[]>().notNull().default([]),
    error: text("error"),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("clip_jobs_user_idx").on(t.userId, t.createdAt), index("clip_jobs_status_idx").on(t.status)],
);

export const clips = pgTable(
  "clips",
  {
    id: id(),
    userId: userId(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => clipJobs.id, { onDelete: "cascade" }),
    rank: integer("rank").notNull(),
    startSec: real("start_sec").notNull(),
    endSec: real("end_sec").notNull(),
    title: text("title").notNull(),
    hook: text("hook"),
    caption: text("caption").notNull().default(""),
    hashtags: text("hashtags").array().notNull().default(sql`'{}'::text[]`),
    transcript: text("transcript").notNull().default(""),
    /** Computed from measured signals (always present). */
    computedScore: integer("computed_score").notNull(),
    scoreBreakdown: jsonb("score_breakdown").$type<Record<string, { value: number; weight: number; detail: string }>>().notNull(),
    /** AI estimate (only when an AI provider and a transcript are available). */
    aiScore: integer("ai_score"),
    aiReason: text("ai_reason"),
    /** candidate | queued | rendering | ready | failed | embed (YouTube clip played in the official player, no file) */
    status: text("status").notNull().default("candidate"),
    renderSettings: jsonb("render_settings").$type<Record<string, unknown>>().notNull(),
    assetId: uuid("asset_id").references(() => mediaAssets.id, { onDelete: "set null" }),
    thumbnailAssetId: uuid("thumbnail_asset_id").references(() => mediaAssets.id, { onDelete: "set null" }),
    renderInfo: jsonb("render_info").$type<Record<string, unknown>>(),
    error: text("error"),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("clips_job_idx").on(t.jobId, t.rank), index("clips_status_idx").on(t.status)],
);

/** Tables that carry user_id and are protected by owner-only RLS policies. */
export const USER_OWNED_TABLES = [
  "profiles",
  "platform_connections",
  "oauth_states",
  "media_assets",
  "content_projects",
  "project_versions",
  "scripts",
  "script_versions",
  "research_runs",
  "ideas",
  "keyword_lists",
  "keywords",
  "trend_items",
  "trend_watchlists",
  "competitors",
  "competitor_content",
  "thumbnails",
  "video_analyses",
  "posts",
  "post_targets",
  "publish_events",
  "workflows",
  "workflow_runs",
  "agents",
  "agent_runs",
  "metric_snapshots",
  "experiments",
  "notifications",
  "activity_log",
  "clip_jobs",
  "clips",
] as const;

