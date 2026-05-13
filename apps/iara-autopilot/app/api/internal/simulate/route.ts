import { NextRequest, NextResponse } from "next/server";
import { assertInternalApiKey } from "@/lib/auth";
import { getActivePrompt, getSimulationCases } from "@/lib/db";
import { generateJson, generateText } from "@/lib/openai";
import { env } from "@/lib/env";

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    assertInternalApiKey(req);
    const body = await req.json().catch(() => ({}));
    const promptOverride = typeof body?.prompt === "string" ? body.prompt : undefined;

    const active = await getActivePrompt();
    const prompt = promptOverride ?? active.promptText;
    const cases = await getSimulationCases(env.MAX_SIMULATION_CASES);

    const results = [] as Array<Record<string, unknown>>;
    for (const c of cases) {
      const answer = await generateText(
        `Contexto: ${c.context ?? "sem contexto"}\nUsuário: ${c.input}\n\nResponda como Iara.`,
        prompt
      );

      const evaluation = await generateJson<{ score: number; notes: string }>(
        `Caso: ${JSON.stringify(c)}\nResposta: ${answer}`,
        "Avalie a resposta de 0 a 1. Retorne JSON {score, notes}."
      );

      results.push({
        case: c,
        answer,
        evaluation
      });
    }

    const avg = results.length
      ? results.reduce((acc, cur) => acc + Number((cur.evaluation as any).score ?? 0), 0) / results.length
      : 0;

    return NextResponse.json({ ok: true, promptVersion: active.version, averageScore: avg, results }, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown_error";
    const status = message.includes("unauthorized") ? 401 : 500;
    return NextResponse.json({ ok: false, message }, { status });
  }
}
