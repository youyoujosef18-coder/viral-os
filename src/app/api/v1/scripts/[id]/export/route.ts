import { eq } from "drizzle-orm";
import { route } from "@/lib/api/handler";
import { schema, withUser } from "@/lib/db/client";
import { scriptToMarkdown } from "@/lib/services/scripts";
import { notFound } from "@/lib/api/errors";

export const GET = route<{ id: string }>(async ({ req, user, params }) => {
  const [s] = await withUser(user.id, (tx) => tx.select().from(schema.scripts).where(eq(schema.scripts.id, params.id)));
  if (!s) throw notFound("Script");
  const format = req.nextUrl.searchParams.get("format") ?? "md";
  const base = s.title.replace(/[^\w-]+/g, "-").slice(0, 60) || "script";
  if (format === "json") return new Response(JSON.stringify({ title: s.title, platform: s.platform, controls: s.controls, content: s.content }, null, 2), { headers: { "Content-Type": "application/json", "Content-Disposition": `attachment; filename="${base}.json"` } });
  const md = scriptToMarkdown(s.title, s.content);
  const body = format === "txt" ? md.replace(/[#*]/g, "") : md;
  return new Response(body, { headers: { "Content-Type": format === "txt" ? "text/plain; charset=utf-8" : "text/markdown; charset=utf-8", "Content-Disposition": `attachment; filename="${base}.${format === "txt" ? "txt" : "md"}"` } });
});
