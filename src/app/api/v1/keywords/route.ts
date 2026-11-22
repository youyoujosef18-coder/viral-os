import { route } from "@/lib/api/handler";
import { listKeywords } from "@/lib/services/keywords";

export const GET = route(async ({ req, user }) => {
  const sp = req.nextUrl.searchParams;
  return listKeywords(user.id, { listId: sp.get("listId") ?? undefined, seed: sp.get("seed") ?? undefined });
});
