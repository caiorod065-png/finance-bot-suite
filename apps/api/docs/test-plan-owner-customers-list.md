# Plano de Testes — Bug `owner customers list`

## 1) Objetivo
Garantir que perguntas do dono sobre **quantidade/lista de números ativos** sejam respondidas corretamente em PT-BR natural, sem placeholders (ex: `(xx) xxxx-xxxx`) e sem respostas genéricas/desalinhadas.

Fluxo alvo no código:
- `isOwnerCustomersCountQuestion(...)`
- `isOwnerCustomersListQuestion(...)`
- bloco de decisão em `processInboundMessage(...)` para intents:
  - `owner-customers-count`
  - `owner-customers-list`

## 2) Escopo
- Canal WhatsApp (entrada textual) com foco em frases reais em PT-BR.
- Modo **owner** vs **não-owner**.
- Casos com contexto anterior (pronome: “eles/esses”).
- Asserts de conteúdo da resposta (strings e regex).

Fora de escopo:
- UI do painel admin.
- Cobrança/plano.
- Fluxos de custos operacionais (OpenAI/Twilio etc.).

## 3) Pré-condições e massa de dados

### 3.1 Configuração
- `OWNER_WHATSAPP_NUMBERS` deve conter o número dono de teste (ex: `11943341547`).

### 3.2 Massa base (6 ativos)
Criar 6 clientes ativos únicos para validar lista:
1. Ana — `+55 11 98888-1111`
2. Bruno — `+55 11 97777-2222`
3. Carla — `+55 21 96666-3333`
4. Diego — `+55 31 95555-4444`
5. Erika — `+55 41 94444-5555`
6. Fabio — `+55 51 93333-6666`

Observação: inserir também duplicatas do mesmo número com formatação diferente para validar deduplicação.

## 4) Critérios de aceitação (globais)
1. Perguntas de owner sobre quantidade/lista retornam dados reais e consistentes.
2. Frases com pronome (“eles/esses”) só listam quando houver contexto válido anterior.
3. Não-owner recebe bloqueio claro.
4. Sem placeholders mascarados tipo `(xx) xxxx-xxxx`.
5. Formatação de telefone em padrão legível BR (`+55 DD 9XXXX-XXXX`).

---

## 5) Matriz de testes (positivos/negativos)

## Positivos

### P01 — Quantidade (frase natural)
**Entrada (owner):**
`iara, quero saber quantos números temos cadastrados no nosso sistema`

**Esperado:**
- Status sucesso.
- Resposta contém: `Hoje temos 6 número(s) ativo(s) com acesso no sistema.`
- Resposta contém convite de continuidade: `Se quiser, eu te mostro a lista completa agora.`

**Asserts sugeridos:**
- `includes('Hoje temos 6 número(s) ativo(s) com acesso no sistema.')`
- `includes('lista completa')`

---

### P02 — Lista explícita (frase pedida pelo usuário)
**Entrada (owner):**
`me fale quais são esses 6 números`

**Esperado:**
- Retorna lista numerada.
- Cabeçalho com quantidade listada.
- Linhas no formato `1) Nome — +55 ...`

**Asserts sugeridos:**
- `includes('Perfeito. Aqui estão os 6 número(s) com acesso ativo:')`
- Regex por item: `/^1\) .+ — \+55 \d{2} \d{4,5}-\d{4}/m`
- `!includes('(xx) xxxx-xxxx')`
- `!includes('Sem nome')` (quando massa tem nomes preenchidos)

---

### P03 — Lista por pronome com contexto
**Pré-contexto (outbound anterior):**
`Hoje temos 6 número(s) ativo(s) com acesso no sistema...`

**Entrada (owner):**
`me mostre quais são eles`

**Esperado:**
- Deve listar os 6.

**Asserts sugeridos:**
- `includes('número(s) com acesso ativo')`
- regex de 6 linhas numeradas (`/^\d+\) .+$/gm` count = 6)

---

### P04 — Variação linguística com acento/caixa
**Entrada (owner):**
`Me Mostra Quais São os Números Ativos?`

**Esperado:**
- Lista correta.

**Asserts sugeridos:**
- `includes('acesso ativo')`

---

### P05 — Deduplicação de contatos
**Massa:** 8 registros, porém 2 duplicados de números já existentes.

**Entrada (owner):**
`quero ver os números cadastrados`

**Esperado:**
- Total e lista refletem **6 únicos**.

**Asserts sugeridos:**
- cabeçalho com `6`
- não repetir mesmo telefone em duas linhas

---

### P06 — Paginação lógica (mais de 20)
**Massa:** 26 contatos ativos únicos.

**Entrada (owner):**
`me mostre os números cadastrados`

**Esperado:**
- Mostra primeiros 20.
- Informa restantes.

**Asserts sugeridos:**
- `includes('primeiros de 26')`
- `includes('... e mais 6 número(s).')`
- número de linhas listadas = 20

---

## Negativos

### N01 — Não-owner tentando listar
**Entrada (não-owner):**
`me mostre quais são os números cadastrados`

**Esperado:**
- Bloqueio de permissão.

**Asserts sugeridos:**
- `equals('Essa consulta é do dono do sistema. Se quiser, eu te mostro só os dados do seu próprio número.')`

---

### N02 — Pergunta parecida, mas fora de escopo (não é clientes)
**Entrada (owner):**
`quantos gastos eu lancei hoje?`

**Esperado:**
- Não cair no fluxo `owner-customers-*`.
- Não responder com “números ativos”.

**Asserts sugeridos:**
- `!includes('número(s) ativo(s)')`
- `intent !== 'owner-customers-count'`

---

### N03 — Pronome sem contexto anterior
**Pré-contexto:** vazio ou última mensagem sobre outro assunto.

**Entrada (owner):**
`me mostre quais são eles`

**Esperado:**
- Não listar clientes por inferência fraca.
- Cair em help/clarificação.

**Asserts sugeridos:**
- `!includes('número(s) com acesso ativo')`
- resposta pede esclarecimento/contexto

---

### N04 — Sem contatos ativos
**Massa:** 0 ativos.

**Entrada (owner):**
`me mostre quais são eles`

**Esperado:**
- Mensagem de vazio correta.

**Asserts sugeridos:**
- `equals('No momento, não existe nenhum número ativo para listar.')`

---

### N05 — “esses 6” com base real diferente
**Massa:** 4 ativos.

**Entrada (owner):**
`me fale quais são esses 6 números`

**Esperado:**
- Sistema ignora “6” informado pelo usuário e responde com 4 reais.

**Asserts sugeridos:**
- cabeçalho com `4`
- `!includes('os 6 número(s)')`

---

### N06 — Privacidade de dados
**Entrada (owner):** listagem comum.

**Esperado:**
- Não vazar CPF/CNPJ, e-mail, IDs internos, chaves.

**Asserts sugeridos:**
- `!match(/\b\d{11}\b/)` para CPF puro (quando não é telefone)
- `!includes('@')`
- `!includes('customer_id')`
- `!includes('tax_id')`

---

## 6) Asserts de qualidade textual
Aplicar em todos os casos de lista/contagem:
1. Não contém placeholder mascarado:
   - `!includes('(xx) xxxx-xxxx')`
2. Não contém texto codificado/técnico indevido.
3. Tom claro e objetivo em PT-BR.
4. Sem contradição entre total e linhas retornadas.

---

## 7) Estratégia de automação recomendada

### 7.1 Camada unitária (rápida)
Testar funções puras:
- `isOwnerCustomersCountQuestion`
- `isOwnerCustomersListQuestion`
- `formatWhatsappNumberPretty`

### 7.2 Camada integração (crítica)
Testar `processInboundMessage` com mocks/stubs de:
- owner check
- `listActiveCustomerContacts`
- `getLastOutboundMessage`

Garantir asserts de:
- texto da resposta
- intent logado
- total/shown corretos
- lista sem placeholders

### 7.3 Regressão de linguagem real
Criar suite com frases reais PT-BR (as acima) e variações:
- “me fale quais são esses 6 números”
- “me mostre quais são eles”
- “me diga os telefones ativos”
- “quais clientes com acesso?”

---

## 8) Critério de pronto
O bug é considerado resolvido quando:
1. Todos os casos P01..P06 passam.
2. Todos os casos N01..N06 passam.
3. Nenhuma resposta de lista usa placeholders mascarados.
4. Não há regressão nos testes já existentes de owner (cost/status/customers).

