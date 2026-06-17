# Flow Validation Report — IARA Bot (WhatsApp / Twilio)

**Gerado por:** flow-validator  
**Codebase:** `/apps/api/src`  
**Data de análise:** 2026-06-17

---

## 1. Diagrama textual do fluxo completo

```
[Twilio] ──POST /webhooks/whatsapp/twilio──► [webhooks.ts]
              │
              ▼
   1. HMAC-SHA1 verification (verifyTwilioSignature)
      ├─ config.twilioAuthToken ausente → SKIP (apenas warn)
      └─ falha → 403 + TwiML vazio (sem exception)
              │
              ▼
   2. extractTwilioWebhookPayload(request.body)
      ├─ Body vazio ou From/WaId ausente → TwiML vazio (retorno 200 silencioso)
      └─ parse via twilioInboundSchema (zod .passthrough())
              │
              ▼
   3. processInboundMessage(payload)
      │
      ├─ 3a. upsertCustomerByWhatsapp(from, name)
      │       └─ ensureCustomerSchema() → ALTER TABLE (lazy migration)
      │
      ├─ 3b. logConversation(id, 'inbound', text)
      │
      ├─ 3c. Jardes routing (isOwnerMode?) → early return possível
      │
      ├─ 3d. evaluateCustomerAccess(customerId)
      │
      ├─ 3e. onboarding check → handleSmartOnboardingReply / resumeSmartOnboarding
      │
      ├─ 3f. parseIntent(text, now, { context })
      │       ├─ ruleBased() — resposta síncrona
      │       └─ OpenAI call com withBreaker (circuit breaker)
      │           ├─ 3500ms timeout → fallback ruleBased()
      │           └─ parseAiJsonOutput + aiSchema.parse + normalizeAiIntent
      │
      ├─ 3g. Intent dispatch → uma de ~30 branches
      │       └─ ex: 'register-transaction' → saveTransaction() → ledger
      │
      ├─ 3h. generateScopedSupportReply (intents tipo 'help')
      │       ├─ withBreaker → OpenAI (9000ms timeout, 1 retry de 6000ms)
      │       └─ fallback: fallbackSupportReply() (local, sem I/O)
      │
      ├─ 3i. logConversation(id, 'outbound', replyText)
      │
      └─ 3j. retorna { responseBody, replyText }
              │
              ▼
   4. runJardesInterceptor (se não for owner)
              │
              ▼
   5. twimlResponse(finalReplyText) → reply 200 Content-Type: text/xml
```

---

## 2. Análise detalhada por camada

### 2.1 Camada de Entrada — `POST /webhooks/whatsapp/twilio`

**Arquivo:** `src/routes/webhooks.ts` linhas 5906–5945

| Etapa | Mecanismo | Risco de falha silenciosa |
|---|---|---|
| HMAC-SHA1 | `verifyTwilioSignature` com `timingSafeEqual` | **SIM** — se `TWILIO_AUTH_TOKEN` não estiver setado, a verificação é completamente ignorada (apenas log warn). Qualquer HTTP POST sem autenticação passa. |
| Parsing do body | `extractTwilioWebhookPayload` via Zod `.safeParse` | SIM — Body vazio retorna `null`, handler responde 200 + TwiML vazio. Twilio interpreta 200 como sucesso. Sem log de erro, apenas retorno silencioso. |
| messageId / deduplicação | **Ausente no Twilio** | **SIM** — O payload Twilio não inclui `messageId` (campo `WaId` é o número, não o ID da mensagem). A tabela `processed_webhook_messages` / `claimWebhookMessage` só é utilizada no handler Meta (não no Twilio). Mensagens duplicadas (retry do Twilio) são processadas múltiplas vezes. |

### 2.2 Camada de Parser — `src/services/parser.ts`

**Função principal:** `parseIntent` (linha 1247)

**Circuit breaker:** O `withBreaker` é aplicado **somente em `generateScopedSupportReply`** (linha 1739). A chamada OpenAI dentro de `parseIntent` (linha 1291) usa apenas um `Promise.race` com timeout de 3500ms, com `catch {}` que cai para `ruleBased()`. Não há contagem de falhas/circuit breaker em `parseIntent`.

| Ponto | Comportamento |
|---|---|
| AI OFF ou sem client | Retorna `ruleBased()` diretamente — sem OpenAI |
| Timeout 3500ms | Cai silenciosamente para `ruleBased()` — sem log |
| JSON inválido da IA | `parseAiJsonOutput` retorna `null` → `ruleBased()` — sem log |
| Zod parse falha (`aiSchema.parse`) | Lança exceção capturada pelo `catch {}` → `ruleBased()` com contexto — sem log |
| `generateScopedSupportReply` falha total | `withBreaker` chama `fallbackSupportReply()` — resposta local determinística |

**`fallbackSupportReply` coberta por testes?**
- O arquivo `src/services/parser.test.ts` existe, mas não testa `fallbackSupportReply` diretamente (a função é unexported — só exportável como comportamento observável via `generateScopedSupportReply`). A função é coberta indiretamente apenas se os testes forcam o circuito aberto ou timeout.

### 2.3 Camada de Ledger — `src/services/ledger/transactions.ts`

**Função:** `saveTransaction` (linha 73)

```typescript
await pool.query(
  `INSERT INTO transactions (...) VALUES (...)`,
  [...]
);
```

| Aspecto | Status |
|---|---|
| Validação de duplicata | **Ausente** — Não há índice UNIQUE em `(customer_id, occurred_at, amount_cents)` nem constraint que previna inserção duplicada. Reprocessamento do mesmo webhook Twilio insere transação duplicada. |
| Rollback em falha | **Ausente** — `saveTransaction` executa INSERT simples. Se `logConversation` (outbound) falhar depois, a transação já foi salva. Não há `BEGIN/COMMIT/ROLLBACK` em torno do fluxo completo. |
| Try/catch | **Ausente** — A função não tem try/catch. Erros de DB propagam para o caller. O caller (`processInboundMessage`) também não tem try/catch global — uma falha de DB quebra o handler e retorna 500 ao Twilio, que vai retentar (agravando a duplicata). |
| `logConversation` inbound | Executa dois queries em série (INSERT + UPDATE customers). Se o UPDATE falhar, o INSERT já foi commitado. Sem transação. |

---

## 3. Pontos cegos identificados

### P1 — Crítico

**3.1 Ausência de deduplicação no handler Twilio**
- **Onde:** `src/routes/webhooks.ts` linha 5929
- **Problema:** O handler Meta usa `claimWebhookMessage(messageId)` para garantir idempotência. O handler Twilio não faz isso — o payload Twilio não tem `MessageSid` sendo extraído. Uma reentrega do Twilio (retry por timeout) processa e salva a transação duas vezes.
- **Impacto:** Duplicação de gastos/receitas registrados; usuário não recebe alerta.

**3.2 HMAC bypassável em ambiente sem variável de ambiente**
- **Onde:** `src/routes/webhooks.ts` linha 5907
- **Problema:** `if (config.twilioAuthToken)` — em staging/dev ou se a variável for esquecida em produção, qualquer POST não autenticado é aceito como legítimo.
- **Impacto:** Injeção de mensagens fraudulentas, spam ou exploit de recursos.

**3.3 Sem transação de banco no fluxo principal**
- **Onde:** `processInboundMessage`, `saveTransaction`, `logConversation`
- **Problema:** `saveTransaction` + `logConversation(outbound)` são operações separadas sem `BEGIN/COMMIT`. Se o sistema cair entre elas, o usuário não recebe resposta mas a transação foi salva. Se `saveTransaction` for chamado duas vezes (retry), dois registros idênticos aparecem.
- **Impacto:** Estado inconsistente entre transações e logs.

### P2 — Importante

**3.4 Erros de OpenAI em `parseIntent` sem logging**
- **Onde:** `src/services/parser.ts` linha 1314 (`catch {}`)
- **Problema:** O bloco catch é completamente vazio. Timeouts, erros de quota, erros de rede caem silenciosamente sem nenhum log. Dificulta diagnóstico de degradação da IA.

**3.5 `generateScopedSupportReply` pode retornar `null`**
- **Onde:** `src/services/parser.ts` linha 1551 (`if (!client) return null`)
- **Problema:** Se `OPENAI_API_KEY` não estiver configurada, a função retorna `null`. O caller em `processInboundMessage` precisa tratar esse `null` explicitamente. Se não tratar, o usuário não recebe resposta e o log outbound é registrado com string vazia.

**3.6 Circuit breaker em estado global singleton (não thread-safe para produção distribuída)**
- **Onde:** `src/services/openai-circuit-breaker.ts` linhas 7–10
- **Problema:** `state`, `failureCount`, `openedAt` são variáveis de módulo. Em ambiente com múltiplas instâncias/workers (cluster Node.js, múltiplos pods), cada instância tem seu próprio circuit breaker sem compartilhar estado. Uma instância pode ter o circuito aberto enquanto as outras continuam enviando requests à OpenAI.

**3.7 `correctLastTransactionAmount` sem validação de propriedade**
- **Onde:** `src/services/ledger/transactions.ts` linha 134
- **Problema:** A query usa `customer_id = $1` — correto. Mas o `deleteLastTransaction` também só filtra por `customer_id`. Se dois usuários mandam mensagem simultaneamente, a ordem de `occurred_at DESC` pode pegar a transação correta. Porém o "last" é semântico — se o usuário tem dois gastos ao mesmo segundo, o DELETE apaga arbitrariamente um dos dois.

**3.8 `parseDateFlexible` / `parseRelativeOccurredAt` — timezone implícito**
- **Onde:** `src/routes/webhooks.ts` linha 724, `src/services/parser.ts` linha 264
- **Problema:** `parseRelativeOccurredAt` usa `new Date()` UTC sem ajuste de timezone. "ontem" para um usuário de SP às 01:00 BRT (04:00 UTC) pode calcular "ontem UTC" em vez de "ontem BRT", criando transação com data errada.

### P3 — Melhoria

**3.9 `extractTwilioWebhookPayload` retorna 200 em falha de parsing**
- **Onde:** `src/routes/webhooks.ts` linha 5922–5927
- **Problema:** Quando `extractTwilioWebhookPayload` retorna `null` (payload malformado), o handler responde `200 + TwiML vazio`. Twilio considera sucesso e não retentar. Correto do ponto de vista de retry, mas falha completamente silenciosa sem log.

**3.10 `logConversation` não tem try/catch**
- **Onde:** `src/services/ledger/conversations.ts` linha 5
- **Problema:** Se o banco estiver indisponível no momento do log inbound, a requisição inteira falha antes de processar a mensagem. O usuário não recebe resposta e a mensagem é perdida.

**3.11 Cleanup de `processed_webhook_messages` é fire-and-forget**
- **Onde:** `src/routes/webhooks.ts` linha 123
- **Problema:** `pool.query(...).catch(() => undefined)` — erros no cleanup são ignorados completamente. Se a tabela crescer demais, performance degrada silenciosamente.

---

## 4. Recomendações prioritárias

### P1 — Implementar imediatamente

**R1.1 Deduplicação no handler Twilio**
```typescript
// Extrair MessageSid do payload Twilio e usar claimWebhookMessage
const messageSid = (request.body as Record<string, string>).MessageSid;
if (messageSid) {
  const isNew = await claimWebhookMessage(messageSid);
  if (!isNew) return reply.header(...).send(twimlResponse()); // duplicata ignorada
}
```

**R1.2 Forçar HMAC em produção**
```typescript
if (!config.twilioAuthToken && config.nodeEnv === 'production') {
  request.log.error('TWILIO_AUTH_TOKEN não configurado em produção — abortando request');
  return reply.status(403).send(twimlResponse());
}
```

**R1.3 Envolver `saveTransaction` + `logConversation(outbound)` em transação DB**
```typescript
const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query('INSERT INTO transactions ...', [...]);
  await client.query('INSERT INTO conversation_logs ...', [...]);
  await client.query('COMMIT');
} catch (err) {
  await client.query('ROLLBACK');
  throw err;
} finally {
  client.release();
}
```

### P2 — Implementar no próximo sprint

**R2.1 Logar falhas da OpenAI em `parseIntent`**
```typescript
} catch (error) {
  request.log?.warn({ err: error }, 'parseIntent_openai_error');
  return ruleBased(text, now, options.context);
}
```

**R2.2 Tratar retorno `null` de `generateScopedSupportReply` explicitamente**
- Garantir que o caller verifique `if (!supportReply)` e use `fallbackSupportReply()` como fallback.

**R2.3 Considerar circuit breaker compartilhado via Redis/DB para ambientes multi-instância**
- Se o deploy usa múltiplos workers/pods, o circuit breaker in-memory perde eficácia.

**R2.4 Corrigir timezone em `parseRelativeOccurredAt`**
- Usar `config.defaultTimezone` ('America/Sao_Paulo') ao calcular "hoje/ontem" para evitar erros de data após meia-noite BRT.

### P3 — Melhorias de observabilidade

**R3.1 Adicionar log quando `extractTwilioWebhookPayload` retorna `null`**
```typescript
if (!payload) {
  request.log.warn({ body: request.body }, 'twilio_payload_parse_failed');
  return reply.header(...).send(twimlResponse());
}
```

**R3.2 Adicionar try/catch em `logConversation` inbound**
- Separar logging inbound do pipeline de processamento para que falha de log não impeça resposta ao usuário.

**R3.3 Adicionar índice UNIQUE ou constraint de idempotência em `transactions`**
- Considerar `UNIQUE(customer_id, source_message_hash)` ou similar para prevenir duplicatas sem depender apenas da lógica de aplicação.

---

## 5. Resumo executivo

O fluxo Twilio funciona corretamente no caminho feliz, mas possui três brechas críticas:

1. **Sem deduplicação** — mensagens reenviadas pelo Twilio geram transações duplicadas;
2. **HMAC bypassável** — ausência da variável de ambiente desabilita silenciosamente a autenticação;
3. **Sem transação DB** — estado inconsistente possível entre `saveTransaction` e `logConversation`.

O circuit breaker está bem implementado para o `generateScopedSupportReply`, mas ausente na chamada de `parseIntent`. A função `fallbackSupportReply` funciona como rede de segurança local adequada, mas não está diretamente coberta por testes unitários.
