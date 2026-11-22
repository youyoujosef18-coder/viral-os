import { and, eq } from "drizzle-orm";
import { serviceDb, schema, type Executor } from "../db/client";
import { decryptSecret, encryptSecret } from "../crypto";
import { getAdapter } from "../providers/platforms";
import { ProviderError } from "../providers/http";
import type { Platform, TokenSet } from "../providers/platforms/types";
import { notify } from "./notifications";

type ConnectionRow = typeof schema.platformConnections.$inferSelect;

/** Public-safe shape: never includes tokens. */
export function toPublicConnection(c: ConnectionRow) {
  return {
    id: c.id,
    platform: c.platform,
    externalAccountId: c.externalAccountId,
    accountName: c.accountName,
    accountHandle: c.accountHandle,
    avatarUrl: c.avatarUrl,
    status: c.status,
    scopes: c.scopes,
    tokenExpiresAt: c.tokenExpiresAt,
    lastSyncedAt: c.lastSyncedAt,
    lastError: c.lastError,
    createdAt: c.createdAt,
  };
}

export async function saveConnection(userId: string, platform: Platform, tokens: TokenSet, account: { externalAccountId: string; name: string; handle?: string; avatarUrl?: string; metadata?: Record<string, unknown> }) {
  const values = {
    userId,
    platform,
    externalAccountId: account.externalAccountId,
    accountName: account.name,
    accountHandle: account.handle ?? null,
    avatarUrl: account.avatarUrl ?? null,
    accessTokenEnc: encryptSecret(tokens.accessToken),
    refreshTokenEnc: tokens.refreshToken ? encryptSecret(tokens.refreshToken) : null,
    tokenExpiresAt: tokens.expiresAt ?? null,
    refreshTokenExpiresAt: tokens.refreshExpiresAt ?? null,
    scopes: tokens.scopes,
    status: "active" as const,
    lastError: null,
    metadata: account.metadata ?? {},
    updatedAt: new Date(),
  };
  const [row] = await serviceDb()
    .insert(schema.platformConnections)
    .values(values)
    .onConflictDoUpdate({
      target: [schema.platformConnections.userId, schema.platformConnections.platform, schema.platformConnections.externalAccountId],
      set: values,
    })
    .returning();
  return row;
}

export async function markConnectionError(connectionId: string, err: unknown) {
  const reauth = err instanceof ProviderError && err.opts.reauth;
  const [row] = await serviceDb()
    .update(schema.platformConnections)
    .set({ status: reauth ? "requires_reauth" : "error", lastError: (err as Error).message.slice(0, 1000), updatedAt: new Date() })
    .where(eq(schema.platformConnections.id, connectionId))
    .returning();
  if (row && reauth) {
    await notify(row.userId, {
      type: "error",
      title: `${getAdapter(row.platform).displayName} needs to be reconnected`,
      body: `Access for ${row.accountName ?? "your account"} expired or was revoked. Reconnect it in Settings → Connections.`,
      link: "/settings?tab=connections",
    });
  }
}

/** Refresh 5 minutes before expiry. Returns a usable access token or throws ProviderError(reauth). */
export async function getValidAccessToken(connection: ConnectionRow, db: Executor = serviceDb()): Promise<string> {
  if (connection.status === "revoked") throw new ProviderError("Connection was disconnected", { reauth: true, userAction: true });
  const current: TokenSet = {
    accessToken: decryptSecret(connection.accessTokenEnc),
    refreshToken: connection.refreshTokenEnc ? decryptSecret(connection.refreshTokenEnc) : undefined,
    expiresAt: connection.tokenExpiresAt ?? undefined,
    scopes: connection.scopes,
  };
  const expiresSoon = current.expiresAt && current.expiresAt.getTime() - Date.now() < 5 * 60_000;
  if (!expiresSoon) return current.accessToken;

  const adapter = getAdapter(connection.platform);
  const refreshable = connection.platform === "instagram" ? current.accessToken : current.refreshToken;
  if (!refreshable) throw new ProviderError("Access token expired and no refresh token is available. Reconnect the account.", { reauth: true });
  try {
    const next = await adapter.refresh(refreshable, current);
    await db
      .update(schema.platformConnections)
      .set({
        accessTokenEnc: encryptSecret(next.accessToken),
        refreshTokenEnc: next.refreshToken ? encryptSecret(next.refreshToken) : connection.refreshTokenEnc,
        tokenExpiresAt: next.expiresAt ?? null,
        refreshTokenExpiresAt: next.refreshExpiresAt ?? connection.refreshTokenExpiresAt,
        status: "active",
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(schema.platformConnections.id, connection.id));
    return next.accessToken;
  } catch (err) {
    await markConnectionError(connection.id, err);
    throw err;
  }
}

export async function getConnectionForUser(userId: string, connectionId: string) {
  const rows = await serviceDb()
    .select()
    .from(schema.platformConnections)
    .where(and(eq(schema.platformConnections.id, connectionId), eq(schema.platformConnections.userId, userId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function disconnect(userId: string, connectionId: string) {
  const conn = await getConnectionForUser(userId, connectionId);
  if (!conn) return false;
  try {
    await getAdapter(conn.platform).revoke(decryptSecret(conn.accessTokenEnc));
  } catch {
    // Revocation is best-effort; local tokens are deleted regardless.
  }
  await serviceDb().delete(schema.platformConnections).where(eq(schema.platformConnections.id, conn.id));
  return true;
}
