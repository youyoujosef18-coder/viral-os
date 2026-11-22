import { eq } from "drizzle-orm";
import { route } from "@/lib/api/handler";
import { schema, withUser } from "@/lib/db/client";
import { storage } from "@/lib/storage";
import { notFound } from "@/lib/api/errors";
import { contentDisposition, parseRange } from "@/lib/http-utils";

/** Authenticated media streaming with Range support (video preview scrubbing). Never buffers whole files. */
export const GET = route<{ id: string }>(async ({ req, user, params }) => {
  const [asset] = await withUser(user.id, (tx) => tx.select().from(schema.mediaAssets).where(eq(schema.mediaAssets.id, params.id)));
  if (!asset) throw notFound("Media asset");
  const size = asset.sizeBytes;
  const headers: Record<string, string> = { "Content-Type": asset.mimeType, "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff" };
  if (req.nextUrl.searchParams.get("download") === "1") headers["Content-Disposition"] = contentDisposition(asset.filename);
  const range = parseRange(req.headers.get("range"), size);
  if (range === "unsatisfiable") return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
  if (range) {
    const body = await storage().stream(asset.storageKey, range);
    return new Response(body, { status: 206, headers: { ...headers, "Content-Length": String(range.end - range.start + 1), "Content-Range": `bytes ${range.start}-${range.end}/${size}` } });
  }
  return new Response(await storage().stream(asset.storageKey), { headers: { ...headers, "Content-Length": String(size) } });
});
