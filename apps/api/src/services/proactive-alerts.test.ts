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

// ── progressMessage ────────────────────────────────────────────────────────────

test('progressMessage: streakDays=1 gera "primeiro passo do streak" (sem pluralização incorreta)', () => {
  const msg = __proactiveAlertsTestables.progressMessage({
    name: 'Ana',
    streakDays: 1,
    activeDaysLast30: 1,
    monthOverMonthPct: null,
    tone: 'medium'
  });
  assert.ok(msg.includes('primeiro passo do streak'), `Esperado "primeiro passo do streak", recebido:\n${msg}`);
  assert.ok(!msg.includes('dia(s)'), `Não deve conter "dia(s)", recebido:\n${msg}`);
});

test('progressMessage: streakDays=2 gera "2 dias seguidos"', () => {
  const msg = __proactiveAlertsTestables.progressMessage({
    name: 'Ana',
    streakDays: 2,
    activeDaysLast30: 2,
    monthOverMonthPct: null,
    tone: 'medium'
  });
  assert.ok(msg.includes('2 dias seguidos'), `Esperado "2 dias seguidos", recebido:\n${msg}`);
});

test('progressMessage: activeDaysLast30=1 gera "1 dia" (sem "1 dias")', () => {
  const msg = __proactiveAlertsTestables.progressMessage({
    name: 'Ana',
    streakDays: 0,
    activeDaysLast30: 1,
    monthOverMonthPct: null,
    tone: 'medium'
  });
  assert.ok(msg.includes('1 dia'), `Esperado "1 dia", recebido:\n${msg}`);
  assert.ok(!msg.includes('1 dias'), `Não deve conter "1 dias", recebido:\n${msg}`);
});

test('progressMessage: percentual abaixo de -8% exibe tendência positiva', () => {
  const msg = __proactiveAlertsTestables.progressMessage({
    name: 'Ana',
    streakDays: 3,
    activeDaysLast30: 3,
    monthOverMonthPct: -15,
    tone: 'medium'
  });
  assert.ok(msg.includes('15% abaixo do mês passado'), `Esperado percentual negativo, recebido:\n${msg}`);
});

test('progressMessage: percentual acima de +12% exibe alerta de aumento', () => {
  const msg = __proactiveAlertsTestables.progressMessage({
    name: 'Ana',
    streakDays: 3,
    activeDaysLast30: 3,
    monthOverMonthPct: 20,
    tone: 'medium'
  });
  assert.ok(msg.includes('20% acima do mês passado'), `Esperado percentual positivo, recebido:\n${msg}`);
});

// ── ownerDailyReportMessage ────────────────────────────────────────────────────

const emptySummary = {
  runAt: '2026-04-10T12:00:00.000Z',
  timezone: 'America/Sao_Paulo',
  dryRun: false,
  customersScanned: 0,
  customersEligible: 0,
  skippedAccess: 0,
  inactivityAlertsTriggered: 0,
  inactivityAlertsSent: 0,
  followUpCheckinsTriggered: 0,
  followUpCheckinsSent: 0,
  riskAlertsTriggered: 0,
  riskAlertsSent: 0,
  progressAlertsTriggered: 0,
  progressAlertsSent: 0,
  reminderAlertsTriggered: 0,
  reminderAlertsSent: 0,
  weeklySummariesTriggered: 0,
  weeklySummariesSent: 0,
  scoreEvolutionsTriggered: 0,
  scoreEvolutionsSent: 0,
  monthlyVisualReportsTriggered: 0,
  monthlyVisualReportsSent: 0,
  limitAlertsTriggered: 0,
  limitAlertsSent: 0,
  renewalRemindersTriggered: 0,
  renewalRemindersSent: 0,
  goalAlertsTriggered: 0,
  goalAlertsSent: 0,
  familyRiskAlertsTriggered: 0,
  familyRiskAlertsSent: 0,
  familyMeetingsSent: 0,
  bomDiasSent: 0,
  boaNoitesSent: 0,
  weeklyChallengeSent: 0,
  tipsWeeklySent: 0,
  failures: []
};

test('ownerDailyReportMessage: NÃO contém o caractere "|" no output', () => {
  const msg = __proactiveAlertsTestables.ownerDailyReportMessage({
    ownerName: 'Felipe',
    timezone: 'America/Sao_Paulo',
    referenceDate: new Date('2026-04-10T12:00:00.000Z'),
    summary: emptySummary,
    activeCustomers: 10,
    online1h: 2,
    online24h: 5,
    newCustomersToday: 1,
    inactive7d: 1,
    pendingSetup: 0,
    pastDue: 0,
    trialCustomers: 0,
    mrrCents: 100000,
    planBreakdown: ''
  });
  assert.ok(!msg.includes('|'), `Não deve conter "|", recebido:\n${msg}`);
});

test('ownerDailyReportMessage: 1 cliente ativo usa singular "cliente ativo"', () => {
  const msg = __proactiveAlertsTestables.ownerDailyReportMessage({
    ownerName: 'Felipe',
    timezone: 'America/Sao_Paulo',
    referenceDate: new Date('2026-04-10T12:00:00.000Z'),
    summary: emptySummary,
    activeCustomers: 1,
    online1h: 0,
    online24h: 0,
    newCustomersToday: 0,
    inactive7d: 0,
    pendingSetup: 0,
    pastDue: 0,
    trialCustomers: 0,
    mrrCents: 0,
    planBreakdown: ''
  });
  assert.ok(msg.includes('1 cliente ativo'), `Esperado "1 cliente ativo", recebido:\n${msg}`);
  assert.ok(!msg.includes('1 clientes'), `Não deve conter "1 clientes", recebido:\n${msg}`);
});

test('ownerDailyReportMessage: 2 clientes ativos usa plural "clientes ativos"', () => {
  const msg = __proactiveAlertsTestables.ownerDailyReportMessage({
    ownerName: 'Felipe',
    timezone: 'America/Sao_Paulo',
    referenceDate: new Date('2026-04-10T12:00:00.000Z'),
    summary: emptySummary,
    activeCustomers: 2,
    online1h: 0,
    online24h: 0,
    newCustomersToday: 0,
    inactive7d: 0,
    pendingSetup: 0,
    pastDue: 0,
    trialCustomers: 0,
    mrrCents: 0,
    planBreakdown: ''
  });
  assert.ok(msg.includes('2 clientes ativos'), `Esperado "2 clientes ativos", recebido:\n${msg}`);
});

// ── reminderMessage ────────────────────────────────────────────────────────────

test('reminderMessage: daysUntilDue=1 contém "amanhã"', () => {
  const msg = __proactiveAlertsTestables.reminderMessage({
    name: 'Ana',
    title: 'Aluguel',
    amountCents: null,
    dueDate: '2026-04-11',
    dueTime: null,
    daysUntilDue: 1,
    remindDaysBefore: 1,
    remindMinutesBefore: null
  });
  assert.ok(msg.includes('amanhã'), `Esperado "amanhã", recebido:\n${msg}`);
});

test('reminderMessage: daysUntilDue=3 contém "3 dias"', () => {
  const msg = __proactiveAlertsTestables.reminderMessage({
    name: 'Ana',
    title: 'Aluguel',
    amountCents: null,
    dueDate: '2026-04-13',
    dueTime: null,
    daysUntilDue: 3,
    remindDaysBefore: 3,
    remindMinutesBefore: null
  });
  assert.ok(msg.includes('3 dias'), `Esperado "3 dias", recebido:\n${msg}`);
});

test('reminderMessage: daysUntilDue=0 indica que vence hoje', () => {
  const msg = __proactiveAlertsTestables.reminderMessage({
    name: 'Ana',
    title: 'Aluguel',
    amountCents: null,
    dueDate: '2026-04-10',
    dueTime: null,
    daysUntilDue: 0,
    remindDaysBefore: 0,
    remindMinutesBefore: null
  });
  assert.ok(msg.includes('hoje'), `Esperado "hoje", recebido:\n${msg}`);
});

// ── followUpCheckInMessage ─────────────────────────────────────────────────────

test('followUpCheckInMessage: NÃO contém "offline"', () => {
  for (const tone of ['low', 'medium', 'high', 'max'] as const) {
    const msg = __proactiveAlertsTestables.followUpCheckInMessage({
      name: 'Ana',
      tone,
      minutesSinceOutbound: 90
    });
    assert.ok(!msg.includes('offline'), `Tone "${tone}" não deve conter "offline", recebido:\n${msg}`);
  }
});

test('followUpCheckInMessage: tone=max inclui convite para resumo do dia', () => {
  const msg = __proactiveAlertsTestables.followUpCheckInMessage({
    name: 'Ana',
    tone: 'max',
    minutesSinceOutbound: 90
  });
  assert.ok(msg.includes('organizo'), `Esperado convite para resumo, recebido:\n${msg}`);
});

test('followUpCheckInMessage: tone=low retorna mensagem leve sem pressão', () => {
  const msg = __proactiveAlertsTestables.followUpCheckInMessage({
    name: 'Ana',
    tone: 'low',
    minutesSinceOutbound: 180
  });
  assert.ok(msg.includes('Ana'), `Esperado nome do usuário, recebido:\n${msg}`);
  assert.ok(!msg.includes('risco'), `Não deve mencionar "risco" em tom baixo, recebido:\n${msg}`);
});
