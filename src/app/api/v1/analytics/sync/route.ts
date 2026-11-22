import { route } from "@/lib/api/handler";
import { syncAllForUser, syncConnection } from "@/lib/services/analytics";
import { enqueueSync } from "@/lib/queue/queues";

export const POST = route(async ({ user }) => {
  const conns = await syncAllForUser(user.id);
  const results: { connectionId: string; ok: boolean; queued?: boolean; error?: string }[] = [];
  for (const c of conns) {
    if (await enqueueSync({ kind: "connection", connectionId: c.id, userId: user.id })) {
      results.push({ connectionId: c.id, ok: true, queued: true });
      continue;
    }
    try {
      await syncConnection(c.id);
      results.push({ connectionId: c.id, ok: true });
    } catch (err) {
      results.push({ connectionId: c.id, ok: false, error: (err as Error).message });
    }
  }
  return { results };
}, { rateLimit: { bucket: "sync", limit: 20, windowSeconds: 3600 } });
