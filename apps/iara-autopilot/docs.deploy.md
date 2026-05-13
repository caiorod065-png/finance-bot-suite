# Iara Autopilot - Plano de Implantação

## 1. Pré-requisitos

- Projeto buildando localmente (`npm run build`) ✅
- Banco Supabase com `sql/schema.sql` aplicado
- Variáveis de ambiente de produção preenchidas
- Chave interna definida para integração (`INTERNAL_API_KEY`)

## 2. Variáveis obrigatórias (produção)

- `OPENAI_API_KEY`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `INTERNAL_API_KEY`
- `CRON_SECRET`

## 3. Deploy

Use uma das estratégias:

1. Vercel com Git + Deploy Hook
- Definir `VERCEL_DEPLOY_HOOK_URL`
- Trigger automático pelo loop de melhoria

2. Vercel API direta
- Definir `VERCEL_TOKEN`
- Definir `VERCEL_PROJECT_ID`
- Definir `VERCEL_TEAM_ID` (se aplicável)

## 4. Configuração de integração com bot principal

Todo outbound da Iara principal deve enviar evento para:

- `POST https://<AUTOPILOT>/api/internal/iara-event`

Headers:

- `Content-Type: application/json`
- `x-internal-api-key: <INTERNAL_API_KEY>`

Payload recomendado:

```json
{
  "provider": "finance-bot-api",
  "conversationId": "twilio:+55119...",
  "customerPhone": "+55119...",
  "direction": "outbound",
  "role": "assistant",
  "body": "texto final enviado pela Iara",
  "createdAt": "2026-05-12T12:00:00.000Z",
  "meta": {
    "channel": "twilio",
    "messageId": "SMxxxx",
    "lastUserMessage": "mensagem anterior do usuário"
  }
}
```

## 5. Smoke tests pós deploy

1. Métricas:

```bash
curl -s https://<AUTOPILOT>/api/internal/metrics
```

2. Evento interno:

```bash
curl -X POST https://<AUTOPILOT>/api/internal/iara-event \
  -H "Content-Type: application/json" \
  -H "x-internal-api-key: <INTERNAL_API_KEY>" \
  -d '{"provider":"smoke","conversationId":"smoke:1","direction":"outbound","role":"assistant","body":"teste de smoke","meta":{"lastUserMessage":"teste?"}}'
```

3. Self-improve manual:

```bash
curl -X POST https://<AUTOPILOT>/api/internal/self-improve \
  -H "Content-Type: application/json" \
  -H "x-internal-api-key: <INTERNAL_API_KEY>" \
  -d '{"reason":"post-deploy-smoke"}'
```

## 6. Critérios de Go-Live

- API de métricas respondendo `ok: true`
- Ingestão de eventos outbound em volume real
- Pelo menos 1 run de melhoria registrada sem erro crítico
- Logs de deploy e fallback validados
