import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, hashPassword, verifyPassword, pkceChallenge } from "@/lib/crypto";
import { tiktokChunkPlan, tiktokChunkRanges } from "@/lib/providers/platforms/tiktok";
import { nextOffsetFromRange } from "@/lib/providers/platforms/youtube";
import { aggregateStatus, backoffMs } from "@/lib/services/publishing";
import { overallScore, SCORE_FACTORS } from "@/lib/services/research";
import { competitionFromResults } from "@/lib/services/keywords";
import { computeMomentum, opportunityScores } from "@/lib/services/trends";
import { contrastRatio } from "@/lib/services/thumbnails";
import { pacingFromCuts, parseSceneTimes } from "@/lib/services/analyzer";
import { extractJson } from "@/lib/providers/ai";
import { sniffMime } from "@/lib/services/media";
import { computeCompetitorStats } from "@/lib/services/competitors";
import { nextCronRun, validateCron } from "@/lib/services/automation";

const MB = 1024 * 1024;

describe("crypto", () => {
  it("round-trips and detects tampering", () => {
    const enc = encryptSecret("ya29.secret-token");
    expect(enc.startsWith("v1.")).toBe(true);
    expect(decryptSecret(enc)).toBe("ya29.secret-token");
    const parts = enc.split(".");
    parts[3] = Buffer.from("tampered").toString("base64url");
    expect(() => decryptSecret(parts.join("."))).toThrow();
  });
  it("hashes and verifies passwords", async () => {
    const h = await hashPassword("correct horse battery");
    expect(await verifyPassword("correct horse battery", h)).toBe(true);
    expect(await verifyPassword("wrong", h)).toBe(false);
  });
  it("computes S256 PKCE challenge (base64url, no padding), checked against OpenSSL", () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r7wW1gFWFOEjXk";
    const reference = execSync(`printf %s '${verifier}' | openssl dgst -sha256 -binary | base64 | tr '+/' '-_' | tr -d '='`).toString().trim();
    expect(pkceChallenge(verifier)).toBe(reference);
    expect(pkceChallenge(verifier)).not.toMatch(/[+/=]/);
  });
});

describe("tiktok chunking (Media Transfer Guide rules)", () => {
  it("sends small files whole", () => {
    expect(tiktokChunkPlan(3 * MB)).toEqual({ chunkSize: 3 * MB, totalChunks: 1 });
    expect(tiktokChunkPlan(8 * MB)).toEqual({ chunkSize: 8 * MB, totalChunks: 1 });
  });
  it("uses floor(size/chunk) chunks with remainder in the last", () => {
    const size = 35 * MB + 123;
    const plan = tiktokChunkPlan(size);
    expect(plan).toEqual({ chunkSize: 10 * MB, totalChunks: 3 });
    const ranges = tiktokChunkRanges(size, plan);
    expect(ranges[0]).toEqual({ start: 0, end: 10 * MB - 1 });
    expect(ranges.at(-1)!.end).toBe(size - 1);
    const lastLen = ranges.at(-1)!.end - ranges.at(-1)!.start + 1;
    expect(lastLen).toBeGreaterThanOrEqual(5 * MB);
    expect(lastLen).toBeLessThanOrEqual(128 * MB);
    const total = ranges.reduce((a, r) => a + r.end - r.start + 1, 0);
    expect(total).toBe(size);
  });
  it("rejects empty files", () => expect(() => tiktokChunkPlan(0)).toThrow());
});

describe("youtube resumable helpers", () => {
  it("parses Range header", () => {
    expect(nextOffsetFromRange("bytes=0-8388607")).toBe(8388608);
    expect(nextOffsetFromRange(null)).toBe(0);
  });
});

describe("publishing helpers", () => {
  it("aggregates target statuses", () => {
    expect(aggregateStatus(["published", "published"], "draft")).toBe("published");
    expect(aggregateStatus(["published", "failed"], "draft")).toBe("failed");
    expect(aggregateStatus(["scheduled", "scheduled"], "draft")).toBe("scheduled");
    expect(aggregateStatus(["processing", "failed"], "draft")).toBe("processing");
    expect(aggregateStatus([], "draft")).toBe("draft");
  });
  it("backoff grows exponentially with jitter and caps at 1h", () => {
    expect(backoffMs(1, () => 0)).toBe(15_000);
    expect(backoffMs(1, () => 1)).toBe(30_000);
    expect(backoffMs(3, () => 1)).toBe(120_000);
    expect(backoffMs(20, () => 1)).toBe(3_600_000);
  });
});

describe("idea scoring", () => {
  it("inverts competition and difficulty", () => {
    const mk = (v: number) => Object.fromEntries(SCORE_FACTORS.map((f) => [f, { score: v, reason: "" }])) as unknown as Parameters<typeof overallScore>[0];
    const all100 = overallScore(mk(100));
    const all0 = overallScore(mk(0));
    expect(all100).toBe(79); // 100 minus inverted weights (0.13 + 0.08)
    expect(all0).toBe(21);
    const easy = mk(70);
    easy.competition.score = 10;
    const hard = mk(70);
    hard.competition.score = 90;
    expect(overallScore(easy)).toBeGreaterThan(overallScore(hard));
  });
});

describe("keyword competition (computed from real results)", () => {
  const vid = (title: string, views: number, daysAgo: number) => ({ id: title, title, channelId: "c", channelTitle: "c", publishedAt: new Date(Date.now() - daysAgo * 86400_000).toISOString(), thumbnailUrl: null, durationSeconds: 60, views, likes: 0, comments: 0 });
  it("rates optimized fresh high-view results as harder", () => {
    const hard = competitionFromResults("budget travel", [vid("Budget travel tips", 2_000_000, 10), vid("budget travel hacks", 3_000_000, 20), vid("Budget Travel 2026", 1_500_000, 5)]);
    const easy = competitionFromResults("budget travel", [vid("my trip vlog", 50_000, 900), vid("random video", 80_000, 1200), vid("week in Lisbon", 60_000, 800)]);
    expect(hard!.difficulty).toBeGreaterThan(easy!.difficulty);
    expect(easy!.titleMatchRatio).toBe(0);
    expect(competitionFromResults("x", [])).toBeNull();
  });
});

describe("trend math", () => {
  it("momentum uses snapshot delta when available", () => {
    const now = new Date();
    const m = computeMomentum([{ at: new Date(now.getTime() - 2 * 3600_000).toISOString(), views: 1000 }, { at: now.toISOString(), views: 5000 }], null, now);
    expect(m.value).toBe(2000);
    const first = computeMomentum([{ at: now.toISOString(), views: 1000 }], new Date(now.getTime() - 10 * 3600_000), now);
    expect(first.value).toBe(100);
  });
  it("opportunity scores rank higher momentum higher", () => {
    const s = opportunityScores([{ momentum: 10, ageHours: 5, engagement: 0.01 }, { momentum: 1000, ageHours: 5, engagement: 0.01 }]);
    expect(s[1]).toBeGreaterThan(s[0]);
  });
});

describe("thumbnail/analyzer helpers", () => {
  it("computes WCAG contrast", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBe(21);
    expect(contrastRatio("#777777", "#777777")).toBe(1);
  });
  it("parses ffmpeg scene output and pacing", () => {
    const cuts = parseSceneTimes("[Parsed_showinfo_1] n:0 pts:1 pts_time:1.5 ...\n[Parsed_showinfo_1] n:1 pts_time:4.25 x");
    expect(cuts).toEqual([1.5, 4.25]);
    const p = pacingFromCuts(cuts, 10);
    expect(p.sceneChanges).toBe(2);
    expect(p.cutsPerMinute).toBe(12);
    expect(p.firstCutSeconds).toBe(1.5);
    expect(p.longestShotSeconds).toBe(5.75);
  });
});

describe("misc", () => {
  it("extracts JSON from fenced model output", () => {
    expect(extractJson('Sure!\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('prefix {"b":[1,2]} suffix')).toEqual({ b: [1, 2] });
    expect(() => extractJson("no json")).toThrow();
  });
  it("sniffs file types by magic bytes", () => {
    expect(sniffMime(Buffer.from("ffd8ffe000104a464946", "hex"))).toBe("image/jpeg");
    expect(sniffMime(Buffer.from([0, 0, 0, 0x18, ...Buffer.from("ftypmp42")]))).toBe("video/mp4");
    expect(sniffMime(Buffer.from("hello world"))).toBeNull();
  });
  it("computes competitor stats", () => {
    const base = { id: "", userId: "", competitorId: "", externalId: "", description: null, thumbnailUrl: null, likeCount: 0, commentCount: 0, retrievedAt: new Date() };
    const rows = [
      { ...base, id: "1", title: "How I did X?", publishedAt: new Date("2026-01-01"), durationSeconds: 50, viewCount: 1000 },
      { ...base, id: "2", title: "10 TIPS for Y", publishedAt: new Date("2026-01-08"), durationSeconds: 600, viewCount: 5000 },
      { ...base, id: "3", title: "Z explained", publishedAt: new Date("2026-01-15"), durationSeconds: 700, viewCount: 1200 },
    ];
    const s = computeCompetitorStats(rows)!;
    expect(s.uploadsPerWeek).toBe(1);
    expect(s.medianViews).toBe(1200);
    expect(s.shortFormShare).toBe(33);
    expect(s.outliers[0].id).toBe("2");
  });
  it("validates cron expressions with timezone", () => {
    expect(validateCron("0 9 * * 1", "Africa/Algiers")).toBeNull();
    expect(validateCron("not cron", "UTC")).not.toBeNull();
    const next = nextCronRun("0 9 * * *", "Africa/Algiers", new Date("2026-11-22T00:00:00Z"));
    expect(next.toISOString()).toBe("2026-11-22T08:00:00.000Z"); // 09:00 UTC+1
  });
});
