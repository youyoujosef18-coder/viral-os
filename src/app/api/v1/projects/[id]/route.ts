import { eq } from "drizzle-orm";
import { route, parsePatch } from "@/lib/api/handler";
import { schema, withUser } from "@/lib/db/client";
import { projectSchema } from "@/lib/validation/projects";
import { notFound } from "@/lib/api/errors";

export const GET = route<{ id: string }>(async ({ user, params }) =>
  withUser(user.id, async (tx) => {
    const [p] = await tx.select().from(schema.contentProjects).where(eq(schema.contentProjects.id, params.id));
    if (!p) throw notFound("Project");
    const scripts = await tx.select({ id: schema.scripts.id, title: schema.scripts.title, updatedAt: schema.scripts.updatedAt }).from(schema.scripts).where(eq(schema.scripts.projectId, p.id));
    const posts = await tx.select({ id: schema.posts.id, title: schema.posts.title, status: schema.posts.status }).from(schema.posts).where(eq(schema.posts.projectId, p.id));
    const versions = await tx.select({ id: schema.projectVersions.id, label: schema.projectVersions.label, createdAt: schema.projectVersions.createdAt }).from(schema.projectVersions).where(eq(schema.projectVersions.projectId, p.id));
    return { ...p, scripts, posts, versions: versions.sort((a, b) => +b.createdAt - +a.createdAt) };
  }),
);

export const PATCH = route<{ id: string }>(async ({ req, user, params }) => {
  const body = await parsePatch(req, projectSchema);
  return withUser(user.id, async (tx) => {
    const [cur] = await tx.select().from(schema.contentProjects).where(eq(schema.contentProjects.id, params.id));
    if (!cur) throw notFound("Project");
    // Snapshot the previous state on every save: lightweight version history.
    await tx.insert(schema.projectVersions).values({ userId: user.id, projectId: cur.id, label: `Before edit ${new Date().toISOString()}`, snapshot: cur as unknown as Record<string, unknown> });
    const { dueDate, ...rest } = body;
    const [row] = await tx.update(schema.contentProjects).set({ ...rest, ...(dueDate !== undefined ? { dueDate: dueDate ? new Date(dueDate) : null } : {}), updatedAt: new Date() }).where(eq(schema.contentProjects.id, params.id)).returning();
    return row;
  });
});

export const DELETE = route<{ id: string }>(async ({ user, params }) => {
  const rows = await withUser(user.id, (tx) => tx.delete(schema.contentProjects).where(eq(schema.contentProjects.id, params.id)).returning());
  if (!rows.length) throw notFound("Project");
  return { ok: true };
});
