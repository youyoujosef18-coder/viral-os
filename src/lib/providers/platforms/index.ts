import type { Platform, PlatformAdapter } from "./types";
import { youtubeAdapter } from "./youtube";
import { tiktokAdapter } from "./tiktok";
import { instagramAdapter } from "./instagram";

const registry: Record<Platform, PlatformAdapter> = {
  youtube: youtubeAdapter,
  tiktok: tiktokAdapter,
  instagram: instagramAdapter,
};

const overrides: Partial<Record<Platform, PlatformAdapter>> = {};

export function getAdapter(platform: Platform): PlatformAdapter {
  return overrides[platform] ?? registry[platform];
}

/** Tests replace adapters with mocks; never used in production code paths. */
export function setAdapterForTests(platform: Platform, adapter: PlatformAdapter | null) {
  if (adapter) overrides[platform] = adapter;
  else delete overrides[platform];
}

export const PLATFORMS: Platform[] = ["youtube", "tiktok", "instagram"];
export type { Platform, PlatformAdapter };
