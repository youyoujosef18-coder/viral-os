import { route } from "@/lib/api/handler";
import { ApiError } from "@/lib/api/errors";
import { LocalStorage, UploadTooLargeError, storage, verifyUploadToken } from "@/lib/storage";
import { MAX_UPLOAD_BYTES } from "@/lib/services/media";

/**
 * Direct upload target for local-disk storage (the counterpart of a cloud storage signed URL).
 * The body is streamed to disk with a hard size cap, never held in memory. The file is verified
 * (size + magic bytes) and registered afterwards by POST /api/v1/media/complete.
 */
export const PUT = route<{ token: string }>(
  async ({ req, user, params }) => {
    const key = verifyUploadToken(params.token);
    if (!key) throw new ApiError(403, "This upload link is invalid or expired. Start the upload again.", "forbidden");
    if (!key.startsWith(`${user.id}/`)) throw new ApiError(403, "This upload link belongs to another account.", "forbidden");
    const s = storage();
    if (!(s instanceof LocalStorage)) throw new ApiError(400, "Direct uploads go to cloud storage on this server.", "bad_request");
    const declared = Number(req.headers.get("content-length") ?? 0);
    if (declared > MAX_UPLOAD_BYTES) throw new ApiError(413, "File exceeds the 1 GB upload limit.", "too_large");
    if (!req.body) throw new ApiError(400, "The upload was empty.", "bad_request");
    try {
      const bytes = await s.putStream(key, req.body, MAX_UPLOAD_BYTES);
      return { ok: true, bytes };
    } catch (err) {
      if (err instanceof UploadTooLargeError) throw new ApiError(413, "File exceeds the 1 GB upload limit.", "too_large");
      if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new ApiError(409, "This upload link was already used. Start the upload again.", "conflict");
      throw err;
    }
  },
  { rateLimit: { bucket: "upload-put", limit: 120, windowSeconds: 3600 } },
);
