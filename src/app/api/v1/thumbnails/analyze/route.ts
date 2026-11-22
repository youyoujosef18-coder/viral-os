import { eq } from "drizzle-orm";
import { z } from "zod";
import { route, parseBody } from "@/lib/api/handler";
import { schema, withUser } from "@/lib/db/client";
import { storage } from "@/lib/storage";
import { analyzeImage } from "@/lib/services/thumbnails";
import { ApiError, notFound } from "@/lib/api/errors";

const hex = z.string().regex(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i, "Use a hex color like #ffffff");

export const POST = route(async ({ req, user }) => {
  const b = await parseBody(req, z.object({ assetId: z.string().uuid(), overlayText: z.string().max(120).optional(), textColor: hex.optional(), backgroundColor: hex.optional(), title: z.string().max(200).optional() }));
  const [asset] = await withUser(user.id, (tx) => tx.select().from(schema.mediaAssets).where(eq(schema.mediaAssets.id, b.assetId)));
  if (!asset) throw notFound("Image");
  if (asset.kind !== "image") throw new ApiError(400, "Select an image file to analyze.", "bad_request");
  const analysis = await analyzeImage(await storage().get(asset.storageKey), { text: b.overlayText, textColor: b.textColor, backgroundColor: b.backgroundColor });
  const [row] = await withUser(user.id, (tx) => tx.insert(schema.thumbnails).values({ userId: user.id, assetId: asset.id, kind: "upload", title: b.title || asset.filename, overlayText: b.overlayText ?? null, analysis }).returning());
  return row;
});
