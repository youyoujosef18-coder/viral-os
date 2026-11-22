import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { z } from "zod";
import { env } from "../../env";
import { NotConfiguredError, ApiError } from "../../api/errors";

export type GenerateParams = { system: string; prompt: string; temperature?: number; maxTokens?: number };

export interface AIProvider {
  name: string;
  model: string;
  generateText(p: GenerateParams): Promise<string>;
}

class AnthropicProvider implements AIProvider {
  name = "anthropic";
  private client: Anthropic;
  constructor(apiKey: string, public model: string) {
    this.client = new Anthropic({ apiKey });
  }
  async generateText({ system, prompt, maxTokens = 4096 }: GenerateParams) {
    // Current Claude models manage sampling themselves; the SDK no longer accepts `temperature`.
    const msg = await this.client.messages.create({
      model: this.model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: prompt }],
    });
    return msg.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  }
}

class OpenAIProvider implements AIProvider {
  name = "openai";
  private client: OpenAI;
  constructor(apiKey: string, public model: string, baseURL?: string) {
    this.client = new OpenAI({ apiKey, baseURL });
  }
  async generateText({ system, prompt, maxTokens = 4096 }: GenerateParams) {
    const res = await this.client.chat.completions.create({
      model: this.model,
      max_completion_tokens: maxTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
    });
    return res.choices[0]?.message?.content ?? "";
  }
}

let testProvider: AIProvider | null = null;
/** Tests inject a deterministic provider. Never available in production. */
export function setAIProviderForTests(p: AIProvider | null) {
  testProvider = p;
}

export const AI_SETUP =
  "Set AI_PROVIDER=anthropic with ANTHROPIC_API_KEY (or AI_PROVIDER=openai with OPENAI_API_KEY) in the server environment, then restart.";

export function getAIProvider(): AIProvider {
  const e = env();
  if (testProvider && e.NODE_ENV === "test") return testProvider;
  if (e.AI_PROVIDER === "anthropic" && e.ANTHROPIC_API_KEY) return new AnthropicProvider(e.ANTHROPIC_API_KEY, e.ANTHROPIC_MODEL);
  if (e.AI_PROVIDER === "openai" && e.OPENAI_API_KEY) return new OpenAIProvider(e.OPENAI_API_KEY, e.OPENAI_MODEL, e.OPENAI_BASE_URL);
  throw new NotConfiguredError("AI provider", AI_SETUP);
}

export function isAIConfigured() {
  try {
    getAIProvider();
    return true;
  } catch {
    return false;
  }
}

/** Extract the first JSON object/array from model output (tolerates code fences). */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = (fenced ? fenced[1] : text).trim();
  const start = candidate.search(/[[{]/);
  if (start === -1) throw new Error("No JSON found in model output");
  const open = candidate[start];
  const close = open === "{" ? "}" : "]";
  const end = candidate.lastIndexOf(close);
  return JSON.parse(candidate.slice(start, end + 1));
}

const HONESTY_RULES = `
Rules you must follow:
- Never invent statistics, search volumes, view counts, or claims about real accounts. If a number is not provided in the input, express it qualitatively or as a clearly labeled estimate.
- Scores you produce are AI assessments/estimates, not measured data.
- Produce original content. Never reproduce or closely paraphrase a specific creator's script, title, or copyrighted text.
- Do not recommend deceptive, misleading or clickbait-that-lies tactics.
- Respond ONLY with valid JSON matching the requested shape. No prose outside JSON.`;

/** Generate JSON validated by a Zod schema; retries once with the validation error as feedback. */
export async function generateStructured<S extends z.ZodType>(
  schema: S,
  p: GenerateParams & { shapeHint: string },
): Promise<{ data: z.infer<S>; provider: string; model: string }> {
  const ai = getAIProvider();
  const system = `${p.system}\n${HONESTY_RULES}\nJSON shape:\n${p.shapeHint}`;
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt = attempt === 0 ? p.prompt : `${p.prompt}\n\nYour previous answer was invalid: ${lastError}\nReturn corrected JSON only.`;
    let text: string;
    try {
      text = await ai.generateText({ ...p, system, prompt });
    } catch (err) {
      const status = (err as { status?: number }).status;
      throw new ApiError(status === 429 ? 429 : 502, `AI provider error: ${(err as Error).message}`, "ai_provider_error");
    }
    try {
      const parsed = schema.safeParse(extractJson(text));
      if (parsed.success) return { data: parsed.data, provider: ai.name, model: ai.model };
      lastError = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    } catch (err) {
      lastError = (err as Error).message;
    }
  }
  throw new ApiError(502, `The AI response could not be validated (${lastError}). Please try again.`, "ai_invalid_output");
}

export async function generatePlain(p: GenerateParams) {
  const ai = getAIProvider();
  try {
    const text = await ai.generateText(p);
    return { text, provider: ai.name, model: ai.model };
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(502, `AI provider error: ${(err as Error).message}`, "ai_provider_error");
  }
}
