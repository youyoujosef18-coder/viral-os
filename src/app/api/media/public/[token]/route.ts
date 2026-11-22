import { type NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { verifyMediaToken, storage } from "@/lib/storage";
import { serviceDb, schema } from "@/lib/db/client";
import { parseRange } from "@/lib/http-utils";

/**
 * Time-limited, HMAC-signed media URL for platforms that pull media (Instagram, TikTok PULL_FROM_URL).
 * Supports Range requests and streams from storage. No session: the signature is the authorization.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const key = verifyMediaToken(token);
  if (!key) return new Response("Link expired or invalid", { status: 403 });
  const [asset] = await serviceDb().select().from(schema.mediaAssets).where(eq(schema.mediaAssets.storageKey, key)).limit(1);
  if (!asset) return new Response("Not found", { status: 404 });
  const size = asset.sizeBytes;
  const headers = { "Content-Type": asset.mimeType, "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=300", "X-Content-Type-Options": "nosniff" };
  const range = parseRange(req.headers.get("range"), size);
  if (range === "unsatisfiable") return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
  if (range) {
    return new Response(await storage().stream(key, range), { status: 206, headers: { ...headers, "Content-Length": String(range.end - range.start + 1), "Content-Range": `bytes ${range.start}-${range.end}/${size}` } });
  }
  return new Response(await storage().stream(key), { headers: { ...headers, "Content-Length": String(size) } });
}
