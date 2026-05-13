# Operação Multiagente (Codex) - Finance Bot Suite

Este documento define um fluxo simples para usar vários agentes em paralelo no projeto, sem gerar conflito.

## Objetivo

Separar trabalho por especialidade:

1. `Agente IA/Produto`:
   - conversa da Iara
   - prompt e personalidade
   - regras por plano
2. `Agente QA`:
   - testes de regressão
   - cenários de lembrete/meta/planos
   - checagem de não regressão conversacional
3. `Agente DevOps`:
   - deploy na VPS
   - saúde dos containers
   - diagnóstico Twilio/lembretes proativos

## Fluxo recomendado

1. Orquestrador abre uma tarefa clara por agente.
2. Cada agente roda no próprio escopo e entrega saída objetiva.
3. Orquestrador consolida mudanças e executa gate final:
   - testes
   - build
   - deploy
   - health check

## Gate obrigatório antes de deploy

Executar na API:

```bash
cd /Users/felipegrigolettiguarde/Projects/finance-bot-suite/apps/api
npm test
npm run build
```

Se falhar, não sobe para VPS.

## Operação em produção (VPS)

Rebuild e restart apenas da API:

```bash
ssh -i /Users/felipegrigolettiguarde/.ssh/id_ed25519_hostinger_vps -o IdentitiesOnly=yes root@187.77.245.198 \
  "cd /opt/finance-bot-suite/infra/deploy && \
   docker compose -f docker-compose.vps.yml build api && \
   docker compose -f docker-compose.vps.yml up -d api && \
   docker compose -f docker-compose.vps.yml ps"
```

## Checklist de diagnóstico rápido

1. API de pé:

```bash
curl -s http://127.0.0.1:8080/health
```

2. Scheduler proativo ativo:

```bash
curl -s -H "x-admin-token: $ADMIN_TOKEN" http://127.0.0.1:8080/admin/automation/proactive/status
```

3. Logs de lembrete proativo:

```bash
docker logs --tail=300 finance_api | grep -Ei "Proactive scheduler|auto-reminder-due|reminder"
```

4. Erros Twilio recentes:

```bash
cd /Users/felipegrigolettiguarde/Projects/finance-bot-suite
./scripts/twilio-last-errors.sh
```

## Convenções para evitar conflito entre agentes

1. Não editar o mesmo arquivo em paralelo.
2. QA valida cenários antes de DevOps subir.
3. DevOps só publica depois do gate passar.
4. Toda mudança crítica deve deixar teste de regressão.

## Tarefas padrão para delegar no Codex

1. IA/Produto:
   - "ajuste personalidade da Iara para tom humano + CTA financeiro"
2. QA:
   - "crie 30 casos de regressão para lembretes e intenção conversacional"
3. DevOps:
   - "suba versão na VPS e valide scheduler + health + logs Twilio"
