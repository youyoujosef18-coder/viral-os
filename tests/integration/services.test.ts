import { afterEach, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { generateStructured, setAIProviderForTests } from "@/lib/providers/ai";
import { analyzeImage } from "@/lib/services/thumbnails";
import { technicalAnalysis, ffmpegAvailable } from "@/lib/services/analyzer";
import { generateIdeas } from "@/lib/services/research";
import { startWorkflowRun } from "@/lib/services/automation";
import { schema, serviceDb, withUser } from "@/lib/db/client";
import { createUser } from "../helpers";

afterEach(() => setAIProviderForTests(null));

function scriptedAI(responses: string[]) {
  return { name: "mock", model: "mock-1", generateText: async () => responses.shift() ?? "{}" };
}

describe("AI structured output", () => {
  it("retries once with validation feedback, then succeeds", async () => {
    setAIProviderForTests(scriptedAI(['{"wrong": true}', '```json\n{"title":"ok","n":3}\n```']));
    const r = await generateStructured(z.object({ title: z.string(), n: z.number() }), { system: "s", prompt: "p", shapeHint: "{}" });
    expect(r.data).toEqual({ title: "ok", n: 3 });
  });
  it("fails loudly instead of returning invented data", async () => {
    setAIProviderForTests(scriptedAI(["nope", "still nope"]));
    await expect(generateStructured(z.object({ a: z.string() }), { system: "s", prompt: "p", shapeHint: "{}" })).rejects.toMatchObject({ status: 502 });
  });
  it("scores ideas with the deterministic weighted formula and labels them AI estimates", async () => {
    const user = await createUser();
    const f = (s: number) => ({ score: s, reason: "r" });
    const idea = { title: "Idea", angle: "a", format: "Short", type: "evergreen", confidence: "medium", confidenceReason: "no trend data", factors: { audienceDemand: f(80), trendMomentum: f(40), competition: f(30), creatorRelevance: f(90), productionDifficulty: f(20), potentialRetention: f(70), contentOriginality: f(60), monetizationPotential: f(50) } };
    setAIProviderForTests(scriptedAI([JSON.stringify({ ideas: [idea] })]));
    const r = await generateIdeas(user.id, { niche: "cooking", count: 1 });
    // .2*80 + .12*40 + .13*(100-30) + .15*90 + .08*(100-20) + .12*70 + .1*60 + .1*50 = 69.2
    expect(r.ideas[0].score).toBe(69);
    expect(r.ideas[0].scoreSource).toBe("ai_estimate");
  });
});

describe("thumbnail analysis (measured)", () => {
  it("scores a high-contrast focused image above a flat one", async () => {
    const flat = await sharp({ create: { width: 1280, height: 720, channels: 3, background: "#808080" } }).png().toBuffer();
    const svg = Buffer.from(`<svg width="1280" height="720" xmlns="http://www.w3.org/2000/svg"><rect width="1280" height="720" fill="#0b0b20"/><circle cx="427" cy="240" r="170" fill="#ffd400"/><rect x="760" y="420" width="400" height="160" fill="#ffffff"/></svg>`);
    const bold = await sharp(svg).png().toBuffer();
    const a = await analyzeImage(flat);
    const b = await analyzeImage(bold, { textColor: "#ffffff", backgroundColor: "#0b0b20", text: "Huge result" });
    expect(a.is16by9).toBe(true);
    expect(b.scores.contrast).toBeGreaterThan(a.scores.contrast);
    expect(b.scores.visualHierarchy).toBeGreaterThan(a.scores.visualHierarchy);
    expect(a.recommendations.length).toBeGreaterThan(0);
    expect(b.textChecks.every((t) => t.pass)).toBe(true);
  });
});

describe("video technical analysis (ffmpeg)", () => {
  it("measures duration, orientation and scene cuts on a real video", async () => {
    if (!(await ffmpegAvailable())) return;
    const dir = mkdtempSync(path.join(tmpdir(), "vos-test-"));
    const out = path.join(dir, "cuts.mp4");
    // 3 one-second solid-color segments => 2 hard cuts, vertical 360x640.
    execSync(`ffmpeg -v error -f lavfi -i color=c=red:s=360x640:d=1 -f lavfi -i color=c=blue:s=360x640:d=1 -f lavfi -i color=c=green:s=360x640:d=1 -filter_complex "[0][1][2]concat=n=3:v=1:a=0" -r 25 -pix_fmt yuv420p ${out}`);
    const r = await technicalAnalysis(readFileSync(out), "cuts.mp4");
    expect(r.available).toBe(true);
    if (!r.available) return;
    expect(r.orientation).toBe("vertical");
    expect(r.durationSeconds).toBeCloseTo(3, 0);
    expect(r.sceneChanges).toBe(2);
    expect(r.firstCutSeconds).toBeCloseTo(1, 0);
  });
});

describe("automation workflows", () => {
  it("runs inline when no queue is configured and logs each step", async () => {
    const user = await createUser();
    const [wf] = await withUser(user.id, (tx) => tx.insert(schema.workflows).values({ userId: user.id, name: "Ping", trigger: { type: "manual" }, steps: [{ type: "notify", title: "Hello from automation" }, { type: "sync_analytics" }] }).returning());
    const run = await startWorkflowRun(user.id, wf.id, "manual");
    const [done] = await serviceDb().select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, run.id));
    expect(done.status).toBe("succeeded");
    expect(done.log.map((l) => l.message)).toEqual(["Notification sent", "No active connected accounts to sync"]);
    const notes = await serviceDb().select().from(schema.notifications).where(eq(schema.notifications.userId, user.id));
    expect(notes.some((n) => n.title === "Hello from automation")).toBe(true);
  });
});
