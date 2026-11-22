import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { signUp } from "@/lib/auth/session";
import { errorResponse } from "@/lib/api/handler";
import { rateLimit } from "@/lib/api/rate-limit";
import { ApiError } from "@/lib/api/errors";
import { clientIp } from "@/lib/http-utils";
import { env } from "@/lib/env";

const schema = z.object({
  email: z.string().trim().email("Enter a valid email"),
  password: z.string().min(10, "Use at least 10 characters").max(200),
  displayName: z.string().trim().max(80).optional(),
  timezone: z.string().max(64).refine((tz) => { try { new Intl.DateTimeFormat("en", { timeZone: tz }); return true; } catch { return false; } }).optional(),
});

export async function POST(req: NextRequest) {
  try {
    const ip = clientIp(req.headers, env().TRUSTED_IP_HEADER);
    if (!(await rateLimit(`signup:${ip}`, 5, 3600)).ok) throw new ApiError(429, "Too many sign-up attempts. Try again later.", "rate_limited");
    const body = schema.parse(await req.json());
    const result = await signUp({ ...body, userAgent: req.headers.get("user-agent") ?? undefined });
    return NextResponse.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
