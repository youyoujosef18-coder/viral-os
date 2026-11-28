import { route, readJson } from "@/lib/api/handler";
import { generateVariations } from "@/lib/services/scripts";

export const POST = route(async ({ req }) => ({ variations: await generateVariations("", await readJson(req)) }), { rateLimit: { bucket: "ai", limit: 120, windowSeconds: 3600 } });
