import { describe, expect, it } from "vitest";
import { buildYouTubeWindows, commentMentions, findTimestamps, findYouTubeCandidates, parseChapters, parseRetention, parseYouTubeId, YT_WEIGHTS } from "@/lib/clipping/youtube-moments";
import { embedCode, embedUrl, watchUrl } from "@/lib/clipping/youtube-urls";

const opts = { minSeconds: 15, maxSeconds: 30, targetSeconds: 22 };

describe("parseYouTubeId", () => {
  it.each([
    ["dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s", "dQw4w9WgXcQ"],
    ["youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://m.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://youtu.be/dQw4w9WgXcQ?si=abc", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/shorts/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/embed/dQw4w9WgXcQ?start=5", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/live/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
  ])("%s", (input, id) => expect(parseYouTubeId(input)).toBe(id));

  it.each(["", "hello", "https://vimeo.com/123456", "https://www.youtube.com/watch?v=short", "https://www.youtube.com/@channel", "https://evil.com/watch?v=dQw4w9WgXcQ"])("rejects %s", (input) => {
    expect(parseYouTubeId(input)).toBeNull();
  });
});

describe("timestamps and chapters", () => {
  it("finds m:ss and h:mm:ss, ignores ratios, decimals and versions", () => {
    expect(findTimestamps("best part 3:45 and 1:02:03, also 0:07")).toEqual([225, 3723, 7]);
    expect(findTimestamps("score 16:9 is a ratio? no — v1.2:30 and 12:345")).toEqual([]);
    expect(findTimestamps("1:75:00 isn't valid")).toEqual([]);
  });

  it("parses description chapters and applies YouTube's chapter rules", () => {
    const desc = "My video\n\n0:00 Intro\n0:45 - The setup\n2:10 Big reveal\n3:30 Outro\nhttps://example.com";
    const { chapters, valid } = parseChapters(desc, 240);
    expect(valid).toBe(true);
    expect(chapters).toEqual([
      { start: 0, end: 45, title: "Intro" },
      { start: 45, end: 130, title: "The setup" },
      { start: 130, end: 210, title: "Big reveal" },
      { start: 210, end: 240, title: "Outro" },
    ]);
  });

  it("keeps non-conforming timestamp lists as boundaries but marks them invalid", () => {
    const r = parseChapters("1:00 first\n2:00 second", 300);
    expect(r.valid).toBe(false);
    expect(r.chapters).toHaveLength(2);
    expect(parseChapters("watch at 1:00 only", 300).chapters).toEqual([]);
    expect(parseChapters("0:00 a\n9:00 b past the end\n0:30 c", 120).chapters.map((c) => c.start)).toEqual([0, 30]);
  });

  it("weights comment timestamps by likes and spreads list-style comments", () => {
    const m = commentMentions(
      [
        { text: "2:05 had me crying", likes: 1023 },
        { text: "0:10 0:20 0:30 0:40", likes: 3 },
        { text: "no timestamp here", likes: 999 },
        { text: "9:59 beyond the end", likes: 5 },
      ],
      300,
    );
    expect(m.map((x) => x.t)).toEqual([10, 20, 30, 40, 125]);
    const big = m.find((x) => x.t === 125)!;
    const listed = m.find((x) => x.t === 10)!;
    expect(big.weight).toBeCloseTo(1 + Math.log2(1024), 1);
    expect(listed.weight).toBeCloseTo((1 + Math.log2(4)) / 2, 1);
  });
});

describe("retention", () => {
  it("maps Analytics columns by name", () => {
    const pts = parseRetention({ columnHeaders: [{ name: "elapsedVideoTimeRatio" }, { name: "relativeRetentionPerformance" }, { name: "audienceWatchRatio" }], rows: [[0.02, 0.4, 0.8], [0.01, 0.5, 1]] });
    expect(pts).toEqual([{ ratio: 0.01, watch: 1, relative: 0.5 }, { ratio: 0.02, watch: 0.8, relative: 0.4 }]);
    expect(parseRetention({ columnHeaders: [{ name: "views" }], rows: [[1]] })).toEqual([]);
  });
});

describe("candidates", () => {
  it("returns nothing when there is no data to base a moment on", () => {
    expect(findYouTubeCandidates({ duration: 300, chapters: [], mentions: [], retention: null }, opts)).toEqual([]);
  });

  it("anchors on viewer timestamps, uses whole seconds and ranks the most-mentioned moment first", () => {
    const mentions = commentMentions([{ text: "3:20 insane", likes: 500 }, { text: "3:21 lol", likes: 40 }, { text: "1:00 nice", likes: 0 }], 600);
    const c = findYouTubeCandidates({ duration: 600, chapters: [], mentions, retention: null }, opts);
    expect(c.length).toBeGreaterThan(0);
    for (const w of c) {
      expect(Number.isInteger(w.start) && Number.isInteger(w.end)).toBe(true);
      expect(w.end - w.start).toBeGreaterThanOrEqual(15);
      expect(w.end - w.start).toBeLessThanOrEqual(30);
    }
    const best = [...c].sort((a, b) => b.score - a.score)[0];
    expect(best.start).toBeLessThanOrEqual(200);
    expect(best.end).toBeGreaterThanOrEqual(201);
    expect(Object.keys(best.breakdown)).toEqual(["community"]);
    expect(best.breakdown.community!.weight).toBe(1);
  });

  it("uses retention when available and renormalizes weights over the components that have data", () => {
    const rows = Array.from({ length: 100 }, (_, i) => [(i + 1) / 100, i >= 40 && i < 50 ? 1.4 : 0.6, 0.5]);
    const retention = parseRetention({ columnHeaders: [{ name: "elapsedVideoTimeRatio" }, { name: "audienceWatchRatio" }, { name: "relativeRetentionPerformance" }], rows });
    const chapters = parseChapters("0:00 a\n1:00 b\n2:00 c", 200).chapters;
    const c = findYouTubeCandidates({ duration: 200, chapters, mentions: [], retention }, opts);
    const best = [...c].sort((a, b) => b.score - a.score)[0];
    // ratios 0.41–0.50 of 200 s = 80–100 s is the rewatched part
    expect(best.start).toBeGreaterThanOrEqual(60);
    expect(best.start).toBeLessThan(100);
    const total = YT_WEIGHTS.retention + YT_WEIGHTS.structure;
    expect(best.breakdown.retention!.weight).toBeCloseTo(YT_WEIGHTS.retention / total, 2);
    expect(best.breakdown.structure!.weight).toBeCloseTo(YT_WEIGHTS.structure / total, 2);
    expect(best.breakdown.community).toBeUndefined();
  });

  it("follows caption cues when a transcript exists, rounding outward to whole seconds", () => {
    const segments = [
      { start: 10.2, end: 16.8, text: "Why does this work?" },
      { start: 17, end: 25.4, text: "Because the setup pays off." },
      { start: 26, end: 40.1, text: "And that's the trick." },
    ];
    const wins = buildYouTubeWindows({ duration: 60, segments, chapters: [], mentions: [], retention: null }, opts);
    expect(wins).toContainEqual({ start: 9, end: 26 });
    const c = findYouTubeCandidates({ duration: 60, segments, chapters: [], mentions: [], retention: null }, opts);
    const first = c.find((x) => x.start === 9 && x.end === 26)!;
    expect(first.breakdown.hook!.value).toBe(1);
    expect(first.transcript).toContain("setup pays off");
  });
});

describe("player URLs", () => {
  it("builds official embed and watch URLs with whole-second times", () => {
    expect(embedUrl("dQw4w9WgXcQ", 12.7, 40.2)).toBe("https://www.youtube.com/embed/dQw4w9WgXcQ?start=12&end=41");
    expect(watchUrl("dQw4w9WgXcQ", 65.9)).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=65s");
    expect(embedCode("dQw4w9WgXcQ", 1, 2, 'A "quote" <b>')).toContain('title="A &quot;quote&quot; &lt;b&gt;"');
  });
});
