import test from 'node:test';
import assert from 'node:assert/strict';
import { __proactiveAlertsTestables } from './proactive-alerts.js';

// ── followUpCheckInMessage: ramos adicionais ──────────────────────────────────

test('followUpCheckInMessage: tone=high menciona controle do dia', () => {
  const msg = __proactiveAlertsTestables.followUpCheckInMessage({
    name: 'Carlos',
    tone: 'high',
    minutesSinceOutbound: 60
  });
  assert.ok(msg.includes('Carlos'), `Esperado nome, recebido:\n${msg}`);
  assert.ok(!msg.includes('offline'), `Não deve conter "offline", recebido:\n${msg}`);
});

test('followUpCheckInMessage: tone=max com silêncio curto (≤60min) usa mensagem de disponibilidade', () => {
  // silenceHours = Math.max(1, Math.round(55/60)) = 1 → branch de <= 1 hora
  const msg = __proactiveAlertsTestables.followUpCheckInMessage({
    name: 'Bia',
    tone: 'max',
    minutesSinceOutbound: 55
  });
  assert.ok(
    msg.toLowerCase().includes('vontade') || msg.includes('porta aberta'),
    `Esperado mensagem leve de disponibilidade (≤1h), recebido:\n${msg}`
  );
});

test('followUpCheckInMessage: tone=medium inclui oferta de organizar os gastos', () => {
  const msg = __proactiveAlertsTestables.followUpCheckInMessage({
    name: 'Bia',
    tone: 'medium',
    minutesSinceOutbound: 130
  });
  assert.ok(msg.includes('Bia'), `Esperado nome, recebido:\n${msg}`);
  assert.ok(
    msg.includes('gastos') || msg.includes('organizo'),
    `Esperado oferta de organização de gastos, recebido:\n${msg}`
  );
});

// ── isReminderDueAlertWindow: bordas adicionais ───────────────────────────────

test('isReminderDueAlertWindow: dispara exatamente no horário de vencimento (remindMinutesBefore=0)', () => {
  const shouldSend = __proactiveAlertsTestables.isReminderDueAlertWindow({
    nowMinutes: 18 * 60,
    dueTime: '18:00',
    remindMinutesBefore: 0,
    dueReminderCatchUpMinutes: 60
  });
  assert.equal(shouldSend, true);
});

test('isReminderDueAlertWindow: não dispara antes da janela de antecedência', () => {
  const shouldSend = __proactiveAlertsTestables.isReminderDueAlertWindow({
    nowMinutes: (17 * 60) + 30,
    dueTime: '18:00',
    remindMinutesBefore: 10,
    dueReminderCatchUpMinutes: 60
  });
  assert.equal(shouldSend, false);
});

// ── greetingByTimeInTimezone: fronteiras de horário ──────────────────────────

test('greetingByTimeInTimezone: exatamente às 12:00 retorna "Boa tarde"', () => {
  // 2026-04-10T15:00:00Z = 12:00 America/Sao_Paulo (UTC-3)
  const result = __proactiveAlertsTestables.greetingByTimeInTimezone(
    new Date('2026-04-10T15:00:00.000Z'),
    'America/Sao_Paulo'
  );
  assert.equal(result, 'Boa tarde');
});

test('greetingByTimeInTimezone: exatamente às 18:00 retorna "Boa noite"', () => {
  // 2026-04-10T21:00:00Z = 18:00 America/Sao_Paulo (UTC-3)
  const result = __proactiveAlertsTestables.greetingByTimeInTimezone(
    new Date('2026-04-10T21:00:00.000Z'),
    'America/Sao_Paulo'
  );
  assert.equal(result, 'Boa noite');
});

// ── followUpSilenceMinutesForTone: tone=high ──────────────────────────────────

test('follow-up: plano high espera 75 minutos antes do check-in', () => {
  const minutes = __proactiveAlertsTestables.followUpSilenceMinutesForTone('high');
  assert.equal(minutes, 75);
});

// ── progressMessage: ramos não cobertos ──────────────────────────────────────

test('progressMessage: streakDays=0 e activeDaysLast30=0 gera "Voltando ao controle"', () => {
  const msg = __proactiveAlertsTestables.progressMessage({
    name: 'Ana',
    streakDays: 0,
    activeDaysLast30: 0,
    monthOverMonthPct: null,
    tone: 'medium'
  });
  assert.ok(msg.includes('Voltando ao controle'), `Esperado "Voltando ao controle", recebido:\n${msg}`);
});

test('progressMessage: tone=max inclui convite para ajuste final do mês', () => {
  const msg = __proactiveAlertsTestables.progressMessage({
    name: 'Ana',
    streakDays: 5,
    activeDaysLast30: 10,
    monthOverMonthPct: null,
    tone: 'max'
  });
  assert.ok(msg.includes('fechar o mês'), `Esperado convite para fechamento, recebido:\n${msg}`);
});

test('progressMessage: percentual estável (-7% a +11%) exibe "Ritmo estável"', () => {
  const msg = __proactiveAlertsTestables.progressMessage({
    name: 'Ana',
    streakDays: 3,
    activeDaysLast30: 3,
    monthOverMonthPct: 5,
    tone: 'medium'
  });
  assert.ok(msg.includes('Ritmo estável'), `Esperado "Ritmo estável", recebido:\n${msg}`);
});

test('progressMessage: monthOverMonthPct=null exibe ausência de histórico', () => {
  const msg = __proactiveAlertsTestables.progressMessage({
    name: 'Ana',
    streakDays: 0,
    activeDaysLast30: 2,
    monthOverMonthPct: null,
    tone: 'medium'
  });
  assert.ok(msg.includes('histórico'), `Esperado menção a "histórico", recebido:\n${msg}`);
});

test('progressMessage: activeDaysLast30=5 gera "5 dias" (plural correto)', () => {
  const msg = __proactiveAlertsTestables.progressMessage({
    name: 'Pedro',
    streakDays: 0,
    activeDaysLast30: 5,
    monthOverMonthPct: null,
    tone: 'medium'
  });
  assert.ok(msg.includes('5 dias'), `Esperado "5 dias", recebido:\n${msg}`);
  assert.ok(!msg.includes('5 dia '), `Não deve conter "5 dia " (singular), recebido:\n${msg}`);
});

// ── reminderMessage: ramos adicionais ────────────────────────────────────────

test('reminderMessage: amountCents presente inclui valor formatado em BRL', () => {
  const msg = __proactiveAlertsTestables.reminderMessage({
    name: 'Ana',
    title: 'Aluguel',
    amountCents: 150000,
    dueDate: '2026-04-11',
    dueTime: null,
    daysUntilDue: 1,
    remindDaysBefore: 1,
    remindMinutesBefore: null
  });
  assert.ok(msg.includes('R$'), `Esperado valor em BRL, recebido:\n${msg}`);
  assert.ok(msg.includes('amanhã'), `Esperado "amanhã", recebido:\n${msg}`);
});

test('reminderMessage: dueTime presente inclui horário no label de vencimento', () => {
  const msg = __proactiveAlertsTestables.reminderMessage({
    name: 'Ana',
    title: 'Consulta',
    amountCents: null,
    dueDate: '2026-04-11',
    dueTime: '14:30',
    daysUntilDue: 1,
    remindDaysBefore: 0,
    remindMinutesBefore: null
  });
  assert.ok(msg.includes('14:30'), `Esperado horário no lembrete, recebido:\n${msg}`);
});

test('reminderMessage: remindMinutesBefore=1 usa singular "minuto"', () => {
  const msg = __proactiveAlertsTestables.reminderMessage({
    name: 'Ana',
    title: 'Consulta',
    amountCents: null,
    dueDate: '2026-04-11',
    dueTime: '14:30',
    daysUntilDue: 0,
    remindDaysBefore: 0,
    remindMinutesBefore: 1
  });
  assert.ok(msg.includes('1 minuto'), `Esperado "1 minuto" (singular), recebido:\n${msg}`);
  assert.ok(!msg.includes('1 minutos'), `Não deve conter "1 minutos", recebido:\n${msg}`);
});

test('reminderMessage: remindMinutesBefore=30 usa plural "minutos"', () => {
  const msg = __proactiveAlertsTestables.reminderMessage({
    name: 'Ana',
    title: 'Consulta',
    amountCents: null,
    dueDate: '2026-04-11',
    dueTime: '14:30',
    daysUntilDue: 0,
    remindDaysBefore: 0,
    remindMinutesBefore: 30
  });
  assert.ok(msg.includes('30 minutos'), `Esperado "30 minutos" (plural), recebido:\n${msg}`);
});

// ── ownerDailyReportMessage: ramos de alertas e falhas ───────────────────────

const summaryWithAlerts = {
  runAt: '2026-04-10T12:00:00.000Z',
  timezone: 'America/Sao_Paulo',
  dryRun: false,
  customersScanned: 50,
  customersEligible: 40,
  skippedAccess: 10,
  inactivityAlertsTriggered: 5,
  inactivityAlertsSent: 5,
  followUpCheckinsTriggered: 2,
  followUpCheckinsSent: 2,
  riskAlertsTriggered: 1,
  riskAlertsSent: 1,
  progressAlertsTriggered: 3,
  progressAlertsSent: 3,
  reminderAlertsTriggered: 4,
  reminderAlertsSent: 4,
  weeklySummariesTriggered: 0,
  weeklySummariesSent: 0,
  scoreEvolutionsTriggered: 0,
  scoreEvolutionsSent: 0,
  monthlyVisualReportsTriggered: 0,
  monthlyVisualReportsSent: 0,
  limitAlertsTriggered: 0,
  limitAlertsSent: 0,
  renewalRemindersTriggered: 2,
  renewalRemindersSent: 2,
  goalAlertsTriggered: 0,
  goalAlertsSent: 0,
  familyRiskAlertsTriggered: 0,
  familyRiskAlertsSent: 0,
  familyMeetingsSent: 0,
  bomDiasSent: 10,
  boaNoitesSent: 0,
  weeklyChallengeSent: 0,
  tipsWeeklySent: 0,
  failures: [] as Array<{ customerId: string; whatsappNumber: string; reason: string }>
};

test('ownerDailyReportMessage: exibe linha de automações enviadas quando alertas > 0', () => {
  const msg = __proactiveAlertsTestables.ownerDailyReportMessage({
    ownerName: 'Felipe',
    timezone: 'America/Sao_Paulo',
    referenceDate: new Date('2026-04-10T12:00:00.000Z'),
    summary: summaryWithAlerts,
    activeCustomers: 40,
    online1h: 10,
    online24h: 20,
    newCustomersToday: 3,
    inactive7d: 5,
    pendingSetup: 2,
    pastDue: 1,
    trialCustomers: 4,
    mrrCents: 250000,
    planBreakdown: 'essential: 10 · premium: 5'
  });
  assert.ok(
    msg.includes('automação enviada') || msg.includes('automações enviadas'),
    `Esperado linha de automações, recebido:\n${msg}`
  );
  assert.ok(msg.includes('bom dia'), `Esperado "bom dia" nas automações, recebido:\n${msg}`);
  assert.ok(!msg.includes('|'), `Não deve conter "|", recebido:\n${msg}`);
});

test('ownerDailyReportMessage: exibe "Atenção" com inadimplentes e novos clientes', () => {
  const msg = __proactiveAlertsTestables.ownerDailyReportMessage({
    ownerName: 'Felipe',
    timezone: 'America/Sao_Paulo',
    referenceDate: new Date('2026-04-10T12:00:00.000Z'),
    summary: { ...summaryWithAlerts, bomDiasSent: 0, inactivityAlertsSent: 0, riskAlertsSent: 0, reminderAlertsSent: 0, renewalRemindersSent: 0 },
    activeCustomers: 15,
    online1h: 2,
    online24h: 4,
    newCustomersToday: 2,
    inactive7d: 0,
    pendingSetup: 1,
    pastDue: 3,
    trialCustomers: 0,
    mrrCents: 80000,
    planBreakdown: ''
  });
  assert.ok(msg.includes('Atenção'), `Esperado "Atenção", recebido:\n${msg}`);
  assert.ok(msg.includes('inadimplente'), `Esperado "inadimplente", recebido:\n${msg}`);
  assert.ok(msg.includes('novo'), `Esperado menção a novos clientes, recebido:\n${msg}`);
});

test('ownerDailyReportMessage: falhas reais aparecem como "Falhas reais: N"', () => {
  const summaryComFalha = {
    ...summaryWithAlerts,
    bomDiasSent: 0,
    inactivityAlertsSent: 0,
    riskAlertsSent: 0,
    reminderAlertsSent: 0,
    renewalRemindersSent: 0,
    failures: [
      { customerId: 'c1', whatsappNumber: '5511999990001', reason: 'Falha de rede' },
      { customerId: 'c2', whatsappNumber: '5511999990002', reason: 'timeout' }
    ]
  };
  const msg = __proactiveAlertsTestables.ownerDailyReportMessage({
    ownerName: 'Felipe',
    timezone: 'America/Sao_Paulo',
    referenceDate: new Date('2026-04-10T12:00:00.000Z'),
    summary: summaryComFalha,
    activeCustomers: 10,
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
  assert.ok(msg.includes('Falhas reais: 2'), `Esperado "Falhas reais: 2", recebido:\n${msg}`);
});

test('ownerDailyReportMessage: falha tipo "outside_window" não conta como falha real', () => {
  const summaryWindowFalha = {
    ...summaryWithAlerts,
    bomDiasSent: 0,
    inactivityAlertsSent: 0,
    riskAlertsSent: 0,
    reminderAlertsSent: 0,
    renewalRemindersSent: 0,
    failures: [
      { customerId: 'c1', whatsappNumber: '5511999990001', reason: 'customer_outside_window_no_template' }
    ]
  };
  const msg = __proactiveAlertsTestables.ownerDailyReportMessage({
    ownerName: 'Felipe',
    timezone: 'America/Sao_Paulo',
    referenceDate: new Date('2026-04-10T12:00:00.000Z'),
    summary: summaryWindowFalha,
    activeCustomers: 5,
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
  assert.ok(!msg.includes('Falhas reais'), `Não deve conter "Falhas reais" para erro de janela, recebido:\n${msg}`);
  assert.ok(msg.includes('janela') || msg.includes('Sem falhas'), `Esperado menção à falha de janela, recebido:\n${msg}`);
});
