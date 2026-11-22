import { NextResponse, type NextRequest } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { startOAuth } from "@/lib/services/oauth";
import { PLATFORMS, type Platform } from "@/lib/providers/platforms";
import { ApiError } from "@/lib/api/errors";

export async function GET(req: NextRequest, ctx: { params: Promise<{ platform: string }> }) {
  const { platform } = await ctx.params;
  const user = await getSessionUser();
  if (!user) return NextResponse.redirect(new URL("/login", req.url));
  if (!PLATFORMS.includes(platform as Platform)) return NextResponse.redirect(new URL("/settings?tab=connections&error=unknown_platform", req.url));
  try {
    const url = await startOAuth(user.id, platform as Platform, req.nextUrl.searchParams.get("redirect") ?? "/settings?tab=connections");
    return NextResponse.redirect(url);
  } catch (err) {
    const msg = err instanceof ApiError ? err.message : "Could not start the connection.";
    return NextResponse.redirect(new URL(`/settings?tab=connections&error=${encodeURIComponent(msg)}`, req.url));
  }
}
