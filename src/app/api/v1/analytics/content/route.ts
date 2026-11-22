import { z } from "zod";
import { route, parseQuery } from "@/lib/api/handler";
import { getContentTable } from "@/lib/services/analytics";

export const GET = route(async ({ req, user }) => getContentTable(user.id, parseQuery(req, z.object({ platform: z.enum(["youtube", "tiktok", "instagram"]).optional() }))));
