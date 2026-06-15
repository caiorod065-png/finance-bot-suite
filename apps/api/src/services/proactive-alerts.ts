import { config } from '../config.js';
import {
  adminMetrics,
  batchAutoMessagesSentThisMonth,
  batchAutoMessagesSentThisWeek,
  batchAutoMessagesSentToday,
  batchInboundMessagesSentToday,
  evaluateCustomerAccess,
  findLatestUnansweredOutbound,
  forecastCashflowMonth,
  getCustomerStreak,
  hasAutoMessageThisMonth,
  hasAutoFollowupAfter,
  hasAutoMessageThisWeek,
  hasAutoMessageToday,
  hasInboundMessageToday,
  listActiveCustomerContacts,
  listBillReminders,
  logConversation,
  markBillReminderNotifiedForDueDate,
  monthlyVisualReportData,
  spendingInsights,
  spendingLimitStatuses,
  weeklyFinancialHealthSeries,
  weeklySummary,
  isOwnerWhatsappNumber,
  getActiveSavingsGoals,
  getSavingsGoalMonthlyProgress,
  getFamilyRiskSnapshot,
  familyMonthlySummary
} from './ledger.js';
import { sendWhatsAppText } from './whatsapp-outbound.js';
import { getPlanDefinition, planHasFeature } from './plans.js';
import { pool } from '../db/pool.js';

type ProactiveRunParams = {
  referenceDate?: Date;
  timezone?: string;
  dryRun?: boolean;
  customerLimit?: number;
};

export type ProactiveRunResult = {
  runAt: string;
  timezone: string;
  dryRun: boolean;
  customersScanned: number;
  customersEligible: number;
  skippedAccess: number;
  inactivityAlertsTriggered: number;
  inactivityAlertsSent: number;
  followUpCheckinsTriggered: number;
  followUpCheckinsSent: number;
  riskAlertsTriggered: number;
  riskAlertsSent: number;
  progressAlertsTriggered: number;
  progressAlertsSent: number;
  reminderAlertsTriggered: number;
  reminderAlertsSent: number;
  weeklySummariesTriggered: number;
  weeklySummariesSent: number;
  scoreEvolutionsTriggered: number;
  scoreEvolutionsSent: number;
  monthlyVisualReportsTriggered: number;
  monthlyVisualReportsSent: number;
  limitAlertsTriggered: number;
  limitAlertsSent: number;
  renewalRemindersTriggered: number;
  renewalRemindersSent: number;
  goalAlertsTriggered: number;
  goalAlertsSent: number;
  familyRiskAlertsTriggered: number;
  familyRiskAlertsSent: number;
  familyMeetingsSent: number;
  bomDiasSent: number;
  boaNoitesSent: number;
  weeklyChallengeSent: number;
  tipsWeeklySent: number;
  failures: Array<{ customerId: string; whatsappNumber: string; reason: string }>;
};

type AlertTone = 'low' | 'medium' | 'high' | 'max';
type LimitAlertKind = 'headsup' | 'near' | 'exceeded';

type ProactiveProfile = {
  tone: AlertTone;
  includeNear: boolean;
  includeHeadsUp: boolean;
  headsUpRemainingRatio: number;
  headsUpRemainingCents: number;
  sendDailyInactivity: boolean;
  sendFollowUpCheckIn: boolean;
  sendDailyRisk: boolean;
  sendDailyProgress: boolean;
  sendWeeklySummary: boolean;
  sendWeeklyScoreEvolution: boolean;
  sendMonthlyVisualReport: boolean;
};

function centsToBrl(cents: number): string {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(cents / 100);
}

function dateToIsoInTimezone(referenceDate: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(referenceDate);
  const year = parts.find((item) => item.type === 'year')?.value ?? '1970';
  const month = parts.find((item) => item.type === 'month')?.value ?? '01';
  const day = parts.find((item) => item.type === 'day')?.value ?? '01';
  return `${year}-${month}-${day}`;
}

function isMondayInTimezone(referenceDate: Date, timezone: string): boolean {
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short'
  }).format(referenceDate);
  return weekday.toLowerCase() === 'mon';
}

function isWednesdayInTimezone(referenceDate: Date, timezone: string): boolean {
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short'
  }).format(referenceDate);
  return weekday.toLowerCase() === 'wed';
}

function timePartsInTimezone(referenceDate: Date, timezone: string): { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(referenceDate);
  const hour = Number(parts.find((item) => item.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((item) => item.type === 'minute')?.value ?? '0');
  return {
    hour: Number.isNaN(hour) ? 0 : hour,
    minute: Number.isNaN(minute) ? 0 : minute
  };
}

function ownerDailyReportMessage(params: {
  ownerName: string;
  timezone: string;
  referenceDate: Date;
  summary: ProactiveRunResult;
  activeCustomers: number;
  online1h: number;
  online24h: number;
  newCustomersToday: number;
  inactive7d: number;
  pendingSetup: number;
  pastDue: number;
  trialCustomers: number;
  mrrCents: number;
  planBreakdown: string;
}): string {
  const localNow = new Intl.DateTimeFormat('pt-BR', {
    timeZone: params.timezone,
    dateStyle: 'short',
    timeStyle: 'short'
  }).format(params.referenceDate);
  const greeting = greetingByTimeInTimezone(params.referenceDate, params.timezone);

  const engagementPct = params.activeCustomers > 0
    ? Math.round((params.online24h / params.activeCustomers) * 100)
    : 0;

  const totalAlertsSent =
    params.summary.inactivityAlertsSent + params.summary.followUpCheckinsSent +
    params.summary.riskAlertsSent + params.summary.progressAlertsSent +
    params.summary.reminderAlertsSent + params.summary.weeklySummariesSent +
    params.summary.monthlyVisualReportsSent + params.summary.renewalRemindersSent +
    params.summary.goalAlertsSent + params.summary.bomDiasSent + params.summary.boaNoitesSent;

  const realFailures = params.summary.failures.filter(f => f.reason !== 'customer_outside_window_no_template');
  const windowSkipped = params.summary.failures.length - realFailures.length;
  const failureLine = realFailures.length > 0
    ? `⚠️ Falhas reais: ${realFailures.length} | Fora da janela: ${windowSkipped}`
    : windowSkipped > 0
      ? `✅ Sem falhas. Fora da janela: ${windowSkipped}`
      : '✅ Tudo OK, sem falhas.';

  const attnItems: string[] = [];
  if (params.pastDue > 0) attnItems.push(`${params.pastDue} inadimplente(s)`);
  if (params.pendingSetup > 0) attnItems.push(`${params.pendingSetup} aguardando ativação`);
  if (params.trialCustomers > 0) attnItems.push(`${params.trialCustomers} em trial`);
  if (params.newCustomersToday > 0) attnItems.push(`🆕 ${params.newCustomersToday} novo(s) hoje`);

  const lines = [
    `${greeting}, ${params.ownerName} 👑 | ${localNow}`,
    ``,
    `💰 MRR: ${centsToBrl(params.mrrCents)} | ${params.activeCustomers} clientes ativos`,
  ];
  if (params.planBreakdown) lines.push(`📊 ${params.planBreakdown}`);
  lines.push(`👥 Online 24h: ${params.online24h} (${engagementPct}%) | Inativos 7d: ${params.inactive7d}`);
  if (attnItems.length > 0) lines.push(`⚠️ ${attnItems.join(' · ')}`);
  lines.push(
    ``,
    `🤖 Automações: ${totalAlertsSent} enviadas | bom dia ${params.summary.bomDiasSent} · ausência ${params.summary.inactivityAlertsSent} · risco ${params.summary.riskAlertsSent} · lembrete ${params.summary.reminderAlertsSent} · renovação ${params.summary.renewalRemindersSent}`,
    failureLine
  );
  return lines.join('\n');
}

function greetingByTimeInTimezone(referenceDate: Date, timezone: string): 'Bom dia' | 'Boa tarde' | 'Boa noite' {
  const { hour } = timePartsInTimezone(referenceDate, timezone);
  if (hour < 12) return 'Bom dia';
  if (hour < 18) return 'Boa tarde';
  return 'Boa noite';
}

function isReminderDueAlertWindow(params: {
  nowMinutes: number;
  dueTime: string;
  remindMinutesBefore: number;
  dueReminderCatchUpMinutes: number;
}): boolean {
  const [dueHourRaw, dueMinuteRaw] = params.dueTime.split(':');
  const dueHour = Number(dueHourRaw);
  const dueMinute = Number(dueMinuteRaw);
  if (Number.isNaN(dueHour) || Number.isNaN(dueMinute)) return false;

  const dueMinutes = (dueHour * 60) + dueMinute;
  const triggerAtMinutes = Math.max(0, dueMinutes - Math.max(0, params.remindMinutesBefore));
  const latestAllowedMinutes = Math.min((24 * 60) - 1, dueMinutes + Math.max(1, params.dueReminderCatchUpMinutes));
  return params.nowMinutes >= triggerAtMinutes && params.nowMinutes <= latestAllowedMinutes;
}

function friendlyName(name: string | null): string {
  if (!name) return 'você';
  const first = name.trim().split(/\s+/)[0];
  return first || 'você';
}

function proactiveProfileForPlan(planCode: string | null | undefined): ProactiveProfile {
  const plan = getPlanDefinition(planCode);

  if (plan.code === 'free') {
    return {
      tone: 'low',
      includeNear: false,
      includeHeadsUp: false,
      headsUpRemainingRatio: 0,
      headsUpRemainingCents: 0,
      sendDailyInactivity: false,
      sendFollowUpCheckIn: false,
      sendDailyRisk: false,
      sendDailyProgress: false,
      sendWeeklySummary: false,
      sendWeeklyScoreEvolution: false,
      sendMonthlyVisualReport: false
    };
  }

  if (plan.code === 'essential') {
    return {
      tone: 'medium',
      includeNear: true,
      includeHeadsUp: false,
      headsUpRemainingRatio: 0,
      headsUpRemainingCents: 0,
      sendDailyInactivity: true,
      sendFollowUpCheckIn: true,
      sendDailyRisk: true,
      sendDailyProgress: true,
      sendWeeklySummary: true,
      sendWeeklyScoreEvolution: false,
      sendMonthlyVisualReport: false
    };
  }

  if (plan.code === 'premium') {
    return {
      tone: 'medium',
      includeNear: true,
      includeHeadsUp: true,
      headsUpRemainingRatio: 0.2,
      headsUpRemainingCents: 20000,
      sendDailyInactivity: true,
      sendFollowUpCheckIn: true,
      sendDailyRisk: true,
      sendDailyProgress: true,
      sendWeeklySummary: true,
      sendWeeklyScoreEvolution: true,
      sendMonthlyVisualReport: true
    };
  }

  if (plan.code === 'family') {
    return {
      tone: 'high',
      includeNear: true,
      includeHeadsUp: true,
      headsUpRemainingRatio: 0.28,
      headsUpRemainingCents: 30000,
      sendDailyInactivity: true,
      sendFollowUpCheckIn: true,
      sendDailyRisk: true,
      sendDailyProgress: true,
      sendWeeklySummary: true,
      sendWeeklyScoreEvolution: true,
      sendMonthlyVisualReport: true
    };
  }

  return {
    tone: 'max',
    includeNear: true,
    includeHeadsUp: true,
    headsUpRemainingRatio: 0.4,
    headsUpRemainingCents: 50000,
    sendDailyInactivity: true,
    sendFollowUpCheckIn: true,
    sendDailyRisk: true,
    sendDailyProgress: true,
    sendWeeklySummary: true,
    sendWeeklyScoreEvolution: true,
    sendMonthlyVisualReport: true
  };
}

function pickLimitAlertKind(
  status: {
    status: 'ok' | 'near' | 'exceeded';
    remainingCents: number;
    limitCents: number;
  },
  profile: ProactiveProfile
): LimitAlertKind | null {
  if (status.status === 'exceeded') return 'exceeded';
  if (status.status === 'near') return profile.includeNear ? 'near' : null;
  if (!profile.includeHeadsUp || status.limitCents <= 0) return null;

  const remainingRatio = status.remainingCents / status.limitCents;
  if (remainingRatio <= profile.headsUpRemainingRatio) return 'headsup';
  // Absolute threshold only fires when the limit is large enough that
  // "few dollars left" is meaningful — avoids false alerts on small limits
  if (
    status.limitCents > profile.headsUpRemainingCents * 2 &&
    status.remainingCents <= profile.headsUpRemainingCents
  ) {
    return 'headsup';
  }
  return null;
}

function reminderMessage(params: {
  name: string;
  title: string;
  amountCents: number | null;
  dueDate: string;
  dueTime: string | null;
  daysUntilDue: number;
  remindDaysBefore: number;
  remindMinutesBefore: number | null;
}): string {
  const due = new Date(`${params.dueDate}T12:00:00.000Z`).toLocaleDateString('pt-BR');
  const dueLabel = params.dueTime ? `${due} às ${params.dueTime}` : due;
  const amountLine = params.amountCents ? ` Valor previsto: ${centsToBrl(params.amountCents)}.` : '';
  const leadLabel = params.remindMinutesBefore !== null
    ? `${params.remindMinutesBefore} minuto(s) antes`
    : `${params.remindDaysBefore} dia(s) antes`;

  if (params.daysUntilDue <= 0) {
    return `Oi, ${params.name}! 🔔 Passando pra lembrar: "${params.title}" vence hoje (${dueLabel}). Aviso configurado: ${leadLabel}.${amountLine}`;
  }

  return `Oi, ${params.name}! 🔔 Lembrete: "${params.title}" vence em ${params.daysUntilDue} dia(s), no dia ${dueLabel}. Aviso configurado: ${leadLabel}.${amountLine}`;
}

function bomDiaMessage(name: string): string {
  const options = [
    `Bom dia, ${name}! ☀️ Pronta para te ajudar a manter as finanças no controle hoje.`,
    `Bom dia, ${name}! 🌅 Novo dia, nova chance de registrar tudo certinho. Me conta o que rolar!`,
    `Bom dia, ${name}! ☀️ Aqui é a Iara — se tiver algum gasto hoje, já me manda que eu organizo tudo pra você.`,
    `Bom dia, ${name}! 🌄 Começando o dia com foco nas finanças. Me avisa o que precisar hoje!`,
    `Bom dia! ☀️ ${name}, o dia começou — se tiver gastos rolando, é só me contar.`,
    `Oi, ${name}! Bom dia ☀️ Que tal começarmos o dia com tudo registrado?`
  ];
  return options[Math.floor(Math.random() * options.length)];
}

function boaNoiteMessage(name: string): string {
  const options = [
    `Boa noite, ${name}! 🌙 Passando para lembrar: se tiver algum gasto do dia ainda não registrado, é agora a hora certa.`,
    `Boa noite! 🌙 ${name}, como foi o dia financeiramente? Me manda qualquer gasto pendente antes de dormir.`,
    `Boa noite, ${name}! 🌛 Encerrando o dia com controle: tem algum gasto ou entrada que ficou pra trás hoje?`,
    `Boa noite! 🌙 ${name}, fechando o dia — me conta os gastos que ainda não registrou e deixa tudo em dia.`,
    `Boa noite, ${name}! 🌟 Antes de descansar, que tal fecharmos o dia financeiro? Me manda o que ficou.`
  ];
  return options[Math.floor(Math.random() * options.length)];
}

function inactivityMessage(params: {
  name: string;
  tone: AlertTone;
}): string {
  if (params.tone === 'max') {
    return `Oi, ${params.name}! 👀 Você ainda não registrou nada hoje. Quando fica sem registro, o risco de perder controle sobe. Me manda em 1 linha o que já gastou e eu te devolvo análise + próximo ajuste.`;
  }
  if (params.tone === 'high') {
    return `Oi, ${params.name}! 👀 Você ainda não registrou gastos hoje. Quer me mandar o que já saiu para manter o controle?`;
  }
  return `Oi, ${params.name}! 🔎 Passando para manter seu controle ativo: me conta os gastos de hoje em 1 mensagem.`;
}

function weeklyChallengeMessage(params: {
  name: string;
  topCategory: string;
  lastWeekCents: number;
  targetCents: number;
  reductionCents: number;
}): string {
  const { name, topCategory, lastWeekCents, targetCents, reductionCents } = params;
  return [
    `🏆 Desafio da semana, ${name}!`,
    ``,
    `Semana passada você gastou ${centsToBrl(lastWeekCents)} em *${topCategory}*.`,
    `Desafio: tente manter abaixo de ${centsToBrl(targetCents)} nessa categoria essa semana.`,
    `Economia potencial: ${centsToBrl(reductionCents)} 💰`,
    ``,
    `Me manda seus gastos normalmente — na sexta eu te digo se conseguiu. 💪`
  ].join('\n');
}

function weeklyChallengeConclusionMessage(params: {
  name: string;
  topCategory: string;
  targetCents: number;
  actualCents: number;
  success: boolean;
}): string {
  const { name, topCategory, targetCents, actualCents, success } = params;
  if (success) {
    const savedCents = targetCents - actualCents;
    return [
      `🎉 Missão cumprida, ${name}!`,
      ``,
      `Você gastou ${centsToBrl(actualCents)} em *${topCategory}* — abaixo da meta de ${centsToBrl(targetCents)}.`,
      `Economizou ${centsToBrl(savedCents)} comparado ao objetivo. 🏅`,
      ``,
      `Novo desafio começa agora. Bora manter o ritmo?`
    ].join('\n');
  }
  const overCents = actualCents - targetCents;
  return [
    `Semana encerrada, ${name}.`,
    ``,
    `Em *${topCategory}* você gastou ${centsToBrl(actualCents)} — ${centsToBrl(overCents)} acima da meta de ${centsToBrl(targetCents)}.`,
    `Não tem problema! Novo desafio começa hoje. Quer tentar de novo essa semana? 💪`
  ].join('\n');
}

function followUpSilenceMinutesForTone(tone: AlertTone): number {
  if (tone === 'max') return 45;
  if (tone === 'high') return 75;
  if (tone === 'medium') return 120;
  return 180;
}

function followUpCheckInMessage(params: {
  name: string;
  tone: AlertTone;
  minutesSinceOutbound: number;
}): string {
  const silenceHours = Math.max(1, Math.round(params.minutesSinceOutbound / 60));

  if (params.tone === 'max') {
    return [
      `Oi, ${params.name}! Tudo bem por aí? 👀`,
      `Faz cerca de ${silenceHours}h que você ficou offline depois da nossa última conversa.`,
      'Se quiser, me manda em 1 linha como ficou seu dia financeiro e eu já te devolvo um ajuste prático.'
    ].join('\n');
  }

  if (params.tone === 'high') {
    return [
      `Oi, ${params.name}! Tá tudo bem aí? 🙂`,
      `Passando pra não te deixar perder o controle do dia.`,
      'Quer que eu te ajude com um check rápido dos gastos de hoje?'
    ].join('\n');
  }

  return [
    `Oi, ${params.name}! Tudo certo por aí?`,
    'Se quiser, fazemos um check rápido agora: você me manda os gastos de hoje e eu organizo tudo.'
  ].join('\n');
}

function limitAlertMessage(params: {
  name: string;
  period: 'daily' | 'weekly' | 'monthly';
  kind: LimitAlertKind;
  remainingCents: number;
  limitCents: number;
  spentCents: number;
  tone: AlertTone;
}): string {
  const periodLabel = params.period === 'daily'
    ? 'diário'
    : params.period === 'weekly'
      ? 'semanal'
      : 'mensal';
  const usagePct = params.limitCents > 0
    ? Math.min(Math.round((params.spentCents / params.limitCents) * 100), 999)
    : 0;

  if (params.kind === 'headsup') {
    if (params.tone === 'max') {
      return `Oi, ${params.name}! 🚨 Pré-alerta ${periodLabel}: você já consumiu ${usagePct}% do limite. Ainda faltam ${centsToBrl(params.remainingCents)}, mas nesse ritmo você encosta no teto rápido.`;
    }
    if (params.tone === 'high') {
      return `Oi, ${params.name}! ⚠️ Pré-alerta ${periodLabel}: você já usou ${usagePct}% do limite. Restam ${centsToBrl(params.remainingCents)}.`;
    }
    return `Oi, ${params.name}! 👀 Pré-alerta ${periodLabel}: faltam ${centsToBrl(params.remainingCents)} para o limite de ${centsToBrl(params.limitCents)}.`;
  }

  if (params.kind === 'near') {
    if (params.tone === 'max') {
      return `Oi, ${params.name}! 🚨 Quase no limite ${periodLabel}: faltam só ${centsToBrl(params.remainingCents)} para bater ${centsToBrl(params.limitCents)}. Quer que eu te passe um plano de ajuste imediato?`;
    }
    return `Oi, ${params.name}! ⚠️ Você está perto do seu limite ${periodLabel}. Faltam ${centsToBrl(params.remainingCents)} para chegar em ${centsToBrl(params.limitCents)}.`;
  }

  const exceededBy = Math.abs(params.remainingCents);
  if (params.tone === 'max') {
    return `Oi, ${params.name}! 🚨 Limite ${periodLabel} estourado em ${centsToBrl(exceededBy)} (teto: ${centsToBrl(params.limitCents)}). Se quiser, eu já monto agora um ajuste para você não fechar no vermelho.`;
  }
  return `Oi, ${params.name}! ⚠️ Seu limite ${periodLabel} foi ultrapassado em ${centsToBrl(exceededBy)} (limite: ${centsToBrl(params.limitCents)}).`;
}

function riskForecastMessage(params: {
  name: string;
  deficitCents: number;
  daysLeft: number;
  cutPerDayCents: number;
  tone: AlertTone;
}): string {
  if (params.tone === 'max') {
    return [
      `Oi, ${params.name}! 🚨 Risco detectado: no ritmo atual pode faltar ${centsToBrl(params.deficitCents)} até o fim do mês.`,
      params.daysLeft > 0
        ? `Se ajustar cerca de ${centsToBrl(params.cutPerDayCents)}/dia pelos próximos ${params.daysLeft} dia(s), você tem boa chance de neutralizar esse risco.`
        : 'O mês já está no limite, então o ajuste precisa começar agora.'
    ].join('\n');
  }
  if (params.tone === 'high' || params.tone === 'medium') {
    return [
      `Oi, ${params.name}! ⚠️ Tendência de falta de caixa neste mês: ${centsToBrl(params.deficitCents)}.`,
      params.daysLeft > 0
        ? `Ajuste recomendado: reduzir ~${centsToBrl(params.cutPerDayCents)}/dia até o fechamento.`
        : 'Ajuste recomendado: pausar gastos variáveis hoje e replanejar o restante do mês.'
    ].join('\n');
  }
  return `Oi, ${params.name}! 👀 No ritmo atual, o mês pode fechar negativo em ${centsToBrl(params.deficitCents)}.`;
}

function progressMessage(params: {
  name: string;
  streakDays: number;
  activeDaysLast30: number;
  monthOverMonthPct: number | null;
  tone: AlertTone;
}): string {
  const streakLine = params.streakDays > 0
    ? `🔥 Você está com ${params.streakDays} dia(s) seguidos de registro.`
    : `📌 Você teve atividade em ${params.activeDaysLast30} dia(s) nos últimos 30.`;

  const trendLine = params.monthOverMonthPct === null
    ? 'Ainda sem base comparativa do mês passado.'
    : params.monthOverMonthPct <= -8
      ? `📉 Seus gastos estão ${Math.abs(params.monthOverMonthPct).toFixed(1)}% abaixo do mês passado.`
      : params.monthOverMonthPct >= 12
        ? `📈 Seus gastos subiram ${params.monthOverMonthPct.toFixed(1)}% vs mês passado.`
        : '📊 Seu ritmo está estável em relação ao mês passado.';

  if (params.tone === 'max') {
    return [
      `Oi, ${params.name}! ✅ Sinal de progresso detectado.`,
      streakLine,
      trendLine,
      'Quer que eu te entregue agora o ajuste de maior impacto para continuar evoluindo amanhã?'
    ].join('\n');
  }

  return [
    `Oi, ${params.name}! ✅ Progresso do dia:`,
    streakLine,
    trendLine
  ].join('\n');
}

function weeklySummaryMessage(params: {
  name: string;
  startDate: string;
  endDate: string;
  incomeCents: number;
  expenseCents: number;
  netCents: number;
  byCategory: Array<{ category: string; amountCents: number }>;
  prevWeekExpenseCents?: number;
}): string {
  const startLabel = new Date(`${params.startDate}T12:00:00.000Z`).toLocaleDateString('pt-BR');
  const endLabel = new Date(`${params.endDate}T12:00:00.000Z`).toLocaleDateString('pt-BR');
  const catLines = params.byCategory
    .slice(0, 3)
    .map((item, index) => `${index + 1}) ${item.category}: ${centsToBrl(item.amountCents)}`);

  let trendLine = '';
  if (params.prevWeekExpenseCents !== undefined && params.prevWeekExpenseCents > 0) {
    const pct = Math.round(((params.expenseCents - params.prevWeekExpenseCents) / params.prevWeekExpenseCents) * 100);
    if (pct < -5) trendLine = `📉 Despesas ${Math.abs(pct)}% abaixo da semana passada. Ótimo ritmo!`;
    else if (pct > 10) trendLine = `📈 Despesas ${pct}% acima da semana passada. Vale revisar.`;
    else trendLine = `📊 Despesas estáveis vs semana passada.`;
  }

  const topCat = params.byCategory[0];
  const closingLine = topCat
    ? `💡 Maior gasto: *${topCat.category}*. Quer que eu defina um limite para essa categoria?`
    : 'Se quiser, eu te sugiro um limite para esta semana.';

  return [
    `Oi, ${params.name}! 📊 Semana de ${startLabel} a ${endLabel}:`,
    `• Receitas: ${centsToBrl(params.incomeCents)}`,
    `• Despesas: ${centsToBrl(params.expenseCents)}`,
    `• Saldo: ${centsToBrl(params.netCents)}`,
    ...(trendLine ? [trendLine] : []),
    ...(catLines.length ? [`• Top gastos:\n${catLines.join('\n')}`] : []),
    closingLine
  ].join('\n');
}

function weeklyScoreEvolutionMessage(params: {
  name: string;
  points: Array<{ score: number; weekStartDate: string; weekEndDate: string }>;
  latestDelta: number;
}): string {
  const trend = params.latestDelta > 0
    ? `subiu +${params.latestDelta}`
    : params.latestDelta < 0
      ? `caiu ${params.latestDelta}`
      : 'ficou estável';
  const spark = params.points
    .map((point) => {
      const level = Math.max(1, Math.min(8, Math.round((point.score / 1000) * 8)));
      return '▁▂▃▄▅▆▇█'[level - 1] ?? '▁';
    })
    .join('');
  const latest = params.points[params.points.length - 1]?.score ?? 0;
  return [
    `Oi, ${params.name}! 🧠 Evolução do seu score financeiro (6 semanas): ${spark}`,
    `Score atual: ${latest}/1000 (${trend} vs semana passada).`,
    'Quer que eu te diga o melhor ajuste para subir esse score nesta semana?'
  ].join('\n');
}

function monthlyVisualReportMessage(params: {
  name: string;
  month: number;
  year: number;
  totalIncomeCents: number;
  totalExpenseCents: number;
  netCents: number;
  topCategory: { category: string; sharePct: number } | null;
  biggestExpense: { category: string; amountCents: number } | null;
  monthOverMonthExpensePct: number | null;
}): string {
  const monthLabel = new Date(params.year, params.month - 1, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });

  const trendEmoji = params.monthOverMonthExpensePct === null ? ''
    : params.monthOverMonthExpensePct > 5 ? ' 📈'
    : params.monthOverMonthExpensePct < -5 ? ' 📉' : ' ➡️';
  const trendText = params.monthOverMonthExpensePct === null ? ''
    : params.monthOverMonthExpensePct > 0
      ? `+${params.monthOverMonthExpensePct.toFixed(1)}% vs mês anterior${trendEmoji}`
      : params.monthOverMonthExpensePct < 0
        ? `${params.monthOverMonthExpensePct.toFixed(1)}% vs mês anterior${trendEmoji}`
        : `Estável vs mês anterior${trendEmoji}`;

  const netLabel = params.netCents >= 0
    ? `${centsToBrl(params.netCents)} ✅`
    : `${centsToBrl(params.netCents)} ⚠️`;

  // Savings opportunity when top category dominates
  let savingsLine = '';
  if (params.topCategory && params.topCategory.sharePct > 30) {
    const savingsPerMonth = Math.round(params.totalExpenseCents * (params.topCategory.sharePct / 100) * 0.15);
    const savingsPerYear = savingsPerMonth * 12;
    savingsLine = `\n💡 Cortando 15% em *${params.topCategory.category}*, você economizaria ${centsToBrl(savingsPerMonth)}/mês (${centsToBrl(savingsPerYear)}/ano).`;
  }

  const lines = [
    `Oi, ${params.name}! 🎴 Fechamento de ${monthLabel}:`,
    ``,
    `💰 Receitas: ${centsToBrl(params.totalIncomeCents)}`,
    `💸 Despesas: ${centsToBrl(params.totalExpenseCents)}`,
    `💹 Saldo: ${netLabel}`,
  ];
  if (trendText) lines.push(`📊 ${trendText}`);
  lines.push(``);
  if (params.topCategory) lines.push(`📌 Maior categoria: ${params.topCategory.category} (${params.topCategory.sharePct.toFixed(0)}%)`);
  if (params.biggestExpense) lines.push(`📌 Maior gasto único: ${params.biggestExpense.category} (${centsToBrl(params.biggestExpense.amountCents)})`);
  if (savingsLine) lines.push(savingsLine);
  return lines.join('\n');
}

function dailyFinancialTipMessage(params: {
  name: string;
  topCategory: string | null;
}): string {
  const cat = params.topCategory?.toLowerCase() ?? '';
  let tip: string;

  if (cat.includes('aliment') || cat.includes('restaur') || cat.includes('mercado') || cat.includes('lanche')) {
    tip = 'Cozinhar em casa 2x a mais por semana pode reduzir o gasto com alimentação em até 30-40%. Pequeno esforço, economia real.';
  } else if (cat.includes('transport') || cat.includes('uber') || cat.includes('gasolina') || cat.includes('carro')) {
    tip = 'Calcule o custo total do carro (combustível, seguro, manutenção, parcela) vs o quanto usaria aplicativos. Muitas vezes o carro custa 2x mais do que parece.';
  } else if (cat.includes('lazer') || cat.includes('entretenimento') || cat.includes('stream') || cat.includes('netflix')) {
    tip = 'Assinaturas de streaming se acumulam sem perceber. Revise quais você realmente usa — cancelar 2 pode poupar R$ 60/mês, R$ 720/ano.';
  } else if (cat.includes('saúde') || cat.includes('farmácia') || cat.includes('academia') || cat.includes('médico')) {
    tip = 'Gastos com saúde (médico, plano, remédios) são dedutíveis no IR. Guarda todos os comprovantes durante o ano — vale no ajuste.';
  } else if (cat.includes('roupa') || cat.includes('vestuário') || cat.includes('moda') || cat.includes('calçado')) {
    tip = 'Regra dos 30 usos: antes de comprar, pergunte "vou usar isso 30 vezes?". Se não tiver certeza, espera 72h. Muitas compras por impulso não chegam a 10 usos.';
  } else if (cat) {
    tip = `Sua maior categoria é *${params.topCategory}*. Definir um limite mensal para ela é o jeito mais simples de controlar sem abrir mão do que você gosta.`;
  } else {
    tip = 'Revisar seus gastos fixos mensais 1x por ano pode revelar assinaturas e serviços que você já não usa. Internet, seguros e planos geralmente têm opções mais baratas disponíveis.';
  }

  return `💡 *Dica Iara da semana, ${params.name}:*\n\n${tip}`;
}

function diffDaysIso(fromIso: string, toIso: string): number {
  const msPerDay = 1000 * 60 * 60 * 24;
  const from = new Date(`${fromIso}T12:00:00.000Z`);
  const to = new Date(`${toIso}T12:00:00.000Z`);
  return Math.round((to.getTime() - from.getTime()) / msPerDay);
}

function renewalReminderMessage(params: {
  name: string;
  planCode: string;
  planName: string;
  daysLeft: number;
  dueDate: string;
  monthlyFeeCents: number;
}): string {
  const dueDateLabel = new Date(`${params.dueDate}T12:00:00.000Z`).toLocaleDateString('pt-BR');
  const priceLabel = centsToBrl(params.monthlyFeeCents);
  const { name, planCode, planName, daysLeft } = params;

  if (daysLeft === 3) {
    if (planCode === 'essential') {
      return [
        `Oi, ${name}! 🗓️ Lembrete rápido: seu plano Essencial renova em 3 dias, no dia ${dueDateLabel} — ${priceLabel}.`,
        `Tudo que você controla aqui continua rodando sem interrupção com a renovação.`,
        `Qualquer dúvida sobre a cobrança, é só me chamar. 💚`
      ].join('\n');
    }
    if (planCode === 'premium') {
      return [
        `Oi, ${name}! 🗓️ Passando para avisar: seu plano Premium renova em 3 dias, no dia ${dueDateLabel} — ${priceLabel}.`,
        `Com a renovação você mantém acesso completo: metas, insights, previsão de saldo e alertas automáticos. Vale cada centavo.`,
        `Precisando de algo antes do fechamento do mês, me fala. ✨`
      ].join('\n');
    }
    if (planCode === 'family') {
      return [
        `Oi, ${name}! 🗓️ Aviso para a família: o plano Família renova em 3 dias, no dia ${dueDateLabel} — ${priceLabel}.`,
        `Toda a família continua organizada financeiramente com a renovação. Vale cada centavo quando o controle é coletivo.`,
        `Dúvidas sobre a cobrança ou sobre os membros, é só me avisar. 👨‍👩‍👧`
      ].join('\n');
    }
    if (planCode === 'elite') {
      return [
        `Oi, ${name}. 🗓️ Aviso executivo: seu plano Elite renova em 3 dias, no dia ${dueDateLabel} — ${priceLabel}.`,
        `Com a renovação, acesso completo permanece: 5.000 mensagens, até 15 membros, Open Banking — tudo contigo.`,
        `Me avisa se quiser antecipar alguma análise antes do fechamento. 🏆`
      ].join('\n');
    }
    return [
      `Oi, ${name}! 🗓️ Lembrete: seu plano ${planName} renova em 3 dias, no dia ${dueDateLabel} — ${priceLabel}.`,
      `Qualquer dúvida sobre a cobrança, é só me chamar. 💚`
    ].join('\n');
  }

  // Dia do vencimento
  if (planCode === 'essential') {
    return [
      `Oi, ${name}! Hoje é o dia de renovação do seu plano Essencial — ${priceLabel}.`,
      `O Pix foi gerado automaticamente. Assim que confirmar, sigo aqui cuidando do seu controle financeiro.`,
      `Se tiver qualquer problema com o pagamento, me fala que eu te ajudo. 💚`
    ].join('\n');
  }
  if (planCode === 'premium') {
    return [
      `Oi, ${name}! Hoje renova seu plano Premium — ${priceLabel}. O Pix está disponível para pagamento.`,
      `Com a renovação você mantém acesso completo: metas, insights, alertas e tudo mais.`,
      `Me avisa se precisar de qualquer coisa. ✨`
    ].join('\n');
  }
  if (planCode === 'family') {
    return [
      `Oi, ${name}! Hoje é o dia de renovação do plano Família — ${priceLabel}. O Pix já foi gerado.`,
      `A família inteira continua organizada com a renovação. Qualquer questão sobre o pagamento, me conta. 👨‍👩‍👧`
    ].join('\n');
  }
  if (planCode === 'elite') {
    return [
      `Oi, ${name}. Hoje renova seu plano Elite — ${priceLabel}. Pix disponível para confirmação.`,
      `Renovando, mantemos o nível de análise e acesso completo. Se houver qualquer detalhe com o pagamento, me chama imediatamente. 🏆`
    ].join('\n');
  }
  return [
    `Oi, ${name}! Hoje é o dia de renovação do seu plano ${planName} — ${priceLabel}.`,
    `O Pix foi gerado automaticamente. Qualquer dúvida, é só me falar. 💚`
  ].join('\n');
}

export async function runProactiveAlerts(params: ProactiveRunParams = {}): Promise<ProactiveRunResult> {
  const referenceDate = params.referenceDate ?? new Date();
  const timezone = params.timezone ?? config.defaultTimezone;
  const dryRun = Boolean(params.dryRun);
  const customerLimit = params.customerLimit ?? 1000;
  const todayIso = dateToIsoInTimezone(referenceDate, timezone);
  const runWeekly = isMondayInTimezone(referenceDate, timezone);
  const runWednesday = isWednesdayInTimezone(referenceDate, timezone);
  const isFirstDayOfMonth = Number(todayIso.slice(-2)) === 1;
  const nowTime = timePartsInTimezone(referenceDate, timezone);
  const isBomDiaWindow = nowTime.hour === 6; // janela: 6h–6h59 (scheduler roda a cada 5min)
  const isBoaNoiteWindow = nowTime.hour === 21; // janela: 21h–21h59
  // Horário silencioso: não disparar alertas proativos entre 22h e 6h59
  const isQuietHours = nowTime.hour >= 22 || nowTime.hour < 7;
  const ownerReportWindowOpen =
    config.ownerDailyReportEnabled &&
    (nowTime.hour > config.ownerDailyReportHour ||
      (nowTime.hour === config.ownerDailyReportHour && nowTime.minute >= config.ownerDailyReportMinute));

  const result: ProactiveRunResult = {
    runAt: referenceDate.toISOString(),
    timezone,
    dryRun,
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

  const customers = await listActiveCustomerContacts(customerLimit);
  result.customersScanned = customers.length;

  // Pré-carrega todos os dados de "já enviado" em 4 queries ao invés de N*20 queries
  const customerIds = customers.map((c) => c.id);
  const [sentToday, inboundToday, sentThisWeek, sentThisMonth] = await Promise.all([
    batchAutoMessagesSentToday({ customerIds, referenceDate, timezone }),
    batchInboundMessagesSentToday({ customerIds, referenceDate, timezone }),
    batchAutoMessagesSentThisWeek({ customerIds, referenceDate, timezone }),
    batchAutoMessagesSentThisMonth({ customerIds, referenceDate, timezone }),
  ]);

  // Helpers síncronos que substituem as queries individuais
  const wasSentToday = (customerId: string, source: string): boolean =>
    sentToday.has(`${customerId}:${source}`);
  const hadInboundToday = (customerId: string): boolean =>
    inboundToday.has(customerId);
  const wasSentThisWeek = (customerId: string, source: string): boolean =>
    sentThisWeek.has(`${customerId}:${source}`);
  const wasSentThisMonth = (customerId: string, source: string): boolean =>
    sentThisMonth.has(`${customerId}:${source}`);

  for (const customer of customers) {
    const name = friendlyName(customer.name);

    try {
      const access = await evaluateCustomerAccess(customer.id, referenceDate);
      if (!access.allowed) {
        result.skippedAccess += 1;
        continue;
      }
      const proactiveProfile = proactiveProfileForPlan(access.planCode);
      result.customersEligible += 1;

      // Limite de alertas proativos por cliente por ciclo — evita flood de mensagens
      const MAX_ALERTS_PER_CYCLE = 2;
      let alertsSentThisCycle = 0;

      // ── Bom dia às 6h (enviado para todos, independente de atividade) ───
      if (isBomDiaWindow && proactiveProfile.sendDailyInactivity) {
        const bomDiaSource = 'auto-bom-dia';
        const bomDiaJaSent = wasSentToday(customer.id, bomDiaSource);
        if (!bomDiaJaSent) {
          const text = bomDiaMessage(name);
          let sentOk = false;
          if (!dryRun) {
            const sent = await sendWhatsAppText({ to: customer.whatsappNumber, message: text });
            if (sent.sent) { sentOk = true; result.bomDiasSent += 1; }
            else result.failures.push({ customerId: customer.id, whatsappNumber: customer.whatsappNumber, reason: sent.error ?? 'Falha ao enviar bom dia' });
          }
          await logConversation(customer.id, 'outbound', text, {
            source: bomDiaSource,
            dryRun,
            sent: sentOk,
            referenceDate: todayIso
          });
        }
      }

      // ── Boa noite às 21h ─────────────────────────────────────────────────
      if (isBoaNoiteWindow && proactiveProfile.sendDailyInactivity) {
        const boaNoiteSource = 'auto-boa-noite';
        const boaNoiteJaSent = wasSentToday(customer.id, boaNoiteSource);
        if (!boaNoiteJaSent) {
          const text = boaNoiteMessage(name);
          let sentOk = false;
          if (!dryRun) {
            const sent = await sendWhatsAppText({ to: customer.whatsappNumber, message: text });
            if (sent.sent) { sentOk = true; result.boaNoitesSent += 1; }
            else result.failures.push({ customerId: customer.id, whatsappNumber: customer.whatsappNumber, reason: sent.error ?? 'Falha ao enviar boa noite' });
          }
          await logConversation(customer.id, 'outbound', text, {
            source: boaNoiteSource,
            dryRun,
            sent: sentOk,
            referenceDate: todayIso
          });
        }
      }

      // ── Horário silencioso + conversa ativa: bloqueia todos os alertas contextuais ──
      const recentlyActiveMs = customer.lastInboundAt
        ? Date.now() - customer.lastInboundAt.getTime()
        : Infinity;
      const isConversationActive = recentlyActiveMs < 30 * 60 * 1000; // 30 min
      if (isQuietHours || isConversationActive) continue;

      if (alertsSentThisCycle < MAX_ALERTS_PER_CYCLE && proactiveProfile.sendDailyInactivity) {
        const source = 'auto-inactivity-daily';
        const alreadySentToday = wasSentToday(customer.id, source);
        if (!alreadySentToday) {
          const hasInboundToday = hadInboundToday(customer.id);
          if (!hasInboundToday) {
            result.inactivityAlertsTriggered += 1;
            const text = inactivityMessage({
              name,
              tone: proactiveProfile.tone
            });

            let sentOk = false;
            if (!dryRun) {
              const sent = await sendWhatsAppText({ to: customer.whatsappNumber, message: text });
              if (sent.sent) {
                sentOk = true;
                result.inactivityAlertsSent += 1;
                alertsSentThisCycle += 1;
              } else {
                result.failures.push({
                  customerId: customer.id,
                  whatsappNumber: customer.whatsappNumber,
                  reason: sent.error ?? 'Falha ao enviar alerta de ausência de uso'
                });
              }
            }

            await logConversation(customer.id, 'outbound', text, {
              source,
              dryRun,
              sent: sentOk,
              referenceDate: todayIso
            });
          }
        }
      }

      if (alertsSentThisCycle < MAX_ALERTS_PER_CYCLE && proactiveProfile.sendFollowUpCheckIn) {
        const source = 'auto-followup-checkin';
        const alreadySentToday = wasSentToday(customer.id, source);

        if (!alreadySentToday) {
          const unansweredOutbound = await findLatestUnansweredOutbound({
            customerId: customer.id,
            referenceDate,
            minSilenceMinutes: followUpSilenceMinutesForTone(proactiveProfile.tone),
            maxLookbackHours: 36
          });

          if (unansweredOutbound) {
            const followupAlreadyAfterThatMessage = await hasAutoFollowupAfter({
              customerId: customer.id,
              outboundCreatedAt: unansweredOutbound.createdAt
            });

            if (!followupAlreadyAfterThatMessage) {
              result.followUpCheckinsTriggered += 1;
              const text = followUpCheckInMessage({
                name,
                tone: proactiveProfile.tone,
                minutesSinceOutbound: unansweredOutbound.minutesSinceOutbound
              });

              let sentOk = false;
              if (!dryRun) {
                const sent = await sendWhatsAppText({ to: customer.whatsappNumber, message: text });
                if (sent.sent) {
                  sentOk = true;
                  result.followUpCheckinsSent += 1;
                  alertsSentThisCycle += 1;
                } else {
                  result.failures.push({
                    customerId: customer.id,
                    whatsappNumber: customer.whatsappNumber,
                    reason: sent.error ?? 'Falha ao enviar follow-up de conversa'
                  });
                }
              }

              await logConversation(customer.id, 'outbound', text, {
                source,
                dryRun,
                sent: sentOk,
                basedOnOutboundId: unansweredOutbound.id,
                basedOnIntent: unansweredOutbound.intent,
                basedOnSource: unansweredOutbound.source,
                minutesSinceOutbound: unansweredOutbound.minutesSinceOutbound
              });
            }
          }
        }
      }

      if (alertsSentThisCycle < MAX_ALERTS_PER_CYCLE && proactiveProfile.sendDailyRisk) {
        const source = 'auto-risk-forecast';
        const alreadySentToday = wasSentToday(customer.id, source);
        if (!alreadySentToday) {
          const forecast = await forecastCashflowMonth(customer.id, referenceDate, timezone);
          if (forecast.projectedNetAfterBillsCents < 0) {
            result.riskAlertsTriggered += 1;
            const deficit = Math.abs(forecast.projectedNetAfterBillsCents);
            const daysLeft = Math.max(forecast.daysInMonth - forecast.dayOfMonth, 0);
            const cutPerDay = daysLeft > 0 ? Math.ceil(deficit / daysLeft) : deficit;
            const text = riskForecastMessage({
              name,
              deficitCents: deficit,
              daysLeft,
              cutPerDayCents: cutPerDay,
              tone: proactiveProfile.tone
            });

            let sentOk = false;
            if (!dryRun) {
              const sent = await sendWhatsAppText({ to: customer.whatsappNumber, message: text });
              if (sent.sent) {
                sentOk = true;
                result.riskAlertsSent += 1; alertsSentThisCycle += 1;
              } else {
                result.failures.push({
                  customerId: customer.id,
                  whatsappNumber: customer.whatsappNumber,
                  reason: sent.error ?? 'Falha ao enviar alerta de risco financeiro'
                });
              }
            }

            await logConversation(customer.id, 'outbound', text, {
              source,
              dryRun,
              sent: sentOk,
              deficitCents: deficit,
              daysLeft
            });
          }
        }
      }

      const reminders = await listBillReminders(customer.id, referenceDate, timezone);
      const nowMinutes = (nowTime.hour * 60) + nowTime.minute;
      const dueReminderGraceMinutes = Math.max(
        60,
        Math.max(1, config.proactiveAutomationIntervalMinutes || 15) * 3
      );
      const dueReminderCatchUpMinutes = Math.max(
        dueReminderGraceMinutes,
        Math.max(1, config.proactiveAutomationIntervalMinutes || 15) * 8
      );
      const dueAlerts = reminders.filter((item) => {
        if (item.effectiveDueDate === item.lastNotifiedForDueDate) {
          return false;
        }

        if (item.remindMinutesBefore !== null && item.dueTime && item.effectiveDueDate === todayIso) {
          return isReminderDueAlertWindow({
            nowMinutes,
            dueTime: item.dueTime,
            remindMinutesBefore: item.remindMinutesBefore,
            dueReminderCatchUpMinutes
          });
        }

        return item.daysUntilDue >= 0 && item.daysUntilDue <= item.remindDaysBefore;
      });

      for (const reminder of dueAlerts) {
        if (alertsSentThisCycle >= MAX_ALERTS_PER_CYCLE) break;
        result.reminderAlertsTriggered += 1;
        const text = reminderMessage({
          name,
          title: reminder.title,
          amountCents: reminder.amountCents,
          dueDate: reminder.effectiveDueDate,
          dueTime: reminder.dueTime,
          daysUntilDue: reminder.daysUntilDue,
          remindDaysBefore: reminder.remindDaysBefore,
          remindMinutesBefore: reminder.remindMinutesBefore
        });

        let sentOk = false;
        if (!dryRun) {
          const sent = await sendWhatsAppText({ to: customer.whatsappNumber, message: text });
          if (sent.sent) {
            sentOk = true;
            result.reminderAlertsSent += 1;
            alertsSentThisCycle += 1;
            await markBillReminderNotifiedForDueDate({
              customerId: customer.id,
              reminderId: reminder.id,
              dueDate: reminder.effectiveDueDate
            });
          } else {
            result.failures.push({
              customerId: customer.id,
              whatsappNumber: customer.whatsappNumber,
              reason: sent.error ?? 'Falha ao enviar lembrete proativo'
            });
          }
        }

        await logConversation(customer.id, 'outbound', text, {
          source: 'auto-reminder-due',
          dryRun,
          sent: sentOk,
          reminderId: reminder.id,
          effectiveDueDate: reminder.effectiveDueDate,
          remindDaysBefore: reminder.remindDaysBefore,
          remindMinutesBefore: reminder.remindMinutesBefore
        });
      }

      // Lembrete de renovação do plano: 3 dias antes e no dia do vencimento
      if (
        access.reason === 'ok' &&
        access.dueDate &&
        access.planCode &&
        access.planCode !== 'free'
      ) {
        const daysLeft = diffDaysIso(todayIso, access.dueDate);
        if (daysLeft === 3 || daysLeft === 0) {
          const renewalSource = daysLeft === 3 ? 'auto-renewal-reminder-3d' : 'auto-renewal-reminder-0d';
          const alreadySentToday = wasSentToday(customer.id, renewalSource);

          if (!alreadySentToday) {
            result.renewalRemindersTriggered += 1;
            const plan = getPlanDefinition(access.planCode);
            const text = renewalReminderMessage({
              name,
              planCode: access.planCode,
              planName: access.planName ?? plan.name,
              daysLeft,
              dueDate: access.dueDate,
              monthlyFeeCents: plan.monthlyFeeCents
            });

            let sentOk = false;
            if (!dryRun) {
              const sent = await sendWhatsAppText({ to: customer.whatsappNumber, message: text });
              if (sent.sent) {
                sentOk = true;
                result.renewalRemindersSent += 1;
              } else {
                result.failures.push({
                  customerId: customer.id,
                  whatsappNumber: customer.whatsappNumber,
                  reason: sent.error ?? `Falha ao enviar lembrete de renovação (${renewalSource})`
                });
              }
            }

            await logConversation(customer.id, 'outbound', text, {
              source: renewalSource,
              dryRun,
              sent: sentOk,
              daysLeft,
              dueDate: access.dueDate
            });
          }
        }
      }

      const limitStatuses = await spendingLimitStatuses({
        customerId: customer.id,
        referenceDate,
        timezone
      });
      for (const status of limitStatuses) {
        if (alertsSentThisCycle >= MAX_ALERTS_PER_CYCLE) break;
        const alertKind = pickLimitAlertKind(status, proactiveProfile);
        if (!alertKind) continue;

        const source = `auto-limit-${status.period}-${alertKind}`;
        if (wasSentToday(customer.id, source)) continue;

        result.limitAlertsTriggered += 1;
        const text = limitAlertMessage({
          name,
          period: status.period,
          kind: alertKind,
          remainingCents: status.remainingCents,
          limitCents: status.limitCents,
          spentCents: status.spentCents,
          tone: proactiveProfile.tone
        });

        let sentOk = false;
        if (!dryRun) {
          const sent = await sendWhatsAppText({ to: customer.whatsappNumber, message: text });
          if (sent.sent) {
            sentOk = true;
            result.limitAlertsSent += 1;
            alertsSentThisCycle += 1;
          } else {
            result.failures.push({
              customerId: customer.id,
              whatsappNumber: customer.whatsappNumber,
              reason: sent.error ?? `Falha ao enviar alerta de limite ${status.period}`
            });
          }
        }

        await logConversation(customer.id, 'outbound', text, {
          source,
          dryRun,
          sent: sentOk,
          status: status.status,
          alertKind,
          period: status.period,
          limitCents: status.limitCents,
          spentCents: status.spentCents,
          referenceDate: todayIso
        });
      }

      if (alertsSentThisCycle < MAX_ALERTS_PER_CYCLE && proactiveProfile.sendDailyProgress) {
        const source = 'auto-progress-daily';
        if (!wasSentToday(customer.id, source)) {
          const hasInboundToday = hadInboundToday(customer.id);
          if (hasInboundToday) {
            const [streak, insights] = await Promise.all([
              getCustomerStreak(customer.id, referenceDate, timezone),
              spendingInsights(customer.id, referenceDate, timezone)
            ]);

            // Evita notificação sem sinal real de progresso
            const hasProgressSignal = streak.currentStreakDays >= 2 || (insights.monthOverMonthPct !== null && insights.monthOverMonthPct <= -8);
            if (hasProgressSignal) {
              result.progressAlertsTriggered += 1;
              const text = progressMessage({
                name,
                streakDays: streak.currentStreakDays,
                activeDaysLast30: streak.activeDaysLast30,
                monthOverMonthPct: insights.monthOverMonthPct,
                tone: proactiveProfile.tone
              });

              let sentOk = false;
              if (!dryRun) {
                const sent = await sendWhatsAppText({ to: customer.whatsappNumber, message: text });
                if (sent.sent) {
                  sentOk = true;
                  result.progressAlertsSent += 1;
                } else {
                  result.failures.push({
                    customerId: customer.id,
                    whatsappNumber: customer.whatsappNumber,
                    reason: sent.error ?? 'Falha ao enviar reforço de progresso'
                  });
                }
              }

              await logConversation(customer.id, 'outbound', text, {
                source,
                dryRun,
                sent: sentOk,
                streakDays: streak.currentStreakDays,
                activeDaysLast30: streak.activeDaysLast30,
                monthOverMonthPct: insights.monthOverMonthPct
              });
            }
          }
        }
      }

      // ── Resumo semanal + score consolidados em UMA mensagem (segunda-feira) ──
      if (runWeekly && proactiveProfile.sendWeeklySummary) {
        const weeklySource = 'auto-weekly-summary';
        const alreadySentWeek = wasSentThisWeek(customer.id, weeklySource);
        if (!alreadySentWeek) {
          const prevWeekDate = new Date(referenceDate);
          prevWeekDate.setDate(referenceDate.getDate() - 7);
          const [summary, prevWeekSummary] = await Promise.all([
            weeklySummary(customer.id, referenceDate, timezone),
            weeklySummary(customer.id, prevWeekDate, timezone)
          ]);
          if (summary.totalIncomeCents > 0 || summary.totalExpenseCents > 0) {
            result.weeklySummariesTriggered += 1;

            // Se score também precisa ir nesta semana, incluir na mesma mensagem
            const scoreSource = 'auto-weekly-score-evolution';
            let scoreBlock = '';
            let scoreNeedsSending = false;
            if (proactiveProfile.sendWeeklyScoreEvolution && planHasFeature(access.planCode, 'health_score')) {
              const scoreAlreadySent = wasSentThisWeek(customer.id, scoreSource);
              if (!scoreAlreadySent) {
                const evolution = await weeklyFinancialHealthSeries({
                  customerId: customer.id,
                  referenceDate,
                  timezone,
                  weeks: 6
                });
                const deltaLabel = evolution.latestDelta === null ? 'início' : evolution.latestDelta > 0 ? `+${evolution.latestDelta}` : String(evolution.latestDelta);
                const latestScore = evolution.points.length > 0 ? evolution.points[evolution.points.length - 1] : null;
                if (latestScore !== null) {
                  scoreBlock = `\n\n🧠 Score financeiro: ${latestScore}/1000 (${deltaLabel} vs semana passada)`;
                  scoreNeedsSending = true;
                  result.scoreEvolutionsTriggered += 1;
                }
              }
            }

            const text = weeklySummaryMessage({
              name,
              startDate: summary.startDate,
              endDate: summary.endDate,
              incomeCents: summary.totalIncomeCents,
              expenseCents: summary.totalExpenseCents,
              netCents: summary.netCents,
              byCategory: summary.byCategory,
              prevWeekExpenseCents: prevWeekSummary.totalExpenseCents > 0
                ? prevWeekSummary.totalExpenseCents
                : undefined
            }) + scoreBlock;

            let sentOk = false;
            if (!dryRun) {
              const sent = await sendWhatsAppText({ to: customer.whatsappNumber, message: text });
              if (sent.sent) {
                sentOk = true;
                result.weeklySummariesSent += 1;
                if (scoreNeedsSending) result.scoreEvolutionsSent += 1;
              } else {
                result.failures.push({
                  customerId: customer.id,
                  whatsappNumber: customer.whatsappNumber,
                  reason: sent.error ?? 'Falha ao enviar resumo semanal'
                });
              }
            }

            await logConversation(customer.id, 'outbound', text, {
              source: weeklySource,
              dryRun,
              sent: sentOk,
              startDate: summary.startDate,
              endDate: summary.endDate,
              totalIncomeCents: summary.totalIncomeCents,
              totalExpenseCents: summary.totalExpenseCents
            });
            // Marca score como enviado também para não reenviar separado
            if (scoreNeedsSending) {
              await logConversation(customer.id, 'outbound', '__score-included-in-weekly__', {
                source: scoreSource,
                dryRun,
                sent: sentOk,
                automated: 'true'
              });
            }
          }
        }
      }

      if (isFirstDayOfMonth && proactiveProfile.sendMonthlyVisualReport && planHasFeature(access.planCode, 'visual_monthly_report')) {
        const prevMonthDate = new Date(referenceDate);
        prevMonthDate.setMonth(referenceDate.getMonth() - 1);
        const prevMonth = prevMonthDate.getMonth() + 1;
        const prevYear = prevMonthDate.getFullYear();
        const monthSource = `auto-monthly-visual-${prevYear}-${String(prevMonth).padStart(2, '0')}`;
        const monthAlreadySent = wasSentThisMonth(customer.id, monthSource);
        if (!monthAlreadySent) {
          const visual = await monthlyVisualReportData({
            customerId: customer.id,
            month: prevMonth,
            year: prevYear
          });
          if (visual.totalIncomeCents > 0 || visual.totalExpenseCents > 0) {
            result.monthlyVisualReportsTriggered += 1;
            const text = monthlyVisualReportMessage({
              name,
              month: visual.month,
              year: visual.year,
              totalIncomeCents: visual.totalIncomeCents,
              totalExpenseCents: visual.totalExpenseCents,
              netCents: visual.netCents,
              topCategory: visual.topCategory
                ? { category: visual.topCategory.category, sharePct: visual.topCategory.sharePct }
                : null,
              biggestExpense: visual.biggestExpense
                ? { category: visual.biggestExpense.category, amountCents: visual.biggestExpense.amountCents }
                : null,
              monthOverMonthExpensePct: visual.monthOverMonthExpensePct
            });

            let sentOk = false;
            if (!dryRun) {
              const sent = await sendWhatsAppText({ to: customer.whatsappNumber, message: text });
              if (sent.sent) {
                sentOk = true;
                result.monthlyVisualReportsSent += 1;
              } else {
                result.failures.push({
                  customerId: customer.id,
                  whatsappNumber: customer.whatsappNumber,
                  reason: sent.error ?? 'Falha ao enviar relatório visual mensal'
                });
              }
            }

            await logConversation(customer.id, 'outbound', text, {
              source: monthSource,
              dryRun,
              sent: sentOk,
              month: visual.month,
              year: visual.year
            });
          }
        }
      }
      if (runWeekly) {
        const goalSource = 'auto-savings-goal-alert';
        const goalAlreadySent = wasSentThisWeek(customer.id, goalSource);
        if (!goalAlreadySent) {
          const goals = await getActiveSavingsGoals(customer.id);
          for (const goal of goals) {
            const progress = await getSavingsGoalMonthlyProgress({ customerId: customer.id, goalCreatedAt: goal.createdAt });
            const deadlineDate = goal.deadlineDate;
            const monthsRemaining = Math.max(
              1,
              (deadlineDate.getFullYear() - referenceDate.getFullYear()) * 12 +
                (deadlineDate.getMonth() - referenceDate.getMonth()) + 1
            );
            const projectedTotal = progress.avgMonthlySurplusCents * monthsRemaining;
            const atRisk = projectedTotal < goal.targetCents;

            if (atRisk) {
              result.goalAlertsTriggered += 1;
              const shortfallCents = goal.targetCents - projectedTotal;
              const deadlineFmt = deadlineDate.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
              const text = [
                `⚠️ Atenção, ${name}! Sua meta está em risco.`,
                ``,
                `🎯 *${goal.description}*`,
                `💰 Alvo: ${centsToBrl(goal.targetCents)} até ${deadlineFmt}`,
                `📈 Com seu ritmo atual, projeção é ${centsToBrl(projectedTotal)} — faltam ${centsToBrl(shortfallCents)}.`,
                ``,
                `Corte ${centsToBrl(Math.ceil(shortfallCents / monthsRemaining))}/mês nos gastos para volcar ao trilho. 💪`
              ].join('\n');

              let sentOk = false;
              if (!dryRun) {
                const sent = await sendWhatsAppText({ to: customer.whatsappNumber, message: text });
                if (sent.sent) {
                  sentOk = true;
                  result.goalAlertsSent += 1;
                } else {
                  result.failures.push({
                    customerId: customer.id,
                    whatsappNumber: customer.whatsappNumber,
                    reason: sent.error ?? 'Falha ao enviar alerta de meta'
                  });
                }
              }

              await logConversation(customer.id, 'outbound', text, {
                source: goalSource,
                dryRun,
                sent: sentOk,
                goalId: goal.id,
                shortfallCents
              });
              break;
            }
          }
        }
      }
      // ── Desafio da Semana (segunda-feira, planos pagos) ──────────────────────
      if (runWeekly && access.planCode !== 'free' && proactiveProfile.sendDailyInactivity) {
        const challengeSource = 'auto-weekly-challenge';
        const prevChallengeSource = 'auto-weekly-challenge-prev-check';

        const challengeAlreadySent = wasSentThisWeek(customer.id, challengeSource);

        if (!challengeAlreadySent) {
          // Verifica resultado do desafio da semana passada
          const prevWeekDate = new Date(referenceDate);
          prevWeekDate.setDate(referenceDate.getDate() - 7);
          const prevCheckAlreadySent = wasSentThisWeek(customer.id, prevChallengeSource);

          if (!prevCheckAlreadySent) {
            const prevChallengeLog = await pool.query<{ metadata: Record<string, unknown> }>(
              `SELECT metadata FROM conversation_logs
               WHERE customer_id = $1 AND direction = 'outbound'
                 AND metadata->>'source' = 'auto-weekly-challenge'
                 AND created_at >= NOW() - INTERVAL '14 days'
               ORDER BY created_at DESC LIMIT 1`,
              [customer.id]
            );
            const prevChallenge = prevChallengeLog.rows[0]?.metadata;
            if (prevChallenge && prevChallenge.targetCategory && prevChallenge.targetCents) {
              const prevSummary = await weeklySummary(customer.id, prevWeekDate, timezone);
              const categoryData = prevSummary.byCategory.find(
                c => c.category === prevChallenge.targetCategory
              );
              const actualCents = categoryData?.amountCents ?? 0;
              const targetCents = Number(prevChallenge.targetCents);
              const success = actualCents <= targetCents;
              const conclusionText = weeklyChallengeConclusionMessage({
                name,
                topCategory: String(prevChallenge.targetCategory),
                targetCents,
                actualCents,
                success
              });
              if (!dryRun) {
                await sendWhatsAppText({ to: customer.whatsappNumber, message: conclusionText });
              }
              await logConversation(customer.id, 'outbound', conclusionText, {
                source: prevChallengeSource,
                dryRun,
                success,
                actualCents,
                targetCents
              });
            }
          }

          // Envia novo desafio baseado na semana passada
          const lastWeekSummary = await weeklySummary(customer.id, prevWeekDate, timezone);
          const topCat = lastWeekSummary.byCategory[0];
          if (topCat && topCat.amountCents > 0) {
            const reductionCents = Math.round(topCat.amountCents * 0.2);
            const targetCents = topCat.amountCents - reductionCents;
            const challengeText = weeklyChallengeMessage({
              name,
              topCategory: topCat.category,
              lastWeekCents: topCat.amountCents,
              targetCents,
              reductionCents
            });

            let sentOk = false;
            if (!dryRun) {
              const sent = await sendWhatsAppText({ to: customer.whatsappNumber, message: challengeText });
              if (sent.sent) { sentOk = true; result.weeklyChallengeSent += 1; }
              else result.failures.push({ customerId: customer.id, whatsappNumber: customer.whatsappNumber, reason: sent.error ?? 'Falha ao enviar desafio semanal' });
            }
            await logConversation(customer.id, 'outbound', challengeText, {
              source: challengeSource,
              dryRun,
              sent: sentOk,
              targetCategory: topCat.category,
              targetCents,
              lastWeekCents: topCat.amountCents
            });
          }
        }
      }

      // ── Alerta de risco financeiro familiar (semanal) ──────────────────────
      if (runWeekly && access.planCode === 'family') {
        const familyRiskSource = 'auto-family-risk-alert';
        const familyRiskSent = wasSentThisWeek(customer.id, familyRiskSource);
        if (!familyRiskSent) {
          try {
            const riskSnap = await getFamilyRiskSnapshot({ customerId: customer.id, referenceDate, timezone });
            if (riskSnap?.atRisk) {
              result.familyRiskAlertsTriggered += 1;
              const usagePct = Math.round(riskSnap.usageRatio * 100);
              const text = [
                `⚠️ ${name}, a família está em zona de risco financeiro esta semana.`,
                ``,
                `💸 Gastos: ${centsToBrl(riskSnap.totalExpenseCents)} (${usagePct}% da renda)`,
                `💰 Entradas: ${centsToBrl(riskSnap.totalIncomeCents)}`,
                `📉 Saldo: ${centsToBrl(riskSnap.netCents)}`,
                ``,
                `Com ${riskSnap.memberCount} membro(s) no grupo. Hora de revisar os gastos juntos. 🏠`
              ].join('\n');

              let sentOk = false;
              if (!dryRun) {
                const sent = await sendWhatsAppText({ to: customer.whatsappNumber, message: text });
                if (sent.sent) { sentOk = true; result.familyRiskAlertsSent += 1; }
                else result.failures.push({ customerId: customer.id, whatsappNumber: customer.whatsappNumber, reason: sent.error ?? 'Falha alerta risco familiar' });
              }
              await logConversation(customer.id, 'outbound', text, { source: familyRiskSource, dryRun, sent: sentOk });
            }
          } catch { /* família sem dados suficientes — ignora */ }
        }
      }

      // ── Reunião financeira mensal (1º dia do mês, plano família) ───────────
      if (isFirstDayOfMonth && access.planCode === 'family') {
        const prevMonthDate = new Date(referenceDate);
        prevMonthDate.setMonth(referenceDate.getMonth() - 1);
        const meetingSource = `auto-family-meeting-${prevMonthDate.getFullYear()}-${String(prevMonthDate.getMonth() + 1).padStart(2, '0')}`;
        const meetingSent = wasSentThisMonth(customer.id, meetingSource);
        if (!meetingSent) {
          try {
            const summary = await familyMonthlySummary(customer.id, prevMonthDate, timezone);
            if (summary && (summary.totalIncomeCents > 0 || summary.totalExpenseCents > 0)) {
              const monthName = new Date(summary.year, summary.month - 1, 1)
                .toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
              const topCats = summary.byCategory.slice(0, 4)
                .map(c => `   • ${c.category}: ${centsToBrl(c.amountCents)}`).join('\n');
              const memberLines = summary.memberExpenses
                .map(m => `   • ${m.name ?? 'Membro'}: ${centsToBrl(m.amountCents)}`).join('\n');
              const netLabel = summary.netCents >= 0
                ? `✅ Sobra: ${centsToBrl(summary.netCents)}`
                : `⚠️ Déficit: ${centsToBrl(Math.abs(summary.netCents))}`;
              const nextGoal = summary.netCents < 0
                ? `Cortar ${centsToBrl(Math.abs(summary.netCents))} para equilibrar.`
                : `Guardar ${centsToBrl(Math.round(summary.netCents * 0.3))} nos cofres.`;

              const text = [
                `📋 *Reunião Financeira da Família — ${monthName}*`,
                ``,
                `💰 Entradas: ${centsToBrl(summary.totalIncomeCents)}`,
                `💸 Saídas: ${centsToBrl(summary.totalExpenseCents)}`,
                `${netLabel}`,
                ``,
                `📊 Top categorias:\n${topCats || '   Sem dados'}`,
                ``,
                `👥 Por membro:\n${memberLines || '   Sem dados'}`,
                ``,
                `🎯 Meta do próximo mês: ${nextGoal}`
              ].join('\n');

              let sentOk = false;
              if (!dryRun) {
                const sent = await sendWhatsAppText({ to: customer.whatsappNumber, message: text });
                if (sent.sent) { sentOk = true; result.familyMeetingsSent += 1; }
                else result.failures.push({ customerId: customer.id, whatsappNumber: customer.whatsappNumber, reason: sent.error ?? 'Falha reunião familiar' });
              }
              await logConversation(customer.id, 'outbound', text, { source: meetingSource, dryRun, sent: sentOk, month: summary.month, year: summary.year });
            }
          } catch { /* família sem dados — ignora */ }
        }
      }

      // ── Dica semanal personalizada (quarta-feira, planos premium+) ─────────
      if (runWednesday && (access.planCode === 'premium' || access.planCode === 'family' || access.planCode === 'elite')) {
        const tipSource = 'auto-tip-weekly';
        const tipAlreadySent = wasSentThisWeek(customer.id, tipSource);
        if (!tipAlreadySent) {
          try {
            const insights = await spendingInsights(customer.id, referenceDate, timezone);
            const topCat = insights.topCategory?.category ?? null;
            const text = dailyFinancialTipMessage({ name, topCategory: topCat });
            let sentOk = false;
            if (!dryRun) {
              const sent = await sendWhatsAppText({ to: customer.whatsappNumber, message: text });
              if (sent.sent) { sentOk = true; result.tipsWeeklySent += 1; }
              else result.failures.push({ customerId: customer.id, whatsappNumber: customer.whatsappNumber, reason: sent.error ?? 'Falha ao enviar dica semanal' });
            }
            await logConversation(customer.id, 'outbound', text, { source: tipSource, dryRun, sent: sentOk, topCategory: topCat });
          } catch { /* sem dados suficientes — ignora */ }
        }
      }

    } catch (error) {
      result.failures.push({
        customerId: customer.id,
        whatsappNumber: customer.whatsappNumber,
        reason: error instanceof Error ? error.message : 'Erro desconhecido na execução'
      });
    }
  }

  if (ownerReportWindowOpen) {
    const ownerContacts = customers.filter((customer) => isOwnerWhatsappNumber(customer.whatsappNumber));
    if (ownerContacts.length > 0) {
      const metrics = await adminMetrics();
      const source = 'auto-owner-daily-report';

      // MRR and plan breakdown from active subscriptions
      let mrrCents = 0;
      let planBreakdown = '';
      try {
        const planRes = await pool.query<{ plan_code: string; monthly_fee_cents: string; total: string }>(
          `SELECT s.plan_code, s.monthly_fee_cents, COUNT(*)::text AS total
           FROM subscriptions s
           JOIN customers c ON c.id = s.customer_id
           WHERE c.is_active = TRUE AND s.status = 'active'
           GROUP BY s.plan_code, s.monthly_fee_cents`
        );
        for (const row of planRes.rows) {
          mrrCents += Number(row.monthly_fee_cents) * Number(row.total);
        }
        const order: Record<string, number> = { free: 0, essential: 1, premium: 2, family: 3, elite: 4 };
        const sorted = [...planRes.rows].sort((a, b) => (order[a.plan_code] ?? 9) - (order[b.plan_code] ?? 9));
        planBreakdown = sorted.map(r => `${r.plan_code}: ${r.total}`).join(' · ');
      } catch { /* ignora falha de MRR */ }

      for (const owner of ownerContacts) {
        if (wasSentToday(owner.id, source)) continue;

        const text = ownerDailyReportMessage({
          ownerName: friendlyName(owner.name),
          timezone,
          referenceDate,
          summary: result,
          activeCustomers: metrics.activeCustomers,
          online1h: metrics.customersOnline1h,
          online24h: metrics.customersOnline24h,
          newCustomersToday: metrics.newCustomersToday,
          inactive7d: metrics.inactive7d,
          pendingSetup: metrics.pendingSetupCustomers,
          pastDue: metrics.pastDueCustomers,
          trialCustomers: metrics.trialCustomers,
          mrrCents,
          planBreakdown
        });

        let sentOk = false;
        if (!dryRun) {
          const sent = await sendWhatsAppText({ to: owner.whatsappNumber, message: text });
          if (!sent.sent) {
            result.failures.push({
              customerId: owner.id,
              whatsappNumber: owner.whatsappNumber,
              reason: sent.error ?? 'Falha ao enviar relatório diário do coordenador'
            });
          } else {
            sentOk = true;
          }
        }

        await logConversation(owner.id, 'outbound', text, {
          source,
          dryRun,
          sent: sentOk,
          referenceDate: todayIso
        });
      }
    }
  }

  return result;
}

export const __proactiveAlertsTestables = {
  isReminderDueAlertWindow,
  followUpSilenceMinutesForTone,
  greetingByTimeInTimezone
};
