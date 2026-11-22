import { z } from "zod";
import { route, parseBody } from "@/lib/api/handler";
import { refreshTrends } from "@/lib/services/trends";
import { ProviderError } from "@/lib/providers/http";
import { ApiError } from "@/lib/api/errors";

export const POST = route(
  async ({ req, user }) => {
    const b = await parseBody(req, z.object({ region: z.string().length(2).toUpperCase().default("US"), categoryId: z.string().max(5).optional() }));
    try {
      return await refreshTrends(user.id, b.region, b.categoryId);
    } catch (err) {
      if (err instanceof ProviderError) throw new ApiError(502, err.message, err.opts.code ?? "provider_error");
      throw err;
    }
  },
  { rateLimit: { bucket: "trends", limit: 30, windowSeconds: 3600 } },
);
