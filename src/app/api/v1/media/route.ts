import { and, desc, eq, ilike, sql } from "drizzle-orm";
import { route } from "@/lib/api/handler";
import { schema, withUser } from "@/lib/db/client";
import { MAX_MULTIPART_BYTES, saveUpload } from "@/lib/services/media";
import { ApiError, badRequest } from "@/lib/api/errors";

export const GET = route(async ({ req, user }) => {
  const sp = req.nextUrl.searchParams;
  const kind = sp.get("kind");
  const q = sp.get("q");
  const folder = sp.get("folder");
  const page = Math.max(1, Number(sp.get("page") ?? 1));
  const pageSize = Math.min(100, Math.max(1, Number(sp.get("pageSize") ?? 40)));
  return withUser(user.id, async (tx) => {
    const conds = [];
    if (kind && ["video", "image", "audio", "document"].includes(kind)) conds.push(eq(schema.mediaAssets.kind, kind as "video"));
    if (q) conds.push(ilike(schema.mediaAssets.filename, `%${q.replace(/[%_]/g, "")}%`));
    if (folder) conds.push(eq(schema.mediaAssets.folder, folder));
    const where = conds.length ? and(...conds) : undefined;
    const items = await tx.select().from(schema.mediaAssets).where(where).orderBy(desc(schema.mediaAssets.createdAt)).limit(pageSize).offset((page - 1) * pageSize);
    const [{ count }] = await tx.select({ count: sql<number>`count(*)::int` }).from(schema.mediaAssets).where(where);
    const folders = await tx.selectDistinct({ folder: schema.mediaAssets.folder }).from(schema.mediaAssets);
    return { items, total: count, page, pageSize, folders: folders.map((f) => f.folder) };
  });
});

export const POST = route(
  async ({ req, user }) => {
    // Multipart bodies are parsed in memory, so this route only takes small files. The upload dialog
    // uses the streaming direct-upload flow (upload-url → PUT → complete) for everything.
    if (Number(req.headers.get("content-length") ?? 0) > MAX_MULTIPART_BYTES) throw new ApiError(413, "Files over 100 MB must use the direct upload (the Upload dialog does this automatically).", "too_large");
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw badRequest("Attach a file in the 'file' field.");
    const folder = String(form.get("folder") ?? "") || undefined;
    const tags = String(form.get("tags") ?? "").split(",").map((t) => t.trim()).filter(Boolean).slice(0, 20);
    return saveUpload(user.id, { name: file.name, type: file.type, buffer: Buffer.from(await file.arrayBuffer()) }, { folder, tags });
  },
  { rateLimit: { bucket: "upload", limit: 60, windowSeconds: 3600 } },
);
