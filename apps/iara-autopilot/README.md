# Iara Autopilot (Next.js + Vercel)

Agente de auto-melhoria contínua para o bot WhatsApp **Iara**.

Loop recursivo implementado:

1. Analisa conversas em tempo real via webhook
2. Detecta falhas (repetição, tom robótico, falta de empatia, risco transacional)
3. Critica prompt ativo
4. Gera novo prompt candidato
5. Testa em simulação com casos reais + seeds
6. Valida com agentes externos (opcional)
7. Promove prompt se melhor
8. Gera ZIP do projeto e dispara deploy automático na Vercel

## Stack

- Next.js (App Router + API Routes)
- Supabase/Postgres (logs, issues, prompt versions, runs)
- OpenAI (GPT-4o para análise/otimização + embeddings)
- Vercel API/Deploy Hook

## Endpoints

- `GET /api/webhooks/whatsapp` valida webhook Meta
- `POST /api/webhooks/whatsapp` ingere mensagens WhatsApp/Twilio
- `GET /api/cron/self-improve` loop via cron Vercel
- `POST /api/internal/self-improve` loop manual
- `POST /api/internal/simulate` simulação manual
- `POST /api/internal/deploy` deploy manual
- `GET /api/internal/metrics` contadores

## Setup

1. Instale dependências:

```bash
npm install
```

2. Crie `.env` a partir de `.env.example`.

3. Execute schema no Supabase SQL editor:

- arquivo: `sql/schema.sql`

4. Rode local:

```bash
npm run dev
```

## Cron

`vercel.json` já agenda o loop a cada 3 minutos:

- `GET /api/cron/self-improve`

Defina `CRON_SECRET` e envie no header `Authorization: Bearer <CRON_SECRET>` em ambientes não-Vercel.

## Webhook WhatsApp

### Meta

- Callback URL: `https://SEU_DOMINIO/api/webhooks/whatsapp`
- Verify token: `WHATSAPP_VERIFY_TOKEN`

### Twilio

- When a message comes in: `POST https://SEU_DOMINIO/api/webhooks/whatsapp`

## Deploy automático Vercel

Opção A (recomendada): `VERCEL_DEPLOY_HOOK_URL`
- O loop gera ZIP para auditoria e dispara deploy hook.

Opção B: API direta
- Configure `VERCEL_TOKEN` + `VERCEL_PROJECT_ID` (+ `VERCEL_TEAM_ID` se houver)
- O loop envia arquivos para `/v13/deployments`.

## Integração com outros agentes

Use:

- `VALIDATOR_AGENT_ENDPOINTS=https://agent1/validate,https://agent2/validate`
- `VALIDATOR_AGENT_BEARER=...` (opcional)

Payload enviado para cada agente validador:

```json
{
  "candidatePrompt": "...",
  "baselinePrompt": "...",
  "qualitySignals": ["..."],
  "runId": "r-..."
}
```

Resposta esperada:

```json
{
  "pass": true,
  "score": 0.82,
  "notes": "Prompt melhora naturalidade"
}
```

## Observações de produção

- Em Vercel, use Supabase Service Role Key apenas no server-side.
- Recomenda-se ligar esse autopilot em paralelo com a API principal da Iara para monitoramento e otimização contínua.
