/**
 * End-to-end clipping on REAL videos (run `npm run fixtures:fetch` first):
 *  - Sintel excerpt with its real English WebVTT captions (dialogue-driven clipping + burned captions)
 *  - Big Buck Bunny excerpt (no dialogue: signal-only clipping)
 * Everything runs for real: Postgres + RLS, storage, ffprobe/ffmpeg analysis and rendering.
 * Only the AI and speech-to-text providers are replaced with deterministic test doubles.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { schema, serviceDb, withUser } from "@/lib/db/client";
import { storage } from "@/lib/storage";
import { saveUpload } from "@/lib/services/media";
import { createClipJob, createPostFromClip, getClipJob, runClipJob, renderClipRow, updateClip, reconcileClips } from "@/lib/services/clipping";
import { parseCaptions, setTranscriberForTests } from "@/lib/clipping/transcript";
import { probe } from "@/lib/clipping/signals";
import { renderClip, DEFAULT_RENDER } from "@/lib/clipping/render";
import { setAIProviderForTests } from "@/lib/providers/ai";
import { resetEnvCache } from "@/lib/env";
import { createUser } from "../helpers";

const run = promisify(execFile);
const FIX = path.join(process.cwd(), "tests/fixtures/real");
const SINTEL = path.join(FIX, "sintel-short.mp4");
const VTT = path.join(FIX, "sintel-en.vtt");
const BBB = path.join(FIX, "bbb.mp4");
const haveFixtures = [SINTEL, VTT, BBB].every(existsSync);
if (!haveFixtures && process.env.REQUIRE_REAL_VIDEOS === "1") throw new Error("Real test videos missing: run `npm run fixtures:fetch`");

async function uploadReal(userId: string, file: string) {
  return saveUpload(userId, { name: path.basename(file), type: "video/mp4", buffer: readFileSync(file) });
}

async function assetFile(assetId: string) {
  const [a] = await serviceDb().select().from(schema.mediaAssets).where(eq(schema.mediaAssets.id, assetId));
  const dir = await mkdtemp(path.join(tmpdir(), "vos-out-"));
  const file = path.join(dir, a.filename);
  await storage().downloadToFile(a.storageKey, file);
  return { asset: a, file };
}

/** Integrated loudness (LUFS) measured with ffmpeg's EBU R128 filter. */
async function measureLufs(file: string) {
  const { stderr } = await run("ffmpeg", ["-hide_banner", "-nostats", "-i", file, "-af", "ebur128", "-f", "null", "-"], { maxBuffer: 50 * 1024 * 1024 });
  const m = /Integrated loudness:\s*\n\s*I:\s*(-?[\d.]+) LUFS/.exec(stderr);
  return m ? Number(m[1]) : NaN;
}

async function frameAt(file: string, t: number) {
  const out = path.join(await mkdtemp(path.join(tmpdir(), "vos-frame-")), "f.png");
  await run("ffmpeg", ["-v", "error", "-y", "-ss", String(t), "-i", file, "-frames:v", "1", out]);
  return sharp(out).raw().toBuffer({ resolveWithObject: true });
}

function regionDiff(a: Buffer, b: Buffer, width: number, y0: number, y1: number, channels: number) {
  let sum = 0, n = 0;
  for (let y = y0; y < y1; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * channels;
    sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    n += 3;
  }
  return sum / n;
}

afterEach(() => {
  setAIProviderForTests(null);
  setTranscriberForTests(null);
});

describe.skipIf(!haveFixtures)("clipping real videos", () => {
  it("clips Sintel along its real dialogue, renders vertical 720×1280 clips with audio at about -14 LUFS", async () => {
    const user = await createUser();
    const src = await uploadReal(user.id, SINTEL);
    const cues = parseCaptions(readFileSync(VTT, "utf8"));
    const job = await createClipJob(user.id, { assetId: src.id, transcriptMode: "captions", captionsText: readFileSync(VTT, "utf8"), minSeconds: 8, maxSeconds: 25, count: 3, autoRender: true });
    expect(job.status).toBe("queued");

    expect(await runClipJob(job.id)).toBe("completed");
    const done = await getClipJob(user.id, job.id);
    expect(done.status).toBe("completed");
    expect(done.progress).toBe(100);
    expect((done.source as { duration: number }).duration).toBe(120);
    expect(done.clips).toHaveLength(3);
    expect(done.notes.join(" ")).toMatch(/No AI provider/); // honest about how titles/ranking were made

    for (const c of done.clips) {
      // Every clip starts just before a real caption cue and ends just after one: no mid-sentence cuts.
      expect(cues.some((q) => Math.abs(q.start - 0.25 - c.startSec) < 0.02)).toBe(true);
      expect(cues.some((q) => Math.abs(q.end + 0.4 - c.endSec) < 0.02)).toBe(true);
      expect(c.endSec - c.startSec).toBeGreaterThanOrEqual(8);
      expect(c.endSec - c.startSec).toBeLessThanOrEqual(25);
      expect(c.transcript.length).toBeGreaterThan(10);
      expect(c.title.length).toBeGreaterThan(3);
      expect(c.aiScore).toBeNull();
      expect(c.computedScore).toBeGreaterThan(0);
      expect(c.status).toBe("ready");

      const { asset, file } = await assetFile(c.assetId!);
      expect(asset.folder).toBe("Clips");
      const info = await probe(file);
      expect(info.width).toBe(720);
      expect(info.height).toBe(1280);
      expect(info.hasAudio).toBe(true);
      expect(Math.abs(info.duration - (c.endSec - c.startSec))).toBeLessThan(0.25);
      const lufs = await measureLufs(file);
      expect(lufs).toBeGreaterThan(-17.5);
      expect(lufs).toBeLessThan(-10.5);
      expect(c.thumbnailAssetId).toBeTruthy();
      expect((c.renderInfo as { reframe: string; captions: boolean }).reframe).toBe("blur");
      expect((c.renderInfo as { captions: boolean }).captions).toBe(true);
    }
    // Ranked best-first, no overlapping clips.
    const sorted = [...done.clips].sort((a, b) => a.startSec - b.startSec);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i].startSec).toBeGreaterThanOrEqual(sorted[i - 1].endSec - 0.15 * (sorted[i].endSec - sorted[i].startSec));
  }, 300_000);

  it("burns the real caption text into the frame (pixel comparison with and without captions)", async () => {
    const info = await probe(SINTEL);
    const cues = parseCaptions(readFileSync(VTT, "utf8"));
    const cue = cues[0]; // 18.7–21.5 "This blade has a dark past."
    const start = cue.start - 0.25, end = cue.end + 0.4;
    const rel = [{ start: cue.start - start, end: cue.end - start, text: cue.text }];
    const withCaps = await renderClip(SINTEL, info, start, end, { ...DEFAULT_RENDER, captions: true }, rel);
    const noCaps = await renderClip(SINTEL, info, start, end, { ...DEFAULT_RENDER, captions: false }, null);
    try {
      const a = await frameAt(withCaps.file, 1.0);
      const b = await frameAt(noCaps.file, 1.0);
      const { width, height, channels } = a.info;
      const captionBand = regionDiff(a.data, b.data, width, Math.round(height * 0.62), Math.round(height * 0.86), channels);
      const topBand = regionDiff(a.data, b.data, width, 0, Math.round(height * 0.3), channels);
      expect(captionBand).toBeGreaterThan(4); // text pixels differ where captions sit
      expect(topBand).toBeLessThan(1.5); // the rest of the picture is identical
    } finally {
      await withCaps.cleanup();
      await noCaps.cleanup();
    }
  }, 120_000);

  it("clips Big Buck Bunny (no dialogue) from measured pauses and scene cuts, without captions", async () => {
    const user = await createUser();
    const src = await uploadReal(user.id, BBB);
    const job = await createClipJob(user.id, { assetId: src.id, transcriptMode: "none", minSeconds: 8, maxSeconds: 20, count: 3, autoRender: true, render: { ...DEFAULT_RENDER, aspect: "1:1" } });
    expect(await runClipJob(job.id)).toBe("completed");
    const done = await getClipJob(user.id, job.id);
    const sig = done.signals as { silences: { start: number; end: number }[]; cuts: number[] };
    expect(sig.cuts.length).toBeGreaterThan(2);
    expect(done.notes.join(" ")).toMatch(/No transcript/);
    expect(done.clips.length).toBeGreaterThanOrEqual(2);
    for (const c of done.clips) {
      const boundaries = [0, ...sig.silences.map((s) => s.end), ...sig.cuts];
      expect(boundaries.some((b) => Math.abs(b - c.startSec) < 0.02)).toBe(true);
      expect(c.endSec - c.startSec).toBeGreaterThanOrEqual(8);
      expect(c.endSec - c.startSec).toBeLessThanOrEqual(20);
      expect(c.transcript).toBe("");
      expect((c.renderInfo as { captions: boolean }).captions).toBe(false);
      const { file } = await assetFile(c.assetId!);
      const info = await probe(file);
      expect([info.width, info.height]).toEqual([720, 720]);
    }
  }, 300_000);

  it("renders footage that has no audio track", async () => {
    const user = await createUser();
    const silentFile = path.join(await mkdtemp(path.join(tmpdir(), "vos-mute-")), "bbb-mute.mp4");
    await run("ffmpeg", ["-v", "error", "-y", "-i", BBB, "-an", "-c:v", "copy", silentFile]);
    const src = await uploadReal(user.id, silentFile);
    const job = await createClipJob(user.id, { assetId: src.id, minSeconds: 8, maxSeconds: 15, count: 1 });
    expect(await runClipJob(job.id)).toBe("completed");
    const done = await getClipJob(user.id, job.id);
    const { file } = await assetFile(done.clips[0].assetId!);
    const info = await probe(file);
    expect(info.hasAudio).toBe(false);
    expect(info.height).toBe(1280);
  }, 180_000);

  it("uses AI titles and blends the AI score with the measured score when a provider is configured", async () => {
    const user = await createUser();
    const src = await uploadReal(user.id, SINTEL);
    let seenPrompt = "";
    setAIProviderForTests({
      name: "test-ai",
      model: "test-model",
      generateText: async ({ prompt }) => {
        seenPrompt = prompt;
        const n = (prompt.match(/^#\d+ /gm) ?? []).length;
        return JSON.stringify({ clips: Array.from({ length: n }, (_, i) => ({ index: i, score: i === n - 1 ? 99 : 10, title: `AI title ${i}`, hook: "hook", caption: "caption", hashtags: ["#sintel", "blender"], reason: "test" })) });
      },
    });
    const job = await createClipJob(user.id, { assetId: src.id, transcriptMode: "captions", captionsText: readFileSync(VTT, "utf8"), minSeconds: 8, maxSeconds: 25, count: 2, autoRender: false });
    expect(await runClipJob(job.id)).toBe("completed");
    const done = await getClipJob(user.id, job.id);
    expect(seenPrompt).toContain("This blade has a dark past."); // the AI only sees the real transcript
    expect(done.clips.every((c) => c.status === "candidate" && c.assetId === null)).toBe(true);
    expect(done.clips[0].aiScore).toBe(99); // highest AI score ranks first
    expect(done.clips[0].title).toMatch(/^AI title/);
    expect(done.clips[0].hashtags).toEqual(["sintel", "blender"]);
    expect(done.clips[0].aiReason).toContain("test-model");
  }, 180_000);

  it("falls back to measured ranking when the AI provider fails", async () => {
    const user = await createUser();
    const src = await uploadReal(user.id, SINTEL);
    setAIProviderForTests({ name: "broken", model: "x", generateText: async () => { throw Object.assign(new Error("upstream 503"), { status: 503 }); } });
    const job = await createClipJob(user.id, { assetId: src.id, transcriptMode: "captions", captionsText: readFileSync(VTT, "utf8"), minSeconds: 8, maxSeconds: 25, count: 2, autoRender: false });
    expect(await runClipJob(job.id)).toBe("completed");
    const done = await getClipJob(user.id, job.id);
    expect(done.notes.join(" ")).toMatch(/AI titles and ranking were skipped/);
    expect(done.clips.every((c) => c.aiScore === null)).toBe(true);
  }, 180_000);

  it("transcribes real audio extracted from the video (speech-to-text provider stubbed) and offsets timestamps", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    resetEnvCache();
    try {
      const user = await createUser();
      const src = await uploadReal(user.id, SINTEL);
      const received: Buffer[] = [];
      setTranscriberForTests(async (audio) => {
        received.push(audio);
        return parseCaptions(readFileSync(VTT, "utf8")); // stand-in for the API's segments
      });
      const job = await createClipJob(user.id, { assetId: src.id, transcriptMode: "auto", minSeconds: 8, maxSeconds: 25, count: 2, autoRender: false });
      expect(await runClipJob(job.id)).toBe("completed");
      expect(received).toHaveLength(1); // 2-minute video fits in one 20-minute chunk
      expect(received[0].length).toBeGreaterThan(100_000); // real MP3 audio was extracted with ffmpeg
      expect(received[0].subarray(0, 3).toString("hex")).toMatch(/^(494433|fff[23b])/); // ID3 or MPEG frame header
      const done = await getClipJob(user.id, job.id);
      expect(done.transcriptSource).toBe("openai");
      expect(done.transcript?.[0].text).toBe("This blade has a dark past.");
    } finally {
      delete process.env.OPENAI_API_KEY;
      resetEnvCache();
    }
  }, 180_000);

  it("re-renders after a trim, replaces the old files, and creates a draft post from the clip", async () => {
    const user = await createUser();
    const src = await uploadReal(user.id, SINTEL);
    const job = await createClipJob(user.id, { assetId: src.id, transcriptMode: "captions", captionsText: readFileSync(VTT, "utf8"), minSeconds: 8, maxSeconds: 20, count: 1, autoRender: true });
    await runClipJob(job.id);
    const [clip] = (await getClipJob(user.id, job.id)).clips;
    const oldAsset = clip.assetId!;

    const trimmed = await updateClip(user.id, clip.id, { startSec: clip.startSec + 1, endSec: clip.startSec + 9, render: { aspect: "16:9", reframe: "fit" } });
    expect(trimmed.status).toBe("queued");
    expect(await renderClipRow(clip.id)).toBe("ready");
    const [after] = (await getClipJob(user.id, job.id)).clips;
    expect(after.assetId).not.toBe(oldAsset);
    expect(await serviceDb().select().from(schema.mediaAssets).where(eq(schema.mediaAssets.id, oldAsset))).toHaveLength(0);
    const { file } = await assetFile(after.assetId!);
    const info = await probe(file);
    expect([info.width, info.height]).toEqual([1280, 720]);
    expect(info.duration).toBeGreaterThan(7.7);
    expect(info.duration).toBeLessThan(8.3);

    await expect(updateClip(user.id, clip.id, { endSec: 500 })).rejects.toThrow(/only 120.0s long/);
    const post = await createPostFromClip(user.id, clip.id);
    expect(post.status).toBe("draft");
    expect(post.mediaAssetId).toBe(after.assetId);
    expect(post.title).toBe(after.title.slice(0, 200));
  }, 240_000);

  it("isolates clip jobs between users and recovers queued work through the reconciler", async () => {
    const owner = await createUser();
    const other = await createUser();
    const src = await uploadReal(owner.id, BBB);
    const job = await createClipJob(owner.id, { assetId: src.id, minSeconds: 8, maxSeconds: 12, count: 1, autoRender: false });
    await expect(getClipJob(other.id, job.id)).rejects.toThrow(/not found/i);
    expect(await withUser(other.id, (tx) => tx.select().from(schema.clipJobs))).toHaveLength(0);
    await expect(createClipJob(other.id, { assetId: src.id })).rejects.toThrow(/not found/i); // can't clip someone else's video

    // No queue in this test environment: the worker's reconciler picks the job up from Postgres.
    const r = await reconcileClips();
    expect(r.jobs).toBeGreaterThanOrEqual(1);
    expect((await getClipJob(owner.id, job.id)).status).toBe("completed");
  }, 180_000);

  it("rejects invalid requests before queueing", async () => {
    const user = await createUser();
    const src = await uploadReal(user.id, BBB);
    await expect(createClipJob(user.id, { assetId: src.id, transcriptMode: "captions" })).rejects.toThrow();
    await expect(createClipJob(user.id, { assetId: src.id, transcriptMode: "captions", captionsText: "not captions" })).rejects.toThrow(/No timed captions/);
    await expect(createClipJob(user.id, { assetId: src.id, minSeconds: 30, maxSeconds: 31 })).rejects.toThrow();
    await expect(createClipJob(user.id, { assetId: src.id, transcriptMode: "auto" })).rejects.toThrow(/OPENAI_API_KEY/);
    const img = await saveUpload(user.id, { name: "x.png", type: "image/png", buffer: await sharp({ create: { width: 10, height: 10, channels: 3, background: "#000" } }).png().toBuffer() });
    await expect(createClipJob(user.id, { assetId: img.id })).rejects.toThrow(/video/);
    void writeFile;
  }, 60_000);
});
