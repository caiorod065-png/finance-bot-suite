import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { assertInternalApiKey } from "@/lib/auth";
import { deployToVercel } from "@/lib/vercel-deploy";

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    assertInternalApiKey(req);
    const body = await req.json().catch(() => ({}));
    const customRoot = typeof body?.projectRoot === "string" ? body.projectRoot : process.cwd();

    const root = path.resolve(customRoot);
    const deployment = await deployToVercel(root);

    return NextResponse.json({ ok: true, deployment }, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown_error";
    const status = message.includes("unauthorized") ? 401 : 500;
    return NextResponse.json({ ok: false, message }, { status });
  }
}
