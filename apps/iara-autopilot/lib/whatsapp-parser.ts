import { nowIso } from "@/lib/utils";

export interface ParsedWebhookEvent {
  provider: "meta" | "twilio" | "unknown";
  events: Array<{
    conversationId: string;
    customerPhone?: string;
    direction: "inbound" | "outbound";
    role: "user" | "assistant" | "system";
    body: string;
    createdAt: string;
    meta?: Record<string, unknown>;
  }>;
}

function parseMetaPayload(payload: unknown): ParsedWebhookEvent {
  const data = payload as any;
  const events: ParsedWebhookEvent["events"] = [];

  const entries = Array.isArray(data?.entry) ? data.entry : [];
  for (const entry of entries) {
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];
    for (const change of changes) {
      const value = change?.value;
      const messages = Array.isArray(value?.messages) ? value.messages : [];
      for (const msg of messages) {
        const from = String(msg?.from ?? "unknown");
        const text = String(msg?.text?.body ?? "").trim();
        if (!text) continue;

        events.push({
          conversationId: `${value?.metadata?.phone_number_id ?? "meta"}:${from}`,
          customerPhone: from,
          direction: "inbound",
          role: "user",
          body: text,
          createdAt: nowIso(),
          meta: {
            source: "meta_message",
            messageId: msg?.id,
            timestamp: msg?.timestamp
          }
        });
      }

      const statuses = Array.isArray(value?.statuses) ? value.statuses : [];
      for (const status of statuses) {
        const text = String(status?.conversation?.origin?.type ?? "status_update");
        events.push({
          conversationId: `${value?.metadata?.phone_number_id ?? "meta"}:${status?.recipient_id ?? "unknown"}`,
          customerPhone: String(status?.recipient_id ?? ""),
          direction: "outbound",
          role: "system",
          body: text,
          createdAt: nowIso(),
          meta: {
            source: "meta_status",
            status: status?.status,
            messageId: status?.id,
            pricing: status?.pricing
          }
        });
      }
    }
  }

  return { provider: "meta", events };
}

function parseTwilioPayload(payload: URLSearchParams): ParsedWebhookEvent {
  const body = payload.get("Body") ?? "";
  const from = (payload.get("From") ?? "").replace(/^whatsapp:/, "");
  const to = (payload.get("To") ?? "").replace(/^whatsapp:/, "");

  const events: ParsedWebhookEvent["events"] = [];

  if (body.trim()) {
    events.push({
      conversationId: `${to}:${from}`,
      customerPhone: from,
      direction: "inbound",
      role: "user",
      body: body.trim(),
      createdAt: nowIso(),
      meta: {
        source: "twilio_inbound",
        sid: payload.get("MessageSid")
      }
    });
  }

  return { provider: "twilio", events };
}

export async function parseIncomingWebhook(request: Request): Promise<ParsedWebhookEvent> {
  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.includes("application/x-www-form-urlencoded")) {
    const text = await request.text();
    const params = new URLSearchParams(text);
    return parseTwilioPayload(params);
  }

  if (contentType.includes("application/json")) {
    const payload = await request.json();
    return parseMetaPayload(payload);
  }

  return { provider: "unknown", events: [] };
}
