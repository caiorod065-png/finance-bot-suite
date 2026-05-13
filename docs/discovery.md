# Discovery: perguntas críticas do projeto

## Produto
- Você vai vender em modelo assinatura mensal? (sim/não)
- Cada cliente terá 1 número de WhatsApp vinculado por conta?
- O cliente pode editar/apagar transações por mensagem?

## Operação
- Vai começar com 1 número de WhatsApp para todos os clientes ou 1 número por cliente premium?
- Qual limite de clientes no MVP (ex: 100, 500, 2.000)?
- Qual SLA de resposta esperado (ex: < 5 segundos)?

## Financeiro/Comercial
- Quais planos (Starter/Pro/Premium) e limites por plano?
- Como será cobrança (Stripe, Asaas, Mercado Pago)?
- Regra para bloquear acesso por inadimplência?

## Compliance
- Precisa de termo LGPD explícito no onboarding? (recomendado: sim)
- Por quanto tempo armazenar histórico de mensagens?
- Precisa exportação de dados do cliente sob demanda?

## Técnica
- Provedor inicial de WhatsApp: Cloud API (Meta), Twilio, Z-API ou Evolution?
- Infra de produção: VPS, AWS, GCP ou outro?
- Banco principal: PostgreSQL gerenciado ou self-hosted?

## Sequência recomendada
1. Fechar provedor WhatsApp e cobrança.
2. Validar MVP com 10 clientes reais.
3. Medir retenção e qualidade de categorização.
4. Escalar painel, auth e observabilidade.
