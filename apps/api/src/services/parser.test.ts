import test from 'node:test';
import assert from 'node:assert/strict';
import { inferCategory, parseIntent, detectClientContext, formatProfileFactsForPrompt } from './parser.js';

const referenceDate = new Date('2026-03-24T21:00:00.000Z');

test('Caso 1: pergunta de confirmação não vira lançamento', async () => {
  const intent = await parseIntent('Mas eu só tenho esse gasto de 80 reais até agora?', referenceDate, {
    disableAi: true,
    context: {
      lastAssistantMessage: 'Seu resumo do mês mostra despesas e projeção.',
      recentUserMessages: ['resumo do mês']
    }
  });

  assert.notEqual(intent.type, 'register-transaction');
  assert.equal(intent.type, 'ask-confirmation');
});

test('Caso 2: lançamento explícito registra gasto', async () => {
  const intent = await parseIntent('gastei 80 de transporte', referenceDate, { disableAi: true });
  assert.equal(intent.type, 'register-transaction');
  if (intent.type === 'register-transaction') {
    assert.equal(intent.amountCents, 8000);
    assert.equal(intent.category, 'transporte');
  }
});

test('Lançamento explícito dentro de conversa casual com pergunta anterior registra gasto', async () => {
  const intent = await parseIntent(
    'Estou um pouco cansado, o que recomenda? Um sono kk? Iara aproveitando, ontem gastei 45 reais em lanche',
    referenceDate,
    { disableAi: true }
  );

  assert.equal(intent.type, 'register-transaction');
  if (intent.type === 'register-transaction') {
    assert.equal(intent.amountCents, 4500);
    assert.equal(intent.category, 'alimentacao');
    assert.match(intent.occurredAtIso, /^2026-03-23T/);
  }
});

test('Categoria: comida deve entrar em alimentação (não em outros)', async () => {
  assert.equal(inferCategory('gastei 35 reais em comida'), 'alimentacao');
  assert.equal(inferCategory('hoje paguei almoço 42 reais'), 'alimentacao');
  assert.equal(inferCategory('jantei fora, deu 58 reais'), 'alimentacao');

  const intent = await parseIntent('Iara, anota ai, hoje gastei 35 reais em comida', referenceDate, { disableAi: true });
  assert.equal(intent.type, 'register-transaction');
  if (intent.type === 'register-transaction') {
    assert.equal(intent.amountCents, 3500);
    assert.equal(intent.category, 'alimentacao');
  }
});

test('Caso 3: confirmação de estado não registra gasto', async () => {
  const intent = await parseIntent('esse 80 já está anotado ou você acabou de lançar de novo?', referenceDate, {
    disableAi: true,
    context: { lastAssistantMessage: 'Anotado gasto de R$ 80,00 em transporte.' }
  });
  assert.equal(intent.type, 'ask-confirmation');
});

test('Caso 4: correção explícita corrige lançamento', async () => {
  const intent = await parseIntent('corrige, não foi 80, foi 60', referenceDate, { disableAi: true });
  assert.equal(intent.type, 'correct-last-transaction');
  if (intent.type === 'correct-last-transaction') {
    assert.equal(intent.newAmountCents, 6000);
  }
});

test('Caso 5: frase ambígua pede confirmação antes de registrar', async () => {
  const intent = await parseIntent('80 em transporte?', referenceDate, { disableAi: true });
  assert.equal(intent.type, 'confirm-transaction-action');
});

test('Caso 6: pergunta de projeção explica cálculo sem registrar', async () => {
  const intent = await parseIntent('como você chegou nesse déficit?', referenceDate, {
    disableAi: true,
    context: { lastAssistantMessage: 'Risco alto: no ritmo atual, pode faltar dinheiro.' }
  });
  assert.equal(intent.type, 'ask-projection-reason');
});

test('Caso 7: pergunta sobre lembrete não vira resumo mensal', async () => {
  const intent = await parseIntent('mas amanhã você vai me lembrar?', referenceDate, {
    disableAi: true,
    context: { lastAssistantMessage: 'Já deixei um lembrete para amanhã: comprar remédio.' }
  });
  assert.equal(intent.type, 'help');
});

test('Caso 8: despedida de sono entra em modo conversacional (sem resumo)', async () => {
  const intent = await parseIntent(
    'Boa, amanhã eu te passo tudo direitinho, vou dormir que estou muito cansado, até amanhã!',
    referenceDate,
    {
      disableAi: true,
      context: {
        lastAssistantMessage: 'Quer dar uma olhada e lançar alguma despesa que ficou faltando?'
      }
    }
  );

  assert.equal(intent.type, 'help');
  if (intent.type === 'help') {
    assert.equal(intent.reason, 'sleep-farewell');
  }
});

test('Bateria curta adicional anti-regressão', async () => {
  const samples: Array<{ text: string; expected: string }> = [
    { text: 'mas eu só tenho esse gasto?', expected: 'ask-confirmation' },
    { text: 'então esse valor já está salvo?', expected: 'ask-confirmation' },
    { text: 'como assim déficit?', expected: 'ask-projection-reason' },
    { text: '80 em mercado?', expected: 'confirm-transaction-action' },
    { text: 'corrige, era 50', expected: 'correct-last-transaction' }
  ];

  for (const sample of samples) {
    const intent = await parseIntent(sample.text, referenceDate, {
      disableAi: true,
      context: { lastAssistantMessage: 'Resumo atualizado.' }
    });
    assert.equal(intent.type, sample.expected);
  }
});

test('Bateria 120 perguntas de conversa/uso não viram lançamento nem resumo automático', async () => {
  const prefixes = [
    'quero sim',
    'beleza',
    'entendi',
    'ok',
    'show',
    'iara'
  ];

  const usageQuestions = [
    'como posso te mandar meus gastos',
    'como mando meus gastos',
    'como eu envio meus gastos',
    'como faço para registrar um gasto',
    'como faço para registrar receitas',
    'como funciona',
    'como você funciona',
    'quais comandos você entende',
    'quais opções eu tenho',
    'me explica como usar',
    'me ensina a usar',
    'o que você faz',
    'como anotar um gasto',
    'como anotar uma receita',
    'como te passo meus dados',
    'como começo a usar',
    'como eu falo com você',
    'como te mando as informações',
    'como cadastrar meus gastos',
    'como usar direito'
  ];

  let executed = 0;
  for (const prefix of prefixes) {
    for (const question of usageQuestions) {
      const text = `${prefix}, ${question}?`;
      const intent = await parseIntent(text, referenceDate, {
        disableAi: true,
        context: {
          lastAssistantMessage: 'Tudo certo. Se quiser, já começamos seu controle.',
          recentUserMessages: ['oi', 'quero começar']
        }
      });
      executed += 1;
      assert.equal(intent.type, 'help', `Falhou para frase: "${text}" => ${intent.type}`);
    }
  }

  assert.equal(executed, 120);
});

test('Bateria extra: perguntas com valor monetário continuam seguras (sem escrita automática)', async () => {
  const samples = [
    'mas esse 80 já está salvo?',
    'então 230 foi o total?',
    'como assim déficit de 27 reais?',
    'esse valor de 120 é de ontem?',
    '80 em mercado?',
    'isso quer dizer que já gastei 300?',
    'esse 50 foi lançado em qual categoria?',
    'de onde saiu esse 90?',
    'como você chegou nesses 400?',
    'então meu único gasto foi 80 mesmo?',
    'amanhã você vai me lembrar desse remédio?'
  ];

  for (const text of samples) {
    const intent = await parseIntent(text, referenceDate, {
      disableAi: true,
      context: {
        lastAssistantMessage: 'Resumo: despesas de R$ 230 e projeção de déficit.',
        recentUserMessages: ['resumo do mês']
      }
    });
    assert.notEqual(intent.type, 'register-transaction', `Não deveria registrar para: "${text}"`);
    assert.notEqual(intent.type, 'set-spending-limit', `Não deveria setar limite para: "${text}"`);
    assert.notEqual(intent.type, 'clear-spending-limit', `Não deveria remover limite para: "${text}"`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// inferCategory — todas as categorias em bateria única
// ─────────────────────────────────────────────────────────────────────────────

test('inferCategory: bateria completa de categorias', () => {
  // transporte
  assert.equal(inferCategory('paguei uber 28 reais'), 'transporte');
  assert.equal(inferCategory('gasolina do carro'), 'transporte');
  assert.equal(inferCategory('passagem de ônibus'), 'transporte');
  assert.equal(inferCategory('estacionamento hoje'), 'transporte');
  // alimentação
  assert.equal(inferCategory('almocei no restaurante'), 'alimentacao');
  assert.equal(inferCategory('pedi ifood'), 'alimentacao');
  assert.equal(inferCategory('pizza delivery'), 'alimentacao');
  assert.equal(inferCategory('açaí com granola'), 'alimentacao');
  // mercado
  assert.equal(inferCategory('fui ao supermercado'), 'mercado');
  assert.equal(inferCategory('compra do mercado'), 'mercado');
  assert.equal(inferCategory('feira livre hoje'), 'mercado');
  // saúde
  assert.equal(inferCategory('consulta médica'), 'saude');
  assert.equal(inferCategory('farmácia remédio'), 'saude');
  assert.equal(inferCategory('academia mensal'), 'saude');
  assert.equal(inferCategory('sessão de fisioterapia'), 'saude');
  // lazer
  assert.equal(inferCategory('netflix mensal'), 'lazer');
  assert.equal(inferCategory('cinema com amigos'), 'lazer');
  assert.equal(inferCategory('ingresso show'), 'lazer');
  // moradia
  assert.equal(inferCategory('aluguel do apartamento'), 'moradia');
  assert.equal(inferCategory('condomínio deste mês'), 'moradia');
  assert.equal(inferCategory('reforma do banheiro'), 'moradia');
  // utilidades
  assert.equal(inferCategory('conta de água'), 'utilidades');
  assert.equal(inferCategory('conta de luz'), 'utilidades');
  assert.equal(inferCategory('internet mensal'), 'utilidades');
  assert.equal(inferCategory('botijão de gás'), 'utilidades');
  // educação
  assert.equal(inferCategory('mensalidade da faculdade'), 'educacao');
  assert.equal(inferCategory('curso online'), 'educacao');
  assert.equal(inferCategory('material escolar'), 'educacao');
  // vestuário
  assert.equal(inferCategory('comprei uma camisa'), 'vestuario');
  assert.equal(inferCategory('tênis novo'), 'vestuario');
  assert.equal(inferCategory('calça jeans'), 'vestuario');
  // beleza
  assert.equal(inferCategory('manicure'), 'beleza');
  assert.equal(inferCategory('salão de cabeleireiro'), 'beleza');
  assert.equal(inferCategory('barbearia'), 'beleza');
  // impostos
  assert.equal(inferCategory('IPTU do imóvel'), 'impostos');
  assert.equal(inferCategory('IPVA do carro'), 'impostos');
  // outros
  assert.equal(inferCategory('coisa aleatória sem categoria'), 'outros');
  assert.equal(inferCategory('presente para amigo'), 'outros');
});

// ─────────────────────────────────────────────────────────────────────────────
// Valores monetários e datas relativas (via parseIntent com disableAi)
// ─────────────────────────────────────────────────────────────────────────────

test('Valores monetários: numérico simples, centavos, R$, milhar, extenso puro', async () => {
  const cases: Array<{ text: string; cents: number }> = [
    { text: 'gastei 50 reais no mercado', cents: 5000 },
    { text: 'paguei 32,50 no restaurante', cents: 3250 },
    { text: 'gastei R$ 120 no shopping', cents: 12000 },
    { text: 'paguei 1.500 reais de aluguel', cents: 150000 },
    { text: 'gastei trinta reais no mercado', cents: 3000 },
    { text: 'paguei cinquenta e cinco reais de aluguel', cents: 5500 },
    { text: 'gastei trinta e dois reais no lanche', cents: 3200 },
  ];
  for (const c of cases) {
    const intent = await parseIntent(c.text, referenceDate, { disableAi: true });
    assert.equal(intent.type, 'register-transaction', `tipo errado para: "${c.text}"`);
    if (intent.type === 'register-transaction') {
      assert.equal(intent.amountCents, c.cents, `centavos errado para: "${c.text}"`);
    }
  }
});

test('Valor misto "30 e dois reais" prioriza numérico (30 reais = 3000)', async () => {
  // currencyAfterNumber captura "30 reais" antes do processamento por extenso misto
  const intent = await parseIntent('gastei 30 e dois reais no lanche', referenceDate, { disableAi: true });
  assert.equal(intent.type, 'register-transaction');
  if (intent.type === 'register-transaction') {
    assert.equal(intent.amountCents, 3000);
  }
});

test('Datas relativas: ontem, anteontem, hoje, data explícita', async () => {
  const cases = [
    { text: 'ontem gastei 40 reais em lanche', pattern: /^2026-03-23T/ },
    { text: 'anteontem gastei 60 reais em transporte', pattern: /^2026-03-22T/ },
    { text: 'hoje gastei 20 reais em café', pattern: /^2026-03-24T/ },
    { text: 'gastei 80 reais em mercado no dia 10/03', pattern: /^2026-03-10T/ },
  ];
  for (const c of cases) {
    const intent = await parseIntent(c.text, referenceDate, { disableAi: true });
    assert.equal(intent.type, 'register-transaction', `tipo errado para: "${c.text}"`);
    if (intent.type === 'register-transaction') {
      assert.match(intent.occurredAtIso ?? '', c.pattern, `data errada para: "${c.text}"`);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ruleBased — intents reconhecidos sem OpenAI
// ─────────────────────────────────────────────────────────────────────────────

test('ruleBased: resumo, income, delete, limites, extrato, correção', async () => {
  // resumo mensal
  const resumo = await parseIntent('resumo do mês', referenceDate, { disableAi: true });
  assert.equal(resumo.type, 'monthly-summary');
  if (resumo.type === 'monthly-summary') {
    assert.equal(resumo.month, 3);
    assert.equal(resumo.year, 2026);
  }

  // income
  const income = await parseIntent('recebi 3000 reais de salário', referenceDate, { disableAi: true });
  assert.equal(income.type, 'register-transaction');
  if (income.type === 'register-transaction') {
    assert.equal(income.kind, 'income');
    assert.equal(income.amountCents, 300000);
  }

  // delete
  const del = await parseIntent('apaga o último gasto', referenceDate, { disableAi: true });
  assert.equal(del.type, 'delete-last-transaction');

  // limites
  const listLim = await parseIntent('meus limites', referenceDate, { disableAi: true });
  assert.equal(listLim.type, 'list-spending-limits');

  const setLim = await parseIntent('limite semanal de 500 reais', referenceDate, { disableAi: true });
  assert.equal(setLim.type, 'set-spending-limit');
  if (setLim.type === 'set-spending-limit') {
    assert.equal(setLim.period, 'weekly');
    assert.equal(setLim.amountCents, 50000);
  }

  // "zera" é uma palavra completa e casa \bzera\b na regex de clear
  const clrLim = await parseIntent('zera o limite semanal', referenceDate, { disableAi: true });
  assert.equal(clrLim.type, 'clear-spending-limit');

  // extrato
  const extrato = await parseIntent('quero ver meu extrato', referenceDate, { disableAi: true });
  assert.equal(extrato.type, 'ask-expense-period');

  const exMes = await parseIntent('todos os gastos esse mês', referenceDate, { disableAi: true });
  assert.equal(exMes.type, 'full-expense-list');
  if (exMes.type === 'full-expense-list') {
    assert.equal(exMes.period, 'this-month');
  }

  // "deste mês" não casa "esse mes" → ask-expense-period
  const desteMes = await parseIntent('todos os gastos deste mês', referenceDate, { disableAi: true });
  assert.equal(desteMes.type, 'ask-expense-period');

  // correção rápida
  const corr = await parseIntent('não, foi 33', referenceDate, { disableAi: true });
  assert.equal(corr.type, 'correct-last-transaction');
  if (corr.type === 'correct-last-transaction') {
    assert.equal(corr.newAmountCents, 3300);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// detectClientContext e formatProfileFactsForPrompt — funções puras
// ─────────────────────────────────────────────────────────────────────────────

test('detectClientContext: DDD, tom emocional e linguagem', () => {
  assert.match(detectClientContext('+5511998887777', 'oi'), /São Paulo \(capital\)/);
  assert.match(detectClientContext('+5521987654321', 'oi'), /Rio de Janeiro/);
  assert.match(detectClientContext('+5511999', 'absurdo, não funciona de jeito nenhum'), /irritado/);
  assert.match(detectClientContext('+5511999', 'não entendi nada, como assim?'), /confuso/);
  assert.match(detectClientContext('+5511999', 'precisa ser agora, urgente!'), /urgência/);
  assert.match(detectClientContext('+5511999', 'mano, tá ligado? sacou?'), /muito informal/);
});

test('formatProfileFactsForPrompt: vazio, fatos conhecidos e chave desconhecida', () => {
  assert.equal(formatProfileFactsForPrompt([]), undefined);

  const result = formatProfileFactsForPrompt([
    { key: 'profissao', value: 'CLT' },
    { key: 'tem_dependentes', value: 'sim (2 filhos)' }
  ]);
  assert.ok(result);
  assert.match(result, /Profissão: CLT/);
  assert.match(result, /Dependentes: sim \(2 filhos\)/);

  const unknown = formatProfileFactsForPrompt([{ key: 'chave_nao_mapeada', value: 'valor_teste' }]);
  assert.ok(unknown);
  assert.match(unknown, /chave_nao_mapeada: valor_teste/);
});
