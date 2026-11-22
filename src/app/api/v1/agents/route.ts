import { desc } from "drizzle-orm";
import { z } from "zod";
import { route, parseBody } from "@/lib/api/handler";
import { schema, withUser } from "@/lib/db/client";
import { AGENT_TEMPLATES } from "@/lib/services/agents";

const agentSchema = z.object({
  name: z.string().trim().min(1).max(80),
  role: z.string().trim().min(1).max(60),
  instructions: z.string().trim().min(20, "Give the agent at least a sentence of instructions").max(8000),
  outputFormat: z.enum(["markdown", "plain text", "bullet list", "JSON"]).default("markdown"),
  temperature: z.number().min(0).max(1).default(0.7),
  enabled: z.boolean().default(true),
});

export const GET = route(async ({ user }) => {
  const agents = await withUser(user.id, (tx) => tx.select().from(schema.agents).orderBy(desc(schema.agents.createdAt)));
  return { agents, templates: AGENT_TEMPLATES };
});

export const POST = route(async ({ req, user }) => {
  const b = await parseBody(req, agentSchema);
  const [row] = await withUser(user.id, (tx) => tx.insert(schema.agents).values({ userId: user.id, ...b }).returning());
  return row;
});
