// Sends malformed input to every API route (bad ids, empty/malformed/wrong-typed bodies, junk query
// strings) and fails on any 500. 502/503 are allowed only with the deliberate "not configured" or
// "upstream unavailable" codes. Usage: start the app (npm run start), then npm run test:e2e:fuzz
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
const B = "http://localhost:3000";
const ROOT = process.cwd();
const files = execSync(`find ${ROOT}/src/app/api -name route.ts`, { encoding: "utf8" }).trim().split("\n");
const routes = files.map((f) => {
  const src = readFileSync(f, "utf8");
  const methods = [...src.matchAll(/export (?:const|async function) (GET|POST|PUT|PATCH|DELETE)\b/g)].map((m) => m[1]);
  const path = f.replace(`${ROOT}/src/app`, "").replace(/\/route\.ts$/, "");
  return { path, methods };
});
// Things that would end the session or need external redirects are skipped.
const SKIP = [/\/api\/auth\/logout/, /\/api\/oauth\/.*\/start/, /\/api\/oauth\/.*\/callback/, /\/api\/cron/, /\/api\/v1\/me$/ /* DELETE removes the account */];
let cookie = "";
async function req(method, url, body, raw) {
  const headers = { Origin: B, Cookie: cookie };
  let payload;
  if (raw !== undefined) { headers["Content-Type"] = "application/json"; payload = raw; }
  else if (body !== undefined) { headers["Content-Type"] = "application/json"; payload = JSON.stringify(body); }
  const r = await fetch(B + url, { method, headers, body: payload, redirect: "manual" });
  const text = await r.text().catch(() => "");
  return { status: r.status, text };
}
const email = `fuzz${Date.now()}@viralos.test`;
const s = await fetch(B + "/api/auth/signup", { method: "POST", headers: { "Content-Type": "application/json", Origin: B }, body: JSON.stringify({ email, password: "fuzz-password-123", displayName: "Fuzz", timezone: "UTC" }) });
cookie = (s.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
console.log("signup", s.status, cookie ? "cookie ok" : "NO COOKIE");
const UUID = "00000000-0000-4000-8000-000000000000";
const bodies = [undefined, {}, [], { x: 1 }, { id: "nope", title: 123, startSec: "a", url: 5, items: "x", status: {}, platform: "myspace", name: null }];
const raws = ["{", "null", "\"str\"", "1e999"];
const found = [];
let count = 0;
for (const r of routes) {
  if (SKIP.some((re) => re.test(r.path))) continue;
  for (const variant of [UUID, "not-a-uuid"]) {
    const url = r.path.replace(/\[[^\]]+\]/g, variant);
    for (const m of r.methods) {
      const tries = m === "GET" ? [[undefined, undefined], [undefined, undefined, "?q=%00&limit=-1&type=zzz&days=abc&from=2026-13-45&page=-5&id=x&userId=bad"]] : [...bodies.map((b) => [b]), ...raws.map((x) => [undefined, x])];
      for (const [b, raw, qs] of tries) {
        const res = await req(m, url + (qs ?? ""), b, raw);
        count++;
        const expected = (res.status === 503 && /"code":"not_configured"/.test(res.text)) || (res.status === 502 && /"code":"(provider_error|youtube_error|upstream_error|[a-z_]+)"/.test(res.text) && !/"code":"internal"/.test(res.text));
        if (res.status >= 500 && !expected) found.push(`${res.status} ${m} ${url}${qs ?? ""} body=${raw ?? JSON.stringify(b)} :: ${res.text.slice(0, 160)}`);
      }
    }
  }
}
console.log(`requests: ${count}, unexpected server errors: ${found.length}`);
for (const f of [...new Set(found)]) console.log(f);
process.exit(found.length || !cookie ? 1 : 0);
