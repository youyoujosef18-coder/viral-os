import { z } from "zod";
import { route, parseBody } from "@/lib/api/handler";
import { addCompetitor, listCompetitors } from "@/lib/services/competitors";
import { ProviderError } from "@/lib/providers/http";
import { ApiError } from "@/lib/api/errors";

export const GET = route(async ({ user }) => listCompetitors(user.id));
export const POST = route(async ({ req, user }) => {
  const b = await parseBody(req, z.object({ platform: z.enum(["youtube", "tiktok", "instagram"]), identifier: z.string().trim().min(2).max(300), name: z.string().trim().max(120).optional() }));
  try {
    return await addCompetitor(user.id, b);
  } catch (err) {
    if (err instanceof ProviderError) throw new ApiError(502, err.message, err.opts.code ?? "provider_error");
    throw err;
  }
});
