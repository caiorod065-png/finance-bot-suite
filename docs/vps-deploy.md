# Deploy em VPS (URL fixa, sem túnel)

Este fluxo deixa API + painel admin em produção com HTTPS automático usando Caddy.

Arquivos usados:
- Compose: `infra/deploy/docker-compose.vps.yml`
- Proxy HTTPS: `infra/deploy/Caddyfile`
- Bootstrap VPS: `scripts/vps-bootstrap-ubuntu.sh`
- Deploy: `scripts/vps-deploy.sh`
- Status/logs: `scripts/vps-status.sh`

## 1) DNS do domínio

No seu provedor de DNS:
- crie `A` record para `SEU_DOMINIO` apontando para o IP público da VPS
- exemplo: `bot.seudominio.com -> 123.45.67.89`

## 2) Preparar VPS (Ubuntu 22.04/24.04)

SSH na VPS e rode:

```bash
git clone <SEU_REPO_GIT> /opt/finance-bot-suite
cd /opt/finance-bot-suite
./scripts/vps-bootstrap-ubuntu.sh
```

Saia e entre no SSH novamente (para aplicar grupo docker no usuário).

## 3) Configurar `.env` de produção

```bash
cd /opt/finance-bot-suite
cp .env.example .env
nano .env
```

Obrigatórios para produção:
- `PUBLIC_DOMAIN=bot.seudominio.com`
- `LETSENCRYPT_EMAIL=seu-email@dominio.com`
- `DATABASE_URL_VPS=postgres://finance_user:finance_pass@postgres:5432/finance_bot`
- `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`
- `ADMIN_TOKEN`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_JWT_SECRET`
- `OPENAI_API_KEY`, `OPENAI_MODEL`
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM`
- `ASAAS_API_KEY`, `ASAAS_WEBHOOK_TOKEN` (se cobrança automática estiver ativa)

## 4) Deploy

```bash
cd /opt/finance-bot-suite
./scripts/vps-deploy.sh
```

Saídas esperadas:
- Painel: `https://SEU_DOMINIO`
- Health: `https://SEU_DOMINIO/health`
- Webhook Twilio: `https://SEU_DOMINIO/webhooks/whatsapp/twilio`
- Webhook Meta: `https://SEU_DOMINIO/webhooks/whatsapp`

## 5) Configurar Twilio e Meta

Twilio Sandbox/Produção:
- `When a message comes in`: `https://SEU_DOMINIO/webhooks/whatsapp/twilio`
- Method: `POST`

Meta WhatsApp Cloud API:
- Callback URL: `https://SEU_DOMINIO/webhooks/whatsapp`
- Verify token: valor de `WHATSAPP_VERIFY_TOKEN` do `.env`

## 6) Operação diária

Status e logs:

```bash
cd /opt/finance-bot-suite
./scripts/vps-status.sh
```

Rebuild/restart após alteração:

```bash
docker compose -f infra/deploy/docker-compose.vps.yml --env-file .env up -d --build
```

## 7) Atualizar código

```bash
cd /opt/finance-bot-suite
git pull
./scripts/vps-deploy.sh
```

## 8) Backup do banco (recomendado)

```bash
cd /opt/finance-bot-suite
mkdir -p backups
docker compose -f infra/deploy/docker-compose.vps.yml --env-file .env exec -T postgres \
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" > backups/finance_bot_$(date +%F_%H%M).sql
```
