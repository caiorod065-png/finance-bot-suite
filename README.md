# Finance Bot Suite (WhatsApp + IA + n8n)

Plataforma para assistente financeiro no WhatsApp com:
- captura de gastos em linguagem natural
- organização automática por categoria
- resumo mensal em tempo real
- painel administrativo para operação

## Arquitetura recomendada (MVP)

- **Canal**: WhatsApp Cloud API (Meta), 1 número para todos os clientes no MVP
- **Orquestração**: n8n (webhooks, roteamento e integrações)
- **Backend IA**: API Node.js (Fastify)
- **Banco**: PostgreSQL
- **Painel Admin**: front-end estático (Nginx) consumindo API
- **IA de parsing**: OpenAI API (com fallback por regra)

Fluxo principal:
1. Cliente envia mensagem no WhatsApp.
2. WhatsApp API chama webhook no n8n.
3. n8n envia payload para o backend (`POST /webhooks/whatsapp`).
4. Backend interpreta intenção (lançamento de gasto, consulta de resumo etc).
5. Backend persiste dados no PostgreSQL.
6. Backend devolve resposta textual.
7. n8n envia resposta para o cliente no WhatsApp.

## Plano de ação (11 etapas)

1. Definir regras de negócio (planos, limites, onboarding e cancelamento).
2. Escolher provedor WhatsApp (Cloud API oficial é o mais seguro para escala).
3. Subir stack local com Docker (Postgres + n8n + API + painel).
4. Configurar webhook de entrada no n8n.
5. Implementar parser de mensagens (gasto/receita/consulta/correção).
6. Persistir transações e logs de conversa.
7. Implementar resumo mensal por categoria e total.
8. Criar painel admin (clientes, métricas, atividade recente).
9. Adicionar autenticação forte (JWT + RBAC) e trilha de auditoria.
10. Implantar observabilidade (logs estruturados, alertas, health checks).
11. Preparar produção (SSL, backups, LGPD, testes de carga e antifraude básico).

## Regras comerciais aplicadas (MVP)

- Sem taxa de ativação — o cliente paga apenas a mensalidade do plano escolhido.
- Mensalidade conforme o plano (Gratuito R$0, Essencial R$39,90, Premium R$79,90, Família R$149,90, Elite R$299,90).
- Plano Família: 3 membros inclusos + R$29,90/mês por membro extra.
- Desconto por indicação: mensalidade cai para 60% quando cliente atinge `6` indicações.
- Bloqueio automático por inadimplência: cliente passa para `past_due` após vencimento + tolerância.
- Cancelamento: status `canceled` bloqueia respostas do bot até reativação.

## Status desta entrega

- [x] Estrutura do projeto criada
- [x] Docker Compose inicial
- [x] API MVP com webhook + parsing + resumo
- [x] Banco com schema inicial
- [x] Painel admin operacional (métricas, status de assinatura, ações de cobrança)
- [x] Workflows n8n de referência (entrada WhatsApp + sync de inadimplência)
- [x] Cobrança/assinatura manual com regras de bloqueio e reativação
- [x] Webhook de confirmação de pagamento (Asaas) para reativação automática
- [x] Comandos de correção no WhatsApp (apagar último gasto, corrigir valor)
- [x] Geração de cobranças Asaas pelo painel (entrada/mensal)
- [x] Rotina de renovação automática (geração de cobranças mensais pendentes)
- [x] Autenticação robusta de admin (login email/senha + JWT)

## Operação com multiagentes

Para trabalhar com vários agentes no Codex (Produto IA, Core Transacional, QA e Deploy),
use o playbook:

- `docs/codex-multi-agents.md`

## Como rodar localmente

1. Copie `.env.example` para `.env` na raiz.
2. Ajuste as variáveis (principalmente `OPENAI_API_KEY`, `ADMIN_TOKEN`).
   - Modelo padrão: `OPENAI_MODEL=gpt-4.1-mini`
   - Para gestão de custos no painel:
     - `COST_USD_BRL_RATE` (conversão USD -> BRL para projeções)
     - `COST_OPENAI_MONTHLY_USD` (fallback manual se API da OpenAI não tiver permissão de custo)
     - `COST_TWILIO_MONTHLY_USD` (fallback manual se API Twilio não estiver disponível)
     - `COST_SUPABASE_MONTHLY_USD` (ex: 25)
     - `COST_INFRA_MONTHLY_USD` (VPS/servidor)
     - `COST_OTHER_MONTHLY_USD` (outras despesas fixas)
3. Se seu banco já existia antes desta versão, rode as migrations:

```bash
psql "$DATABASE_URL" -f infra/migrations/2026-02-28-subscriptions-and-activity.sql
psql "$DATABASE_URL" -f infra/migrations/2026-03-04-admin-auth-billing-automation.sql
psql "$DATABASE_URL" -f infra/migrations/2026-03-08-spending-limits.sql
psql "$DATABASE_URL" -f infra/migrations/2026-03-08-trial-subscriptions.sql
psql "$DATABASE_URL" -f infra/migrations/2026-03-09-customer-tax-id.sql
psql "$DATABASE_URL" -f infra/migrations/2026-03-16-goals-reminders.sql
```

4. Suba o ambiente:

```bash
docker compose up --build
```

Serviços:
- API: `http://localhost:8080`
- Painel admin: `http://localhost:8081`
- n8n: `http://localhost:5678`
- Postgres: `localhost:5432`

Webhook oficial do WhatsApp (Meta):
- Verificação (`GET`) e mensagens (`POST`) em `http://SEU_DOMINIO/webhooks/whatsapp`
- Verify token: valor de `WHATSAPP_VERIFY_TOKEN` no `.env`
- A API já responde direto ao usuário quando recebe payload oficial da Meta.

Webhook de teste via Twilio Sandbox:
- Endpoint de entrada: `POST http://SEU_DOMINIO/webhooks/whatsapp/twilio`
- Content-Type esperado: `application/x-www-form-urlencoded`
- Resposta da API: TwiML XML (o próprio Twilio envia para o usuário no WhatsApp)

Webhook de cobrança disponível:
- `POST /webhooks/billing/asaas?token=<ASAAS_WEBHOOK_TOKEN>` com `externalReference` no formato `setup:<customer_uuid>` ou `monthly:<customer_uuid>`.
- quando o webhook recebe `PAYMENT_CONFIRMED`/`PAYMENT_RECEIVED`, o acesso é liberado automaticamente e o sistema tenta enviar mensagem de agradecimento no WhatsApp.
- para envio proativo via Twilio, configure no `.env`:
  - `TWILIO_ACCOUNT_SID`
  - `TWILIO_AUTH_TOKEN`
  - `TWILIO_WHATSAPP_FROM` (ex: `whatsapp:+14155238886` no sandbox)

Comandos já suportados no WhatsApp:
- `apaga meu último gasto`
- `corrige mercado, era 150 e foi 253,50`
- `limite diário 80`
- `limite semanal 450`
- `limite mensal 1800`
- `remover limite diário`
- `meus limites`
- `quero colocar um limite semanal` (a Iara pergunta o valor que falta)
- `meta 5000 para viagem até 31/12/2026`
- `minhas metas`
- `lembrete aluguel vence 20/03 lembrar 3 dias antes`
- `lembrete cartão dia 15 todo mês`
- `meus lembretes` / `contas a vencer`
- `insights do mês`
- `assinaturas` (detecção de recorrentes)
- `previsão de saldo` / `fluxo de caixa`
- `simular investimento 300 por mês por 24 meses a 1% ao mês`

Teste grátis:
- o painel permite ativar período de teste de 5 dias por cliente
- durante o teste, o bot responde normalmente e avisa que está em período de avaliação
- ao fim do teste, o acesso é bloqueado automaticamente até pagamento da entrada

Cobrança automática (Pix):
- quando o cliente sem acesso enviar mensagem, a API tenta gerar automaticamente a cobrança de entrada/mensal no Asaas
- quando o pagamento for confirmado via webhook Asaas, o acesso é liberado automaticamente
- se o Asaas exigir CPF/CNPJ, o bot pede o documento no WhatsApp para concluir a geração do Pix

Gestão de custos (novo):
- painel admin agora exibe custo MTD/projeção de OpenAI + Twilio + custos fixos (ex: Supabase)
- endpoint de visão consolidada: `GET /admin/costs/overview`
- snapshot diário de custos/lucro: `POST /admin/costs/snapshots`
- histórico de snapshots: `GET /admin/costs/snapshots?limit=30`
- script para snapshot diário: `./scripts/costs-daily-snapshot.sh`

Alertas proativos automáticos (novo):
- scheduler interno da API (rodando 24/7) agora executa os alertas automaticamente
  - variáveis: `PROACTIVE_AUTOMATION_ENABLED`, `PROACTIVE_AUTOMATION_INTERVAL_MINUTES`, `PROACTIVE_AUTOMATION_STARTUP_DELAY_SECONDS`, `PROACTIVE_AUTOMATION_CUSTOMER_LIMIT`
- status do scheduler: `GET /admin/automation/proactive/status`
- endpoint manual: `POST /admin/automation/proactive/run`
- painel admin: botão `Rodar alertas proativos`
- script CLI: `./scripts/proactive-alerts-run.sh`
- o job dispara:
  - lembretes de vencimento (na janela definida de cada conta)
  - alertas de limite (quando estiver perto/passar do limite diário/semanal/mensal)
  - resumo semanal automático (segunda-feira, quando houver movimento)

Exemplo de automação diária (cron, 23:55):

```bash
55 23 * * * cd /Users/felipegrigolettiguarde/Projects/finance-bot-suite && ./scripts/costs-daily-snapshot.sh >> /tmp/finance-costs.log 2>&1
```

Exemplo opcional de automação proativa por cron (se quiser execução externa):

```bash
0 8 * * * cd /Users/felipegrigolettiguarde/Projects/finance-bot-suite && ./scripts/proactive-alerts-run.sh >> /tmp/finance-proactive.log 2>&1
```

### Ativar IA (GPT-4.1 mini)

1. Gere sua chave em [OpenAI API Keys](https://platform.openai.com/api-keys)
2. No `.env`, configure:
   - `OPENAI_API_KEY=<sua_chave>`
   - `OPENAI_MODEL=gpt-4.1-mini`
3. Reinicie a API (`npm run dev` no `apps/api` ou reinicie o container)

Quando a chave estiver configurada, o parser passa a usar IA e mantém fallback por regra se houver erro momentâneo.

### Teste real no WhatsApp sem número próprio (Twilio Sandbox)

1. Crie conta em [Twilio WhatsApp Sandbox](https://www.twilio.com/docs/whatsapp/sandbox)
2. No painel do Sandbox, copie o `join code`
3. No seu WhatsApp, envie `join <codigo>` para o número do Sandbox Twilio
4. Configure no Twilio:
   - `When a message comes in` -> `POST https://SEU_DOMINIO/webhooks/whatsapp/twilio`
5. Envie uma mensagem de teste para o Sandbox

Resultado esperado:
- Sua mensagem entra na API
- A API processa (gasto/resumo/correção/apagar)
- Twilio entrega a resposta no seu WhatsApp

### Subir tudo com 1 comando (novo)

Para ligar API + painel admin + túnel de uma vez:

```bash
cd /Users/felipegrigolettiguarde/Projects/finance-bot-suite
./scripts/start-dev-stack.sh
```

Parar tudo:

```bash
./scripts/stop-dev-stack.sh
```

Ver status (portas, URL atual do túnel, logs):

```bash
./scripts/status-dev-stack.sh
```

## Operação Multiagente no Codex

Para trabalhar com vários agentes em paralelo (Produto IA, Core Backend, QA e Deploy),
use o playbook:

- [codex-multi-agent.md](/Users/felipegrigolettiguarde/Projects/finance-bot-suite/docs/codex-multi-agent.md)

Auto-start no login do Mac (não precisar abrir manualmente):

```bash
./scripts/install-mac-autostart.sh
```

Remover auto-start:

```bash
./scripts/uninstall-mac-autostart.sh
```

## Iara Autopilot (Self-Improvement em Next.js + Vercel)

Novo app para auto-melhoria recursiva de prompt/comportamento da Iara:

- path: `apps/iara-autopilot`
- docs: `apps/iara-autopilot/README.md`
- schema DB: `apps/iara-autopilot/sql/schema.sql`
- webhook: `POST /api/webhooks/whatsapp`
- loop cron: `GET /api/cron/self-improve` (agendado no `vercel.json` a cada 3 min)

Esse app monitora conversas, detecta repetição/tom robótico, gera novo prompt, simula, valida e aciona deploy automático na Vercel se houver ganho de qualidade.

### Deploy VPS com URL fixa (produção)

Guia completo:
- [docs/vps-deploy.md](/Users/felipegrigolettiguarde/Projects/finance-bot-suite/docs/vps-deploy.md)

Arquivos de produção:
- compose: `/infra/deploy/docker-compose.vps.yml`
- proxy HTTPS: `/infra/deploy/Caddyfile`
- bootstrap Ubuntu: `/scripts/vps-bootstrap-ubuntu.sh`
- deploy: `/scripts/vps-deploy.sh`
- status/logs: `/scripts/vps-status.sh`

Admin auth (novo):
- `POST /admin/auth/login` com `email` e `password` (retorna JWT)
- `GET /admin/auth/me` para validar sessão
- `POST /admin/auth/bootstrap` (usa `x-admin-token`) para definir/atualizar senha inicial
- Compatibilidade legada mantida via `x-admin-token` para n8n/scripts

Cobrança e renovação (novo):
- `POST /admin/billing/customers/:id/charges` para gerar cobrança Asaas (setup/mensal)
- `POST /admin/billing/renewals/run` para varrer vencimentos e gerar cobranças pendentes
- `GET /admin/payments` para ver pagamentos/pendências no painel

Gestão financeira avançada (novo):
- `GET /admin/customers/:id/goals`
- `GET /admin/customers/:id/goals/progress`
- `POST /admin/customers/:id/goals`
- `GET /admin/customers/:id/reminders`
- `POST /admin/customers/:id/reminders`
- `GET /admin/customers/:id/insights` (previsão + recorrentes)
- `POST /admin/automation/proactive/run` (execução de alertas automáticos)

## Teste sem número (sandbox local)

Quando você ainda não tem chip/eSIM, rode um fluxo local que simula conversa completa sem envio real no WhatsApp.

Pré-requisito: API local rodando em `http://localhost:8080`.

```bash
./scripts/sandbox-local-test.sh
```

O script:
- cria/usa um cliente simulado (`SANDBOX_FROM`)
- ativa assinatura (setup + mensal) via endpoint admin
- lança gastos, corrige valor, apaga último gasto e consulta resumo
- mostra respostas do bot no terminal

Teste de regressão das sprints (metas/lembretes/insights/previsão/simulador):

```bash
cd /Users/felipegrigolettiguarde/Projects/finance-bot-suite
ADMIN_TOKEN="<seu_admin_token>" node scripts/sprints-regression-test.mjs
```

Variáveis opcionais:
- `API_BASE_URL` (default: `http://localhost:8080`)
- `SANDBOX_FROM` (default: número aleatório `55119990XXXXXXXX`)
- `SANDBOX_NAME` (default: `Cliente Sandbox`)

Limpeza de clientes de teste (mantendo finais específicos):

```bash
cd /Users/felipegrigolettiguarde/Projects/finance-bot-suite
ADMIN_TOKEN="<seu_admin_token>" KEEP_SUFFIXES="1547,7750" node scripts/cleanup-customers.mjs
```

## Segurança e conformidade

- Não armazenar dados sensíveis sem necessidade.
- Criptografar tráfego (HTTPS) em produção.
- Política de retenção inicial:
  - histórico de mensagens: 12 meses
  - transações financeiras: 24 meses
  - backups: 90 dias
- Expor termos e consentimento no onboarding (LGPD).

## Próximos passos recomendados

- Conectar número real no WhatsApp Cloud API.
- Importar os 2 workflows n8n em `n8n/workflows`.
- Fazer testes reais com 5 cenários:
  - lançamento de gasto
  - consulta de total do mês
  - consulta por categoria
  - cliente sem pagamento de entrada
  - cliente em atraso mensal
