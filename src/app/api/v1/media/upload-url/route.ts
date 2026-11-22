import { z } from "zod";
import { route, parseBody } from "@/lib/api/handler";
import { createDirectUpload } from "@/lib/services/media";

/** Returns a signed direct-upload URL (Supabase Storage) or { mode: "multipart" } for local storage. */
export const POST = route(async ({ req, user }) => {
  const b = await parseBody(req, z.object({ filename: z.string().trim().min(1).max(255), size: z.number().int().positive() }));
  return createDirectUpload(user.id, { name: b.filename, size: b.size });
}, { rateLimit: { bucket: "upload", limit: 60, windowSeconds: 3600 } });
