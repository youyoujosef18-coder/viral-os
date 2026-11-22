import { NextResponse } from "next/server";
import { signOut } from "@/lib/auth/session";
import { errorResponse } from "@/lib/api/handler";

export async function POST() {
  try {
    await signOut();
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
