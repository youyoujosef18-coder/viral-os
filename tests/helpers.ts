import { randomUUID } from "node:crypto";
import { serviceDb, schema } from "@/lib/db/client";
import { saveConnection } from "@/lib/services/connections";
import type { Platform, PlatformAdapter, PublishOutcome } from "@/lib/providers/platforms/types";

export async function createUser(email = `u-${randomUUID()}@test.dev`) {
  const id = randomUUID();
  await serviceDb().insert(schema.profiles).values({ id, email });
  return { id, email };
}

export async function createConnection(userId: string, platform: Platform = "youtube", expiresInMs = 3600_000) {
  return saveConnection(userId, platform, { accessToken: "access-123", refreshToken: "refresh-456", expiresAt: new Date(Date.now() + expiresInMs), scopes: ["s"] }, { externalAccountId: `ext-${randomUUID()}`, name: "Test Channel", handle: "@test" });
}

/** A scripted fake adapter: each call to publish/checkStatus consumes the next scripted step. */
export function scriptedAdapter(platform: Platform, steps: (PublishOutcome | Error)[]): PlatformAdapter & { calls: string[] } {
  const calls: string[] = [];
  const next = async (kind: string) => {
    calls.push(kind);
    const s = steps.shift();
    if (!s) throw new Error("No scripted step left");
    if (s instanceof Error) throw s;
    return s;
  };
  return {
    platform,
    displayName: platform,
    usesPkce: false,
    setupInstructions: "",
    isConfigured: () => true,
    buildAuthUrl: () => "https://example.test/auth",
    exchangeCode: async () => ({ accessToken: "a", scopes: [] }),
    refresh: async (_r, cur) => ({ ...cur, accessToken: "refreshed", expiresAt: new Date(Date.now() + 3600_000) }),
    fetchAccount: async () => ({ externalAccountId: "x", name: "x" }),
    revoke: async () => {},
    publish: () => next("publish"),
    checkStatus: () => next("checkStatus"),
    fetchAnalytics: async () => ({ account: {}, content: [], daily: [] }),
    validate: () => [],
    calls,
  };
}
