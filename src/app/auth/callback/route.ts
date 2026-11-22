import { NextResponse, type NextRequest } from "next/server";
import { exchangeSupabaseCode } from "@/lib/auth/session";

/** Supabase Auth email-confirmation / magic-link callback. */
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  if (!code) return NextResponse.redirect(new URL("/login?error=missing_code", req.url));
  try {
    await exchangeSupabaseCode(code);
    return NextResponse.redirect(new URL("/overview", req.url));
  } catch {
    return NextResponse.redirect(new URL("/login?error=link_invalid", req.url));
  }
}
