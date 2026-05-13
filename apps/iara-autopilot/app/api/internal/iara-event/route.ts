import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { assertInternalApiKey } from "@/lib/auth";
import { ingestParsedWebhook } from "@/lib/ingestion";

const bodySchema = z.object({
  provider: z.string().default("iara-api"),
  conversationId: z.string().min(3),
  customerPhone: z.string().optional(),
  direction: z.enum(["inbound", "outbound"]).default("outbound"),
  role: z.enum(["user", "assistant", "system"]).default("assistant"),
  body: z.string().min(1),
  createdAt: z.string().datetime().optional(),
  meta: z.record(z.string(), z.unknown()).optional()
});

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    assertInternalApiKey(req);
    const raw = await req.json();
    const parsed = bodySchema.parse(raw);

    const result = await ingestParsedWebhook({
      provider: "unknown",
      events: [
        {
          conversationId: parsed.conversationId,
          customerPhone: parsed.customerPhone,
          direction: parsed.direction,
          role: parsed.role,
          body: parsed.body,
          createdAt: parsed.createdAt ?? new Date().toISOString(),
          meta: {
            source: parsed.provider,
            ...(parsed.meta ?? {})
          }
        }
      ]
    });

    return NextResponse.json({ ok: true, ...result }, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown_error";
    const status = message.includes("unauthorized") ? 401 : 400;
    return NextResponse.json({ ok: false, message }, { status });
  }
}
