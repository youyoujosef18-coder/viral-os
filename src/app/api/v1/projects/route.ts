import { desc, eq } from "drizzle-orm";
import { route, parseBody } from "@/lib/api/handler";
import { schema, withUser } from "@/lib/db/client";
import { projectSchema } from "@/lib/validation/projects";
import { logActivity } from "@/lib/services/activity";

export const GET = route(async ({ req, user }) => {
  const status = req.nextUrl.searchParams.get("status");
  return withUser(user.id, (tx) =>
    tx.select().from(schema.contentProjects).where(status ? eq(schema.contentProjects.status, status as "idea") : undefined).orderBy(desc(schema.contentProjects.updatedAt)).limit(500),
  );
});

export const POST = route(async ({ req, user }) => {
  const body = await parseBody(req, projectSchema);
  const [row] = await withUser(user.id, (tx) => tx.insert(schema.contentProjects).values({ ...body, userId: user.id, dueDate: body.dueDate ? new Date(body.dueDate) : null }).returning());
  await logActivity(user.id, { action: "project.created", entityType: "project", entityId: row.id, summary: `Created project "${row.title}"` });
  return row;
});
