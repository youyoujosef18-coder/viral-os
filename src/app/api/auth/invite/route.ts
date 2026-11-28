import { NextResponse, type NextRequest } from "next/server";
import { connection } from "next/server";
import { errorResponse } from "@/lib/api/handler";
import { rateLimit } from "@/lib/api/rate-limit";
import { ApiError } from "@/lib/api/errors";
import { clientIp } from "@/lib/http-utils";
import { env } from "@/lib/env";
import { describeInvite } from "@/lib/services/admin";
import { unstable_rethrow } from "next/navigation";

/** Public: tells the sign-up page whether an invite link is still valid (and which email it is for). */
export async function GET(req: NextRequest) {
  try {
    await connection();
    if (!(await rateLimit(`invite-check:${clientIp(req.headers, env().TRUSTED_IP_HEADER)}`, 30, 3600)).ok) throw new ApiError(429, "Too many requests. Try again later.", "rate_limited");
    const token = req.nextUrl.searchParams.get("token")?.trim() ?? "";
    if (!token || token.length > 200) return NextResponse.json({ valid: false, email: null });
    return NextResponse.json(await describeInvite(token), { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    unstable_rethrow(err); // let Next.js prerender control flow through
    return errorResponse(err);
  }
}
