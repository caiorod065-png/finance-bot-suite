import test from 'node:test';
import assert from 'node:assert/strict';
import { __webhooksTestables } from './webhooks.js';

const reference = new Date('2026-03-27T13:43:00.000Z');

test('contexto: confirmação curta ativa exclusão do último gasto quando veio de fallback de histórico', () => {
  const confirmed = __webhooksTestables.shouldConfirmDeleteLastFromContext({
    text: 'quero',
    lastAssistantMessage:
      'Oi! Entendo querer limpar tudo, mas não tenho como apagar todo o histórico de uma vez. Posso ajudar a apagar o último gasto que você anotou, se quiser. Quer fazer isso agora?'
  });
  assert.equal(confirmed, true);
});

test('contexto: confirmação curta sem oferta anterior NÃO ativa exclusão', () => {
  const confirmed = __webhooksTestables.shouldConfirmDeleteLastFromContext({
    text: 'quero',
    lastAssistantMessage: 'Quer que eu mostre seu resumo do mês?'
  });
  assert.equal(confirmed, false);
});

test('contexto: frase longa NÃO é confirmação curta de ação', () => {
  const confirmed = __webhooksTestables.shouldConfirmDeleteLastFromContext({
    text: 'quero apagar, mas antes me mostra meus gastos do mês',
    lastAssistantMessage:
      'Posso ajudar a apagar o último gasto que você anotou, se quiser. Quer fazer isso agora?'
  });
  assert.equal(confirmed, false);
});

test('lembrete: confirmação usa o rascunho da janela de contexto imediata, não um lembrete antigo', () => {
  const parsed = __webhooksTestables.extractReminderDraftFromRecentInboundMessages(
    [
      { direction: 'inbound', message: 'Pode criar esse lembrete e me avise 1 minuto antes' },
      { direction: 'outbound', message: 'Posso criar esse lembrete para você agora?' },
      { direction: 'inbound', message: 'Me lembre as 18 horas para me arrumar para ir para faculdade' },
      { direction: 'outbound', message: 'Anotei seu lembrete de vitamina.' },
      { direction: 'inbound', message: 'me lembra hoje as 22:00 para tomar vitamina' }
    ],
    'Pode criar esse lembrete e me avise 1 minuto antes',
    reference
  );

  assert.ok(parsed);
  assert.equal(parsed.dueDate, '2026-03-27');
  assert.equal(parsed.dueTime, '18:00');
  assert.equal(parsed.title.includes('faculdade'), true);
});

test('lembrete: se o pedido imediatamente anterior for incompleto, não recicla lembrete antigo', () => {
  const parsed = __webhooksTestables.extractReminderDraftFromRecentInboundMessages(
    [
      { direction: 'inbound', message: 'Pode criar esse lembrete e me avise 1 minuto antes' },
      { direction: 'outbound', message: 'Posso criar esse lembrete para você agora?' },
      { direction: 'inbound', message: 'quero criar um lembrete' },
      { direction: 'outbound', message: 'Anotei seu lembrete de vitamina.' },
      { direction: 'inbound', message: 'me lembra hoje as 22:00 para tomar vitamina' }
    ],
    'Pode criar esse lembrete e me avise 1 minuto antes',
    reference
  );

  assert.equal(parsed, null);
});

test('lembrete: sem janela outbound imediata, usa fallback para o inbound mais recente válido', () => {
  const parsed = __webhooksTestables.extractReminderDraftFromRecentInboundMessages(
    [
      { direction: 'inbound', message: 'Pode criar esse lembrete e me avise 1 minuto antes' },
      { direction: 'inbound', message: 'Me lembre amanhã às 07:00 de treino' },
      { direction: 'inbound', message: 'Me lembra hoje às 22:00 de tomar vitamina' }
    ],
    'Pode criar esse lembrete e me avise 1 minuto antes',
    reference
  );

  assert.ok(parsed);
  assert.equal(parsed.dueDate, '2026-03-28');
  assert.equal(parsed.dueTime, '07:00');
  assert.equal(parsed.title.includes('treino'), true);
});

test('owner report: pergunta de horário do relatório diário é detectada corretamente', () => {
  assert.equal(
    __webhooksTestables.isOwnerDailyReportScheduleQuestion('Iara me fala que horas você vai me encaminhar um relatório do dia?'),
    true
  );
  assert.equal(
    __webhooksTestables.isOwnerDailyReportScheduleQuestion('quero resumo do mês'),
    false
  );
});

test('owner costs: detecta pergunta natural de custo OpenAI', () => {
  const parsedMtd = __webhooksTestables.parseOwnerCostIntent(
    'Iara, quanto está o custo da OpenAI até agora nesse mês?'
  );
  assert.ok(parsedMtd);
  assert.equal(parsedMtd?.scopes.includes('openai'), true);
  assert.equal(parsedMtd?.window, 'mtd');

  const parsedProjected = __webhooksTestables.parseOwnerCostIntent(
    'me mostra a projeção de custo do open ai no fechamento do mês'
  );
  assert.ok(parsedProjected);
  assert.equal(parsedProjected?.scopes.includes('openai'), true);
  assert.equal(parsedProjected?.window, 'projected');

  const parsedNonCost = __webhooksTestables.parseOwnerCostIntent(
    'quanto eu gastei hoje no mercado?'
  );
  assert.equal(parsedNonCost, null);
});

test('owner costs: owner-mode responde custo OpenAI com overview mockado', async () => {
  let calls = 0;
  const resolved = await __webhooksTestables.resolveOwnerCostIntentReply({
    text: 'iara, qual o custo da openai no mês atual?',
    isOwner: true,
    loadOverview: async () => {
      calls += 1;
      return {
        period: {
          year: 2026,
          month: 4,
          dayOfMonth: 13,
          daysInMonth: 30,
          generatedAt: '2026-04-13T12:00:00.000Z'
        },
        fxUsdBrlRate: 5.4,
        providers: [
          {
            provider: 'openai',
            source: 'api',
            status: 'ok',
            mtdUsd: 12.34,
            projectedUsd: 28.5
          },
          {
            provider: 'twilio',
            source: 'fixed',
            status: 'ok',
            mtdUsd: 3.2,
            projectedUsd: 8.1
          },
          {
            provider: 'supabase',
            source: 'fixed',
            status: 'ok',
            mtdUsd: 10,
            projectedUsd: 25
          }
        ],
        totals: {
          mtdUsd: 25.54,
          projectedUsd: 61.6,
          mtdBrlCents: 13792,
          projectedBrlCents: 33264
        },
        revenue: {
          mtdBrlCents: 200000,
          projectedBrlCents: 420000,
          mrrBrlCents: 500000
        },
        profit: {
          mtdBrlCents: 186208,
          projectedBrlCents: 386736
        }
      };
    }
  });

  assert.ok(resolved);
  assert.equal(calls, 1);
  assert.equal(resolved?.denied, undefined);
  assert.equal(resolved?.error, undefined);
  assert.equal(resolved?.replyText.includes('OpenAI API'), true);
  assert.equal(resolved?.replyText.includes('MTD'), true);
});

test('owner costs: não-owner recebe bloqueio e não consulta overview', async () => {
  let calls = 0;
  const resolved = await __webhooksTestables.resolveOwnerCostIntentReply({
    text: 'qual o custo da openai no mês atual?',
    isOwner: false,
    loadOverview: async () => {
      calls += 1;
      throw new Error('não deveria chamar');
    }
  });

  assert.ok(resolved);
  assert.equal(calls, 0);
  assert.equal(resolved?.denied, true);
  assert.equal(
    resolved?.replyText,
    'Essa consulta de custo operacional é exclusiva do número administrador.'
  );
});

test('owner report: extrai número alvo de consulta de atividade diária', () => {
  const parsed = __webhooksTestables.extractOwnerStatusQueryTarget(
    'iara, quero saber o que o numero 11 96889-7750 anotou hoje'
  );
  assert.ok(parsed);
  assert.equal(parsed?.targetPhone, '11968897750');
});

test('owner grant: detecta comando de liberação com número e plano', () => {
  const parsed = __webhooksTestables.parseOwnerGrantAccessCommand(
    'iara, libera acesso do numero 11 96889-7750 no plano elite'
  );
  assert.deepEqual(parsed, {
    targetPhone: '11968897750',
    planCode: 'elite'
  });
});

test('owner grant: detecta comando de liberação sem plano explícito', () => {
  const parsed = __webhooksTestables.parseOwnerGrantAccessCommand(
    'liberar acesso do número 21969609354'
  );
  assert.ok(parsed);
  assert.equal(parsed?.targetPhone, '21969609354');
  assert.equal(parsed?.planCode, null);
});

test('owner grant: ignora frase que não é comando de liberação', () => {
  const parsed = __webhooksTestables.parseOwnerGrantAccessCommand(
    'quero saber quantos clientes ativos tenho'
  );
  assert.equal(parsed, null);
});

test('owner report: não extrai número quando não é consulta diária de status', () => {
  const parsed = __webhooksTestables.extractOwnerStatusQueryTarget(
    'iara, quero enviar mensagem para o numero 11 96889-7750'
  );
  assert.equal(parsed, null);
});

test('owner customers: detecta pergunta de quantidade de números cadastrados', () => {
  assert.equal(
    __webhooksTestables.isOwnerCustomersCountQuestion('Iara, quero saber quantos números temos cadastrados no nosso sistema'),
    true
  );
  assert.equal(
    __webhooksTestables.isOwnerCustomersCountQuestion('Iara, quantos gastos eu lancei hoje?'),
    false
  );
});

test('owner customers: detecta pedido explícito de lista de números', () => {
  assert.equal(
    __webhooksTestables.isOwnerCustomersListQuestion('me mostra quais são os números cadastrados', null),
    true
  );
  assert.equal(
    __webhooksTestables.isOwnerCustomersListQuestion('me fale quais são esses 6 números com acesso', null),
    true
  );
});

test('owner customers: detecta pedido por pronome com contexto recente', () => {
  assert.equal(
    __webhooksTestables.isOwnerCustomersListQuestion(
      'me mostre quais são eles',
      'Hoje temos 6 número(s) ativo(s) com acesso no sistema. Se quiser, eu te mostro a lista completa agora.'
    ),
    true
  );
  assert.equal(
    __webhooksTestables.isOwnerCustomersListQuestion(
      'me mostre quais são eles',
      'Quer que eu te mostre seu resumo do mês?'
    ),
    false
  );
  assert.equal(
    __webhooksTestables.isOwnerCustomersListQuestion(
      'me mostre quais são eles',
      null
    ),
    false
  );
});

test('owner customers: formata número BR de forma legível', () => {
  assert.equal(
    __webhooksTestables.formatWhatsappNumberPretty('11968897750'),
    '+55 11 96889-7750'
  );
  assert.equal(
    __webhooksTestables.formatWhatsappNumberPretty('+5511943341547'),
    '+55 11 94334-1547'
  );
});

test('owner costs: detecta custo da OpenAI com frase natural em PT-BR', () => {
  const parsed = __webhooksTestables.parseOwnerCostIntent('quanto está meus gastos na api da openai');
  assert.deepEqual(parsed, {
    scopes: ['openai'],
    window: 'both'
  });
});

test('owner costs: detecta custo da OpenAI mesmo com saudação no início', () => {
  const parsed = __webhooksTestables.parseOwnerCostIntent('bom dia iara, quero saber quanto está os meus gastos na api da openai');
  assert.deepEqual(parsed, {
    scopes: ['openai'],
    window: 'both'
  });
});

test('owner costs: detecta consulta consolidada com MTD e projetado', () => {
  const parsed = __webhooksTestables.parseOwnerCostIntent('me passa o custo total mtd e projetado da operação');
  assert.deepEqual(parsed, {
    scopes: ['total'],
    window: 'both'
  });
});

test('owner costs: detecta consulta específica de Twilio projetado', () => {
  const parsed = __webhooksTestables.parseOwnerCostIntent('qual a projeção de custo do twilio no fim do mês?');
  assert.deepEqual(parsed, {
    scopes: ['twilio'],
    window: 'projected'
  });
});

test('owner costs: detecta consulta do Supabase no mês atual', () => {
  const parsed = __webhooksTestables.parseOwnerCostIntent('quanto está o custo do supabase neste mês?');
  assert.deepEqual(parsed, {
    scopes: ['supabase'],
    window: 'mtd'
  });
});

test('owner costs: não confunde gasto pessoal com custo operacional', () => {
  const parsed = __webhooksTestables.parseOwnerCostIntent('quanto eu gastei hoje no mercado?');
  assert.equal(parsed, null);
});

test('owner costs: não confunde resumo mensal pessoal com total operacional', () => {
  const parsed = __webhooksTestables.parseOwnerCostIntent('qual o total de gastos desse mês?');
  assert.equal(parsed, null);
});

test('owner costs: resolvedor responde com custo OpenAI quando owner mistura saudação + pergunta', async () => {
  const resolved = await __webhooksTestables.resolveOwnerCostIntentReply({
    text: 'bom dia iara, quero saber quanto está os meus gastos na api da openai',
    isOwner: true,
    loadOverview: async () => ({
      period: {
        year: 2026,
        month: 4,
        dayOfMonth: 13,
        daysInMonth: 30,
        generatedAt: '2026-04-13T10:00:00.000Z'
      },
      fxUsdBrlRate: 5.0,
      revenue: {
        mtdBrlCents: 0,
        projectedBrlCents: 0,
        mrrBrlCents: 0
      },
      profit: {
        mtdBrlCents: -6250,
        projectedBrlCents: -13000
      },
      totals: {
        mtdUsd: 12.5,
        projectedUsd: 26,
        mtdBrlCents: 6250,
        projectedBrlCents: 13000
      },
      providers: [
        {
          provider: 'openai',
          source: 'api',
          status: 'ok',
          mtdUsd: 9,
          projectedUsd: 18
        },
        {
          provider: 'twilio',
          source: 'api',
          status: 'ok',
          mtdUsd: 2,
          projectedUsd: 5
        },
        {
          provider: 'supabase',
          source: 'fixed',
          status: 'ok',
          mtdUsd: 1.5,
          projectedUsd: 3,
          monthlyUsd: 3
        }
      ]
    }),
    loadPreviousMonthSnapshot: async () => ({
      snapshotDate: '2026-03-31',
      overview: {
        period: {
          year: 2026,
          month: 3,
          dayOfMonth: 31,
          daysInMonth: 31,
          generatedAt: '2026-03-31T23:59:59.000Z'
        },
        fxUsdBrlRate: 5.1,
        totals: {
          mtdUsd: 22,
          projectedUsd: 22,
          mtdBrlCents: 11220,
          projectedBrlCents: 11220
        },
        revenue: {
          mtdBrlCents: 0,
          projectedBrlCents: 0,
          mrrBrlCents: 0
        },
        profit: {
          mtdBrlCents: -11220,
          projectedBrlCents: -11220
        },
        providers: [
          {
            provider: 'openai',
            source: 'api',
            status: 'ok',
            mtdUsd: 12,
            projectedUsd: 12
          }
        ]
      }
    })
  });
  assert.ok(resolved);
  assert.equal(Boolean(resolved?.denied), false);
  assert.match((resolved?.replyText ?? '').toLowerCase(), /openai/);
  assert.match((resolved?.replyText ?? '').toLowerCase(), /variacao vs mes anterior|variação vs mês anterior/);
});
