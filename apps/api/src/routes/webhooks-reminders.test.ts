import test from 'node:test';
import assert from 'node:assert/strict';
import { __webhooksTestables } from './webhooks.js';

test('lembrete com horário no mesmo dia usa antecedência em minutos (padrão 10)', () => {
  const reference = new Date('2026-03-27T12:43:00.000Z');
  const parsed = __webhooksTestables.parseReminderCreateCommand(
    'Me lembrar hoje às 10:00 para tomar uma vitamina',
    reference
  );

  assert.ok(parsed);
  assert.equal(parsed.dueDate, '2026-03-27');
  assert.equal(parsed.dueTime, '10:00');
  assert.equal(parsed.remindDaysBefore, 0);
  assert.equal(parsed.remindMinutesBefore, 10);
  assert.equal(parsed.title.includes('vitamina'), true);
});

test('lembrete com antecedência explícita em minutos preserva valor informado', () => {
  const reference = new Date('2026-03-27T12:43:00.000Z');
  const parsed = __webhooksTestables.parseReminderCreateCommand(
    'me lembra amanhã às 08:30 de tomar remédio 15 minutos antes',
    reference
  );

  assert.ok(parsed);
  assert.equal(parsed.dueDate, '2026-03-28');
  assert.equal(parsed.dueTime, '08:30');
  assert.equal(parsed.remindDaysBefore, 0);
  assert.equal(parsed.remindMinutesBefore, 15);
});

test('lembrete com antecedência em dias continua compatível', () => {
  const reference = new Date('2026-03-27T12:43:00.000Z');
  const parsed = __webhooksTestables.parseReminderCreateCommand(
    'lembrete aluguel vence 10/04 lembrar 3 dias antes',
    reference
  );

  assert.ok(parsed);
  assert.equal(parsed.dueDate, '2026-04-10');
  assert.equal(parsed.remindDaysBefore, 3);
  assert.equal(parsed.remindMinutesBefore, null);
});

test('lembrete com horário sem data explícita assume hoje quando horário ainda não passou', () => {
  const reference = new Date('2026-03-30T19:57:00.000Z'); // 16:57 America/Sao_Paulo
  const parsed = __webhooksTestables.parseReminderCreateCommand(
    'Me lembre as 18 horas para me arrumar para ir para faculdade',
    reference
  );

  assert.ok(parsed);
  assert.equal(parsed.dueDate, '2026-03-30');
  assert.equal(parsed.dueTime, '18:00');
  assert.equal(parsed.remindMinutesBefore, 10);
  assert.equal(parsed.title.includes('arrumar'), true);
  assert.equal(parsed.title.includes('faculdade'), true);
});

test('lembrete com horário sem data explícita assume amanhã quando horário já passou', () => {
  const reference = new Date('2026-03-30T22:10:00.000Z'); // 19:10 America/Sao_Paulo
  const parsed = __webhooksTestables.parseReminderCreateCommand(
    'Me lembre as 18 horas para ir para a faculdade',
    reference
  );

  assert.ok(parsed);
  assert.equal(parsed.dueDate, '2026-03-31');
  assert.equal(parsed.dueTime, '18:00');
  assert.equal(parsed.remindMinutesBefore, 10);
  assert.equal(parsed.remindDaysBefore, 0);
});

test('intenção de criar lembrete sem campos suficientes fica no fluxo de lembrete (não cai no chat genérico)', () => {
  const isCreateIntent = __webhooksTestables.isReminderCreateIntentEvenIfMissingFields(
    'quero colocar um lembrete'
  );
  assert.equal(isCreateIntent, true);
});

test('criação natural: "quero anotar um lembrete..." gera lembrete válido com título correto', () => {
  const reference = new Date('2026-03-27T16:42:00.000Z');
  const parsed = __webhooksTestables.parseReminderCreateCommand(
    'Quero anotar um lembrete, as 15:40 tenho que tomar banho',
    reference
  );
  assert.ok(parsed);
  assert.equal(parsed.dueTime, '15:40');
  assert.equal(parsed.title.includes('banho'), true);
  assert.equal(parsed.remindMinutesBefore, 10);
});

test('pergunta de status de lembrete não deve forçar fluxo de criação', () => {
  const isCreateIntent = __webhooksTestables.isReminderCreateIntentEvenIfMissingFields(
    'você vai me lembrar às 18?'
  );
  assert.equal(isCreateIntent, false);
});
