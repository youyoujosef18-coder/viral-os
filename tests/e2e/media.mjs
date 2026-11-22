import { chromium } from "playwright-core";
import { execFileSync } from "node:child_process";
// Media, upload and auth hardening checks against a running app (npm run start).
// Usage: CHROME_PATH=/path/to/chrome npm run test:e2e:media
const B = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const errors = [];
const puts = [];
page.on("pageerror", (e) => errors.push(`PAGEERROR ${e.message.slice(0, 200)}`));
page.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && errors.push(`console: ${m.text().slice(0, 160)}`));
page.on("response", (r) => r.status() >= 500 && errors.push(`HTTP ${r.status()} ${r.url()}`));
page.on("request", (r) => r.method() === "PUT" && puts.push(r.url()));
let failed = 0;
const step = (n, ok, d = "") => { if (!ok) failed++; console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? ` — ${d}` : ""}`); };
const email = `media${Date.now()}@viralos.test`;

await page.goto(`${B}/signup`);
await page.fill("#displayName", "Media Tester");
await page.fill("#email", email);
await page.fill("#password", "media-password-123");
await page.click("button[type=submit]");
await page.waitForURL("**/overview", { timeout: 20000 });

// Upload through the real dialog: with local storage this now streams to the signed local endpoint.
await page.goto(`${B}/clips`);
await page.getByRole("button", { name: "Upload new" }).click();
await page.setInputFiles("input[type=file][multiple]", `${process.cwd()}/tests/fixtures/real/bbb.mp4`);
await page.getByRole("button", { name: /Upload 1 file/ }).click();
await page.getByText("Upload finished").waitFor({ timeout: 60000 });
const put = puts.find((u) => u.includes("/api/v1/media/local-upload/"));
step("dialog upload streamed to the signed local endpoint (no multipart)", !!put, put?.slice(0, 80));

const api = (url, init) => page.evaluate(async ([u, i]) => { const r = await fetch(u, i); const buf = await r.arrayBuffer(); return { status: r.status, headers: Object.fromEntries(r.headers.entries()), len: buf.byteLength, text: r.headers.get("content-type")?.includes("json") ? new TextDecoder().decode(buf) : "" }; }, [url, init]);
const list = JSON.parse((await api("/api/v1/media?kind=video")).text);
const asset = list.items.find((a) => a.filename === "bbb.mp4");
step("uploaded file registered and verified", !!asset && asset.mimeType === "video/mp4", asset ? `${asset.sizeBytes} bytes` : "missing");

const reuse = await page.evaluate(async (u) => (await fetch(u, { method: "PUT", body: "overwrite attempt" })).status, put);
step("a reused upload link can't overwrite the file", reuse === 409, String(reuse));
const again = await api("/api/v1/media", { method: "GET" });
step("original still intact after the reuse attempt", JSON.parse(again.text).items.find((a) => a.id === asset.id)?.sizeBytes === asset.sizeBytes);

const renamed = await api(`/api/v1/media/${asset.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filename: "فيديو العطلة.mp4" }) });
step("rename to an Arabic filename", renamed.status === 200);
const dl = await api(`/api/v1/media/${asset.id}/file?download=1`);
step("download works with the Arabic name", dl.status === 200 && dl.len === asset.sizeBytes && /filename\*=UTF-8''%D9%81/.test(dl.headers["content-disposition"] ?? ""), `${dl.status} ${dl.headers["content-disposition"]}`);
const r1 = await api(`/api/v1/media/${asset.id}/file`, { headers: { Range: "bytes=0-99" } });
step("range a-b", r1.status === 206 && r1.len === 100 && r1.headers["content-range"] === `bytes 0-99/${asset.sizeBytes}`);
const r2 = await api(`/api/v1/media/${asset.id}/file`, { headers: { Range: "bytes=-100" } });
step("suffix range -n", r2.status === 206 && r2.len === 100 && r2.headers["content-range"] === `bytes ${asset.sizeBytes - 100}-${asset.sizeBytes - 1}/${asset.sizeBytes}`);
const r3 = await api(`/api/v1/media/${asset.id}/file`, { headers: { Range: "bytes=50-10" } });
step("backwards range answers 416, not a server error", r3.status === 416, String(r3.status));
const playable = await page.evaluate(async (id) => { const v = document.createElement("video"); v.muted = true; v.src = `/api/v1/media/${id}/file`; document.body.append(v); await v.play(); await new Promise((r) => setTimeout(r, 1200)); const t = v.currentTime; v.remove(); return t; }, asset.id);
step("browser plays the streamed video", playable > 0.5, `t=${playable.toFixed(2)}`);

// Large multipart bodies are refused before parsing.
const cookie = (await context.cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
let code = "";
try {
  code = execFileSync("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "15", "-X", "POST", `${B}/api/v1/media`, "-H", `Cookie: ${cookie}`, "-H", `Origin: ${B}`, "-H", "Content-Type: multipart/form-data; boundary=x", "-H", "Content-Length: 200000000", "--data-binary", "--x--"], { encoding: "utf8" });
} catch (e) { code = String(e.stdout ?? ""); }
step("multipart over 100 MB refused with 413", code === "413", code);

// Login: open redirect blocked.
const fresh = await (await browser.newContext()).newPage();
await fresh.goto(`${B}/login?next=${encodeURIComponent("/\\evil.example/steal")}`);
await fresh.fill("#email", email);
await fresh.fill("#password", "media-password-123");
await fresh.click("button[type=submit]");
await fresh.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20000 });
step("login ?next=/\\evil.example stays on this site", new URL(fresh.url()).host === new URL(B).host && new URL(fresh.url()).pathname === "/overview", fresh.url());

// Login limit: rotating a spoofed X-Forwarded-For can't get around the per-email cap.
const victim = `victim${Date.now()}@viralos.test`;
let statuses = [];
for (let i = 0; i < 32; i++) {
  const r = await fetch(`${B}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": `10.9.${i}.1`, Origin: B }, body: JSON.stringify({ email: victim, password: "wrong-password" }) });
  statuses.push(r.status);
}
step("per-email login cap holds against IP rotation", statuses.slice(0, 30).every((s) => s === 401) && statuses.slice(30).every((s) => s === 429), statuses.slice(28).join(","));

console.log(errors.length ? `ERRORS:\n${errors.join("\n")}` : "NO BROWSER ERRORS");
await browser.close();
process.exit(failed || errors.length ? 1 : 0);
