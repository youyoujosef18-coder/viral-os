import { describe, expect, it } from "vitest";
import { clientIp, contentDisposition, parseRange, safeLocalPath } from "@/lib/http-utils";
import { signMediaToken, signUploadToken, verifyMediaToken, verifyUploadToken } from "@/lib/storage";
import { memoryLimiterSize, rateLimit, sweepExpired } from "@/lib/api/rate-limit";

describe("safeLocalPath (open redirect guard)", () => {
  it.each([
    ["/settings?tab=connections", "/settings?tab=connections"],
    ["/clips?job=1#top", "/clips?job=1#top"],
    ["/a/../b", "/b"],
  ])("keeps local path %s", (input, out) => expect(safeLocalPath(input, "/fallback")).toBe(out));

  it.each(["//evil.example/x", "/\\evil.example", "/\\/evil.example", "https://evil.example", "evil.example", "/\t/evil.example", "/\n/evil.example", "", null, undefined, "javascript:alert(1)"])("rejects %j", (input) => {
    expect(safeLocalPath(input as string, "/fallback")).toBe("/fallback");
  });
});

describe("parseRange", () => {
  it("handles the three single-range forms", () => {
    expect(parseRange("bytes=0-99", 1000)).toEqual({ start: 0, end: 99 });
    expect(parseRange("bytes=900-", 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange("bytes=-100", 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange("bytes=-5000", 1000)).toEqual({ start: 0, end: 999 });
    expect(parseRange("bytes=500-99999", 1000)).toEqual({ start: 500, end: 999 });
  });
  it("returns unsatisfiable instead of crashing on bad ranges", () => {
    expect(parseRange("bytes=50-10", 1000)).toBe("unsatisfiable");
    expect(parseRange("bytes=1000-", 1000)).toBe("unsatisfiable");
    expect(parseRange("bytes=-0", 1000)).toBe("unsatisfiable");
    expect(parseRange("bytes=0-0", 0)).toBe("unsatisfiable");
  });
  it("ignores missing, malformed and multi-range headers (serve the whole file)", () => {
    expect(parseRange(null, 1000)).toBeNull();
    expect(parseRange("bytes=-", 1000)).toBeNull();
    expect(parseRange("items=0-5", 1000)).toBeNull();
    expect(parseRange("bytes=0-5,10-20", 1000)).toBeNull();
  });
});

describe("contentDisposition", () => {
  it("produces a valid header for Arabic, accented and quoted names", () => {
    for (const name of ["فيديو العطلة.mp4", "café « été ».mov", 'my "best" clip.mp4', "line\nbreak.mp4"]) {
      const value = contentDisposition(name);
      expect(() => new Response(null, { headers: { "Content-Disposition": value } })).not.toThrow();
      expect(value).toMatch(/^attachment; filename="[\x20-\x7e]+"; filename\*=UTF-8''/);
      expect(decodeURIComponent(value.split("UTF-8''")[1])).toBe(name);
    }
  });
});

describe("clientIp", () => {
  it("ignores the client-controlled first X-Forwarded-For entry", () => {
    expect(clientIp(new Headers({ "x-forwarded-for": "1.2.3.4, 203.0.113.9" }))).toBe("203.0.113.9");
    expect(clientIp(new Headers({ "x-forwarded-for": "203.0.113.9" }))).toBe("203.0.113.9");
    expect(clientIp(new Headers())).toBe("local");
  });
  it("uses a configured trusted header when present", () => {
    const h = new Headers({ "x-real-ip": "198.51.100.7", "x-forwarded-for": "1.2.3.4" });
    expect(clientIp(h, "x-real-ip")).toBe("198.51.100.7");
    expect(clientIp(new Headers({ "x-forwarded-for": "1.2.3.4, 10.0.0.1" }), "x-real-ip")).toBe("10.0.0.1");
  });
});

describe("signed storage tokens", () => {
  const future = () => Date.now() + 60_000;
  it("verifies, rejects tampering, expiry and wrong purpose", () => {
    const t = signMediaToken("u1/2026-11/a.mp4", future());
    expect(verifyMediaToken(t)).toBe("u1/2026-11/a.mp4");
    const [payload, sig] = t.split(".");
    const flipped = sig.slice(0, -1) + (sig.endsWith("A") ? "B" : "A");
    expect(verifyMediaToken(`${payload}.${flipped}`)).toBeNull();
    expect(verifyMediaToken(`${payload}.${sig.slice(0, 10)}`)).toBeNull(); // different length
    expect(verifyMediaToken(`${Buffer.from('{"k":"u2/x","e":9e15}').toString("base64url")}.${sig}`)).toBeNull();
    expect(verifyMediaToken(`${t}.extra`)).toBeNull();
    expect(verifyMediaToken("garbage")).toBeNull();
    expect(verifyMediaToken(signMediaToken("k", Date.now() - 1))).toBeNull();
    // A media (download) token can't be used as an upload token and vice versa.
    expect(verifyUploadToken(t)).toBeNull();
    expect(verifyMediaToken(signUploadToken("k", future()))).toBeNull();
    expect(verifyUploadToken(signUploadToken("k", future()))).toBe("k");
  });
});

describe("in-memory rate limiter", () => {
  it("drops expired windows so memory stays bounded", async () => {
    for (let i = 0; i < 50; i++) await rateLimit(`sweep-test-${i}`, 5, 1);
    const before = memoryLimiterSize();
    expect(before).toBeGreaterThanOrEqual(50);
    const removed = sweepExpired(Date.now() + 120_000);
    expect(removed).toBeGreaterThanOrEqual(50);
    expect(memoryLimiterSize()).toBe(before - removed);
  });
});
