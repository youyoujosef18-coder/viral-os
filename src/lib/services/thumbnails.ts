import sharp from "sharp";
import { z } from "zod";
import { schema, withUser } from "../db/client";
import { generateStructured } from "../providers/ai";
import { assertOwned } from "./ownership";

/** WCAG relative luminance contrast ratio between two hex colors. */
export function contrastRatio(hexA: string, hexB: string) {
  const lum = (hex: string) => {
    const n = hex.replace("#", "");
    const full = n.length === 3 ? n.split("").map((c) => c + c).join("") : n;
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [a, b] = [lum(hexA), lum(hexB)].sort((x, y) => y - x);
  return Number(((a + 0.05) / (b + 0.05)).toFixed(2));
}

/**
 * Measured image analysis (no AI): brightness, RMS contrast, colorfulness (Hasler–Süsstrunk),
 * edge density at full size vs mobile size (detail loss), dominant colors, and a visual
 * hierarchy heuristic (how concentrated edge energy is, and whether its centroid sits near
 * a rule-of-thirds intersection).
 */
export async function analyzeImage(buf: Buffer, overlay?: { textColor?: string; backgroundColor?: string; text?: string }) {
  const meta = await sharp(buf).metadata();
  const W = 320, H = 180;
  const { data: rgb } = await sharp(buf).resize(W, H, { fit: "cover" }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const n = W * H;
  const gray = new Float32Array(n);
  let sum = 0, rgSum = 0, ybSum = 0, rgSq = 0, ybSq = 0;
  for (let i = 0; i < n; i++) {
    const r = rgb[i * 3], g = rgb[i * 3 + 1], b = rgb[i * 3 + 2];
    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    gray[i] = y;
    sum += y;
    const rg = r - g, yb = 0.5 * (r + g) - b;
    rgSum += rg; ybSum += yb; rgSq += rg * rg; ybSq += yb * yb;
  }
  const mean = sum / n;
  let varSum = 0;
  for (let i = 0; i < n; i++) varSum += (gray[i] - mean) ** 2;
  const rmsContrast = Math.sqrt(varSum / n) / 255;
  const rgMean = rgSum / n, ybMean = ybSum / n;
  const colorfulness = Math.sqrt(rgSq / n - rgMean ** 2 + (ybSq / n - ybMean ** 2)) + 0.3 * Math.sqrt(rgMean ** 2 + ybMean ** 2);

  const edgesAt = (g: Float32Array, w: number, h: number) => {
    const mag = new Float32Array(w * h);
    let strong = 0;
    for (let y = 1; y < h - 1; y++)
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const gx = -g[i - w - 1] - 2 * g[i - 1] - g[i + w - 1] + g[i - w + 1] + 2 * g[i + 1] + g[i + w + 1];
        const gy = -g[i - w - 1] - 2 * g[i - w] - g[i - w + 1] + g[i + w - 1] + 2 * g[i + w] + g[i + w + 1];
        const m = Math.hypot(gx, gy);
        mag[i] = m;
        if (m > 120) strong++;
      }
    return { mag, density: strong / (w * h) };
  };
  const full = edgesAt(gray, W, H);
  const { data: small } = await sharp(buf).resize(168, 94, { fit: "cover" }).greyscale().raw().toBuffer({ resolveWithObject: true });
  const smallEdges = edgesAt(Float32Array.from(small), 168, 94);
  const detailRetention = full.density > 0 ? Math.min(1.5, smallEdges.density / full.density) : 0;

  let cx = 0, cy = 0, total = 0;
  const cell = new Float32Array(9);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const m = full.mag[y * W + x];
      cx += m * x; cy += m * y; total += m;
      cell[Math.min(2, Math.floor((3 * y) / H)) * 3 + Math.min(2, Math.floor((3 * x) / W))] += m;
    }
  const centroid = total ? { x: cx / total / W, y: cy / total / H } : { x: 0.5, y: 0.5 };
  const thirds = [[1 / 3, 1 / 3], [2 / 3, 1 / 3], [1 / 3, 2 / 3], [2 / 3, 2 / 3]];
  const thirdsDistance = Math.min(...thirds.map(([tx, ty]) => Math.hypot(centroid.x - tx, centroid.y - ty)));
  const maxCell = Math.max(...cell) / (total || 1);
  const focus = Math.min(1, Math.max(0, (maxCell - 1 / 9) / (0.4 - 1 / 9)));

  const { dominant } = await sharp(buf).stats();
  const hex = (c: { r: number; g: number; b: number }) => `#${[c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;

  const contrastScore = Math.round(Math.min(100, (rmsContrast / 0.3) * 100));
  const mobileScore = Math.round(Math.min(100, 100 * (0.5 * Math.min(1, detailRetention) + 0.5 * Math.min(1, rmsContrast / 0.25))) - (full.density > 0.35 ? 15 : 0));
  const hierarchyScore = Math.round(100 * (0.6 * focus + 0.4 * Math.max(0, 1 - thirdsDistance / 0.35)));

  const textChecks: { label: string; value: string; pass: boolean }[] = [];
  if (overlay?.textColor && overlay?.backgroundColor) {
    const ratio = contrastRatio(overlay.textColor, overlay.backgroundColor);
    textChecks.push({ label: "Text/background contrast (WCAG)", value: `${ratio}:1`, pass: ratio >= 4.5 });
  }
  if (overlay?.text) {
    const words = overlay.text.trim().split(/\s+/).filter(Boolean).length;
    textChecks.push({ label: "Overlay word count", value: `${words} words`, pass: words <= 5 });
  }

  const recommendations: string[] = [];
  if (contrastScore < 50) recommendations.push("Increase overall contrast: darken the background or brighten the subject so it separates at small sizes.");
  if (mobileScore < 55) recommendations.push("Too much fine detail is lost at mobile size. Simplify the background and enlarge the main subject/text.");
  if (hierarchyScore < 45) recommendations.push("No clear focal point. Make one element dominant and place it near a rule-of-thirds intersection.");
  if (colorfulness < 25) recommendations.push("Colors are muted; a saturated accent color can help the thumbnail stand out in a feed.");
  if (mean < 60) recommendations.push("Image is very dark overall; thumbnails are often viewed on small, bright screens.");
  for (const t of textChecks) if (!t.pass) recommendations.push(t.label.startsWith("Overlay") ? "Keep overlay text to 5 words or fewer for mobile readability." : "Overlay text contrast is below 4.5:1; choose a lighter/darker text color or add an outline/shadow.");

  return {
    method: "Measured with image processing (sharp): no AI involved in these scores.",
    width: meta.width ?? null,
    height: meta.height ?? null,
    aspectRatio: meta.width && meta.height ? Number((meta.width / meta.height).toFixed(3)) : null,
    is16by9: meta.width && meta.height ? Math.abs(meta.width / meta.height - 16 / 9) < 0.02 : null,
    brightness: Math.round((mean / 255) * 100),
    rmsContrast: Number(rmsContrast.toFixed(3)),
    colorfulness: Math.round(colorfulness),
    edgeDensity: Number(full.density.toFixed(3)),
    detailRetentionAtMobile: Number(detailRetention.toFixed(2)),
    focalPoint: { x: Number(centroid.x.toFixed(2)), y: Number(centroid.y.toFixed(2)) },
    dominantColor: hex(dominant),
    scores: { contrast: contrastScore, mobileReadability: Math.max(0, mobileScore), visualHierarchy: hierarchyScore },
    textChecks,
    recommendations,
  };
}

const conceptSchema = z.object({
  concepts: z.array(z.object({
    name: z.string(),
    composition: z.string(),
    overlayText: z.string(),
    colorPalette: z.array(z.string()),
    emotion: z.string(),
    imagePrompt: z.string(),
    pairedTitle: z.string(),
    whyItWorks: z.string(),
  })).min(1).max(6),
});

export async function generateConcepts(userId: string, input: { title: string; topic: string; style?: string; projectId?: string | null }) {
  await assertOwned(userId, { projects: [input.projectId] });
  const { data, provider, model } = await generateStructured(conceptSchema, {
    system: "You are a thumbnail art director. Produce ORIGINAL concepts. Never suggest misleading imagery that misrepresents the video, fake reactions to things that don't happen, or copying another creator's thumbnail. Overlay text max 5 words. Colors as hex.",
    prompt: `Video title: ${input.title}\nTopic: ${input.topic}\nStyle preference: ${input.style ?? "bold, clean, high contrast"}\nGive 4 distinct concepts with an image-generation prompt each (describe scene, subject, lighting, composition; no text in the image itself) and a title that pairs with it without repeating the overlay text.`,
    shapeHint: `{"concepts":[{"name":string,"composition":string,"overlayText":string,"colorPalette":[string],"emotion":string,"imagePrompt":string,"pairedTitle":string,"whyItWorks":string}]}`,
  });
  const rows = await withUser(userId, (tx) =>
    tx.insert(schema.thumbnails).values(data.concepts.map((c) => ({ userId, projectId: input.projectId ?? null, kind: "concept", title: c.name, overlayText: c.overlayText, prompt: c.imagePrompt, concept: { ...c, provider, model } }))).returning(),
  );
  return rows;
}
