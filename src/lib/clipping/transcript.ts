import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import OpenAI, { toFile } from "openai";
import { env } from "../env";
import { NotConfiguredError, badRequest } from "../api/errors";

const run = promisify(execFile);
const FFMPEG = () => process.env.FFMPEG_PATH || "ffmpeg";

export type Segment = { start: number; end: number; text: string };

/** "00:01:02.500", "01:02.5", "00:01:02,500" → seconds */
export function parseTimestamp(ts: string): number {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/.exec(ts.trim());
  if (!m) throw new Error(`Invalid timestamp "${ts}"`);
  const [, h, mi, s, ms] = m;
  return Number(h ?? 0) * 3600 + Number(mi) * 60 + Number(s) + (ms ? Number(ms.padEnd(3, "0")) / 1000 : 0);
}

function cleanCueText(raw: string): string {
  return raw
    .replace(/<v(?:\.[^\s>]*)?\s+[^>]*>/gi, "") // voice tags <v Speaker>
    .replace(/<\/?[a-z][^>]*>/gi, "") // <i>, <b>, <c.class>, timestamps
    .replace(/\{\\[^}]*\}/g, "") // SSA override tags in SRT
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Parse WebVTT or SRT captions into time-ordered segments. Ignores NOTE/STYLE/REGION blocks,
 * cue settings, and non-speech cues made only of bracketed sound descriptions like "[Test]".
 */
export function parseCaptions(text: string): Segment[] {
  const body = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const blocks = body.split(/\n{2,}/);
  const out: Segment[] = [];
  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.trim() !== "");
    if (!lines.length) continue;
    if (/^(WEBVTT|NOTE|STYLE|REGION)\b/.test(lines[0])) continue;
    const idx = lines.findIndex((l) => l.includes("-->"));
    if (idx === -1) continue;
    const [a, rest] = lines[idx].split("-->");
    const b = rest.trim().split(/\s+/)[0];
    let start: number, end: number;
    try {
      start = parseTimestamp(a);
      end = parseTimestamp(b);
    } catch {
      continue;
    }
    const textOut = cleanCueText(lines.slice(idx + 1).join(" "));
    if (!textOut || /^(\[[^\]]*\]|\([^)]*\)|♪+)$/.test(textOut) || end <= start) continue;
    out.push({ start, end, text: textOut });
  }
  if (!out.length) throw badRequest("No timed captions found. Upload a valid .srt or .vtt file.");
  return out.sort((x, y) => x.start - y.start);
}

export function wordCount(s: string) {
  return s.split(/\s+/).filter(Boolean).length;
}

/** Segments overlapping [start, end], with times shifted to be relative to `start` and clamped. */
export function segmentsInRange(segments: Segment[], start: number, end: number): Segment[] {
  return segments
    .filter((s) => s.end > start && s.start < end)
    .map((s) => ({ start: Math.max(0, s.start - start), end: Math.min(end, s.end) - start, text: s.text }));
}

export function isTranscriptionConfigured() {
  return !!env().OPENAI_API_KEY;
}

// Whisper API upload limit is 25 MB. 32 kbps mono MP3 ≈ 14 MB/hour, so 20-minute chunks stay well under it.
const CHUNK_SECONDS = 20 * 60;

type TranscribeFn = (audio: Buffer, filename: string) => Promise<Segment[]>;
let testTranscriber: TranscribeFn | null = null;
export function setTranscriberForTests(fn: TranscribeFn | null) {
  testTranscriber = fn;
}

async function openAITranscribe(audio: Buffer, filename: string): Promise<Segment[]> {
  const e = env();
  if (!e.OPENAI_API_KEY) throw new NotConfiguredError("Automatic transcription", "Set OPENAI_API_KEY to transcribe audio, or upload an .srt/.vtt caption file.");
  const client = new OpenAI({ apiKey: e.OPENAI_API_KEY, baseURL: e.OPENAI_BASE_URL });
  const res = (await client.audio.transcriptions.create({
    file: await toFile(audio, filename, { type: "audio/mpeg" }),
    model: process.env.OPENAI_TRANSCRIBE_MODEL || "whisper-1",
    response_format: "verbose_json",
    timestamp_granularities: ["segment"],
  })) as unknown as { segments?: { start: number; end: number; text: string }[] };
  return (res.segments ?? []).map((s) => ({ start: s.start, end: s.end, text: s.text.trim() })).filter((s) => s.text);
}

/**
 * Transcribe a media file: extract compact mono audio with ffmpeg, split into chunks under the API
 * size limit, transcribe each, and offset timestamps back onto the source timeline.
 */
export async function transcribeFile(inputPath: string, durationSeconds: number): Promise<Segment[]> {
  const transcribe = (testTranscriber && env().NODE_ENV === "test" ? testTranscriber : null) ?? openAITranscribe;
  if (transcribe === openAITranscribe && !isTranscriptionConfigured()) {
    throw new NotConfiguredError("Automatic transcription", "Set OPENAI_API_KEY to transcribe audio, or upload an .srt/.vtt caption file.");
  }
  const dir = await mkdtemp(path.join(tmpdir(), "vos-stt-"));
  try {
    const all: Segment[] = [];
    for (let offset = 0; offset < Math.max(durationSeconds, 0.1); offset += CHUNK_SECONDS) {
      const out = path.join(dir, `chunk-${offset}.mp3`);
      await run(FFMPEG(), ["-v", "error", "-y", "-ss", String(offset), "-t", String(CHUNK_SECONDS), "-i", inputPath, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "32k", out], { timeout: 10 * 60_000 });
      const size = (await stat(out).catch(() => ({ size: 0 }))).size;
      if (size < 1024) continue; // no audio in this range
      const segs = await transcribe(await readFile(out), `chunk-${offset}.mp3`);
      for (const s of segs) all.push({ start: s.start + offset, end: s.end + offset, text: s.text });
    }
    return all.sort((a, b) => a.start - b.start);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
