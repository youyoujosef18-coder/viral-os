import { route, readJson } from "@/lib/api/handler";
import { addManualClip } from "@/lib/services/youtube-clips";

/** Add a clip by hand (start/end in seconds) to a YouTube clip job. */
export const POST = route<{ id: string }>(async ({ req, user, params }) => addManualClip(user.id, params.id, await readJson(req)), { rateLimit: { bucket: "clips-manual", limit: 300, windowSeconds: 3600 } });
