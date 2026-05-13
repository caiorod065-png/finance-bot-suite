import test from 'node:test';
import assert from 'node:assert/strict';
import { inferCategory, parseIntent } from './parser.js';

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
