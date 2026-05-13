# Operação Multiagente no Codex (Projeto Iara)

Este guia padroniza como usar múltiplos agentes no projeto `finance-bot-suite`.

## Objetivo

Rodar trabalho em paralelo sem perder controle:
- agente 1: produto/IA (tom de voz, fluxos conversacionais)
- agente 2: backend transacional (gastos, metas, lembretes, limites)
- agente 3: QA/regressão (bateria de testes e cenários reais)
- agente 4: DevOps (deploy, monitoramento, rollback)

## Formato recomendado de sprints

1. Definir escopo curto (1 objetivo por rodada)
2. Delegar em paralelo para 2-4 agentes
3. Consolidar resultados no agente principal
4. Aplicar patch único no código
5. Rodar testes
6. Subir para VPS

## Prompts prontos para delegação

Use estes prompts quando quiser me pedir para abrir múltiplos agentes.

### 1) Produto/IA
"Abra um agente para revisar a conversa da Iara e melhorar tom humano sem perder foco financeiro. Entregue regras e exemplos."

### 2) Backend
"Abra um agente para corrigir parsing transacional (gastos/metas/lembretes), com segurança para não executar ação em mensagem ambígua."

### 3) QA
"Abra um agente para criar regressão com no mínimo 100 testes de conversa e lembretes com horários relativos."

### 4) DevOps
"Abra um agente para validar deploy na VPS, health checks, logs de envio WhatsApp e plano de rollback."

## Checklist de aceite por rodada

- [ ] Mensagem ambígua não executa ação sem confirmação
- [ ] Lembrete com horário dispara no tempo esperado
- [ ] Respostas da Iara soam humanas e variam linguagem
- [ ] Plano/feature bloqueada é explicada sem texto robótico
- [ ] Testes automatizados passando
- [ ] Deploy atualizado na VPS

## Comandos úteis (operação local)

```bash
cd /Users/felipegrigolettiguarde/Projects/finance-bot-suite
./scripts/start-dev-stack.sh
./scripts/status-dev-stack.sh
./scripts/stop-dev-stack.sh
```

## Comandos úteis (VPS)

```bash
ssh root@187.77.245.198
cd /opt/finance-bot-suite/infra/deploy
docker compose -f docker-compose.vps.yml ps
docker logs -n 200 finance_api
```

## Observação

Quando instalar novas skills no Codex, reinicie o Codex para carregar.
