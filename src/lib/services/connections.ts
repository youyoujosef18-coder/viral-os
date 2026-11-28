import { and, eq } from "drizzle-orm";
import { serviceDb, schema } from "../db/client";
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

const DEFAULT_REFRESH_WINDOW_MS = 5 * 60_000;

function tokensOf(row: ConnectionRow): TokenSet {
  return {
    accessToken: decryptSecret(row.accessTokenEnc),
    refreshToken: row.refreshTokenEnc ? decryptSecret(row.refreshTokenEnc) : undefined,
    expiresAt: row.tokenExpiresAt ?? undefined,
    scopes: row.scopes,
  };
}

function expiresWithin(row: ConnectionRow, windowMs: number) {
  return !!row.tokenExpiresAt && row.tokenExpiresAt.getTime() - Date.now() < windowMs;
}

/**
 * Returns a usable access token, refreshing it when it expires within `refreshWithinMs`
 * (default 5 minutes). Throws ProviderError(reauth) when the account must be reconnected.
 *
 * The refresh runs under a row lock and re-reads the stored tokens first, so two jobs
 * refreshing the same account at once cannot both spend the same refresh token
 * (TikTok rotates refresh tokens; the second use would fail and force a reconnect).
 */
export async function getValidAccessToken(connection: ConnectionRow, opts: { refreshWithinMs?: number } = {}): Promise<string> {
  if (connection.status === "revoked") throw new ProviderError("Connection was disconnected", { reauth: true, userAction: true });
  const windowMs = opts.refreshWithinMs ?? DEFAULT_REFRESH_WINDOW_MS;
  if (!expiresWithin(connection, windowMs)) return decryptSecret(connection.accessTokenEnc);

  try {
    return await serviceDb().transaction(async (tx) => {
      const [fresh] = await tx.select().from(schema.platformConnections).where(eq(schema.platformConnections.id, connection.id)).for("update");
      if (!fresh || fresh.status === "revoked") throw new ProviderError("Connection was disconnected", { reauth: true, userAction: true });
      // Another job may have refreshed while we waited for the lock.
      if (!expiresWithin(fresh, windowMs)) return decryptSecret(fresh.accessTokenEnc);

      const current = tokensOf(fresh);
      const refreshable = fresh.platform === "instagram" ? current.accessToken : current.refreshToken;
      if (!refreshable) throw new ProviderError("Access token expired and no refresh token is available. Reconnect the account.", { reauth: true });
      const next = await getAdapter(fresh.platform).refresh(refreshable, current);
      await tx
        .update(schema.platformConnections)
        .set({
          accessTokenEnc: encryptSecret(next.accessToken),
          refreshTokenEnc: next.refreshToken ? encryptSecret(next.refreshToken) : fresh.refreshTokenEnc,
          tokenExpiresAt: next.expiresAt ?? null,
          refreshTokenExpiresAt: next.refreshExpiresAt ?? fresh.refreshTokenExpiresAt,
          status: "active",
          lastError: null,
          updatedAt: new Date(),
        })
        .where(eq(schema.platformConnections.id, fresh.id));
      return next.accessToken;
    });
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
