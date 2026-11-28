import { desc } from "drizzle-orm";
import { route, readJson } from "@/lib/api/handler";
import { schema, withUser } from "@/lib/db/client";
import { analyzeVideo } from "@/lib/services/analyzer";

export const GET = route(async ({ user }) => withUser(user.id, (tx) => tx.select().from(schema.videoAnalyses).orderBy(desc(schema.videoAnalyses.createdAt)).limit(100)));
export const POST = route(async ({ req, user }) => analyzeVideo(user.id, await readJson(req)), { rateLimit: { bucket: "analyze", limit: 40, windowSeconds: 3600 } });
