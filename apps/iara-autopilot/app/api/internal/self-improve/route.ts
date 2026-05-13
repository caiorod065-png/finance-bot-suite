import { NextRequest, NextResponse } from "next/server";
import { assertInternalApiKey } from "@/lib/auth";
import { runSelfImprovement } from "@/lib/self-improve";

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    assertInternalApiKey(req);
    const body = await req.json().catch(() => ({}));
    const reason = typeof body?.reason === "string" ? body.reason : "manual";

    const result = await runSelfImprovement(reason);
    return NextResponse.json({ ok: true, result }, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown_error";
    const status = message.includes("unauthorized") ? 401 : 500;
    return NextResponse.json({ ok: false, message }, { status });
  }
}
