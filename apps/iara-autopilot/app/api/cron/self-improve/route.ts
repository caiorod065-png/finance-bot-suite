import { NextRequest, NextResponse } from "next/server";
import { assertCronSecret } from "@/lib/auth";
import { runSelfImprovement } from "@/lib/self-improve";

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    assertCronSecret(req);
    const result = await runSelfImprovement("cron");
    return NextResponse.json({ ok: true, result }, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown_error";
    const status = message.includes("unauthorized") ? 401 : 500;
    return NextResponse.json({ ok: false, message }, { status });
  }
}
