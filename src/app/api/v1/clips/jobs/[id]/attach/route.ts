import { z } from "zod";
import { parseBody, route } from "@/lib/api/handler";
import { attachOriginal } from "@/lib/services/youtube-clips";

/** Attach your own original file to a YouTube clip job (only for videos on your connected channel). */
export const POST = route<{ id: string }>(async ({ req, user, params }) => {
  const { assetId } = await parseBody(req, z.object({ assetId: z.string().uuid() }));
  return attachOriginal(user.id, params.id, assetId);
});
