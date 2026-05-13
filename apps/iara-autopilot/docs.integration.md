# Integrando com o bot Iara atual (finance-bot-suite/apps/api)

Para monitorar **100% das respostas da Iara**, envie cada resposta outbound do bot atual para:

- `POST https://SEU_AUTOPILOT/api/internal/iara-event`

Headers:

- `Content-Type: application/json`
- `x-internal-api-key: <INTERNAL_API_KEY>`

Payload:

```json
{
  "provider": "finance-bot-api",
  "conversationId": "twilio:+55119...",
  "customerPhone": "+55119...",
  "direction": "outbound",
  "role": "assistant",
  "body": "texto final enviado pela Iara",
  "createdAt": "2026-04-01T12:00:00.000Z",
  "meta": {
    "channel": "twilio",
    "messageId": "SMxxxx",
    "lastUserMessage": "quero definir uma meta"
  }
}
```

Com isso, o autopilot avalia repetição/tom/empatia e alimenta o loop de melhoria automática.
