import test from 'node:test';
import assert from 'node:assert/strict';
import { __webhooksTestables } from './webhooks.js';

const reference = new Date('2026-03-27T13:43:00.000Z');

test('regressão: ajuste de antecedência prioriza lembrete em foco da conversa', () => {
  const decision = __webhooksTestables.selectReminderForLeadUpdate({
    focusedReminderId: 'r-2',
    activeReminders: [
      { id: 'r-1', title: 'tomar vitamina', effectiveDueDate: '2026-03-27', dueTime: '22:00' },
      { id: 'r-2', title: 'tomar banho', effectiveDueDate: '2026-03-27', dueTime: '15:40' }
    ]
  });

  assert.equal(decision.type, 'update');
  if (decision.type === 'update') {
    assert.equal(decision.reminder.id, 'r-2');
    assert.equal(decision.reason, 'focused');
  }
});

test('regressão: sem foco, só atualiza automático quando há 1 lembrete ativo', () => {
  const decision = __webhooksTestables.selectReminderForLeadUpdate({
    focusedReminderId: null,
    activeReminders: [
      { id: 'r-1', title: 'pagar internet', effectiveDueDate: '2026-03-29', dueTime: null }
    ]
  });

  assert.equal(decision.type, 'update');
  if (decision.type === 'update') {
    assert.equal(decision.reminder.id, 'r-1');
    assert.equal(decision.reason, 'single-active');
  }
});

test('regressão: sem foco e com múltiplos lembretes, exige desambiguação', () => {
  const decision = __webhooksTestables.selectReminderForLeadUpdate({
    focusedReminderId: null,
    activeReminders: [
      { id: 'r-1', title: 'tomar vitamina', effectiveDueDate: '2026-03-27', dueTime: '22:00' },
      { id: 'r-2', title: 'tomar banho', effectiveDueDate: '2026-03-27', dueTime: '15:40' }
    ]
  });

  assert.equal(decision.type, 'ambiguous');
  if (decision.type === 'ambiguous') {
    assert.equal(decision.options.length, 2);
  }
});

test('regressão: "5 minutos antes, só esse lembrete mesmo" continua interpretando ajuste', () => {
  const parsed = __webhooksTestables.parseReminderLeadUpdateCommand('5 minutos antes, só esse lembrete mesmo');
  assert.ok(parsed);
  assert.equal(parsed.remindDaysBefore, 0);
  assert.equal(parsed.remindMinutesBefore, 5);
});

test('regressão: pergunta com intenção forte cria lembrete (quero lembrete ... ?)', () => {
  const parsed = __webhooksTestables.parseReminderCreateCommand(
    'Quero um lembrete para as 13:42 do dia de hoje, consegue me lembrar de almoçar?',
    reference
  );
  assert.ok(parsed);
  assert.equal(parsed.dueDate, '2026-03-27');
  assert.equal(parsed.dueTime, '13:42');
  assert.equal(parsed.title.includes('almocar') || parsed.title.includes('almoçar'), true);
});

test('regressão: confirma criação por contexto ("pode criar esse lembrete")', () => {
  const confirmation = __webhooksTestables.isReminderCreateConfirmationFromContext(
    'Pode criar esse lembrete e me avise 1 minutos antes'
  );
  assert.equal(confirmation, true);
});

test('regressão: extrai draft de lembrete do histórico inbound', () => {
  const parsed = __webhooksTestables.extractReminderDraftFromRecentInboundMessages(
    [
      { direction: 'inbound', message: 'Pode criar esse lembrete e me avise 1 minutos antes' },
      { direction: 'outbound', message: 'Posso criar esse lembrete para você agora?' },
      { direction: 'inbound', message: 'Quero um lembrete para as 13:42 do dia de hoje, consegue me lembrar de almoçar?' }
    ],
    'Pode criar esse lembrete e me avise 1 minutos antes',
    reference
  );
  assert.ok(parsed);
  assert.equal(parsed.dueDate, '2026-03-27');
  assert.equal(parsed.dueTime, '13:42');
});

test('regressão: findReminderByDraft prioriza lembrete certo do contexto recente', () => {
  const draft = __webhooksTestables.parseReminderCreateCommand(
    'Quero um lembrete para as 13:42 do dia de hoje, consegue me lembrar de almoçar?',
    reference
  );
  assert.ok(draft);

  const match = __webhooksTestables.findReminderByDraft(
    [
      { id: 'r-vitamina', title: 'tomar vitamina', effectiveDueDate: '2026-03-27', dueTime: '22:00' },
      { id: 'r-almoco', title: 'almoçar', effectiveDueDate: '2026-03-27', dueTime: '13:42' }
    ],
    draft
  );

  assert.ok(match);
  assert.equal(match?.id, 'r-almoco');
});

test('regressão: confirmação por contexto usa draft recente mesmo sem data explícita na frase original', () => {
  const parsed = __webhooksTestables.extractReminderDraftFromRecentInboundMessages(
    [
      { direction: 'inbound', message: 'Pode criar esse lembrete e me avise 1 minuto antes' },
      { direction: 'outbound', message: 'Perfeito, quer que eu crie esse lembrete agora?' },
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

test('regressão: confirmação usa o lembrete mais recente do contexto (não um antigo)', () => {
  const parsed = __webhooksTestables.extractReminderDraftFromRecentInboundMessages(
    [
      { direction: 'inbound', message: 'Pode criar esse lembrete e me avise 1 minutos antes' },
      { direction: 'inbound', message: 'sim' },
      { direction: 'outbound', message: 'Posso criar esse lembrete para você agora?' },
      { direction: 'inbound', message: 'Quero um lembrete para as 13:42 do dia de hoje, consegue me lembrar de almoçar?' },
      { direction: 'outbound', message: 'Anotei seu lembrete de vitamina.' },
      { direction: 'inbound', message: 'me lembra hoje as 22:00 para tomar vitamina' }
    ],
    'Pode criar esse lembrete e me avise 1 minutos antes',
    reference
  );
  assert.ok(parsed);
  assert.equal(parsed.dueDate, '2026-03-27');
  assert.equal(parsed.dueTime, '13:42');
  assert.equal(parsed.title.includes('almoçar') || parsed.title.includes('almocar'), true);
});

test('regressão: se o pedido imediatamente anterior está incompleto, não recicla lembrete antigo', () => {
  const parsed = __webhooksTestables.extractReminderDraftFromRecentInboundMessages(
    [
      { direction: 'inbound', message: 'Pode criar esse lembrete e me avise 1 minutos antes' },
      { direction: 'outbound', message: 'Posso criar esse lembrete para você agora?' },
      { direction: 'inbound', message: 'quero criar um lembrete' },
      { direction: 'inbound', message: 'me lembra hoje as 22:00 para tomar vitamina' }
    ],
    'Pode criar esse lembrete e me avise 1 minutos antes',
    reference
  );
  assert.equal(parsed, null);
});

test('bateria 150: criação de lembretes em linguagem natural', () => {
  const verbs = [
    'me lembra',
    'me lembre',
    'quero lembrar',
    'quero criar lembrete para',
    'quero cadastrar lembrete para'
  ];
  const activities = [
    'tomar banho',
    'pagar conta de luz',
    'comprar remédio',
    'ligar para escola',
    'tomar vitamina',
    'beber água',
    'ir ao mercado',
    'pagar internet',
    'renovar plano',
    'fazer alongamento'
  ];
  const times = ['08:00', '12:20', '19:40'];

  let executed = 0;
  for (const verb of verbs) {
    for (const activity of activities) {
      for (const time of times) {
        const text = `${verb} amanhã às ${time} para ${activity}`;
        const parsed = __webhooksTestables.parseReminderCreateCommand(text, reference);
        executed += 1;
        assert.ok(parsed, `falhou para: ${text}`);
        assert.equal(parsed.dueDate, '2026-03-28', `data inesperada para: ${text}`);
        assert.equal(parsed.dueTime, time, `hora inesperada para: ${text}`);
        assert.equal(parsed.recurrence, 'none', `recorrência inesperada para: ${text}`);
      }
    }
  }

  assert.equal(executed, 150);
});

test('bateria 80: perguntas de lembrete não criam lembrete transacional', () => {
  const values = [5, 10, 15, 20, 30, 40, 50, 60, 80, 100];
  const templates = [
    (v: number) => `amanhã você vai me lembrar ${v} minutos antes?`,
    (v: number) => `esse lembrete das ${v}:00 está salvo?`,
    (v: number) => `você já anotou meu lembrete de ${v} reais?`,
    (v: number) => `como funciona o aviso de ${v} minutos antes?`,
    (v: number) => `tem certeza que esse lembrete de ${v} está ativo?`,
    (v: number) => `não entendi esse lembrete de ${v}, explica?`,
    (v: number) => `quer dizer que vai lembrar ${v} minutos antes mesmo?`,
    (v: number) => `isso mesmo? o lembrete está para ${v}:30?`
  ];

  let executed = 0;
  for (const value of values) {
    for (const template of templates) {
      const text = template(value);
      const parsedCreate = __webhooksTestables.parseReminderCreateCommand(text, reference);
      executed += 1;
      assert.equal(parsedCreate, null, `não deveria criar lembrete para: ${text}`);
    }
  }

  assert.equal(executed, 80);
});

test('bateria 60: frases de ajuste de antecedência continuam reconhecidas', () => {
  const values = [1, 2, 3, 5, 10, 15, 20, 30, 45, 60];
  const templates = [
    (v: number) => `ajusta esse lembrete para ${v} minutos antes`,
    (v: number) => `quero aviso ${v} minutos antes no lembrete`,
    (v: number) => `mudar lembrete para ${v} minutos antes`,
    (v: number) => `deixa ${v} minutos antes no aviso`,
    (v: number) => `alterar antecedência para ${v} minutos antes no lembrete`,
    (v: number) => `quero lembrete ${v} dias antes`
  ];

  let executed = 0;
  for (const value of values) {
    for (const template of templates) {
      const text = template(value);
      const parsed = __webhooksTestables.parseReminderLeadUpdateCommand(text);
      executed += 1;
      assert.ok(parsed, `deveria identificar ajuste para: ${text}`);
      if (text.includes('dias antes')) {
        assert.equal(parsed.remindDaysBefore, Math.min(value, 30));
        assert.equal(parsed.remindMinutesBefore, null);
      } else {
        assert.equal(parsed.remindDaysBefore, 0);
        assert.equal(parsed.remindMinutesBefore, value);
      }
    }
  }

  assert.equal(executed, 60);
});
