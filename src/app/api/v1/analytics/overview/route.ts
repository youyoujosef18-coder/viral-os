import { z } from "zod";
import { route, parseQuery } from "@/lib/api/handler";
import { getOverview } from "@/lib/services/analytics";

const q = z.object({ days: z.coerce.number().int().min(1).max(365).default(30), platform: z.enum(["youtube", "tiktok", "instagram"]).optional(), connectionId: z.string().uuid().optional() });

export const GET = route(async ({ req, user }) => getOverview(user.id, parseQuery(req, q)));
