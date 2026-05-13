# Multiagentes no Codex (Finance Bot Suite)

Este guia padroniza como usar vários agentes trabalhando em paralelo no projeto.

## Objetivo

Separar trabalho por especialidade para acelerar entregas sem perder qualidade:

- IA conversacional da Iara
- lógica transacional (gastos, metas, lembretes)
- testes/regressão
- deploy/observabilidade

## Papéis recomendados

### 1) Agente Produto IA

Responsável por:

- ajustar prompt e regras de comunicação da Iara
- melhorar clareza/humanidade sem perder foco financeiro
- definir variação de tom por plano (Essencial/Premium/Elite)

Escopo principal:

- `apps/api/src/services/parser.ts`
- blocos de fallback humano em `apps/api/src/routes/webhooks.ts`

Prompt sugerido:

```
Você é o agente de Produto IA da Iara.
Sua meta é melhorar naturalidade, clareza e direção financeira da conversa.
Nunca deixe a resposta parecer robótica e sempre termine com próximo passo útil.
```

### 2) Agente Core Transacional

Responsável por:

- segurança transacional (não executar ação sem intenção explícita)
- parsing de lembretes/gastos/metas
- correções de ambiguidades e contexto

Escopo principal:

- `apps/api/src/routes/webhooks.ts`
- `apps/api/src/services/ledger.ts`

Prompt sugerido:

```
Você é o agente Core Transacional da Iara.
Prioridade máxima: segurança conversacional e execução correta.
Perguntas nunca viram escrita em banco.
```

### 3) Agente QA/Regras

Responsável por:

- testes de regressão
- baterias de conversa humana
- cobertura de casos ambíguos

Escopo principal:

- `apps/api/src/routes/webhooks-reminders.test.ts`
- `apps/api/src/routes/webhooks-reminders-bulk.test.ts`
- `apps/api/src/services/parser.test.ts`

Prompt sugerido:

```
Você é o agente de QA da Iara.
Crie e mantenha testes de regressão para conversa natural, lembretes e segurança transacional.
Priorize casos reais de WhatsApp.
```

### 4) Agente Deploy/Operação

Responsável por:

- VPS e Docker Compose
- saúde dos containers
- scheduler proativo (lembretes, alertas)

Escopo principal:

- `infra/deploy/docker-compose.vps.yml`
- scripts em `scripts/vps-*.sh`
- logs de runtime

Prompt sugerido:

```
Você é o agente de Deploy/Operação.
Mantenha API e scheduler estáveis em produção e valide saúde com evidências objetivas.
```

## Rotina de execução (recomendada)

1. Produto IA define comportamento alvo.
2. Core Transacional implementa regra.
3. QA escreve/regressa testes.
4. Deploy publica e valida em produção.

## Definição de pronto (DoD)

- testes passando (`npm test` e `npm run build`)
- sem regressão de lembretes
- sem execução transacional em pergunta conversacional
- scheduler proativo ativo em produção
- evidência mínima em log/status

## Checklist rápido por release

- [ ] Prompt da Iara atualizado
- [ ] Parsing de intenção validado (ambiguidade com confirmação)
- [ ] Bateria de testes executada
- [ ] Deploy em VPS concluído
- [ ] Verificação do scheduler: `/admin/automation/proactive/status`
- [ ] Teste manual no WhatsApp com frase natural

