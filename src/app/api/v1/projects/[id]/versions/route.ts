import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { route, parseBody } from "@/lib/api/handler";
import { schema, withUser } from "@/lib/db/client";
import { notFound } from "@/lib/api/errors";

export const GET = route<{ id: string }>(async ({ user, params }) =>
  withUser(user.id, (tx) => tx.select().from(schema.projectVersions).where(eq(schema.projectVersions.projectId, params.id)).orderBy(desc(schema.projectVersions.createdAt)).limit(100)),
);

/** Restore a previous version. */
export const POST = route<{ id: string }>(async ({ req, user, params }) => {
  const { versionId } = await parseBody(req, z.object({ versionId: z.string().uuid() }));
  return withUser(user.id, async (tx) => {
    const [v] = await tx.select().from(schema.projectVersions).where(and(eq(schema.projectVersions.id, versionId), eq(schema.projectVersions.projectId, params.id)));
    if (!v) throw notFound("Version");
    const s = v.snapshot as Record<string, unknown>;
    const [cur] = await tx.select().from(schema.contentProjects).where(eq(schema.contentProjects.id, params.id));
    if (!cur) throw notFound("Project");
    await tx.insert(schema.projectVersions).values({ userId: user.id, projectId: cur.id, label: `Before restore ${new Date().toISOString()}`, snapshot: cur as unknown as Record<string, unknown> });
    const [row] = await tx
      .update(schema.contentProjects)
      .set({ title: String(s.title), description: (s.description as string) ?? null, status: s.status as "idea", format: String(s.format), platforms: s.platforms as string[], audience: (s.audience as string) ?? null, tone: (s.tone as string) ?? null, notes: (s.notes as string) ?? null, referenceLinks: (s.referenceLinks as string[]) ?? [], updatedAt: new Date() })
      .where(eq(schema.contentProjects.id, params.id))
      .returning();
    return row;
  });
});
