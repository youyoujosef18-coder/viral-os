/**
 * Downloads the real videos used by the clipping tests into tests/fixtures/real and verifies SHA-256.
 *   npm run fixtures:fetch
 * Sources (openly licensed):
 *  - Sintel (Blender Foundation, CC BY 3.0) excerpt + English WebVTT captions, as used in MDN's
 *    "Adding captions and subtitles to HTML video" guide (github.com/iandevlin/iandevlin.github.io)
 *  - Big Buck Bunny (Blender Foundation, CC BY 3.0) 60 s excerpt (github.com/mediaelement/mediaelement-files)
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const DIR = path.join(process.cwd(), "tests/fixtures/real");
const MDN = "https://raw.githubusercontent.com/iandevlin/iandevlin.github.io/master/mdn/video-player-with-captions";
export const FIXTURES = [
  { file: "sintel-short.mp4", url: `${MDN}/video/sintel-short.mp4`, sha256: "358447f332663e6f3794816e32b8072526fcba8bf8744dc7fb3387afb5b2fceb" },
  { file: "sintel-en.vtt", url: `${MDN}/subtitles/vtt/sintel-en.vtt`, sha256: "b355dbf4a639e335872e719e3927a37c877375a6c37fbaf9207fbd165c153898" },
  { file: "bbb.mp4", url: "https://raw.githubusercontent.com/mediaelement/mediaelement-files/master/big_buck_bunny.mp4", sha256: "543a4ad9fef4c9e0004ec9482cb7225c2574b0f889291e8270b1c4d61dbc1ab8" },
];

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

async function main() {
  mkdirSync(DIR, { recursive: true });
  for (const f of FIXTURES) {
    const dest = path.join(DIR, f.file);
    if (existsSync(dest) && sha(readFileSync(dest)) === f.sha256) {
      console.log(`✓ ${f.file} (cached)`);
      continue;
    }
    const res = await fetch(f.url);
    if (!res.ok) throw new Error(`${f.file}: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (sha(buf) !== f.sha256) throw new Error(`${f.file}: checksum mismatch (source changed?)`);
    writeFileSync(dest, buf);
    console.log(`✓ ${f.file} (${(buf.length / 1e6).toFixed(1)} MB)`);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
