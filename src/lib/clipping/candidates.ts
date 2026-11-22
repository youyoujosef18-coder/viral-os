import { WINDOW, SILENCE_DB, type Signals } from "./signals";
import { wordCount, type Segment } from "./transcript";

export type Window = { start: number; end: number };
export type ScoreBreakdown = Record<"energy" | "hook" | "speech" | "pacing" | "completeness" | "silence", { value: number; weight: number; detail: string }>;
export type Candidate = Window & { score: number; breakdown: ScoreBreakdown; transcript: string };

export type CandidateOptions = { minSeconds: number; maxSeconds: number; targetSeconds: number };

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const round2 = (v: number) => Math.round(v * 100) / 100;

/** Weights sum to 1. Documented in the UI tooltip and README. */
export const WEIGHTS = { energy: 0.25, hook: 0.2, speech: 0.2, pacing: 0.15, completeness: 0.15, silence: 0.05 } as const;

const SENTENCE_END = /[.!?…"”')\]]$/;

/**
 * Candidate windows.
 * - With a transcript: every run of consecutive caption segments, starting at a segment start and ending at
 *   a segment end, whose length is within [min, max]. Clips never cut a sentence mid-way.
 * - Without one: boundaries are silence ends, scene cuts and the start of the file; each window starts at a
 *   boundary and ends at the boundary closest to the target length (or at the max length if none fits).
 */
export function buildWindows(duration: number, signals: Signals, opts: CandidateOptions, segments?: Segment[]): Window[] {
  const { minSeconds: min, maxSeconds: max, targetSeconds: target } = opts;
  const out: Window[] = [];
  const pre = 0.25, post = 0.4; // breathing room so words aren't clipped
  if (segments?.length) {
    for (let i = 0; i < segments.length; i++) {
      for (let j = i; j < segments.length; j++) {
        const start = Math.max(0, segments[i].start - pre);
        const end = Math.min(duration, segments[j].end + post);
        const len = end - start;
        if (len > max) break;
        if (len >= min) out.push({ start: round2(start), end: round2(end) });
      }
    }
    return out;
  }
  const bounds = [...new Set([0, ...signals.silences.map((s) => s.end), ...signals.cuts].map(round2))].filter((b) => b < duration - min).sort((a, b) => a - b);
  const ends = [...new Set([...signals.silences.map((s) => s.start), ...signals.cuts, duration].map(round2))].sort((a, b) => a - b);
  for (const start of bounds) {
    const fits = ends.filter((e) => e - start >= min && e - start <= max);
    const end = fits.length ? fits.reduce((best, e) => (Math.abs(e - start - target) < Math.abs(best - start - target) ? e : best)) : Math.min(duration, start + Math.min(max, Math.max(min, target)));
    if (end - start >= min) out.push({ start, end: round2(end) });
  }
  return out;
}

function meanDb(loudness: number[], start: number, end: number) {
  const a = Math.floor(start / WINDOW), b = Math.max(a + 1, Math.ceil(end / WINDOW));
  const slice = loudness.slice(a, b);
  return slice.length ? slice.reduce((x, y) => x + y, 0) / slice.length : -90;
}

function percentileRank(sorted: number[], v: number) {
  if (!sorted.length) return 0.5;
  let lo = 0;
  while (lo < sorted.length && sorted[lo] < v) lo++;
  return lo / sorted.length;
}

/**
 * Computed (non-AI) score, 0–100, from measured signals and caption timing:
 *  energy       – window loudness percentile within this video
 *  hook         – loudness of the first 3 s relative to the window (a strong open), plus a question/second-person opener
 *  speech       – words per second vs. a 2.2–3.2 wps conversational sweet spot (no transcript: share of non-silent time)
 *  pacing       – scene cuts per minute vs. a 6–30/min short-form range
 *  completeness – starts at a sentence start and ends at sentence-final punctuation (no transcript: starts after a pause)
 *  silence      – penalty for silent share
 */
export function scoreWindow(w: Window, signals: Signals, sortedLoudness: number[], segments?: Segment[]): Candidate {
  const len = w.end - w.start;
  const db = meanDb(signals.loudness, w.start, w.end);
  const energy = signals.loudness.length ? percentileRank(sortedLoudness, db) : 0.5;

  const hookDb = meanDb(signals.loudness, w.start, Math.min(w.end, w.start + 3));
  const inside = segments?.filter((s) => s.end > w.start && s.start < w.end) ?? [];
  const firstLine = inside[0]?.text ?? "";
  const lexicalHook = /\?|^(you|your|why|how|what|this|never|stop|imagine|here'?s)\b/i.test(firstLine) ? 0.2 : 0;
  const hook = clamp01((signals.loudness.length ? clamp01(0.5 + (hookDb - db) / 12) : 0.5) * 0.8 + lexicalHook);

  const silent = signals.silences.reduce((acc, s) => acc + Math.max(0, Math.min(s.end, w.end) - Math.max(s.start, w.start)), 0);
  const silentShare = clamp01(silent / len);

  let speech: number, speechDetail: string;
  if (segments?.length) {
    const words = inside.reduce((acc, s) => acc + wordCount(s.text), 0);
    const wps = words / len;
    speech = wps >= 2.2 && wps <= 3.2 ? 1 : wps < 2.2 ? clamp01(wps / 2.2) : clamp01(1 - (wps - 3.2) / 3);
    speechDetail = `${wps.toFixed(2)} words/sec`;
  } else {
    speech = 1 - silentShare;
    speechDetail = `${Math.round((1 - silentShare) * 100)}% non-silent`;
  }

  const cuts = signals.cuts.filter((c) => c > w.start && c < w.end).length;
  const cpm = (cuts / len) * 60;
  const pacing = cpm >= 6 && cpm <= 30 ? 1 : cpm < 6 ? clamp01(0.3 + cpm / 8.5) : clamp01(1 - (cpm - 30) / 40);

  let completeness: number, completeDetail: string;
  if (segments?.length) {
    const startsClean = inside.length > 0 && inside[0].start >= w.start - 0.05;
    const last = inside[inside.length - 1];
    const endsClean = !!last && last.end <= w.end + 0.05 && SENTENCE_END.test(last.text.trim());
    completeness = (startsClean ? 0.5 : 0) + (endsClean ? 0.5 : 0);
    completeDetail = `${startsClean ? "clean start" : "mid-sentence start"}, ${endsClean ? "ends on a full sentence" : "ends mid-thought"}`;
  } else {
    const afterPause = w.start === 0 || signals.silences.some((s) => Math.abs(s.end - w.start) < 0.3) || signals.cuts.some((c) => Math.abs(c - w.start) < 0.3);
    completeness = afterPause ? 0.8 : 0.4;
    completeDetail = afterPause ? "starts at a pause or cut" : "starts mid-action";
  }
  const silenceScore = 1 - silentShare;

  const breakdown: ScoreBreakdown = {
    energy: { value: round2(energy), weight: WEIGHTS.energy, detail: `${db.toFixed(1)} dBFS average` },
    hook: { value: round2(hook), weight: WEIGHTS.hook, detail: `first 3s at ${hookDb.toFixed(1)} dBFS${lexicalHook ? ", question/direct opener" : ""}` },
    speech: { value: round2(speech), weight: WEIGHTS.speech, detail: speechDetail },
    pacing: { value: round2(pacing), weight: WEIGHTS.pacing, detail: `${cpm.toFixed(1)} cuts/min` },
    completeness: { value: round2(completeness), weight: WEIGHTS.completeness, detail: completeDetail },
    silence: { value: round2(silenceScore), weight: WEIGHTS.silence, detail: `${Math.round(silentShare * 100)}% silent` },
  };
  const score = Math.round(100 * (Object.keys(WEIGHTS) as (keyof typeof WEIGHTS)[]).reduce((acc, k) => acc + WEIGHTS[k] * breakdown[k].value, 0));
  return { ...w, score, breakdown, transcript: inside.map((s) => s.text).join(" ") };
}

/** Greedy pick of the best-scoring windows that overlap each other by at most `maxOverlap` of the shorter one. */
export function selectTop<T extends Window & { score: number }>(cands: T[], count: number, maxOverlap = 0.15): T[] {
  const sorted = [...cands].sort((a, b) => b.score - a.score || a.start - b.start);
  const picked: T[] = [];
  for (const c of sorted) {
    if (picked.length >= count) break;
    const clash = picked.some((p) => {
      const ov = Math.max(0, Math.min(p.end, c.end) - Math.max(p.start, c.start));
      return ov / Math.min(p.end - p.start, c.end - c.start) > maxOverlap;
    });
    if (!clash) picked.push(c);
  }
  return picked;
}

export function findCandidates(duration: number, signals: Signals, opts: CandidateOptions, segments?: Segment[]) {
  const sortedLoudness = [...signals.loudness].filter((v) => v > SILENCE_DB - 30).sort((a, b) => a - b);
  const windows = buildWindows(duration, signals, opts, segments);
  return windows.map((w) => scoreWindow(w, signals, sortedLoudness, segments));
}
