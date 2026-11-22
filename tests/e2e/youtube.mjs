import { chromium } from "playwright-core";
// Usage: start tests/e2e/mock-youtube.mjs, then the app + worker with
//   YOUTUBE_API_KEY=e2e-key YOUTUBE_API_BASE_URL=http://127.0.0.1:4599/youtube/v3
// then: CHROME_PATH=/path/to/chrome npm run test:e2e:youtube
const B = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: B });
const page = await context.newPage();
const errors = [];
const mediaRequests = [];
page.on("pageerror", (e) => errors.push(`PAGEERROR ${e.message.slice(0, 200)}`));
page.on("console", (m) => m.type() === "error" && !/youtube\.com|ERR_|Failed to load resource/.test(m.text()) && errors.push(`console: ${m.text().slice(0, 160)}`));
page.on("request", (r) => /googlevideo\.com|videoplayback/.test(r.url()) && mediaRequests.push(r.url()));
let failed = 0;
const step = (n, ok, d = "") => { if (!ok) failed++; console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? ` — ${d}` : ""}`); };
const EMBED = /^https:\/\/www\.youtube\.com\/embed\/Mock1234567\?start=(\d+)&end=(\d+)$/;

await page.goto(`${B}/signup`);
await page.fill("#displayName", "YouTube Clipper");
await page.fill("#email", `yt${Date.now()}@viralos.test`);
await page.fill("#password", "clip-password-123");
await page.click("button[type=submit]");
await page.waitForURL("**/overview", { timeout: 20000 });

await page.goto(`${B}/clips`);
await page.getByRole("radio", { name: "A YouTube link" }).click();
step("YouTube source form shown", await page.getByText("The video is never downloaded.", { exact: false }).isVisible());
await page.getByRole("button", { name: "Find moments" }).click();
step("empty link is caught", await page.getByText("Paste the YouTube link.").isVisible());
await page.fill("#yt-url", "https://vimeo.com/12345");
await page.getByRole("button", { name: "Find moments" }).click();
await page.getByText(/isn't a YouTube video link/).waitFor({ timeout: 10000 });
step("non-YouTube link rejected by the server", true);

await page.fill("#yt-url", "https://youtu.be/Mock1234567");
await page.selectOption("#yt-n", "3");
await page.getByRole("button", { name: "Find moments" }).click();
await page.waitForURL(/\/clips\?job=/, { timeout: 20000 });
await page.getByText("Done", { exact: true }).waitFor({ timeout: 90000 });
await page.waitForFunction(() => document.querySelectorAll("article iframe").length >= 3, null, { timeout: 30000 });
const srcs = await page.locator("article iframe").evaluateAll((els) => els.map((e) => e.getAttribute("src")));
step("3 clips play in YouTube's official embed with whole-second start/end", srcs.length === 3 && srcs.every((s) => EMBED.test(s ?? "")), srcs.join(" | "));
step("job header shows the YouTube title and channel", await page.getByText("How we built a cabin in 10 days").first().isVisible() && await page.getByText(/from Cabin Builders/).isVisible());
step("notes explain the data used", await page.getByText(/Read 6 comments; 5 mention a timestamp/).isVisible());
step("viewer-timestamp timeline rendered", await page.getByLabel("Viewer timestamps across the video, with clips highlighted").isVisible());
const [s0, e0] = EMBED.exec(srcs[0]).slice(1).map(Number);
step("top clip covers the most-liked timestamp (3:12)", s0 <= 192 && e0 >= 192, `${s0}–${e0}`);
const watch = await page.locator("article").first().getByRole("link").first().getAttribute("href");
step("Watch on YouTube links to the start time", watch === `https://www.youtube.com/watch?v=Mock1234567&t=${s0}s`, watch);
await page.locator("article").first().getByRole("button", { name: "Copy link" }).click();
await page.getByText("Timestamp link copied").waitFor({ timeout: 5000 });
step("timestamp link copied", (await page.evaluate(() => navigator.clipboard.readText())) === watch);
step("no render or attach options for someone else's video", !(await page.getByRole("button", { name: "Render", exact: true }).count()) && !(await page.getByText("Render real clips from your original file").count()));

// Trim clip #1 in whole seconds: no re-render, the embed updates
await page.locator("article").first().getByRole("button", { name: "Edit" }).click();
await page.getByRole("button", { name: "start later" }).click();
await page.getByRole("button", { name: "start later" }).click();
const dialogSrc = await page.getByRole("dialog").locator("iframe").getAttribute("src");
step("edit dialog previews in the embed player", EMBED.test(dialogSrc ?? ""), dialogSrc);
await page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click();
await page.getByText("Clip saved").waitFor({ timeout: 10000 });
await page.waitForFunction((s) => document.querySelector("article iframe")?.getAttribute("src")?.includes(`start=${s + 2}&`), s0, { timeout: 10000 });
step("trim saved without a render", !(await page.getByText(/Waiting to render|Rendering/).count()), await page.locator("article iframe").first().getAttribute("src"));

// Add a clip by hand
await page.getByRole("button", { name: "Add a clip" }).click();
await page.fill("#m-start", "1:05");
await page.fill("#m-end", "0:30");
step("manual clip validation", await page.getByText("The end must be at least 1 second after the start.").isVisible());
await page.fill("#m-end", "1:40");
await page.getByRole("dialog").getByRole("button", { name: "Add clip" }).click();
await page.getByText("Clip added").waitFor({ timeout: 10000 });
await page.waitForFunction(() => document.querySelectorAll("article iframe").length >= 4, null, { timeout: 10000 });
const last = page.locator("article").last();
step("manual clip added and playable", (await last.locator("iframe").getAttribute("src")) === "https://www.youtube.com/embed/Mock1234567?start=65&end=100" && await last.getByText("Added by you, not scored.").isVisible());
step("job list labels the YouTube job", await page.getByRole("button", { name: /How we built a cabin in 10 days/ }).isVisible());
step("no request for YouTube media was made", mediaRequests.length === 0, mediaRequests.slice(0, 2).join(" "));
await page.screenshot({ path: "/tmp/clips-youtube.png", fullPage: false });

console.log(errors.length ? `ERRORS:\n${errors.join("\n")}` : "NO BROWSER ERRORS");
await browser.close();
process.exit(failed || errors.length ? 1 : 0);
