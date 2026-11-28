import { z } from "zod";

/**
 * Central, validated environment configuration.
 * Server-only values must never be imported into client components.
 * Every integration is optional: a missing credential disables that
 * integration and the UI shows a documented connection flow instead.
 */
const optional = z
  .string()
  .optional()
  .transform((v) => (v && v.trim().length > 0 ? v.trim() : undefined));

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_URL: z.string().url().default("http://localhost:3000"),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  /** Set to "true" when DATABASE_URL points at a transaction pooler (Supabase port 6543). */
  DATABASE_POOLER: optional,
  REDIS_URL: optional,

  AUTH_PROVIDER: z.enum(["supabase", "local"]).default("local"),
  NEXT_PUBLIC_SUPABASE_URL: optional,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: optional,
  SUPABASE_SERVICE_ROLE_KEY: optional,

  /** 32-byte key, base64 encoded. Encrypts OAuth tokens at rest (AES-256-GCM). */
  TOKEN_ENCRYPTION_KEY: optional,
  /** Secret used to sign local session cookies and OAuth state. */
  SESSION_SECRET: optional,

  STORAGE_PROVIDER: z.enum(["local", "supabase"]).default("local"),
  STORAGE_LOCAL_DIR: z.string().default("./.storage"),
  SUPABASE_STORAGE_BUCKET: z.string().default("media"),

  AI_PROVIDER: z.enum(["anthropic", "openai", "mock", "none"]).default("none"),
  ANTHROPIC_API_KEY: optional,
  ANTHROPIC_MODEL: z.string().default("claude-sonnet-5-5"),
  OPENAI_API_KEY: optional,
  OPENAI_BASE_URL: optional,
  OPENAI_MODEL: z.string().default("gpt-5-mini"),

  IMAGE_PROVIDER: z.enum(["openai", "none"]).default("none"),
  OPENAI_IMAGE_MODEL: z.string().default("gpt-image-1"),

  GOOGLE_CLIENT_ID: optional,
  GOOGLE_CLIENT_SECRET: optional,
  YOUTUBE_API_KEY: optional,
  /** "true" asks for the youtube.force-ssl scope so Clip Studio can read caption tracks of the user's own videos. */
  YOUTUBE_CAPTION_ACCESS: optional,
  /** Testing only: point the YouTube Data / Analytics API calls at a mock server. Leave unset in production. */
  YOUTUBE_API_BASE_URL: optional,
  YOUTUBE_ANALYTICS_BASE_URL: optional,

  TIKTOK_CLIENT_KEY: optional,
  TIKTOK_CLIENT_SECRET: optional,

  INSTAGRAM_APP_ID: optional,
  INSTAGRAM_APP_SECRET: optional,
  INSTAGRAM_GRAPH_VERSION: z.string().default("v25.0"),

  CRON_SECRET: optional,
  /** Header your host sets with the real client IP and clients cannot forge (e.g. "x-real-ip" behind nginx). Default: last X-Forwarded-For hop. */
  TRUSTED_IP_HEADER: optional,
  /** Comma-separated emails that become workspace owners when they sign up or sign in. */
  OWNER_EMAIL: optional,
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

export function env(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** For tests: drop the cached env so changes to process.env take effect. */
export function resetEnvCache() {
  cached = null;
}

export type IntegrationKey =
  | "ai"
  | "image"
  | "youtube_oauth"
  | "youtube_public"
  | "tiktok"
  | "instagram"
  | "queue"
  | "supabase_auth"
  | "supabase_storage"
  | "token_encryption";

/** Report which integrations are configured. Never exposes secret values. */
export function integrationStatus(): Record<IntegrationKey, boolean> {
  const e = env();
  return {
    ai:
      (e.AI_PROVIDER === "anthropic" && !!e.ANTHROPIC_API_KEY) ||
      (e.AI_PROVIDER === "openai" && !!e.OPENAI_API_KEY) ||
      (e.AI_PROVIDER === "mock" && e.NODE_ENV === "test"),
    image: e.IMAGE_PROVIDER === "openai" && !!e.OPENAI_API_KEY,
    youtube_oauth: !!e.GOOGLE_CLIENT_ID && !!e.GOOGLE_CLIENT_SECRET,
    youtube_public: !!e.YOUTUBE_API_KEY,
    tiktok: !!e.TIKTOK_CLIENT_KEY && !!e.TIKTOK_CLIENT_SECRET,
    instagram: !!e.INSTAGRAM_APP_ID && !!e.INSTAGRAM_APP_SECRET,
    queue: !!e.REDIS_URL,
    supabase_auth: !!e.NEXT_PUBLIC_SUPABASE_URL && !!e.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    supabase_storage: !!e.NEXT_PUBLIC_SUPABASE_URL && !!e.SUPABASE_SERVICE_ROLE_KEY,
    token_encryption: !!e.TOKEN_ENCRYPTION_KEY,
  };
}
