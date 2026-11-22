import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Segment } from "./transcript";

const run = promisify(execFile);
const FFMPEG = () => process.env.FFMPEG_PATH || "ffmpeg";

export type Aspect = "9:16" | "1:1" | "16:9";
export type Reframe = "auto" | "crop" | "blur" | "fit";
export type CaptionStyle = "bold" | "highlight" | "minimal";

export type RenderSettings = {
  aspect: Aspect;
  reframe: Reframe;
  /** Horizontal focus for crop mode: 0 = left edge, 0.5 = center, 1 = right edge. */
  focusX: number;
  quality: "720p" | "1080p";
  captions: boolean;
  captionStyle: CaptionStyle;
  uppercase: boolean;
  normalizeAudio: boolean;
};

export const DEFAULT_RENDER: RenderSettings = { aspect: "9:16", reframe: "auto", focusX: 0.5, quality: "720p", captions: true, captionStyle: "bold", uppercase: true, normalizeAudio: true };

export function outputSize(aspect: Aspect, quality: "720p" | "1080p") {
  const s = quality === "1080p" ? 1080 : 720;
  if (aspect === "9:16") return { w: s, h: Math.round((s * 16) / 9) };
  if (aspect === "1:1") return { w: s, h: s };
  return { w: Math.round((s * 16) / 9), h: s };
}

/** Auto: crop when the source is close to the target shape, otherwise fill with a blurred copy. */
export function resolveReframe(reframe: Reframe, srcW: number, srcH: number, aspect: Aspect): Exclude<Reframe, "auto"> {
  if (reframe !== "auto") return reframe;
  const src = srcW / Math.max(1, srcH);
  const dst = aspect === "9:16" ? 9 / 16 : aspect === "1:1" ? 1 : 16 / 9;
  return Math.abs(Math.log(src / dst)) < 0.35 ? "crop" : "blur";
}

/** ffmpeg filter_complex producing [v] at W×H. */
export function videoFilter(mode: Exclude<Reframe, "auto">, w: number, h: number, focusX: number, duration: number, assPath?: string) {
  const fx = Math.max(0, Math.min(1, focusX)).toFixed(3);
  let chain: string;
  if (mode === "crop") chain = `[0:v]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}:x=(iw-${w})*${fx}:y=(ih-${h})/2,setsar=1`;
  else if (mode === "fit") chain = `[0:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`;
  else chain = `[0:v]split=2[bgsrc][fgsrc];[bgsrc]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},boxblur=20:2,eq=brightness=-0.08[bg];[fgsrc]scale=${w}:${h}:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1`;
  const fadeOut = Math.max(0, duration - 0.3).toFixed(3);
  chain += `,fade=t=in:st=0:d=0.2,fade=t=out:st=${fadeOut}:d=0.3`;
  if (assPath) chain += `,subtitles='${assPath.replace(/\\/g, "/").replace(/'/g, "\\'").replace(/:/g, "\\:")}'`;
  return `${chain},format=yuv420p[v]`;
}

const assTime = (t: number) => {
  const cs = Math.max(0, Math.round(t * 100));
  const h = Math.floor(cs / 360000), m = Math.floor((cs % 360000) / 6000), s = Math.floor((cs % 6000) / 100), c = cs % 100;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(c).padStart(2, "0")}`;
};

/** Escape caption text for ASS: braces start override blocks and backslashes start escapes. */
export const assEscape = (s: string) => s.replace(/\\/g, "\\\\").replace(/\{/g, "(").replace(/\}/g, ")").replace(/\n/g, " ");

/**
 * Split each caption cue into short word groups (≤3 words, ≤18 chars) timed proportionally to their
 * character length inside the cue. Short groups read better on phones than full subtitle lines.
 */
export function captionChunks(segments: Segment[], maxWords = 3, maxChars = 18): Segment[] {
  const out: Segment[] = [];
  for (const seg of segments) {
    const words = seg.text.split(/\s+/).filter(Boolean);
    const groups: string[] = [];
    let cur: string[] = [];
    for (const word of words) {
      const next = [...cur, word].join(" ");
      if (cur.length && (cur.length >= maxWords || next.length > maxChars)) {
        groups.push(cur.join(" "));
        cur = [word];
      } else cur.push(word);
      if (/[.!?,;:]$/.test(word) && cur.length) {
        groups.push(cur.join(" "));
        cur = [];
      }
    }
    if (cur.length) groups.push(cur.join(" "));
    const total = groups.reduce((a, g) => a + g.length, 0) || 1;
    let t = seg.start;
    const span = seg.end - seg.start;
    for (const g of groups) {
      const d = (span * g.length) / total;
      out.push({ start: t, end: t + d, text: g });
      t += d;
    }
  }
  return out;
}

export function buildAss(segments: Segment[], w: number, h: number, style: CaptionStyle, uppercase: boolean) {
  const vertical = h > w;
  const size = Math.round(w * (style === "minimal" ? 0.055 : vertical ? 0.085 : 0.05));
  const marginV = Math.round(h * (vertical ? 0.22 : 0.08));
  // ASS colours are &HAABBGGRR
  const primary = style === "highlight" ? "&H0000E5FF" : "&H00FFFFFF";
  const outline = style === "minimal" ? 2 : Math.max(3, Math.round(size / 12));
  const borderStyle = style === "minimal" ? 3 : 1; // 3 = opaque box behind text
  const back = style === "minimal" ? "&H99000000" : "&H80000000";
  const header = [
    "[Script Info]", "ScriptType: v4.00+", `PlayResX: ${w}`, `PlayResY: ${h}`, "WrapStyle: 0", "ScaledBorderAndShadow: yes", "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Cap,DejaVu Sans,${size},${primary},&H000000FF,&H00000000,${back},-1,0,0,0,100,100,0,0,${borderStyle},${outline},${style === "minimal" ? 0 : 1},2,${Math.round(w * 0.08)},${Math.round(w * 0.08)},${marginV},1`,
    "", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  const chunks = style === "minimal" ? segments : captionChunks(segments);
  const lines = chunks.map((c) => `Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Cap,,0,0,0,,${style === "minimal" ? "" : "{\\fad(60,0)}"}${assEscape(uppercase ? c.text.toUpperCase() : c.text)}`);
  return [...header, ...lines, ""].join("\n");
}

export type RenderResult = { file: string; thumbnail: string; width: number; height: number; duration: number; mode: Exclude<Reframe, "auto">; cleanup: () => Promise<void> };

/**
 * Render [start, end] of `input` to an H.264/AAC MP4 with reframing, optional burned captions
 * (segments relative to the clip start), fades and loudness normalization to -14 LUFS.
 */
export async function renderClip(input: string, src: { width: number; height: number; hasAudio: boolean }, start: number, end: number, settings: RenderSettings, captions: Segment[] | null): Promise<RenderResult> {
  const duration = Math.max(0.5, end - start);
  const { w, h } = outputSize(settings.aspect, settings.quality);
  const mode = resolveReframe(settings.reframe, src.width, src.height, settings.aspect);
  const dir = await mkdtemp(path.join(tmpdir(), "vos-clip-"));
  try {
    let assPath: string | undefined;
    if (settings.captions && captions?.length) {
      assPath = path.join(dir, "captions.ass");
      await writeFile(assPath, buildAss(captions, w, h, settings.captionStyle, settings.uppercase), "utf8");
    }
    const out = path.join(dir, "clip.mp4");
    const args = ["-v", "error", "-y", "-ss", start.toFixed(3), "-i", input, "-t", duration.toFixed(3), "-filter_complex", videoFilter(mode, w, h, settings.focusX, duration, assPath), "-map", "[v]"];
    if (src.hasAudio) {
      const af = [`afade=t=in:st=0:d=0.15`, `afade=t=out:st=${Math.max(0, duration - 0.3).toFixed(3)}:d=0.3`];
      if (settings.normalizeAudio) af.push("loudnorm=I=-14:TP=-1.5:LRA=11");
      args.push("-map", "0:a:0", "-af", af.join(","), "-c:a", "aac", "-b:a", "128k", "-ar", "48000");
    }
    args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-r", "30", "-movflags", "+faststart", out);
    await run(FFMPEG(), args, { timeout: Math.round(Math.max(120_000, duration * 20_000)), maxBuffer: 20 * 1024 * 1024 });
    const thumbnail = path.join(dir, "thumb.jpg");
    await run(FFMPEG(), ["-v", "error", "-y", "-ss", Math.min(1, duration / 2).toFixed(2), "-i", out, "-frames:v", "1", "-q:v", "3", thumbnail], { timeout: 60_000 });
    return { file: out, thumbnail, width: w, height: h, duration, mode, cleanup: () => rm(dir, { recursive: true, force: true }) };
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    const e = err as { stderr?: string; message: string };
    throw new Error(`Rendering failed: ${(e.stderr || e.message).trim().split("\n").slice(-3).join(" ")}`);
  }
}
