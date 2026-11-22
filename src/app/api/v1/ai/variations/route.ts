import { route } from "@/lib/api/handler";
import { generateVariations } from "@/lib/services/scripts";

export const POST = route(async ({ req }) => ({ variations: await generateVariations("", await req.json()) }), { rateLimit: { bucket: "ai", limit: 120, windowSeconds: 3600 } });
