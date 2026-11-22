import { route } from "@/lib/api/handler";
import { listTrends } from "@/lib/services/trends";

export const GET = route(async ({ req, user }) => {
  const sp = req.nextUrl.searchParams;
  return listTrends(user.id, { region: sp.get("region") ?? undefined, saved: sp.get("saved") === "1", q: sp.get("q") ?? undefined });
});
