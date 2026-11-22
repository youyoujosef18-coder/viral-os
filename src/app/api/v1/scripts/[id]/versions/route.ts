import { desc, eq } from "drizzle-orm";
import { route } from "@/lib/api/handler";
import { schema, withUser } from "@/lib/db/client";

export const GET = route<{ id: string }>(async ({ user, params }) =>
  withUser(user.id, (tx) => tx.select().from(schema.scriptVersions).where(eq(schema.scriptVersions.scriptId, params.id)).orderBy(desc(schema.scriptVersions.version)).limit(50)),
);
