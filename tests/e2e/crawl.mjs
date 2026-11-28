import { chromium } from "playwright-core";
import { execSync } from "node:child_process";
// Loads every page as a signed-in user (and as the owner for owner pages), clicks every tab, and fails on
// browser errors, failed requests or server errors. Usage: start the app, then npm run test:e2e:crawl
const B = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const pages = execSync("find src/app -name page.tsx", { encoding: "utf8" }).trim().split("\n")
  .map((f) => f.replace("src/app", "").replace("/page.tsx", "").replace(/\/\([^)]*\)/g, "") || "/")
  .filter((p) => !p.includes("["));
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const problems = [];
let current = "";
async function session(email, password, name) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => problems.push(`${current}: PAGEERROR ${e.message.slice(0, 160)}`));
  p.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && problems.push(`${current}: console ${m.text().slice(0, 160)}`));
  p.on("response", (r) => {
    const u = new URL(r.url());
    if (u.origin !== B) return;
    const okNotConfigured = r.status() === 503 || r.status() === 502;
    if (r.status() >= 500 && !okNotConfigured) problems.push(`${current}: HTTP ${r.status()} ${u.pathname}`);
  });
  p.on("requestfailed", (r) => { if (r.url().startsWith(B) && !/ERR_ABORTED/.test(r.failure()?.errorText ?? "")) problems.push(`${current}: request failed ${r.url()} ${r.failure()?.errorText}`); });
  await p.goto(`${B}/signup`);
  await p.fill("#displayName", name);
  await p.fill("#email", email);
  await p.fill("#password", password);
  await p.click("button[type=submit]");
  await Promise.race([p.waitForURL("**/overview", { timeout: 20000 }), p.getByText("already exists").waitFor({ timeout: 20000 })]).catch(() => {});
  if (!p.url().includes("/overview")) {
    await p.goto(`${B}/login`); await p.fill("#email", email); await p.fill("#password", password); await p.click("button[type=submit]");
    await p.waitForURL("**/overview", { timeout: 20000 });
  }
  return p;
}
async function visit(p, path, label) {
  current = `${label} ${path}`;
  await p.goto(B + path, { waitUntil: "networkidle" }).catch((e) => problems.push(`${current}: navigation ${e.message.slice(0, 120)}`));
  await p.waitForTimeout(600);
  const tabs = await p.getByRole("tab").all();
  for (const t of tabs) {
    if (await t.isVisible().catch(() => false)) { await t.click().catch(() => {}); await p.waitForTimeout(400); }
  }
  console.log(`visited ${label} ${path} (${tabs.length} tabs)`);
}
const user = await session(`crawl${Date.now()}@viralos.test`, "crawl-password-123", "Crawler");
for (const path of pages.filter((p) => !["/login", "/signup", "/auth/callback", "/"].includes(p))) await visit(user, path, "user");
const owner = await session(process.env.E2E_OWNER_EMAIL ?? "owner-e2e@viralos.test", "owner-password-123", "Workspace Owner");
for (const path of ["/admin", "/overview", "/settings"]) await visit(owner, path, "owner");
const anon = await (await browser.newContext()).newPage();
anon.on("pageerror", (e) => problems.push(`${current}: PAGEERROR ${e.message.slice(0, 160)}`));
for (const path of ["/login", "/signup", "/signup?invite=bogus", "/nonexistent-page"]) { current = `anon ${path}`; await anon.goto(B + path); await anon.waitForTimeout(800); console.log(`visited anon ${path}`); }
console.log(problems.length ? `PROBLEMS:\n${[...new Set(problems)].join("\n")}` : "NO PROBLEMS");
await browser.close();
process.exit(problems.length ? 1 : 0);
