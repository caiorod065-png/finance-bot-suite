import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { assertInternalApiKey } from "@/lib/auth";

export async function GET(request: Request): Promise<NextResponse> {
  try {
    assertInternalApiKey(request);
  } catch {
    return NextResponse.json({ ok: false, message: "unauthorized" }, { status: 401 });
  }

  try {
    const [messages, issues, prompts, runs] = await Promise.all([
      supabase.from("conversation_messages").select("id", { count: "exact", head: true }),
      supabase.from("conversation_quality_issues").select("id", { count: "exact", head: true }),
      supabase.from("prompt_versions").select("id", { count: "exact", head: true }),
      supabase.from("improvement_runs").select("id", { count: "exact", head: true })
    ]);

    return NextResponse.json(
      {
        ok: true,
        totals: {
          messages: messages.count ?? 0,
          qualityIssues: issues.count ?? 0,
          promptVersions: prompts.count ?? 0,
          improvementRuns: runs.count ?? 0
        }
      },
      { status: 200 }
    );
  } catch (error) {
    return NextResponse.json(
      { ok: false, message: error instanceof Error ? error.message : "unknown_error" },
      { status: 500 }
    );
  }
}
