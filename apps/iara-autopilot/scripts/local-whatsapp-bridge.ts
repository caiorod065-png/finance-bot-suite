import "dotenv/config";
import { Client, LocalAuth } from "whatsapp-web.js";
import qrcode from "qrcode-terminal";

const webhookUrl = process.env.AUTOPILOT_WEBHOOK_URL;
const internalKey = process.env.INTERNAL_API_KEY;

if (!webhookUrl) {
  throw new Error("Defina AUTOPILOT_WEBHOOK_URL no .env para usar o bridge local.");
}

const client = new Client({
  authStrategy: new LocalAuth({ clientId: "iara-autopilot-bridge" })
});

client.on("qr", (qr) => {
  qrcode.generate(qr, { small: true });
});

client.on("ready", () => {
  console.log("✅ WhatsApp bridge conectado");
});

client.on("message_create", async (msg) => {
  try {
    if (msg.fromMe) {
      await fetch(webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(internalKey ? { "x-internal-api-key": internalKey } : {})
        },
        body: JSON.stringify({
          provider: "whatsapp-web.js",
          conversationId: msg.to,
          customerPhone: msg.to,
          direction: "outbound",
          role: "assistant",
          body: msg.body,
          createdAt: new Date(msg.timestamp * 1000).toISOString(),
          meta: {
            messageId: msg.id?._serialized ?? null,
            from: msg.from,
            to: msg.to
          }
        })
      });
    }
  } catch (error) {
    console.error("bridge message_create error", error);
  }
});

client.on("message", async (msg) => {
  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(internalKey ? { "x-internal-api-key": internalKey } : {})
      },
      body: JSON.stringify({
        provider: "whatsapp-web.js",
        conversationId: msg.from,
        customerPhone: msg.from,
        direction: "inbound",
        role: "user",
        body: msg.body,
        createdAt: new Date(msg.timestamp * 1000).toISOString(),
        meta: {
          messageId: msg.id?._serialized ?? null,
          from: msg.from,
          to: msg.to
        }
      })
    });
  } catch (error) {
    console.error("bridge message error", error);
  }
});

client.initialize();
