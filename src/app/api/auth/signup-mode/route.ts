import { NextResponse } from "next/server";
import { connection } from "next/server";
import { errorResponse } from "@/lib/api/handler";
import { getSignupMode } from "@/lib/services/admin";
import { unstable_rethrow } from "next/navigation";

/** Public: lets the sign-in and sign-up pages show the right options (open, invite-only or closed). */
export async function GET() {
  try {
    await connection();
    return NextResponse.json({ mode: await getSignupMode() }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    unstable_rethrow(err); // let Next.js prerender control flow through
    return errorResponse(err);
  }
}
