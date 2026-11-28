import { chromium } from "playwright-core";
// Owner console end to end. Start the app with OWNER_EMAIL=$E2E_OWNER_EMAIL (default below) and run:
//   CHROME_PATH=/path/to/chrome npm run test:e2e:admin
const B = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const OWNER = process.env.E2E_OWNER_EMAIL ?? "owner-e2e@viralos.test";
const stamp = Date.now();
const owner = { email: OWNER, password: "owner-password-123", name: "Workspace Owner" };
const member = { email: `member${stamp}@viralos.test`, password: "member-password-123", name: "Invited Member" };
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const errors = [];
let failed = 0;
const step = (n, ok, d = "") => { if (!ok) failed++; console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? ` — ${d}` : ""}`); };
async function newPage() {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(`PAGEERROR ${e.message.slice(0, 200)}`));
  p.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && errors.push(`console: ${m.text().slice(0, 160)}`));
  p.on("response", (r) => r.status() >= 500 && errors.push(`HTTP ${r.status()} ${r.url()}`));
  return p;
}
const status = (p, url, init) => p.evaluate(async ([u, i]) => (await fetch(u, i)).status, [url, init]);
async function signIn(p, who) {
  await p.goto(`${B}/login`);
  await p.fill("#email", who.email);
  await p.fill("#password", who.password);
  await p.click("button[type=submit]");
}

// --- owner signs up (OWNER_EMAIL) or signs in if the account already exists
const o = await newPage();
await o.goto(`${B}/signup`);
await o.fill("#displayName", owner.name);
await o.fill("#email", owner.email);
await o.fill("#password", owner.password);
await o.click("button[type=submit]");
await Promise.race([o.waitForURL("**/overview", { timeout: 20000 }), o.getByText("already exists").waitFor({ timeout: 20000 })]);
if (!o.url().includes("/overview")) { await signIn(o, owner); await o.waitForURL("**/overview", { timeout: 20000 }); }
await o.getByRole("link", { name: "Owner console" }).waitFor({ timeout: 10000 });
step("OWNER_EMAIL account is owner and sees Owner console", true);
// Start from open sign-up whatever an earlier run left behind.
await o.evaluate(() => fetch("/api/v1/admin/settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ signupMode: "open" }) }));
await o.getByRole("link", { name: "Owner console" }).click();
await o.waitForURL("**/admin");
step("users list shows the owner", await o.getByRole("cell", { name: new RegExp(owner.email) }).first().waitFor({ timeout: 10000 }).then(() => true, () => false));

// --- invite only + email-bound invite
await o.getByRole("tab", { name: "Sign-up and invites" }).click();
await o.getByRole("radio", { name: /Invite only/ }).click();
await o.getByText("Sign-up setting saved").waitFor({ timeout: 10000 });
await o.getByRole("button", { name: "Create invite" }).first().click();
await o.fill("#inv-email", member.email);
await o.getByRole("dialog").getByRole("button", { name: "Create invite" }).click();
const inviteUrl = await o.getByLabel("Invite link").inputValue({ timeout: 10000 });
step("invite link created and shown once", /\/signup\?invite=/.test(inviteUrl), inviteUrl.replace(/invite=.*/, "invite=…"));
await o.getByRole("button", { name: "Done" }).click();
step("invite listed as active", await o.getByRole("cell", { name: member.email }).isVisible() && await o.getByText("Active").first().isVisible());

// --- visitor without invite is refused; with invite gets in
const m = await newPage();
await m.goto(`${B}/signup`);
step("invite-only sign-up asks for an invite link", await m.getByLabel("Invite link").waitFor({ timeout: 10000 }).then(() => true, () => false));
await m.fill("#displayName", "Gatecrasher");
await m.fill("#email", `crash${stamp}@viralos.test`);
await m.fill("#password", "crash-password-123");
await m.click("button[type=submit]");
await m.getByText(/by invitation only/).waitFor({ timeout: 10000 });
step("sign-up without an invite is refused", true);
await m.goto(inviteUrl.replace(/^https?:\/\/[^/]+/, B));
await m.getByText(`This invite is for ${member.email}`).waitFor({ timeout: 10000 });
step("invite page names the invited email and locks it", (await m.inputValue("#email")) === member.email && (await m.getAttribute("#email", "readonly")) !== null);
await m.fill("#displayName", member.name);
await m.fill("#password", member.password);
await m.click("button[type=submit]");
await m.waitForURL("**/overview", { timeout: 20000 });
step("invited member signed up", true);
step("member does not see Owner console", (await m.getByRole("link", { name: "Owner console" }).count()) === 0);
step("member gets 403 from owner API", (await status(m, "/api/v1/admin/users")) === 403);
await m.goto(`${B}/admin`);
step("member sees 'Owner only' at /admin", await m.getByText("Owner only").waitFor({ timeout: 10000 }).then(() => true, () => false));

// member uploads a file (to view as owner later)
await m.goto(`${B}/clips`);
await m.getByRole("button", { name: "Upload new" }).click();
await m.setInputFiles("input[type=file][multiple]", `${process.cwd()}/tests/fixtures/real/bbb.mp4`);
await m.getByRole("button", { name: /Upload 1 file/ }).click();
await m.getByText("Upload finished").waitFor({ timeout: 60000 });

// reused invite refused
const r = await newPage();
await r.goto(inviteUrl.replace(/^https?:\/\/[^/]+/, B));
await r.getByText(/invalid, expired or already used/).waitFor({ timeout: 10000 });
step("used invite link no longer works", true);

// --- owner: usage, content view (audited), file opens
await o.getByRole("tab", { name: "Users" }).click();
await o.reload();
await o.getByRole("cell", { name: new RegExp(member.email) }).first().click();
await o.waitForURL(/\/admin\/user\?id=/);
await o.getByText("1 file", { exact: true }).waitFor({ timeout: 10000 });
step("usage shows the member's upload", true);
await o.getByRole("tab", { name: "Media" }).click();
await o.getByRole("button", { name: /bbb\.mp4/ }).click();
const played = await o.getByRole("dialog").locator("video").evaluate(async (v) => { v.muted = true; await v.play(); await new Promise((res) => setTimeout(res, 1200)); return v.currentTime; });
step("owner can open the member's video (read-only)", played > 0.5, `t=${played.toFixed(2)}`);
await o.keyboard.press("Escape");
await o.getByRole("tab", { name: "Posts" }).click();
await o.getByText("No posts").waitFor({ timeout: 10000 });
await o.getByRole("tab", { name: "Access log" }).click();
await o.getByText("Viewed a user's content").first().waitFor({ timeout: 10000 });
step("access log records content views and file opens", await o.getByText("Opened a user's file").first().isVisible() && await o.getByText("Opened a user's overview").first().isVisible());

// --- disable / re-enable
await o.getByRole("button", { name: "Disable account" }).click();
await o.getByRole("dialog").getByRole("button", { name: "Disable account" }).click();
await o.getByText("Account disabled").waitFor({ timeout: 10000 });
step("member signed out everywhere when disabled", (await status(m, "/api/v1/me")) === 401);
const m2 = await newPage();
await signIn(m2, member);
await m2.getByText(/has been disabled/).waitFor({ timeout: 10000 });
step("disabled member can't sign in", true);
await o.getByRole("button", { name: "Re-enable account" }).click();
await o.getByText("Account re-enabled").waitFor({ timeout: 10000 });
await signIn(m2, member);
await m2.waitForURL("**/overview", { timeout: 20000 });
step("re-enabled member can sign in again", true);

// --- closed sign-up
await o.goto(`${B}/admin`);
await o.getByRole("tab", { name: "Sign-up and invites" }).click();
await o.getByRole("radio", { name: /Closed/ }).click();
await o.getByText("Sign-up setting saved").waitFor({ timeout: 10000 });
const v = await newPage();
await v.goto(`${B}/login`);
await v.getByRole("button", { name: "Sign in" }).waitFor();
await v.waitForTimeout(800);
step("login page hides 'Create an account' when closed", (await v.getByRole("link", { name: /Create an account/ }).count()) === 0);
await v.goto(`${B}/signup`);
await v.getByText("Sign-up is closed.").first().waitFor({ timeout: 10000 });
await v.fill("#displayName", "Late");
await v.fill("#email", `late${stamp}@viralos.test`);
await v.fill("#password", "late-password-123");
await v.click("button[type=submit]");
await v.getByText("Sign-up is closed. Ask the workspace owner for access.").waitFor({ timeout: 10000 });
step("closed sign-up refuses new accounts", true);

// --- delete the member
await o.getByRole("tab", { name: "Users" }).click();
await o.getByRole("cell", { name: new RegExp(member.email) }).first().click();
await o.waitForURL(/\/admin\/user\?id=/);
await o.getByRole("button", { name: "Delete account" }).click();
const del = o.getByRole("dialog").getByRole("button", { name: "Delete account" });
step("delete stays disabled until the email is typed", await del.isDisabled());
await o.fill("#del-confirm", member.email);
await del.click();
await o.waitForURL(/\/admin$/, { timeout: 15000 });
await o.getByText(/Account deleted with 1 of 1 files/).waitFor({ timeout: 10000 });
step("member deleted with their file", await o.getByRole("cell", { name: new RegExp(member.email) }).first().waitFor({ state: "detached", timeout: 10000 }).then(() => true, () => false));
const m3 = await newPage();
await signIn(m3, member);
await m3.getByText("Invalid email or password").waitFor({ timeout: 10000 });
step("deleted member can't sign in", true);

// --- owner's own page has no destructive actions; restore open sign-up
const meId = await o.evaluate(async () => (await (await fetch("/api/v1/me")).json()).id);
await o.goto(`${B}/admin/user?id=${meId}`);
await o.getByText("This is your account.").waitFor({ timeout: 10000 });
step("owner can't disable or delete their own account", (await o.getByRole("button", { name: "Delete account" }).count()) === 0);
await o.goto(`${B}/admin`);
await o.getByRole("tab", { name: "Sign-up and invites" }).click();
await o.getByRole("radio", { name: /Open/ }).click();
await o.getByText("Sign-up setting saved").waitFor({ timeout: 10000 });
await o.goto(`${B}/admin`);
await o.getByRole("tab", { name: "Access log" }).click();
await o.getByText("Deleted an account").first().waitFor({ timeout: 10000 });
step("access log lists the deletion and mode changes", await o.getByText("Changed sign-up mode").first().isVisible());
await o.screenshot({ path: "/tmp/owner-console.png" });

console.log(errors.length ? `ERRORS:\n${errors.join("\n")}` : "NO BROWSER ERRORS");
await browser.close();
process.exit(failed || errors.length ? 1 : 0);
