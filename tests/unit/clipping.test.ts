import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseCaptions, parseTimestamp, segmentsInRange } from "@/lib/clipping/transcript";
import { buildWindows, findCandidates, selectTop, WEIGHTS, type Candidate } from "@/lib/clipping/candidates";
import { parseRmsLevels, parseSilences } from "@/lib/clipping/signals";
import { assEscape, buildAss, captionChunks, outputSize, resolveReframe, videoFilter } from "@/lib/clipping/render";
import { fallbackCopy } from "@/lib/services/clipping";

const VTT = path.join(process.cwd(), "tests/fixtures/real/sintel-en.vtt");

describe("caption parsing", () => {
  it("parses timestamps in VTT and SRT forms", () => {
    expect(parseTimestamp("00:00:18.700")).toBe(18.7);
    expect(parseTimestamp("01:02.5")).toBe(62.5);
    expect(parseTimestamp("00:01:02,050")).toBe(62.05);
    expect(() => parseTimestamp("nope")).toThrow();
  });

  it.skipIf(!existsSync(VTT))("parses the real Sintel WebVTT file and drops the non-speech cue", () => {
    const segs = parseCaptions(readFileSync(VTT, "utf8"));
    expect(segs.length).toBe(13); // 14 cues, minus "[Test]"
    expect(segs[0]).toEqual({ start: 18.7, end: 21.5, text: "This blade has a dark past." });
    expect(segs.find((s) => s.text.startsWith("You're a fool"))?.text).toBe("You're a fool for traveling alone, so completely unprepared.");
    expect(segs.every((s, i) => i === 0 || s.start >= segs[i - 1].start)).toBe(true);
  });

  it("parses SRT with formatting tags and rejects files without cues", () => {
    const srt = "1\n00:00:01,000 --> 00:00:02,500\n<i>Hello</i> {\\an8}there\n\n2\n00:00:03,000 --> 00:00:04,000 align:start\n<v Bob>How are you?</v>\n";
    expect(parseCaptions(srt)).toEqual([{ start: 1, end: 2.5, text: "Hello there" }, { start: 3, end: 4, text: "How are you?" }]);
    expect(() => parseCaptions("WEBVTT\n\nNOTE nothing here")).toThrow(/No timed captions/);
  });

  it("shifts segments into clip-relative time", () => {
    const r = segmentsInRange([{ start: 10, end: 12, text: "a" }, { start: 13, end: 20, text: "b" }, { start: 30, end: 31, text: "c" }], 11, 18);
    expect(r).toEqual([{ start: 0, end: 1, text: "a" }, { start: 2, end: 7, text: "b" }]);
  });
});

describe("signal parsing", () => {
  it("parses astats RMS levels and silencedetect output", () => {
    expect(parseRmsLevels("frame:0\nlavfi.astats.Overall.RMS_level=-23.5\nframe:1\nlavfi.astats.Overall.RMS_level=-inf\n")).toEqual([-23.5, -90]);
    const s = parseSilences("[silencedetect] silence_start: 1.5\n[silencedetect] silence_end: 3.25 | silence_duration: 1.75\n[silencedetect] silence_start: 9\n", 10);
    expect(s).toEqual([{ start: 1.5, end: 3.25 }, { start: 9, end: 10 }]);
  });
});

describe("candidate windows and scoring", () => {
  const segs = [
    { start: 2, end: 5, text: "Why does nobody talk about this?" },
    { start: 5.5, end: 9, text: "Because it is hard to explain." },
    { start: 10, end: 14, text: "So here is the trick" },
    { start: 14.2, end: 19, text: "and it works every single time." },
  ];
  const signals = { loudness: Array.from({ length: 50 }, (_, i) => (i < 8 ? -20 : -30)), silences: [{ start: 0, end: 1.8 }, { start: 9.1, end: 9.9 }], cuts: [4, 12, 16] };

  it("aligns transcript windows to sentence boundaries within the length range", () => {
    const w = buildWindows(25, signals, { minSeconds: 6, maxSeconds: 12, targetSeconds: 9 }, segs);
    expect(w.length).toBeGreaterThan(0);
    for (const x of w) {
      expect(segs.some((s) => Math.abs(s.start - 0.25 - x.start) < 0.01)).toBe(true);
      expect(segs.some((s) => Math.abs(s.end + 0.4 - x.end) < 0.01)).toBe(true);
      expect(x.end - x.start).toBeGreaterThanOrEqual(6);
      expect(x.end - x.start).toBeLessThanOrEqual(12);
    }
  });

  it("builds signal-only windows from pauses and cuts", () => {
    const w = buildWindows(25, signals, { minSeconds: 5, maxSeconds: 10, targetSeconds: 8 });
    expect(w.map((x) => x.start)).toEqual(expect.arrayContaining([0, 1.8, 4, 9.9, 12]));
    expect(w.every((x) => x.end - x.start >= 5 && x.end - x.start <= 10)).toBe(true);
  });

  it("scores with documented weights and prefers complete, energetic windows", () => {
    expect(Object.values(WEIGHTS).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
    const cands = findCandidates(25, signals, { minSeconds: 6, maxSeconds: 12, targetSeconds: 9 }, segs);
    const best = [...cands].sort((a, b) => b.score - a.score)[0];
    expect(best.breakdown.completeness.value).toBe(1);
    expect(best.transcript).toContain("Why does nobody talk about this?");
    expect(best.breakdown.hook.detail).toContain("question");
    for (const c of cands) {
      expect(c.score).toBeGreaterThanOrEqual(0);
      expect(c.score).toBeLessThanOrEqual(100);
    }
  });

  it("selects non-overlapping top clips", () => {
    const mk = (start: number, end: number, score: number) => ({ start, end, score, transcript: "", breakdown: {} as Candidate["breakdown"] });
    const picked = selectTop([mk(0, 10, 90), mk(2, 12, 89), mk(20, 30, 50), mk(11, 21, 40)], 3);
    expect(picked.map((p) => p.start)).toEqual([0, 20, 11]);
  });

  it("derives titles from the transcript when there is no AI", () => {
    const c = { start: 18.45, end: 36.2, score: 70, breakdown: {} as Candidate["breakdown"], transcript: "This blade has a dark past. It has shed much innocent blood." };
    expect(fallbackCopy(c, 0).title).toBe("This blade has a dark past.");
    expect(fallbackCopy({ ...c, transcript: "" }, 1).title).toBe("Highlight 2");
  });
});

describe("rendering helpers", () => {
  it("chooses output sizes and reframing", () => {
    expect(outputSize("9:16", "1080p")).toEqual({ w: 1080, h: 1920 });
    expect(outputSize("16:9", "720p")).toEqual({ w: 1280, h: 720 });
    expect(resolveReframe("auto", 720, 306, "9:16")).toBe("blur"); // cinema-wide source into vertical
    expect(resolveReframe("auto", 1080, 1920, "9:16")).toBe("crop");
    expect(resolveReframe("auto", 1920, 1080, "16:9")).toBe("crop");
    expect(resolveReframe("fit", 1920, 1080, "9:16")).toBe("fit");
  });

  it("splits captions into short timed groups that cover each cue exactly", () => {
    const chunks = captionChunks([{ start: 0, end: 3, text: "You're a fool for traveling alone, so completely unprepared." }]);
    expect(chunks.every((c) => c.text.split(" ").length <= 3)).toBe(true);
    expect(chunks[0].start).toBe(0);
    expect(chunks.at(-1)!.end).toBeCloseTo(3, 6);
    expect(chunks.map((c) => c.text).join(" ")).toBe("You're a fool for traveling alone, so completely unprepared.");
  });

  it("escapes ASS override characters and builds a valid script", () => {
    expect(assEscape("a{\\b1}b\\c")).toBe("a(\\\\b1)b\\\\c");
    const ass = buildAss([{ start: 0, end: 1.5, text: "hi {there}" }], 720, 1280, "bold", true);
    expect(ass).toContain("PlayResY: 1280");
    expect(ass).toContain("Dialogue: 0,0:00:00.00,0:00:01.50,Cap,,0,0,0,,{\\fad(60,0)}HI (THERE)");
  });

  it("builds filter graphs for each reframe mode", () => {
    expect(videoFilter("crop", 720, 1280, 0.25, 10)).toContain("crop=720:1280:x=(iw-720)*0.250");
    expect(videoFilter("blur", 720, 1280, 0.5, 10)).toContain("boxblur");
    expect(videoFilter("fit", 720, 1280, 0.5, 10)).toContain("pad=720:1280");
    expect(videoFilter("crop", 720, 1280, 0.5, 10, "/tmp/a b/c.ass")).toContain("subtitles='/tmp/a b/c.ass'");
  });
});
