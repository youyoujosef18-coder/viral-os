import { z } from "zod";
import { ownerRoute } from "@/lib/api/owner";
import { listAudit } from "@/lib/services/admin";

export const GET = ownerRoute(async ({ req }) => {
  const userId = z.string().uuid().optional().parse(req.nextUrl.searchParams.get("userId") ?? undefined);
  return { items: await listAudit(200, userId) };
});
