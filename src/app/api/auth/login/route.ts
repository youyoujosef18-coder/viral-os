import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { signIn } from "@/lib/auth/session";
import { errorResponse } from "@/lib/api/handler";
import { rateLimit } from "@/lib/api/rate-limit";
import { ApiError } from "@/lib/api/errors";
import { clientIp } from "@/lib/http-utils";
import { env } from "@/lib/env";

const schema = z.object({ email: z.string().trim().email(), password: z.string().min(1).max(200) });

export async function POST(req: NextRequest) {
  try {
    const body = schema.parse(await req.json());
    const ip = clientIp(req.headers, env().TRUSTED_IP_HEADER);
    const email = body.email.toLowerCase();
    // Per address+email, plus a per-email cap that no IP rotation can get around.
    const perIp = await rateLimit(`login:${ip}:${email}`, 10, 900);
    const perEmail = await rateLimit(`login-email:${email}`, 30, 900);
    if (!perIp.ok || !perEmail.ok) throw new ApiError(429, "Too many login attempts. Wait 15 minutes and try again.", "rate_limited");
    await signIn({ ...body, userAgent: req.headers.get("user-agent") ?? undefined });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
