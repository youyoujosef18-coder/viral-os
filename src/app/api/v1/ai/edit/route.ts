import { z } from "zod";
import { route, parseBody } from "@/lib/api/handler";
import { editOps, editText } from "@/lib/services/scripts";

export const POST = route(async ({ req }) => {
  const b = await parseBody(req, z.object({ op: z.enum(editOps), text: z.string().trim().min(1).max(20000), tone: z.string().max(60).optional(), language: z.string().max(40).optional(), instruction: z.string().max(500).optional(), context: z.string().max(4000).optional() }));
  return { text: await editText(b.op, b.text, b) };
}, { rateLimit: { bucket: "ai", limit: 120, windowSeconds: 3600 } });
