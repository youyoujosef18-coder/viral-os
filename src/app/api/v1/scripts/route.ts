import { desc } from "drizzle-orm";
import { route } from "@/lib/api/handler";
import { schema, withUser } from "@/lib/db/client";
import { generateScript } from "@/lib/services/scripts";

export const GET = route(async ({ user }) =>
  withUser(user.id, (tx) => tx.select({ id: schema.scripts.id, title: schema.scripts.title, platform: schema.scripts.platform, projectId: schema.scripts.projectId, version: schema.scripts.version, updatedAt: schema.scripts.updatedAt, generatedBy: schema.scripts.generatedBy }).from(schema.scripts).orderBy(desc(schema.scripts.updatedAt)).limit(300)),
);

export const POST = route(async ({ req, user }) => generateScript(user.id, await req.json()), { rateLimit: { bucket: "ai", limit: 120, windowSeconds: 3600 } });
