import { chromium } from "playwright-core";
// Usage: start the app + worker, run `npm run fixtures:fetch`, then: CHROME_PATH=/path/to/chrome npm run test:e2e:clips
const B = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(`PAGEERROR ${e.message.slice(0, 200)}`));
page.on("console", (m) => m.type() === "error" && errors.push(`console: ${m.text().slice(0, 160)}`));
const step = (n, ok, d = "") => console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? ` — ${d}` : ""}`);
const t0 = Date.now();

await page.goto(`${B}/signup`);
await page.fill("#displayName", "Clip Tester");
await page.fill("#email", `clip${Date.now()}@viralos.test`);
await page.fill("#password", "clip-password-123");
await page.click("button[type=submit]");
await page.waitForURL("**/overview", { timeout: 20000 });

await page.goto(`${B}/clips`);
step("Clip Studio is in navigation", await page.getByRole("link", { name: "Clip Studio" }).isVisible());
// Validation before anything is chosen
await page.getByRole("button", { name: "Find clips" }).click();
step("form validation shown", await page.getByText("Choose the video to clip.").isVisible());

// Upload the REAL Sintel video through the media picker's upload dialog
await page.getByRole("button", { name: "Upload new" }).click();
await page.setInputFiles("input[type=file][multiple]", `${process.cwd()}/tests/fixtures/real/sintel-short.mp4`);
await page.getByRole("button", { name: /Upload 1 file/ }).click();
await page.getByText("Upload finished").waitFor({ timeout: 60000 });
step("real 22 MB Sintel video uploaded through the UI", await page.getByText("sintel-short.mp4").first().isVisible());

// Use the real caption file
await page.getByRole("button", { name: /Upload captions/ }).click();
await page.setInputFiles("input[aria-label='Caption file']", `${process.cwd()}/tests/fixtures/real/sintel-en.vtt`);
step("caption file read in the browser", await page.getByText(/sintel-en\.vtt \(14 cues\)/).waitFor({ timeout: 10000 }).then(() => true, () => false));
await page.selectOption("#cl-len", "custom");
await page.fill("#cl-min", "8");
await page.fill("#cl-max", "25");
await page.selectOption("#cl-n", "3");
await page.getByRole("button", { name: "Find clips" }).click();
await page.waitForURL(/\/clips\?job=/, { timeout: 20000 });
step("clip job created", true);

// The worker picks it up via Redis; wait for completion
await page.getByText("Done", { exact: true }).waitFor({ timeout: 180000 });
const videos = page.locator("article video[controls]");
await page.waitForFunction(() => document.querySelectorAll("article video[controls]").length >= 3, null, { timeout: 120000 });
step("worker analyzed and rendered 3 clips", (await videos.count()) === 3, `${Math.round((Date.now() - t0) / 1000)}s total`);
step("timeline chart rendered", await page.getByLabel("Loudness timeline with clip positions").isVisible());
step("first clip title from real dialogue", await page.locator("article h3").first().textContent().then((t) => !!t && t.length > 3), await page.locator("article h3").first().textContent());

// Play a rendered clip in the browser
const playable = await videos.first().evaluate(async (v) => { v.muted = true; await v.play(); await new Promise((r) => setTimeout(r, 1200)); const ok = v.currentTime > 0.5 && v.videoWidth === 720 && v.videoHeight === 1280; v.pause(); return { ok, t: v.currentTime, w: v.videoWidth, h: v.videoHeight }; });
step("rendered clip plays in the browser at 720×1280", playable.ok, JSON.stringify(playable));

// Trim and re-render clip #1
await page.locator("article").first().getByRole("button", { name: "Edit" }).click();
await page.getByRole("button", { name: "start later" }).click();
await page.getByRole("button", { name: "start later" }).click();
await page.getByRole("button", { name: "Save and re-render" }).click();
await page.getByText(/Waiting to render|Rendering/).first().waitFor({ timeout: 15000 });
step("trim queued a re-render", true);
await page.waitForFunction(() => document.querySelectorAll("article video[controls]").length >= 3, null, { timeout: 120000 });
step("re-render finished", true);

// Create a draft post from the clip
await page.locator("article").first().getByRole("button", { name: "Create post" }).click();
await page.waitForURL(/\/publishing\?post=/, { timeout: 20000 });
await page.waitForTimeout(1500);
step("draft post created from clip and opened in Publishing Center", await page.getByRole("dialog").isVisible());

console.log(errors.length ? `ERRORS:\n${errors.join("\n")}` : "NO BROWSER ERRORS");
await browser.close();
