import { chromium } from "playwright-core";
// Usage: start the app + worker, then: CHROME_PATH=/path/to/chrome npm run test:e2e
const B = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(`PAGEERROR ${e.message.slice(0, 200)}`));
// Chrome logs every 4xx/5xx as "Failed to load resource" without the URL, so server errors are checked on
// the responses instead. The only expected one is the AI step's 503 ("AI provider not configured").
page.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && errors.push(`console: ${m.text().slice(0, 160)}`));
page.on("response", (r) => r.status() >= 500 && !(r.status() === 503 && new URL(r.url()).pathname === "/api/v1/scripts") && errors.push(`HTTP ${r.status()} ${r.url()}`));
const step = (n, ok, d = "") => console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? ` — ${d}` : ""}`);

// Sign up a fresh user through the UI (validation first)
await page.goto(`${B}/signup`);
await page.click("button[type=submit]");
step("signup shows validation errors", await page.getByText("Enter a valid email address").isVisible());
const email = `flow${Date.now()}@viralos.test`;
await page.fill("#displayName", "Flow Tester");
await page.fill("#email", email);
await page.fill("#password", "flow-password-123");
await page.click("button[type=submit]");
await page.waitForURL("**/overview", { timeout: 20000 });
step("signup lands on overview", true);

// Create a project through the form
await page.goto(`${B}/studio?new=1`);
await page.fill("#p-title", "Latte art for beginners");
await page.selectOption("#p-format", "Reels");
await page.locator("label", { hasText: "TikTok" }).click();
await page.getByRole("button", { name: "Create project" }).click();
await page.waitForTimeout(1500);
const drawerTitle = await page.getByRole("dialog").getByText("Latte art for beginners").first().isVisible();
step("project created and detail opened", drawerTitle);
await page.keyboard.press("Escape");
await page.waitForTimeout(500);
const card = page.getByRole("button", { name: /Latte art for beginners/ });
step("project card in pipeline shows chosen format", (await card.textContent())?.includes("Reels") ?? false);

// Upload a file through the UI (multipart path with progress)
await page.goto(`${B}/media`);
await page.getByRole("button", { name: "Upload", exact: true }).click();
await page.setInputFiles("input[type=file]", { name: "clip.mp4", mimeType: "video/mp4", buffer: Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypmp42"), Buffer.alloc(4096, 1)]) });
await page.getByRole("button", { name: /Upload 1 file/ }).click();
await page.getByText("Upload finished").waitFor({ timeout: 20000 });
await page.keyboard.press("Escape");
await page.waitForTimeout(1000);
step("upload via UI appears in library", await page.getByText("clip.mp4").first().isVisible());

// Compose a post draft with the uploaded media
await page.goto(`${B}/publishing?new=1`);
await page.fill("#c-title", "Latte heart in 30 seconds");
await page.locator(".tiptap").click();
await page.keyboard.type("Pour low, then lift. #latteart");
await page.getByRole("button", { name: "Choose video or image" }).click();
await page.getByRole("dialog", { name: /Choose video or image/ }).getByRole("button", { name: /clip\.mp4/ }).click();
await page.getByRole("button", { name: "Save draft" }).click();
await page.waitForTimeout(1500);
step("post draft saved and detail shown", await page.getByRole("dialog").getByText("Latte heart in 30 seconds").first().isVisible());
await page.keyboard.press("Escape");
// Publishing without accounts is refused with a clear message
await page.goto(`${B}/publishing`);
await page.getByText("Latte heart in 30 seconds").click();
await page.getByRole("button", { name: "Edit" }).click();
await page.selectOption("select[aria-label='Publishing mode']", "now");
await page.getByRole("button", { name: "Publish now" }).click();
step("publish without accounts is blocked with guidance", await page.getByText("Select at least one connected account.").isVisible());
await page.keyboard.press("Escape");

// Automation: create, run now, notification appears
await page.goto(`${B}/automation?new=1`);
await page.fill("#w-name", "Smoke automation");
await page.getByPlaceholder("Notification title").fill("Automation says hello");
await page.getByRole("button", { name: "Save automation" }).click();
await page.waitForTimeout(1200);
await page.getByRole("button", { name: "Run now" }).click();
await page.getByText(/Automation (ran successfully|queued)/).waitFor({ timeout: 15000 });
step("automation started (inline or queued to worker)", true);
await page.getByRole("button", { name: "Run history" }).click();
await page.getByRole("dialog").getByText("Succeeded").first().waitFor({ timeout: 20000 });
step("worker completed the run (run history shows Succeeded)", true);
await page.keyboard.press("Escape");
await page.reload();
await page.waitForTimeout(1500);
await page.getByRole("button", { name: /Notifications/ }).click();
step("notification delivered", await page.getByText("Automation says hello").first().isVisible());
await page.keyboard.press("Escape");

// AI feature without a provider shows setup guidance, not fake output
await page.goto(`${B}/scripts?new=1`);
await page.fill("#s-topic", "Why your latte art fails");
await page.getByRole("button", { name: "Generate script" }).click();
await page.getByText("Script generation needs an AI provider").waitFor({ timeout: 15000 });
step("AI without provider shows setup notice", true);

// Calendar shows the planned post date after drag-free reschedule API
await page.goto(`${B}/calendar`);
await page.waitForTimeout(1500);
step("calendar renders without errors", await page.getByRole("grid", { name: "Calendar" }).isVisible());

await page.goto(`${B}/settings?tab=integrations`);
await page.waitForTimeout(1500);


console.log(errors.length ? `ERRORS:\n${errors.join("\n")}` : "NO BROWSER ERRORS");
await browser.close();
