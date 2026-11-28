import { ownerRoute } from "@/lib/api/owner";
import { listUsers } from "@/lib/services/admin";

export const GET = ownerRoute(async ({ req }) => listUsers(req.nextUrl.searchParams.get("q") ?? undefined));
