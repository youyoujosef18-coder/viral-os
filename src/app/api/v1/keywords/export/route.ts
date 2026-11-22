import { route } from "@/lib/api/handler";
import { keywordsToCsv, listKeywords } from "@/lib/services/keywords";

export const GET = route(async ({ req, user }) => {
  const sp = req.nextUrl.searchParams;
  const rows = await listKeywords(user.id, { listId: sp.get("listId") ?? undefined, seed: sp.get("seed") ?? undefined });
  return new Response(keywordsToCsv(rows), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="viral-os-keywords-${new Date().toISOString().slice(0, 10)}.csv"` } });
});
