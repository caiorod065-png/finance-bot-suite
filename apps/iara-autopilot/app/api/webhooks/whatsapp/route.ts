import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";
import { parseIncomingWebhook } from "@/lib/whatsapp-parser";
import { ingestParsedWebhook } from "@/lib/ingestion";
import { runSelfImprovement } from "@/lib/self-improve";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const mode = req.nextUrl.searchParams.get("hub.mode");
  const token = req.nextUrl.searchParams.get("hub.verify_token");
  const challenge = req.nextUrl.searchParams.get("hub.challenge");

  if (mode === "subscribe" && token && env.WHATSAPP_VERIFY_TOKEN && token === env.WHATSAPP_VERIFY_TOKEN) {
    return new NextResponse(challenge ?? "ok", { status: 200 });
  }

  return NextResponse.json({ ok: false, message: "forbidden" }, { status: 403 });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const parsed = await parseIncomingWebhook(req);
    const ingestion = await ingestParsedWebhook(parsed);

    // Trigger inteligente: se apareceu sinal de resposta ruim, roda loop assíncrono.
    if (ingestion.issues > 0) {
      queueMicrotask(async () => {
        try {
          await runSelfImprovement("bad-conversation-trigger");
        } catch (error) {
          console.error("self-improvement-trigger-error", error);
        }
      });
    }

    if (parsed.provider === "twilio") {
      return new NextResponse("<Response></Response>", {
        status: 200,
        headers: { "Content-Type": "text/xml" }
      });
    }

    return NextResponse.json({ ok: true, provider: parsed.provider, ...ingestion }, { status: 200 });
  } catch (error) {
    console.error("whatsapp-webhook-error", error);
    return NextResponse.json(
      {
        ok: false,
        message: error instanceof Error ? error.message : "unknown_error"
      },
      { status: 500 }
    );
  }
}
