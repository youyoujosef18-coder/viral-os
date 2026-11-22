import { eq } from "drizzle-orm";
import { route } from "@/lib/api/handler";
import { schema, withUser } from "@/lib/db/client";
import { notFound } from "@/lib/api/errors";

export const POST = route<{ id: string }>(async ({ user, params }) =>
  withUser(user.id, async (tx) => {
    const [p] = await tx.select().from(schema.contentProjects).where(eq(schema.contentProjects.id, params.id));
    if (!p) throw notFound("Project");
    const { id, createdAt, updatedAt, ...rest } = p;
    void id; void createdAt; void updatedAt;
    const [copy] = await tx.insert(schema.contentProjects).values({ ...rest, title: `${p.title} (copy)`, status: "idea" }).returning();
    return copy;
  }),
);
