import { and, eq, gt } from "drizzle-orm";
import { serviceDb, schema } from "../db/client";
import { env } from "../env";
import { pkceChallenge, randomToken } from "../crypto";
import { getAdapter } from "../providers/platforms";
import type { Platform } from "../providers/platforms/types";
import { saveConnection } from "./connections";
import { logActivity } from "./activity";
import { NotConfiguredError, badRequest } from "../api/errors";
import { safeLocalPath } from "../http-utils";

export function redirectUriFor(platform: Platform) {
  return `${env().APP_URL}/api/oauth/${platform}/callback`;
}

export async function startOAuth(userId: string, platform: Platform, redirectTo = "/settings?tab=connections") {
  const adapter = getAdapter(platform);
  if (!adapter.isConfigured()) throw new NotConfiguredError(`${adapter.displayName} integration`, adapter.setupInstructions);
  if (!env().TOKEN_ENCRYPTION_KEY) throw new NotConfiguredError("Token encryption", "Set TOKEN_ENCRYPTION_KEY (32 random bytes, base64).");
  const state = randomToken(24);
  const verifier = adapter.usesPkce ? randomToken(48) : null;
  await serviceDb().insert(schema.oauthStates).values({
    state,
    userId,
    platform,
    codeVerifier: verifier,
    redirectTo: safeLocalPath(redirectTo, "/settings?tab=connections"),
    expiresAt: new Date(Date.now() + 10 * 60_000),
  });
  return adapter.buildAuthUrl({ state, redirectUri: redirectUriFor(platform), codeChallenge: verifier ? pkceChallenge(verifier) : undefined });
}

/** Completes the OAuth flow. The state must belong to the signed-in user (prevents login CSRF / account mixing). */
export async function completeOAuth(userId: string, platform: Platform, code: string, state: string) {
  const db = serviceDb();
  const rows = await db
    .delete(schema.oauthStates)
    .where(and(eq(schema.oauthStates.state, state), eq(schema.oauthStates.userId, userId), eq(schema.oauthStates.platform, platform), gt(schema.oauthStates.expiresAt, new Date())))
    .returning();
  const saved = rows[0];
  if (!saved) throw badRequest("OAuth state is invalid or expired. Please start the connection again.");
  const adapter = getAdapter(platform);
  const tokens = await adapter.exchangeCode({ code, redirectUri: redirectUriFor(platform), codeVerifier: saved.codeVerifier ?? undefined });
  const account = await adapter.fetchAccount(tokens.accessToken);
  const connection = await saveConnection(userId, platform, tokens, account);
  await logActivity(userId, { action: "connection.connected", entityType: "connection", entityId: connection.id, summary: `Connected ${adapter.displayName}: ${account.name}` });
  return { connection, redirectTo: safeLocalPath(saved.redirectTo, "/settings?tab=connections") };
}
