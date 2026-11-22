import { route } from "@/lib/api/handler";
import { integrationStatus, env } from "@/lib/env";
import { PLATFORMS, getAdapter } from "@/lib/providers/platforms";
import { redirectUriFor } from "@/lib/services/oauth";
import { AI_SETUP } from "@/lib/providers/ai";
import { ffmpegAvailable } from "@/lib/services/analyzer";

/** Which integrations are configured + exact setup steps. Never returns secret values. */
export const GET = route(async () => {
  const s = integrationStatus();
  const e = env();
  return {
    status: s,
    aiProvider: s.ai ? e.AI_PROVIDER : null,
    aiModel: s.ai ? (e.AI_PROVIDER === "anthropic" ? e.ANTHROPIC_MODEL : e.OPENAI_MODEL) : null,
    ffmpeg: await ffmpegAvailable(),
    platforms: PLATFORMS.map((p) => {
      const a = getAdapter(p);
      return { platform: p, name: a.displayName, configured: a.isConfigured(), redirectUri: redirectUriFor(p), setup: a.setupInstructions };
    }),
    setup: {
      ai: AI_SETUP,
      youtubePublic: "Set YOUTUBE_API_KEY (Google Cloud → Credentials → API key, restricted to YouTube Data API v3). Powers Trend Radar, keyword competition and competitor lookups.",
      queue: "Set REDIS_URL and run `npm run worker` on a persistent host. Without it, scheduled publishing relies on the worker's Postgres polling mode.",
      image: "Set IMAGE_PROVIDER=openai and OPENAI_API_KEY to generate thumbnail images.",
      searchVolume: "Search volume is shown only from a licensed provider. None is configured, so volume is reported as unavailable instead of estimated.",
    },
  };
});
