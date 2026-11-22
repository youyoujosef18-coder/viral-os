import { eq } from "drizzle-orm";
import { z } from "zod";
import { route, parseBody } from "@/lib/api/handler";
import { schema, withUser } from "@/lib/db/client";
import { getImageProvider } from "@/lib/providers/ai/image";
import { saveUpload } from "@/lib/services/media";
import { analyzeImage } from "@/lib/services/thumbnails";
import { badRequest, notFound } from "@/lib/api/errors";

export const POST = route(
  async ({ req, user }) => {
    const b = await parseBody(req, z.object({ thumbnailId: z.string().uuid().optional(), prompt: z.string().trim().min(10).max(4000).optional() }));
    let prompt = b.prompt;
    let title = "Generated thumbnail";
    if (b.thumbnailId) {
      const [t] = await withUser(user.id, (tx) => tx.select().from(schema.thumbnails).where(eq(schema.thumbnails.id, b.thumbnailId!)));
      if (!t) throw notFound("Concept");
      prompt = t.prompt ?? prompt;
      title = t.title;
    }
    if (!prompt) throw badRequest("Provide a prompt or a concept.");
    const provider = getImageProvider();
    const png = await provider.generate(`${prompt}\nYouTube thumbnail composition, 16:9, bold focal subject, high contrast, no text, no logos, no real people's likeness.`, "1536x1024");
    const asset = await saveUpload(user.id, { name: `${title.replace(/[^\w-]+/g, "-").slice(0, 40)}.png`, type: "image/png", buffer: png }, { folder: "Thumbnails", tags: ["ai-generated"] });
    const analysis = await analyzeImage(png);
    const [row] = await withUser(user.id, (tx) => tx.insert(schema.thumbnails).values({ userId: user.id, assetId: asset.id, kind: "generated", title, prompt, analysis, concept: { provider: provider.name } }).returning());
    return row;
  },
  { rateLimit: { bucket: "image", limit: 30, windowSeconds: 3600 } },
);
