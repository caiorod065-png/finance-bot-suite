import test from 'node:test';
import assert from 'node:assert/strict';
import { __proactiveAlertsTestables } from './proactive-alerts.js';

test('janela de lembrete por horário dispara no minuto exato de antecedência', () => {
  const shouldSend = __proactiveAlertsTestables.isReminderDueAlertWindow({
    nowMinutes: (17 * 60) + 59,
    dueTime: '18:00',
    remindMinutesBefore: 1,
    dueReminderCatchUpMinutes: 120
  });
  assert.equal(shouldSend, true);
});

test('janela de lembrete por horário permite catch-up curto pós-vencimento', () => {
  const shouldSend = __proactiveAlertsTestables.isReminderDueAlertWindow({
    nowMinutes: (18 * 60) + 45,
    dueTime: '18:00',
    remindMinutesBefore: 10,
    dueReminderCatchUpMinutes: 120
  });
  assert.equal(shouldSend, true);
});

test('janela de lembrete por horário não dispara fora do catch-up', () => {
  const shouldSend = __proactiveAlertsTestables.isReminderDueAlertWindow({
    nowMinutes: (22 * 60) + 10,
    dueTime: '18:00',
    remindMinutesBefore: 10,
    dueReminderCatchUpMinutes: 120
  });
  assert.equal(shouldSend, false);
});

test('janela de lembrete por horário ignora dueTime inválido', () => {
  const shouldSend = __proactiveAlertsTestables.isReminderDueAlertWindow({
    nowMinutes: (18 * 60) + 10,
    dueTime: 'abc',
    remindMinutesBefore: 10,
    dueReminderCatchUpMinutes: 120
  });
  assert.equal(shouldSend, false);
});

test('follow-up: plano elite (tone max) deve reagir mais rápido', () => {
  const minutes = __proactiveAlertsTestables.followUpSilenceMinutesForTone('max');
  assert.equal(minutes, 45);
});

test('follow-up: planos médios esperam janela maior para evitar spam', () => {
  const medium = __proactiveAlertsTestables.followUpSilenceMinutesForTone('medium');
  const low = __proactiveAlertsTestables.followUpSilenceMinutesForTone('low');
  assert.equal(medium, 120);
  assert.equal(low, 180);
});

test('saudação do relatório diário usa horário local (America/Sao_Paulo)', () => {
  const morning = __proactiveAlertsTestables.greetingByTimeInTimezone(
    new Date('2026-04-10T11:00:00.000Z'),
    'America/Sao_Paulo'
  );
  const afternoon = __proactiveAlertsTestables.greetingByTimeInTimezone(
    new Date('2026-04-10T18:00:00.000Z'),
    'America/Sao_Paulo'
  );
  const night = __proactiveAlertsTestables.greetingByTimeInTimezone(
    new Date('2026-04-10T23:00:00.000Z'),
    'America/Sao_Paulo'
  );

  assert.equal(morning, 'Bom dia');
  assert.equal(afternoon, 'Boa tarde');
  assert.equal(night, 'Boa noite');
});
