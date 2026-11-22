import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { schema, withUser } from "../db/client";
import type { ScriptContent } from "../db/schema";
import { generatePlain, generateStructured } from "../providers/ai";
import { notFound } from "../api/errors";

export const scriptControlsSchema = z.object({
  topic: z.string().trim().min(3).max(500),
  platform: z.enum(["YouTube", "YouTube Shorts", "TikTok", "Instagram Reels", "Instagram Carousel"]),
  language: z.string().default("English"),
  audience: z.string().max(300).default("general audience"),
  tone: z.string().max(60).default("conversational"),
  lengthSeconds: z.number().int().min(10).max(3600).default(45),
  contentStyle: z.string().max(60).default("educational"),
  goal: z.string().max(60).default("grow audience"),
  hookType: z.enum(["curiosity", "storytelling", "problem-solution", "bold claim", "question", "viral pattern interrupt"]).default("curiosity"),
  ctaType: z.string().max(60).default("follow for more"),
  readingLevel: z.enum(["simple", "standard", "advanced"]).default("standard"),
  projectId: z.string().uuid().nullable().optional(),
});
export type ScriptControls = z.infer<typeof scriptControlsSchema>;

export const scriptContentSchema = z.object({
  hook: z.string(),
  scenes: z.array(z.object({
    title: z.string(),
    voiceover: z.string(),
    visual: z.string(),
    onScreenText: z.string(),
    broll: z.string().optional(),
    transition: z.string().optional(),
    durationSeconds: z.number().optional(),
  })).min(1),
  editingInstructions: z.string(),
  cta: z.string(),
  caption: z.string(),
  hashtags: z.array(z.string()),
  titleOptions: z.array(z.string()).min(1),
  description: z.string().optional(),
  pinnedComment: z.string().optional(),
  repurposingIdeas: z.array(z.string()).optional(),
});

const SHAPE = `{"hook":string,"scenes":[{"title":string,"voiceover":string,"visual":string,"onScreenText":string,"broll":string,"transition":string,"durationSeconds":number}],"editingInstructions":string,"cta":string,"caption":string,"hashtags":[string],"titleOptions":[string],"description":string,"pinnedComment":string,"repurposingIdeas":[string]}`;
const SYSTEM = "You are an expert scriptwriter for social video. Write natural, spoken-language scripts with strong retention structure. Content must be original and honest; no fabricated statistics or claims.";

function brief(c: ScriptControls) {
  return `Topic: ${c.topic}
Platform: ${c.platform}
Language: ${c.language} (write ALL output in this language)
Audience: ${c.audience}
Tone: ${c.tone}
Target length: ~${c.lengthSeconds} seconds of speech
Style: ${c.contentStyle}
Goal: ${c.goal}
Hook type: ${c.hookType}
CTA type: ${c.ctaType}
Reading level: ${c.readingLevel}
Provide 5 title options, 8-15 hashtags without '#', and 3 repurposing ideas.`;
}

export async function generateScript(userId: string, raw: unknown) {
  const controls = scriptControlsSchema.parse(raw);
  const { data, provider, model } = await generateStructured(scriptContentSchema, { system: SYSTEM, prompt: brief(controls), shapeHint: SHAPE, maxTokens: 6000 });
  const [row] = await withUser(userId, (tx) =>
    tx.insert(schema.scripts).values({ userId, projectId: controls.projectId ?? null, title: data.titleOptions[0] ?? controls.topic, platform: controls.platform, controls, content: data, generatedBy: `${provider}/${model}` }).returning(),
  );
  await withUser(userId, (tx) => tx.insert(schema.scriptVersions).values({ userId, scriptId: row.id, version: 1, content: data, reason: "generated" }));
  return row;
}

export async function generateVariations(userId: string, raw: unknown, count = 3) {
  const controls = scriptControlsSchema.parse(raw);
  const out = z.object({ variations: z.array(z.object({ label: z.string(), content: scriptContentSchema })).min(1).max(4) });
  const { data } = await generateStructured(out, {
    system: SYSTEM,
    prompt: `${brief(controls)}\nWrite ${count} meaningfully different variations (different hooks and structures). Label each (e.g. "Story-led").`,
    shapeHint: `{"variations":[{"label":string,"content":${SHAPE}}]}`,
    maxTokens: 12000,
  });
  return data.variations;
}

export const HOOK_TYPES = ["viral", "curiosity", "storytelling", "problem-solution"] as const;
export async function generateHooks(topic: string, platform: string, language: string) {
  const out = z.object({ hooks: z.array(z.object({ type: z.enum(HOOK_TYPES), text: z.string(), whyItWorks: z.string() })).min(4).max(20) });
  const { data } = await generateStructured(out, {
    system: SYSTEM,
    prompt: `Write 3 hooks of EACH type (viral, curiosity, storytelling, problem-solution) for: "${topic}" on ${platform}. Language: ${language}. Hooks must be truthful, not misleading.`,
    shapeHint: `{"hooks":[{"type":"viral|curiosity|storytelling|problem-solution","text":string,"whyItWorks":string}]}`,
  });
  return data.hooks;
}

export const assetKinds = ["titles", "descriptions", "hashtags", "captions", "pinned_comments", "ctas", "repurposing"] as const;
export async function generateAssets(kind: (typeof assetKinds)[number], topic: string, platform: string, language: string) {
  const out = z.object({ items: z.array(z.string()).min(1).max(20) });
  const { data } = await generateStructured(out, {
    system: SYSTEM,
    prompt: `Generate 8 ${kind.replace("_", " ")} for content about "${topic}" on ${platform}. Language: ${language}. ${kind === "hashtags" ? "Return hashtags without '#', mixing broad and niche." : ""}`,
    shapeHint: `{"items":[string]}`,
  });
  return data.items;
}

export const editOps = ["regenerate", "shorten", "expand", "change_tone", "improve_hook", "make_natural", "translate", "rewrite"] as const;
export type EditOp = (typeof editOps)[number];

export async function editText(op: EditOp, text: string, opts: { tone?: string; language?: string; instruction?: string; context?: string }) {
  const instructions: Record<EditOp, string> = {
    regenerate: "Write a fresh alternative version of this section that serves the same purpose.",
    shorten: "Make this about 40% shorter while keeping the key point.",
    expand: "Expand this with more specific detail and an example, about 50% longer.",
    change_tone: `Rewrite in a ${opts.tone ?? "more energetic"} tone.`,
    improve_hook: "Rewrite this as a stronger opening hook: pattern interrupt in the first 2 seconds, honest curiosity, no clickbait lies.",
    make_natural: "Make this sound like natural spoken language; contractions, short sentences, no corporate phrasing.",
    translate: `Translate into ${opts.language ?? "Spanish"}, adapting idioms naturally.`,
    rewrite: opts.instruction ? `Rewrite following this instruction: ${opts.instruction}` : "Rewrite this to be clearer and more engaging.",
  };
  const { text: result } = await generatePlain({
    system: `${SYSTEM}\nReturn ONLY the rewritten text, no quotes, no commentary.`,
    prompt: `${instructions[op]}\n${opts.context ? `Context (do not rewrite): ${opts.context}\n` : ""}Text:\n${text}`,
    maxTokens: 2000,
  });
  return result.trim();
}

export async function saveScript(userId: string, scriptId: string, content: ScriptContent, title?: string, reason = "edit") {
  return withUser(userId, async (tx) => {
    const [cur] = await tx.select().from(schema.scripts).where(eq(schema.scripts.id, scriptId));
    if (!cur) throw notFound("Script");
    const version = cur.version + 1;
    const [row] = await tx.update(schema.scripts).set({ content, title: title ?? cur.title, version, updatedAt: new Date() }).where(eq(schema.scripts.id, scriptId)).returning();
    // Autosave fires frequently: keep a version every save but cap history at 50.
    await tx.insert(schema.scriptVersions).values({ userId, scriptId, version, content, reason });
    const versions = await tx.select({ id: schema.scriptVersions.id }).from(schema.scriptVersions).where(eq(schema.scriptVersions.scriptId, scriptId)).orderBy(desc(schema.scriptVersions.version));
    for (const v of versions.slice(50)) await tx.delete(schema.scriptVersions).where(eq(schema.scriptVersions.id, v.id));
    return row;
  });
}

export function scriptToMarkdown(title: string, c: ScriptContent) {
  const lines = [`# ${title}`, "", `**Hook:** ${c.hook}`, ""];
  c.scenes.forEach((s, i) => {
    lines.push(`## Scene ${i + 1}: ${s.title}${s.durationSeconds ? ` (${s.durationSeconds}s)` : ""}`, "", `**Voiceover:** ${s.voiceover}`, `**Visual:** ${s.visual}`, `**On-screen text:** ${s.onScreenText}`);
    if (s.broll) lines.push(`**B-roll:** ${s.broll}`);
    if (s.transition) lines.push(`**Transition:** ${s.transition}`);
    lines.push("");
  });
  lines.push("## Editing instructions", c.editingInstructions, "", `**CTA:** ${c.cta}`, "", "## Caption", c.caption, "", `**Hashtags:** ${c.hashtags.map((h) => `#${h.replace(/^#/, "")}`).join(" ")}`, "", "## Title options", ...c.titleOptions.map((t) => `- ${t}`));
  if (c.description) lines.push("", "## Description", c.description);
  if (c.pinnedComment) lines.push("", "## Pinned comment", c.pinnedComment);
  if (c.repurposingIdeas?.length) lines.push("", "## Repurposing ideas", ...c.repurposingIdeas.map((t) => `- ${t}`));
  return lines.join("\n");
}
