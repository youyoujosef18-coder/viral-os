import OpenAI from "openai";
import { env } from "../../env";
import { NotConfiguredError, ApiError } from "../../api/errors";
import { recordUsage } from "../../usage";

export interface ImageProvider {
  name: string;
  generate(prompt: string, size: "1536x1024" | "1024x1024" | "1024x1536"): Promise<Buffer>;
}

let testImage: ImageProvider | null = null;
export function setImageProviderForTests(p: ImageProvider | null) {
  testImage = p;
}

export function getImageProvider(): ImageProvider {
  const e = env();
  if (testImage && e.NODE_ENV === "test") return testImage;
  if (e.IMAGE_PROVIDER === "openai" && e.OPENAI_API_KEY) {
    const client = new OpenAI({ apiKey: e.OPENAI_API_KEY, baseURL: e.OPENAI_BASE_URL });
    return {
      name: "openai",
      async generate(prompt, size) {
        try {
          const res = await client.images.generate({ model: e.OPENAI_IMAGE_MODEL, prompt, size, n: 1 });
          const b64 = res.data?.[0]?.b64_json;
          if (!b64) throw new Error("No image returned");
          await recordUsage("ai_call", 1, { detail: { provider: "openai", model: e.OPENAI_IMAGE_MODEL, type: "image" } });
          return Buffer.from(b64, "base64");
        } catch (err) {
          throw new ApiError(502, `Image generation failed: ${(err as Error).message}`, "image_provider_error");
        }
      },
    };
  }
  throw new NotConfiguredError("Image generation", "Set IMAGE_PROVIDER=openai and OPENAI_API_KEY. Thumbnail Lab concepts, analysis and uploads keep working without it.");
}

export function isImageConfigured() {
  try {
    getImageProvider();
    return true;
  } catch {
    return false;
  }
}
