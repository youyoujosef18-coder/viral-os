import { eq } from "drizzle-orm";
import { route } from "@/lib/api/handler";
import { schema, withUser } from "@/lib/db/client";
import { CONTENT_FORMATS } from "@/lib/validation/projects";
import { notFound } from "@/lib/api/errors";

/** Turn an idea into a content project. */
export const POST = route<{ id: string }>(async ({ user, params }) =>
  withUser(user.id, async (tx) => {
    const [idea] = await tx.select().from(schema.ideas).where(eq(schema.ideas.id, params.id));
    if (!idea) throw notFound("Idea");
    const format = (CONTENT_FORMATS as readonly string[]).find((f) => f.toLowerCase() === (idea.format ?? "").toLowerCase()) ?? "Short-form video";
    const [project] = await tx.insert(schema.contentProjects).values({ userId: user.id, title: idea.title, description: idea.angle, status: "research", format }).returning();
    await tx.update(schema.ideas).set({ status: "in_production", projectId: project.id }).where(eq(schema.ideas.id, idea.id));
    return project;
  }),
);
