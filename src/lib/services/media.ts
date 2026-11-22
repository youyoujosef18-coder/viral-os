import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { eq } from "drizzle-orm";
import { schema, withUser } from "../db/client";
import { storage } from "../storage";
import { sha256 } from "../crypto";
import { ApiError, notFound } from "../api/errors";

export const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024; // 1 GB (direct, streaming uploads)
/** Multipart uploads are parsed in memory; larger files use the direct upload flow. */
export const MAX_MULTIPART_BYTES = 100 * 1024 * 1024;
const ALLOWED: Record<string, "video" | "image" | "audio" | "document"> = {
  "video/mp4": "video",
  "video/quicktime": "video",
  "video/webm": "video",
  "image/jpeg": "image",
  "image/png": "image",
  "image/webp": "image",
  "audio/mpeg": "audio",
  "audio/wav": "audio",
  "audio/x-wav": "audio",
  "application/pdf": "document",
  "text/plain": "document",
};

/** Validate by magic bytes as well as declared type (never trust the client's MIME alone). */
export function sniffMime(buf: Buffer): string | null {
  const hex = buf.subarray(0, 16).toString("hex");
  if (hex.startsWith("ffd8ff")) return "image/jpeg";
  if (hex.startsWith("89504e47")) return "image/png";
  if (buf.subarray(0, 4).toString() === "RIFF" && buf.subarray(8, 12).toString() === "WEBP") return "image/webp";
  if (buf.subarray(0, 4).toString() === "RIFF" && buf.subarray(8, 12).toString() === "WAVE") return "audio/wav";
  if (buf.subarray(4, 8).toString() === "ftyp") return buf.subarray(8, 10).toString() === "qt" ? "video/quicktime" : "video/mp4";
  if (hex.startsWith("1a45dfa3")) return "video/webm";
  if (hex.startsWith("494433") || hex.startsWith("fffb") || hex.startsWith("fff3")) return "audio/mpeg";
  if (hex.startsWith("25504446")) return "application/pdf";
  return null;
}

export function buildStorageKey(userId: string, filename: string) {
  const safeName = filename.replace(/[^\w.\- ]/g, "_").slice(0, 180) || "upload";
  return { key: `${userId}/${new Date().toISOString().slice(0, 7)}/${randomUUID()}-${safeName}`, safeName };
}

/** Step 1 of a direct upload: reserve a key under the user's prefix and return a signed PUT URL. */
export async function createDirectUpload(userId: string, file: { name: string; size: number }) {
  if (file.size <= 0) throw new ApiError(400, "File is empty", "bad_request");
  if (file.size > MAX_UPLOAD_BYTES) throw new ApiError(413, "File exceeds the 1 GB upload limit.", "too_large");
  const { key } = buildStorageKey(userId, file.name);
  const signed = await storage().createUploadUrl(key);
  if (!signed) return { mode: "multipart" as const };
  return { mode: "direct" as const, key, url: signed.url, token: signed.token };
}

/** Step 2: verify what actually landed in storage (size + magic bytes), then register the asset. */
export async function completeDirectUpload(userId: string, input: { key: string; filename: string; folder?: string; tags?: string[] }) {
  if (!input.key.startsWith(`${userId}/`)) throw new ApiError(403, "Upload key does not belong to you", "forbidden");
  const [existing] = await withUser(userId, (tx) => tx.select({ id: schema.mediaAssets.id }).from(schema.mediaAssets).where(eq(schema.mediaAssets.storageKey, input.key)).limit(1));
  if (existing) throw new ApiError(409, "This upload was already added to your library.", "conflict");
  const s = storage();
  const size = await s.size(input.key).catch(() => 0);
  if (!size) throw new ApiError(400, "Upload not found in storage. Try uploading again.", "bad_request");
  const head = await s.getRange(input.key, 0, Math.min(size, 4096) - 1);
  const mime = sniffMime(head);
  if (!mime || !ALLOWED[mime]) {
    await s.remove(input.key).catch(() => {});
    throw new ApiError(415, "Unsupported file type. Allowed: MP4, MOV, WebM, JPEG, PNG, WebP, MP3, WAV, PDF.", "unsupported_type");
  }
  const kind = ALLOWED[mime];
  let width: number | null = null, height: number | null = null;
  if (kind === "image") {
    const meta = await sharp(await s.get(input.key)).metadata();
    width = meta.width ?? null;
    height = meta.height ?? null;
  }
  const filename = input.filename.replace(/[^\w.\- ]/g, "_").slice(0, 180) || "upload";
  try {
    const [row] = await withUser(userId, (tx) =>
      tx.insert(schema.mediaAssets).values({ userId, kind, filename, mimeType: mime, sizeBytes: size, storageKey: input.key, width, height, folder: input.folder || "Uncategorized", tags: input.tags ?? [] }).returning(),
    );
    return row;
  } catch (err) {
    // Two "complete" calls for the same upload racing each other: the unique index lets only one through.
    const code = (err as { code?: string; cause?: { code?: string } }).cause?.code ?? (err as { code?: string }).code;
    if (code === "23505") throw new ApiError(409, "This upload was already added to your library.", "conflict");
    throw err;
  }
}

export async function saveUpload(userId: string, file: { name: string; type: string; buffer: Buffer }, opts: { folder?: string; tags?: string[] } = {}) {
  if (file.buffer.length === 0) throw new ApiError(400, "File is empty", "bad_request");
  if (file.buffer.length > MAX_UPLOAD_BYTES) throw new ApiError(413, "File exceeds the 1 GB upload limit.", "too_large");
  const sniffed = sniffMime(file.buffer);
  const mime = sniffed ?? (file.type === "text/plain" ? "text/plain" : null);
  if (!mime || !ALLOWED[mime]) throw new ApiError(415, `Unsupported file type${file.type ? ` (${file.type})` : ""}. Allowed: MP4, MOV, WebM, JPEG, PNG, WebP, MP3, WAV, PDF, TXT.`, "unsupported_type");
  const kind = ALLOWED[mime];
  let width: number | null = null, height: number | null = null;
  if (kind === "image") {
    const meta = await sharp(file.buffer).metadata();
    width = meta.width ?? null;
    height = meta.height ?? null;
  }
  const { key, safeName } = buildStorageKey(userId, file.name);
  await storage().put(key, file.buffer, mime);
  const [row] = await withUser(userId, (tx) =>
    tx.insert(schema.mediaAssets).values({ userId, kind, filename: safeName, mimeType: mime, sizeBytes: file.buffer.length, storageKey: key, width, height, checksum: sha256(file.buffer), folder: opts.folder || "Uncategorized", tags: opts.tags ?? [] }).returning(),
  );
  return row;
}

export async function deleteAsset(userId: string, assetId: string) {
  const [row] = await withUser(userId, (tx) => tx.delete(schema.mediaAssets).where(eq(schema.mediaAssets.id, assetId)).returning());
  if (!row) throw notFound("Media asset");
  await storage().remove(row.storageKey).catch(() => {});
}
