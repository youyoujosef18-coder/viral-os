import { route } from "@/lib/api/handler";
import { refreshCompetitor } from "@/lib/services/competitors";
import { ProviderError } from "@/lib/providers/http";
import { ApiError } from "@/lib/api/errors";

export const POST = route<{ id: string }>(async ({ user, params }) => {
  try {
    return await refreshCompetitor(user.id, params.id);
  } catch (err) {
    if (err instanceof ProviderError) throw new ApiError(502, err.message, err.opts.code ?? "provider_error");
    throw err;
  }
}, { rateLimit: { bucket: "competitor-refresh", limit: 60, windowSeconds: 3600 } });
