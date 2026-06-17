# Relatório de Qualidade — IARA Bot

**Data:** 2026-06-17
**Revisor:** quality-reporter (análise estática direta do código-fonte)
**Branch:** main | Commit HEAD: `526f5a7`

---

## Resumo Executivo

O sistema está em estado funcional e com boa maturidade para um produto em crescimento. A arquitetura central (FastAPI/Fastify + PostgreSQL + OpenAI) está correta e o fluxo de pagamento (`recordSubscriptionPayment`) usa transações com `FOR UPDATE` adequadas. Os pontos críticos identificados são: (1) o pool de conexões PostgreSQL sem limites definidos, o que pode esgotar conexões sob carga, (2) a ausência de rate-limiting no endpoint de login admin (vulnerável a brute-force), e (3) o `ensureJardesSchema` sem guarda de idempotência (executa DDL a cada chamada). Os dois arquivos centrais (`webhooks.ts` com 5.966 linhas e `ledger.ts` com 3.591 linhas) estão muito além do limite de 500 linhas do projeto e impõem risco crescente de manutenção.

---

## P1 — Críticos (corrigir agora)

### 1. Pool de conexões PostgreSQL sem limites configurados

**Arquivo:** `apps/api/src/db/pool.ts` — linha 6

O `Pool` é instanciado apenas com `connectionString`. O padrão `pg` é `max: 10` conexões, mas não há `idleTimeoutMillis`, `connectionTimeoutMillis` nem `max` explícito. Sob picos de tráfego (proactive-alerts + webhooks simultâneos), o pool pode esgotar ou manter conexões idle por tempo indefinido.

**Correção sugerida:**
```typescript
export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});
```

---

### 2. Endpoint de login admin sem rate-limiting (brute-force)

**Arquivo:** `apps/api/src/routes/admin.ts` — handler `POST /admin/auth/login`

O endpoint de login usa `authenticateAdmin` com `scrypt` (correto), mas não há qualquer controle de tentativas por IP ou e-mail. Um atacante pode fazer milhares de tentativas sem ser bloqueado. Não há `429 Too Many Requests` em nenhum ponto do código de autenticação.

**Correção sugerida:** Adicionar `@fastify/rate-limit` com escopo específico para a rota de login:
```typescript
app.post('/admin/auth/login', {
  config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  ...
})
```
Ou implementar um contador em memória/Redis por IP com lockout de 15 minutos após 10 falhas.

---

### 3. `ensureJardesSchema` executa DDL sem guarda de idempotência

**Arquivo:** `apps/api/src/services/jardes-analysis.ts` — linha 61

Diferente dos `ensureXxxSchema` em `ledger.ts` (que usam uma Promise singleton como guarda), `ensureJardesSchema` executa o bloco DDL completo a cada chamada. É chamada em linha 715 dentro de uma função que pode ser invocada repetidamente. Embora o `CREATE TABLE IF NOT EXISTS` seja seguro, cada chamada gera round-trips desnecessários ao banco.

**Correção sugerida:** Adicionar o padrão de guarda já usado no ledger:
```typescript
let _jardesSchemaReady: Promise<void> | null = null;
export async function ensureJardesSchema(): Promise<void> {
  if (!_jardesSchemaReady) {
    _jardesSchemaReady = (async () => {
      await pool.query(`CREATE TABLE IF NOT EXISTS ...`);
    })().catch((err) => { _jardesSchemaReady = null; throw err; });
  }
  await _jardesSchemaReady;
}
```

---

### 4. Webhook Pluggy sem verificação de assinatura quando secret não configurado

**Arquivo:** `apps/api/src/routes/openfinance.ts` — linha 189–194

Quando `config.pluggyWebhookSecret` não está definido, qualquer requisição ao endpoint `POST /openfinance/webhook/pluggy` é aceita sem autenticação. Ao contrário do webhook WhatsApp (que rejeita com 403 quando não configurado), este endpoint silenciosamente aceita tudo.

**Correção sugerida:**
```typescript
if (!config.pluggyWebhookSecret) {
  request.log.error('pluggy_webhook_secret_not_configured');
  return reply.status(403).send({ error: 'webhook_not_configured' });
}
```

---

## P2 — Importantes (próxima sprint)

### 1. `webhooks.ts` com 5.966 linhas — violação severa do limite de 500 linhas

**Arquivo:** `apps/api/src/routes/webhooks.ts`

Toda a lógica de processamento de inbound (`processInboundMessage`), roteamento de intents, e formatação de respostas está em um único arquivo. Isso dificulta testes unitários isolados, code review e resolução de conflitos de merge. A `processInboundMessage` provavelmente tem mais de 3.000 linhas.

**Ação sugerida:** Extrair para módulos já existentes (`routes/webhooks/`) os handlers de intent específicos que ainda estão inline (billing, owner commands, onboarding flow).

---

### 2. `ledger.ts` com 3.591 linhas — violação do limite de 500 linhas

**Arquivo:** `apps/api/src/services/ledger.ts`

Mesmo com a modularização parcial já feita (`ledger/transactions.ts`, `ledger/goals-reminders.ts` etc.), o arquivo principal ainda concentra funções de domínios distintos. A modularização está pela metade — `export * from './ledger/transactions.js'` no final indica a intenção certa, mas a migração não foi concluída.

**Ação sugerida:** Continuar a extração para sub-módulos: `ledger/subscriptions.ts`, `ledger/family.ts`, `ledger/gamification.ts`.

---

### 3. `jardes-analysis.ts` não usa o circuit breaker para chamadas OpenAI

**Arquivo:** `apps/api/src/services/jardes-analysis.ts` — linhas 805, 965, 1114, 1345, 1362, 1440

O `parser.ts` usa `withBreaker` do `openai-circuit-breaker.ts`, mas `jardes-analysis.ts` chama `openai.chat.completions.create` diretamente sem proteção de circuit breaker. Se a API OpenAI estiver falhando, o Jardes continuará tentando indefinidamente, podendo causar acúmulo de erros e impacto nos custos.

**Correção sugerida:**
```typescript
import { withBreaker } from './openai-circuit-breaker.js';
// ...
const response = await withBreaker(
  () => openai.chat.completions.create({ ... }),
  () => { throw new Error('openai_circuit_open'); }
);
```

---

### 4. `jardes-analysis.ts` não registra uso de tokens OpenAI

**Arquivo:** `apps/api/src/services/jardes-analysis.ts`

O `parser.ts` e `agent-room.ts` chamam `recordOpenAiUsageFromResponse` após cada chamada à API. `jardes-analysis.ts` não faz isso para nenhuma das suas chamadas (linhas 805, 965, 1114, 1345, 1362, 1440). Isso gera lacuna nos relatórios de custo do admin dashboard.

**Correção sugerida:** Após cada `openai.chat.completions.create`, adicionar:
```typescript
if (response.usage) recordOpenAiUsageFromResponse(response, 'jardes');
```

---

### 5. Assinatura Twilio: fallback silencioso quando token não configurado

**Arquivo:** `apps/api/src/routes/webhooks.ts` — linha 5917–5919

Quando `config.twilioAuthToken` não está configurado, o código apenas loga um `warn` e continua processando a requisição sem verificação de assinatura. Difere do comportamento do webhook Meta (que retorna 403). Inconsistência de postura de segurança.

**Correção sugerida:** Seguir o mesmo padrão do webhook Meta — rejeitar com 403 se o secret não estiver configurado em produção.

---

### 6. Webhook idempotency table sem índice em `processed_at`

**Arquivo:** `apps/api/src/routes/webhooks.ts` — linhas 96–125

A cleanup periódica faz `DELETE FROM processed_webhook_messages WHERE processed_at < NOW() - INTERVAL '48 hours'` sem índice em `processed_at`. Com alto volume de mensagens, essa query pode fazer seq scan.

**Correção sugerida:** Adicionar índice na criação da tabela:
```sql
CREATE INDEX IF NOT EXISTS idx_processed_webhook_messages_at
  ON processed_webhook_messages (processed_at);
```

---

## P3 — Melhorias (backlog)

1. **`connectRedirects` Map em memória (`openfinance.ts` linha 29):** Tokens Pluggy Connect ficam em memória, perdidos em restart. Em ambiente com múltiplas instâncias, o redirect pode falhar. Migrar para PostgreSQL ou Redis com TTL.

2. **`generateInviteCode` usa `Math.random()` (`ledger.ts` linha 275–282):** Para códigos de convite, `Math.random()` não é criptograficamente seguro. Usar `crypto.randomBytes` (já disponível no projeto).

3. **Ausência de health check do pool de banco:** `GET /health` existe, mas não verifica se o pool consegue executar uma query. Adicionar `SELECT 1` ao health check.

4. **`openai-circuit-breaker.ts` tem estado global singleton:** Com múltiplos módulos chamando OpenAI (parser, agent-room, jardes-analysis), um único circuit breaker compartilhado pode abrir por falhas do Jardes e bloquear o fluxo de resposta ao cliente. Considerar instâncias separadas por serviço.

5. **Testes cobrem parser e webhooks mas não cobrem `ledger.ts`:** Não há `.test.ts` para `ledger.ts` (o arquivo mais crítico de dados). Adicionar testes para `recordSubscriptionPayment`, `evaluateCustomerAccess` e `upsertCustomerByWhatsapp`.

6. **`_test_openai_tmp.ts` commitado no repositório:** Arquivo `apps/api/src/_test_openai_tmp.ts` e sua versão compilada em `dist/` devem ser removidos ou adicionados ao `.gitignore`.

---

## Pontos Positivos

- **Segurança de autenticação admin bem implementada:** uso de `scrypt` com N=16.384, `timingSafeEqual` em comparações, JWT HS256 custom sem dependência externa, migração automática de hashes legados após login.
- **Transação com `FOR UPDATE` no ledger:** `recordSubscriptionPayment` usa `BEGIN/FOR UPDATE/COMMIT` corretamente, evitando double-payment.
- **Verificação HMAC do webhook Meta:** implementada com `timingSafeEqual`, rejeita 403 quando o secret não está configurado — postura correta.
- **Idempotência de webhooks WhatsApp:** tabela `processed_webhook_messages` com `ON CONFLICT DO NOTHING` previne reprocessamento de mensagens duplicadas (Meta reenvia em timeout).
- **Circuit breaker OpenAI:** implementação clean de state machine `closed/open/half-open` com janela de tempo. Integrado corretamente no `parser.ts`.
- **Validação de entrada com Zod:** todos os endpoints usam schemas Zod antes de processar dados, com mensagens de erro claras.
- **Config com rejeição de defaults inseguros:** `INSECURE_DEFAULTS` no `config.ts` impede inicialização com valores placeholder em produção.
- **Modularização em andamento do ledger:** a extração para `ledger/transactions.ts`, `ledger/goals-reminders.ts` etc. está no caminho certo.
- **TypeScript strict mode ativado** no `tsconfig.json`.
