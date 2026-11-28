import { ownerRoute } from "@/lib/api/owner";
import { audit, ownerMediaAsset } from "@/lib/services/admin";
import { storage } from "@/lib/storage";
import { contentDisposition, parseRange } from "@/lib/http-utils";

/**
 * Owner's read-only access to any user's media file (streamed, Range-capable). Opening a file is logged
 * once per view (the first byte range), not for every chunk a video player requests.
 */
export const GET = ownerRoute<{ assetId: string }>(async ({ req, user, params }) => {
  const asset = await ownerMediaAsset(params.assetId);
  const size = asset.sizeBytes;
  const range = parseRange(req.headers.get("range"), size);
  if (range === "unsatisfiable") return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
  if (!range || range.start === 0) await audit(user.id, "media_opened", asset.userId, { assetId: asset.id, filename: asset.filename });
  const headers: Record<string, string> = { "Content-Type": asset.mimeType, "Accept-Ranges": "bytes", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
  if (req.nextUrl.searchParams.get("download") === "1") headers["Content-Disposition"] = contentDisposition(asset.filename);
  if (range) {
    return new Response(await storage().stream(asset.storageKey, range), { status: 206, headers: { ...headers, "Content-Length": String(range.end - range.start + 1), "Content-Range": `bytes ${range.start}-${range.end}/${size}` } });
  }
  return new Response(await storage().stream(asset.storageKey), { headers: { ...headers, "Content-Length": String(size) } });
});
