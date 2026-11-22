import { route } from "@/lib/api/handler";
import { analyzeKeywordCompetition } from "@/lib/services/keywords";
import { ProviderError } from "@/lib/providers/http";
import { ApiError } from "@/lib/api/errors";

export const POST = route<{ id: string }>(
  async ({ user, params }) => {
    try {
      return await analyzeKeywordCompetition(user.id, params.id);
    } catch (err) {
      if (err instanceof ProviderError) throw new ApiError(502, err.message, err.opts.code ?? "provider_error");
      throw err;
    }
  },
  // search.list has its own bucket of 100 calls/day per project; cap per user so one user can't exhaust it.
  { rateLimit: { bucket: "kw-analyze", limit: 40, windowSeconds: 86400 } },
);
