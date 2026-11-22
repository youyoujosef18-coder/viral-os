import { z } from "zod";
import { route, parseBody } from "@/lib/api/handler";
import { completeDirectUpload } from "@/lib/services/media";

export const POST = route(async ({ req, user }) => {
  const b = await parseBody(req, z.object({ key: z.string().min(1).max(500), filename: z.string().trim().min(1).max(255), folder: z.string().max(80).optional(), tags: z.array(z.string().max(40)).max(20).optional() }));
  return completeDirectUpload(user.id, b);
});
