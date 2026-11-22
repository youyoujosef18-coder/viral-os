import { ilike, or } from "drizzle-orm";
import { route } from "@/lib/api/handler";
import { schema, withUser } from "@/lib/db/client";

/** Global search across the user's workspace (RLS scoped). */
export const GET = route(async ({ req, user }) => {
  const q = (req.nextUrl.searchParams.get("q") ?? "").trim().replace(/[%_]/g, "");
  if (q.length < 2) return { results: [] };
  const like = `%${q}%`;
  return withUser(user.id, async (tx) => {
    const [projects, scripts, ideas, posts, keywords, media, competitors] = await Promise.all([
      tx.select({ id: schema.contentProjects.id, title: schema.contentProjects.title }).from(schema.contentProjects).where(or(ilike(schema.contentProjects.title, like), ilike(schema.contentProjects.description, like))).limit(5),
      tx.select({ id: schema.scripts.id, title: schema.scripts.title }).from(schema.scripts).where(ilike(schema.scripts.title, like)).limit(5),
      tx.select({ id: schema.ideas.id, title: schema.ideas.title }).from(schema.ideas).where(ilike(schema.ideas.title, like)).limit(5),
      tx.select({ id: schema.posts.id, title: schema.posts.title }).from(schema.posts).where(ilike(schema.posts.title, like)).limit(5),
      tx.select({ id: schema.keywords.id, title: schema.keywords.keyword }).from(schema.keywords).where(ilike(schema.keywords.keyword, like)).limit(5),
      tx.select({ id: schema.mediaAssets.id, title: schema.mediaAssets.filename }).from(schema.mediaAssets).where(ilike(schema.mediaAssets.filename, like)).limit(5),
      tx.select({ id: schema.competitors.id, title: schema.competitors.name }).from(schema.competitors).where(ilike(schema.competitors.name, like)).limit(5),
    ]);
    const tag = <T extends { id: string; title: string }>(rows: T[], type: string, href: (r: T) => string) => rows.map((r) => ({ ...r, type, href: href(r) }));
    return {
      results: [
        ...tag(projects, "Project", (r) => `/studio?project=${r.id}`),
        ...tag(scripts, "Script", (r) => `/scripts?id=${r.id}`),
        ...tag(ideas, "Idea", () => `/research?tab=ideas`),
        ...tag(posts, "Post", (r) => `/publishing?post=${r.id}`),
        ...tag(keywords, "Keyword", () => `/keywords`),
        ...tag(media, "Media", () => `/media`),
        ...tag(competitors, "Competitor", (r) => `/competitors?id=${r.id}`),
      ],
    };
  });
});
