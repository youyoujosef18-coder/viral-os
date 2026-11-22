import { buildWindows, selectTop, type CandidateOptions, type Window } from "./candidates";
import { wordCount, type Segment } from "./transcript";

/**
 * Moment finding for YouTube videos WITHOUT touching the video file.
 *
 * Everything here works on data returned by the official YouTube APIs:
 *  - chapters parsed from the video description (videos.list snippet.description)
 *  - timestamps viewers wrote in comments (commentThreads.list)
 *  - audience retention for the user's own videos (YouTube Analytics: elapsedVideoTimeRatio + audienceWatchRatio)
 *  - caption text for the user's own videos (captions.download) or a caption file the user supplies
 *
 * Clips are start/end times played back in YouTube's official embedded player.
 */

export type Chapter = { start: number; end: number; title: string };
export type Mention = { t: number; weight: number; likes: number; excerpt: string };
export type RetentionPoint = { ratio: number; watch: number; relative: number | null };
export type YtComponent = "retention" | "community" | "structure" | "hook" | "speech" | "completeness";
export type YtBreakdown = Partial<Record<YtComponent, { value: number; weight: number; detail: string }>>;
export type YtCandidate = Window & { score: number; breakdown: YtBreakdown; transcript: string };
export type YtContext = { duration: number; segments?: Segment[]; chapters: Chapter[]; mentions: Mention[]; retention: RetentionPoint[] | null };

/** Base weights; only the components that have data are used, renormalized to sum to 1. */
export const YT_WEIGHTS: Record<YtComponent, number> = { retention: 0.35, community: 0.25, structure: 0.1, hook: 0.1, speech: 0.1, completeness: 0.1 };

const ID = /^[\w-]{11}$/;
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const round2 = (v: number) => Math.round(v * 100) / 100;

/** Accepts a video ID or any common YouTube URL form (watch, youtu.be, shorts, embed, live). */
export function parseYouTubeId(input: string): string | null {
  const raw = input.trim();
  if (ID.test(raw)) return raw;
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^(www|m|music)\./, "");
  let id: string | null = null;
  if (host === "youtu.be") id = url.pathname.split("/")[1] ?? null;
  else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    if (url.pathname === "/watch") id = url.searchParams.get("v");
    else {
      const m = /^\/(?:shorts|embed|live|v)\/([^/?#]+)/.exec(url.pathname);
      id = m?.[1] ?? null;
    }
  }
  return id && ID.test(id) ? id : null;
}

/** All "h:mm:ss" / "m:ss" timestamps in a text, in seconds, in order of appearance. */
export function findTimestamps(text: string): number[] {
  const out: number[] = [];
  const re = /(?<![\w:.])(?:(\d{1,2}):)?(\d{1,2}):([0-5]\d)(?![\w:])/g;
  for (const m of text.matchAll(re)) {
    const h = m[1] ? Number(m[1]) : 0;
    const mi = Number(m[2]);
    if (m[1] && mi > 59) continue;
    out.push(h * 3600 + mi * 60 + Number(m[3]));
  }
  return out;
}

/**
 * Chapters from a description: lines that contain exactly one timestamp. `valid` follows YouTube's own
 * chapter rules (first at 0:00, at least 3, each at least 10 s); we use the boundaries either way when there
 * are at least two entries.
 */
export function parseChapters(description: string, duration: number): { chapters: Chapter[]; valid: boolean } {
  const found: { start: number; title: string }[] = [];
  for (const line of description.split(/\r?\n/)) {
    const ts = findTimestamps(line);
    if (ts.length !== 1 || ts[0] >= duration) continue;
    const title = line.replace(/(?:\d{1,2}:)?\d{1,2}:[0-5]\d/, "").replace(/^[\s\-–—:|•·*()[\]]+|[\s\-–—:|•·*()[\]]+$/g, "").trim();
    found.push({ start: ts[0], title: title || "Chapter" });
  }
  const sorted = [...new Map(found.sort((a, b) => a.start - b.start).map((c) => [c.start, c])).values()];
  if (sorted.length < 2) return { chapters: [], valid: false };
  const chapters = sorted.map((c, i) => ({ start: c.start, end: i + 1 < sorted.length ? sorted[i + 1].start : duration, title: c.title.slice(0, 120) }));
  const valid = chapters[0].start === 0 && chapters.length >= 3 && chapters.every((c) => c.end - c.start >= 10);
  return { chapters, valid };
}

/**
 * Timestamps viewers wrote in comments. Weight grows with likes (log scale); a comment that lists many
 * timestamps (a viewer-made chapter list) is spread across them so it cannot dominate.
 */
export function commentMentions(comments: { text: string; likes: number }[], duration: number): Mention[] {
  const out: Mention[] = [];
  for (const c of comments) {
    const ts = [...new Set(findTimestamps(c.text))].filter((t) => t < duration);
    if (!ts.length) continue;
    const base = (1 + Math.log2(1 + Math.max(0, c.likes))) / Math.sqrt(ts.length);
    const excerpt = c.text.replace(/\s+/g, " ").trim().slice(0, 140);
    for (const t of ts) out.push({ t, weight: round2(base), likes: c.likes, excerpt });
  }
  return out.sort((a, b) => a.t - b.t);
}

/** Map Analytics rows (by column name) to retention points. */
export function parseRetention(report: { columnHeaders?: { name: string }[]; rows?: (number | string)[][] }): RetentionPoint[] {
  const cols = (report.columnHeaders ?? []).map((c) => c.name);
  const iR = cols.indexOf("elapsedVideoTimeRatio"), iW = cols.indexOf("audienceWatchRatio"), iRel = cols.indexOf("relativeRetentionPerformance");
  if (iR < 0 || iW < 0) return [];
  return (report.rows ?? [])
    .map((r) => ({ ratio: Number(r[iR]), watch: Number(r[iW]), relative: iRel >= 0 ? Number(r[iRel]) : null }))
    .filter((p) => Number.isFinite(p.ratio) && Number.isFinite(p.watch))
    .sort((a, b) => a.ratio - b.ratio);
}

/** Each ratio is the exclusive end of an equal-length interval; use the interval midpoint in seconds. */
function retentionTimes(points: RetentionPoint[], duration: number) {
  const step = points.length ? 1 / points.length : 0;
  return points.map((p) => ({ ...p, t: Math.max(0, (p.ratio - step / 2) * duration) }));
}

/** Integer seconds: the embedded player's start/end parameters only accept whole seconds. */
export function toEmbedWindow(w: Window, duration: number): Window {
  const start = Math.max(0, Math.floor(w.start));
  const end = Math.min(Math.ceil(duration), Math.max(start + 1, Math.ceil(w.end)));
  return { start, end };
}

/** Candidate windows from whatever data exists. Returns [] when there is nothing to base a moment on. */
export function buildYouTubeWindows(ctx: YtContext, opts: CandidateOptions): Window[] {
  const { duration, chapters, mentions, retention } = ctx;
  const { minSeconds: min, maxSeconds: max, targetSeconds: target } = opts;
  let wins: Window[] = [];
  if (ctx.segments?.length) {
    wins = buildWindows(duration, { loudness: [], silences: [], cuts: [] }, opts, ctx.segments);
  } else {
    const anchors = new Set<number>();
    for (const c of chapters) anchors.add(c.start);
    for (const m of mentions) anchors.add(Math.max(0, m.t - 3)); // viewers timestamp the moment itself; open slightly before
    if (retention?.length) {
      const pts = retentionTimes(retention, duration);
      for (let i = 1; i < pts.length - 1; i++) if (pts[i].watch > pts[i - 1].watch && pts[i].watch >= pts[i + 1].watch) anchors.add(Math.max(0, pts[i].t - target / 3));
      const step = Math.max(5, Math.round(target / 2));
      for (let s = 0; s < duration - min; s += step) anchors.add(s);
    }
    const ends = [...chapters.map((c) => c.end), duration];
    for (const start of anchors) {
      if (start > duration - min) continue;
      const fits = ends.filter((e) => e - start >= min && e - start <= max);
      const end = fits.length ? fits.reduce((b, e) => (Math.abs(e - start - target) < Math.abs(b - start - target) ? e : b)) : Math.min(duration, start + target);
      if (end - start >= min) wins.push({ start, end });
    }
  }
  const seen = new Set<string>();
  return wins.map((w) => toEmbedWindow(w, duration)).filter((w) => {
    const key = `${w.start}-${w.end}`;
    if (seen.has(key) || w.end - w.start < Math.floor(min)) return false;
    seen.add(key);
    return true;
  });
}

const SENTENCE_END = /[.!?…"”')\]]$/;

/** Score all windows. Components without data are left out and the rest are renormalized. */
export function findYouTubeCandidates(ctx: YtContext, opts: CandidateOptions): YtCandidate[] {
  const windows = buildYouTubeWindows(ctx, opts);
  if (!windows.length) return [];
  const { duration, chapters, mentions, segments } = ctx;
  const ret = ctx.retention?.length ? retentionTimes(ctx.retention, duration) : null;
  const sortedWatch = ret ? ret.map((p) => p.watch).sort((a, b) => a - b) : [];
  const avgWatch = ret ? ret.reduce((a, p) => a + p.watch, 0) / ret.length : 0;
  const mentionSum = (w: Window) => mentions.filter((m) => m.t >= w.start && m.t <= w.end).reduce((a, m) => a + m.weight, 0);
  const maxMentions = mentions.length ? Math.max(...windows.map(mentionSum)) : 0;

  const available: YtComponent[] = [];
  if (ret) available.push("retention");
  if (maxMentions > 0) available.push("community");
  if (chapters.length) available.push("structure");
  if (segments?.length) available.push("hook", "speech", "completeness");
  if (!available.length) return [];
  const total = available.reduce((a, k) => a + YT_WEIGHTS[k], 0);
  const weight = (k: YtComponent) => round2(YT_WEIGHTS[k] / total);

  return windows.map((w) => {
    const len = w.end - w.start;
    const b: YtBreakdown = {};
    if (ret) {
      const inside = ret.filter((p) => p.t >= w.start && p.t < w.end);
      const pts = inside.length ? inside : [ret.reduce((best, p) => (Math.abs(p.t - (w.start + w.end) / 2) < Math.abs(best.t - (w.start + w.end) / 2) ? p : best))];
      const mean = pts.reduce((a, p) => a + p.watch, 0) / pts.length;
      let below = 0;
      while (below < sortedWatch.length && sortedWatch[below] < mean) below++;
      const pct = sortedWatch.length ? below / sortedWatch.length : 0.5;
      const rels = pts.map((p) => p.relative).filter((r): r is number => r !== null && Number.isFinite(r));
      const rel = rels.length ? rels.reduce((a, r) => a + r, 0) / rels.length : null;
      b.retention = { value: round2(rel === null ? pct : 0.7 * pct + 0.3 * clamp01(rel)), weight: weight("retention"), detail: `audience watch ratio ${mean.toFixed(2)} vs ${avgWatch.toFixed(2)} video average${rel !== null ? `, relative retention ${rel.toFixed(2)}` : ""}` };
    }
    if (maxMentions > 0) {
      const inside = mentions.filter((m) => m.t >= w.start && m.t <= w.end);
      const comments = new Set(inside.map((m) => m.excerpt)).size;
      b.community = { value: round2(clamp01(mentionSum(w) / maxMentions)), weight: weight("community"), detail: `${comments} timestamped comment${comments === 1 ? "" : "s"}${comments ? ` (${inside.reduce((a, m) => Math.max(a, m.likes), 0)} likes on the top one)` : ""}` };
    }
    if (chapters.length) {
      const startsAt = chapters.find((c) => Math.abs(c.start - w.start) <= 2);
      const within = chapters.find((c) => w.start >= c.start - 2 && w.end <= c.end + 2);
      b.structure = { value: startsAt ? 1 : within ? 0.7 : 0.4, weight: weight("structure"), detail: startsAt ? `starts at chapter "${startsAt.title}"` : within ? `inside chapter "${within.title}"` : "spans chapters" };
    }
    let text = "";
    if (segments?.length) {
      const inside = segments.filter((s) => s.end > w.start && s.start < w.end);
      text = inside.map((s) => s.text).join(" ");
      const first = inside[0]?.text ?? "";
      const lexical = /\?|^(you|your|why|how|what|this|never|stop|imagine|here'?s)\b/i.test(first);
      b.hook = { value: lexical ? 1 : 0.4, weight: weight("hook"), detail: lexical ? "opens with a question or direct address" : "plain opener" };
      const wps = inside.reduce((a, s) => a + wordCount(s.text), 0) / len;
      b.speech = { value: round2(wps >= 2.2 && wps <= 3.2 ? 1 : wps < 2.2 ? clamp01(wps / 2.2) : clamp01(1 - (wps - 3.2) / 3)), weight: weight("speech"), detail: `${wps.toFixed(2)} words/sec` };
      const startsClean = inside.length > 0 && inside[0].start >= w.start - 0.05;
      const last = inside[inside.length - 1];
      const endsClean = !!last && last.end <= w.end + 0.05 && SENTENCE_END.test(last.text.trim());
      b.completeness = { value: (startsClean ? 0.5 : 0) + (endsClean ? 0.5 : 0), weight: weight("completeness"), detail: `${startsClean ? "clean start" : "mid-sentence start"}, ${endsClean ? "ends on a full sentence" : "ends mid-thought"}` };
    }
    const score = Math.round((100 * available.reduce((a, k) => a + YT_WEIGHTS[k] * (b[k]?.value ?? 0), 0)) / total);
    return { ...w, score, breakdown: b, transcript: text };
  });
}

export { selectTop };
export { embedUrl, watchUrl } from "./youtube-urls";
