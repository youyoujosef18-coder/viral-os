import { route } from "@/lib/api/handler";
import { getConnectionForUser } from "@/lib/services/connections";
import { syncConnection } from "@/lib/services/analytics";
import { enqueueSync } from "@/lib/queue/queues";
import { ApiError, notFound } from "@/lib/api/errors";
import { ProviderError } from "@/lib/providers/http";

export const POST = route<{ id: string }>(
  async ({ user, params }) => {
    const conn = await getConnectionForUser(user.id, params.id);
    if (!conn) throw notFound("Connection");
    if (await enqueueSync({ kind: "connection", connectionId: conn.id, userId: user.id })) return { queued: true };
    try {
      return { queued: false, ...(await syncConnection(conn.id)) };
    } catch (err) {
      if (err instanceof ProviderError) throw new ApiError(502, err.message, err.opts.code ?? "provider_error");
      throw err;
    }
  },
  { rateLimit: { bucket: "sync", limit: 20, windowSeconds: 3600 } },
);
