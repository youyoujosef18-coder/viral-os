import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseSceneTimes } from "../services/analyzer";

const run = promisify(execFile);
const FFMPEG = () => process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = () => process.env.FFPROBE_PATH || "ffprobe";

/** Loudness window size in seconds. */
export const WINDOW = 0.5;
export const SILENCE_DB = -35;

export type ProbeResult = { duration: number; width: number; height: number; fps: number | null; hasAudio: boolean; hasVideo: boolean };

export type Signals = {
  /** RMS level in dBFS per WINDOW seconds (index i covers [i*WINDOW, (i+1)*WINDOW)). -90 for digital silence. */
  loudness: number[];
  silences: { start: number; end: number }[];
  cuts: number[];
};

export async function probe(file: string): Promise<ProbeResult> {
  const { stdout } = await run(FFPROBE(), ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file], { timeout: 60_000, maxBuffer: 10 * 1024 * 1024 });
  const j = JSON.parse(stdout) as { format?: { duration?: string }; streams?: { codec_type: string; width?: number; height?: number; r_frame_rate?: string; duration?: string }[] };
  const v = j.streams?.find((s) => s.codec_type === "video");
  const a = j.streams?.find((s) => s.codec_type === "audio");
  const [n, d] = (v?.r_frame_rate ?? "0/1").split("/").map(Number);
  return {
    duration: Number(j.format?.duration ?? v?.duration ?? 0),
    width: v?.width ?? 0,
    height: v?.height ?? 0,
    fps: d ? n / d : null,
    hasAudio: !!a,
    hasVideo: !!v,
  };
}

/** Parse `ametadata=print` output of astats RMS levels. */
export function parseRmsLevels(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/lavfi\.astats\.Overall\.RMS_level=(-?inf|-?[\d.]+)/g)) {
    const v = m[1].includes("inf") ? -90 : Number(m[1]);
    out.push(Math.max(-90, Math.min(0, v)));
  }
  return out;
}

/** Parse silencedetect stderr into intervals (open-ended final silence is closed at `duration`). */
export function parseSilences(stderr: string, duration: number) {
  const out: { start: number; end: number }[] = [];
  let open: number | null = null;
  for (const line of stderr.split("\n")) {
    const s = /silence_start:\s*(-?[\d.]+)/.exec(line);
    if (s) open = Math.max(0, Number(s[1]));
    const e = /silence_end:\s*([\d.]+)/.exec(line);
    if (e && open !== null) {
      out.push({ start: open, end: Number(e[1]) });
      open = null;
    }
  }
  if (open !== null) out.push({ start: open, end: duration });
  return out;
}

/**
 * Measure audio loudness, silences and scene cuts. Two ffmpeg passes: audio (decoded at 16 kHz mono)
 * and video (downscaled to 320px wide) so analysis stays fast on long sources.
 */
export async function analyzeSignals(file: string, info: ProbeResult): Promise<Signals> {
  let loudness: number[] = [];
  let silences: { start: number; end: number }[] = [];
  if (info.hasAudio) {
    const samples = Math.round(16000 * WINDOW);
    const { stdout, stderr } = await run(
      FFMPEG(),
      ["-hide_banner", "-nostats", "-i", file, "-vn", "-af", `aresample=16000,aformat=channel_layouts=mono,asetnsamples=n=${samples}:p=0,astats=metadata=1:reset=1,ametadata=mode=print:key=lavfi.astats.Overall.RMS_level:file=-,silencedetect=noise=${SILENCE_DB}dB:d=0.4`, "-f", "null", "-"],
      { timeout: 30 * 60_000, maxBuffer: 200 * 1024 * 1024 },
    );
    loudness = parseRmsLevels(stdout);
    silences = parseSilences(stderr, info.duration);
  }
  let cuts: number[] = [];
  if (info.hasVideo) {
    const res = await run(FFMPEG(), ["-hide_banner", "-nostats", "-i", file, "-an", "-vf", "scale=320:-2,select='gt(scene,0.3)',showinfo", "-f", "null", "-"], { timeout: 30 * 60_000, maxBuffer: 200 * 1024 * 1024 }).catch((e: { stderr?: string }) => ({ stderr: String(e.stderr ?? "") }));
    cuts = parseSceneTimes(res.stderr);
  }
  return { loudness, silences, cuts };
}

/** Downsample loudness to at most `points` values for charts (mean of buckets). */
export function summarizeLoudness(loudness: number[], points = 240) {
  if (loudness.length <= points) return loudness.map((v, i) => ({ t: Number((i * WINDOW).toFixed(2)), db: Number(v.toFixed(1)) }));
  const size = loudness.length / points;
  const out: { t: number; db: number }[] = [];
  for (let i = 0; i < points; i++) {
    const slice = loudness.slice(Math.floor(i * size), Math.floor((i + 1) * size));
    out.push({ t: Number((Math.floor(i * size) * WINDOW).toFixed(2)), db: Number((slice.reduce((a, b) => a + b, 0) / slice.length).toFixed(1)) });
  }
  return out;
}
