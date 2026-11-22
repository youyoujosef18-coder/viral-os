import { NextResponse, type NextRequest } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { completeOAuth } from "@/lib/services/oauth";
import { PLATFORMS, type Platform } from "@/lib/providers/platforms";
import { logger } from "@/lib/logger";

export async function GET(req: NextRequest, ctx: { params: Promise<{ platform: string }> }) {
  const { platform } = await ctx.params;
  const back = (q: string) => NextResponse.redirect(new URL(`/settings?tab=connections&${q}`, req.url));
  const user = await getSessionUser();
  if (!user) return NextResponse.redirect(new URL("/login", req.url));
  if (!PLATFORMS.includes(platform as Platform)) return back("error=unknown_platform");
  const sp = req.nextUrl.searchParams;
  const denied = sp.get("error_description") ?? sp.get("error");
  if (denied) return back(`error=${encodeURIComponent(`Authorization was not granted: ${denied}`)}`);
  const code = sp.get("code"), state = sp.get("state");
  if (!code || !state) return back("error=missing_code");
  try {
    const { redirectTo, connection } = await completeOAuth(user.id, platform as Platform, code, state);
    const url = new URL(redirectTo, req.url);
    url.searchParams.set("connected", connection.platform);
    return NextResponse.redirect(url);
  } catch (err) {
    logger.warn("OAuth callback failed", { platform, err: (err as Error).message });
    return back(`error=${encodeURIComponent((err as Error).message.slice(0, 300))}`);
  }
}
