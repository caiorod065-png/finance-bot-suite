import { config } from '../../config.js';
import {
  logConversation,
  spendingInsights,
  detectRecurringExpenses,
  forecastCashflowMonth,
  financialHealthScore,
  weeklyFinancialHealthSeries,
  monthlyVisualReportData,
  getCustomerStreak,
  evaluateAndUnlockAchievements,
  listCustomerAchievements,
} from '../../services/ledger.js';
import {
  planHasFeature,
  featureLabel,
  minimumPlanForFeature,
  type PlanFeature,
} from '../../services/plans.js';

// ─── Local pure helpers ───────────────────────────────────────────────────────

function centsToBrl(cents: number): string {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(cents / 100);
}

function scoreSparkline(values: number[]): string {
  const chars = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  return values.map(v => chars[Math.min(Math.floor(((v - min) / range) * (chars.length - 1)), chars.length - 1)]).join('');
}

function decorateCategory(category: string): string {
  const map: Record<string, string> = {
    alimentacao: '🍽️', restaurante: '🍽️', mercado: '🛒', transporte: '🚗',
    saude: '💊', lazer: '🎉', educacao: '📚', moradia: '🏠',
    vestuario: '👗', servicos: '🔧', assinaturas: '📱', outros: '💸',
  };
  const key = category.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
  return (map[key] ?? '💸') + ' ' + category;
}

// ─── Feature guard ────────────────────────────────────────────────────────────

async function featureGuard(params: {
  customerId: string;
  customerName: string | null | undefined;
  planCode: string;
  planName: string;
  feature: PlanFeature;
}): Promise<string | null> {
  if (planHasFeature(params.planCode, params.feature)) return null;
  const required = minimumPlanForFeature(params.feature);
  const firstName = params.customerName?.trim().split(/\s+/)[0];
  const namePrefix = firstName ? firstName + ', ' : '';
  const outText = [
    namePrefix + 'esse recurso (' + featureLabel(params.feature) + ') ainda nao esta no seu plano ' + params.planName + '.',
    'Para liberar, voce precisa do plano ' + required + ' ou superior.',
    'Se quiser, eu te mostro em 30 segundos qual upgrade faz mais sentido para o seu uso.'
  ].join('\n');
  await logConversation(params.customerId, 'outbound', outText, {
    intent: 'feature-locked',
    feature: params.feature,
    planCode: params.planCode
  });
  return outText;
}

// ─── Types ────────────────────────────────────────────────────────────────────

export type AnalyticsIntentType =
  | 'insights'
  | 'recurring'
  | 'cashflow'
  | 'investment_simulator'
  | 'health_score'
  | 'weekly_score'
  | 'visual_report'
  | 'streak'
  | 'achievements';

export type InvestmentSimulation = {
  monthlyContributionCents: number;
  months: number;
  monthlyRatePct: number;
};

export type AnalyticsParams = {
  customerId: string;
  customerName: string | null | undefined;
  from: string;
  now: Date;
  planCode: string;
  planName: string;
  intent: AnalyticsIntentType;
  investmentSimulation?: InvestmentSimulation;
};

type HandlerResult = {
  replyText: string;
  responseBody: Record<string, unknown>;
};

// ─── Public handler ───────────────────────────────────────────────────────────

export async function handleAnalyticsIntents(p: AnalyticsParams): Promise<HandlerResult> {
  const guard = (feature: PlanFeature) => featureGuard({
    customerId: p.customerId,
    customerName: p.customerName,
    planCode: p.planCode,
    planName: p.planName,
    feature
  });

  if (p.intent === 'insights') {
    const locked = await guard('insights');
    if (locked) return { replyText: locked, responseBody: { ok: true, to: p.from, replyText: locked, blockedFeature: 'insights' } };
    const insights = await spendingInsights(p.customerId, p.now, config.defaultTimezone);
    const monthLabel = String(insights.month).padStart(2, '0') + '/' + insights.year;
    const trend = insights.monthOverMonthPct === null
      ? 'Sem base suficiente para comparar com mes anterior.'
      : insights.monthOverMonthPct >= 0
        ? 'Seus gastos subiram ' + insights.monthOverMonthPct.toFixed(1) + '% vs mes anterior.'
        : 'Seus gastos cairam ' + Math.abs(insights.monthOverMonthPct).toFixed(1) + '% vs mes anterior.';
    const outText = [
      '📊 Insights de ' + monthLabel + ':',
      '• Despesas no mes: ' + centsToBrl(insights.expenseMtdCents),
      '• ' + trend,
      insights.topCategory
        ? '• Categoria lider: ' + decorateCategory(insights.topCategory.category) + ' (' + centsToBrl(insights.topCategory.amountCents) + ' | ' + insights.topCategory.sharePct.toFixed(1) + '%)'
        : '• Ainda sem categoria lider no mes.',
      insights.topWeekday
        ? '• Dia com mais gasto: ' + insights.topWeekday.weekday + ' (' + centsToBrl(insights.topWeekday.amountCents) + ')'
        : '• Ainda sem padrao semanal identificado.',
      'Quer que eu te sugira um limite semanal com base nisso?'
    ].join('\n');
    await logConversation(p.customerId, 'outbound', outText, { intent: 'spending-insights' });
    return { replyText: outText, responseBody: { ok: true, to: p.from, replyText: outText, insights } };
  }

  if (p.intent === 'recurring') {
    const locked = await guard('recurring');
    if (locked) return { replyText: locked, responseBody: { ok: true, to: p.from, replyText: locked, blockedFeature: 'recurring' } };
    const recurring = await detectRecurringExpenses(p.customerId, p.now, config.defaultTimezone);
    const outText = recurring.length === 0
      ? 'Ainda nao encontrei gastos recorrentes claros.\nQuando houver mais historico, eu te aviso assinaturas suspeitas automaticamente.'
      : '🔁 Possiveis gastos recorrentes detectados:\n' +
        recurring.map((item, i) => {
          const nextDate = new Date(item.nextEstimatedDate + 'T12:00:00.000Z').toLocaleDateString('pt-BR');
          return (i + 1) + ') ' + decorateCategory(item.category) + ' | ' + centsToBrl(item.amountCentsMedian) + ' | ' + item.occurrences + 'x | proximo ~ ' + nextDate;
        }).join('\n') +
        '\nSe quiser, eu transformo isso em lembretes de vencimento.';
    await logConversation(p.customerId, 'outbound', outText, { intent: 'recurring-detection', count: recurring.length });
    return { replyText: outText, responseBody: { ok: true, to: p.from, replyText: outText, recurring } };
  }

  if (p.intent === 'cashflow') {
    const locked = await guard('cashflow');
    if (locked) return { replyText: locked, responseBody: { ok: true, to: p.from, replyText: locked, blockedFeature: 'cashflow' } };
    const forecast = await forecastCashflowMonth(p.customerId, p.now, config.defaultTimezone);
    const monthLabel = String(forecast.month).padStart(2, '0') + '/' + forecast.year;
    const outText = [
      '🔮 Previsao de saldo (' + monthLabel + '):',
      '• Receita projetada: ' + centsToBrl(forecast.projectedIncomeCents),
      '• Despesa projetada: ' + centsToBrl(forecast.projectedExpenseCents),
      '• Saldo projetado: ' + centsToBrl(forecast.projectedNetCents),
      '• Contas a vencer no mes: ' + centsToBrl(forecast.upcomingBillsCents),
      '• Saldo apos vencimentos: ' + centsToBrl(forecast.projectedNetAfterBillsCents),
      'Quer que eu te recomende um teto semanal para segurar esse saldo?'
    ].join('\n');
    await logConversation(p.customerId, 'outbound', outText, { intent: 'cashflow-forecast' });
    return { replyText: outText, responseBody: { ok: true, to: p.from, replyText: outText, forecast } };
  }

  if (p.intent === 'investment_simulator' && p.investmentSimulation) {
    const locked = await guard('investment_simulator');
    if (locked) return { replyText: locked, responseBody: { ok: true, to: p.from, replyText: locked, blockedFeature: 'investment_simulator' } };
    const { monthlyContributionCents, monthlyRatePct, months } = p.investmentSimulation;
    const contribution = monthlyContributionCents / 100;
    const rate = monthlyRatePct / 100;
    const futureValue = rate === 0 ? contribution * months : contribution * ((Math.pow(1 + rate, months) - 1) / rate);
    const invested = contribution * months;
    const earnings = Math.max(futureValue - invested, 0);
    const outText = [
      '💰 Simulacao rapida de investimento:',
      '• Aporte mensal: ' + centsToBrl(monthlyContributionCents),
      '• Prazo: ' + months + ' mes(es)',
      '• Taxa usada: ' + monthlyRatePct.toFixed(2) + '% ao mes',
      '• Total investido: ' + centsToBrl(Math.round(invested * 100)),
      '• Valor estimado final: ' + centsToBrl(Math.round(futureValue * 100)),
      '• Rendimentos estimados: ' + centsToBrl(Math.round(earnings * 100)),
      'Quer que eu simule tambem com outro valor mensal?'
    ].join('\n');
    await logConversation(p.customerId, 'outbound', outText, { intent: 'investment-simulator' });
    return { replyText: outText, responseBody: { ok: true, to: p.from, replyText: outText, investmentSimulation: p.investmentSimulation } };
  }

  if (p.intent === 'health_score') {
    const locked = await guard('health_score');
    if (locked) return { replyText: locked, responseBody: { ok: true, to: p.from, replyText: locked, blockedFeature: 'health_score' } };
    const scoreData = await financialHealthScore(p.customerId, p.now, config.defaultTimezone);
    const scoreText = scoreData.score >= 800 ? 'Excelente fase! 🟢' : scoreData.score >= 600 ? 'Boa evolucao! 🟡' : 'Vamos subir esse placar juntos 💪';
    const outText = [
      '🧠 Seu score financeiro (' + String(scoreData.month).padStart(2, '0') + '/' + scoreData.year + ') e ' + scoreData.score + '/1000.',
      scoreText,
      ...scoreData.components.map((item: { label: string; value: number; max: number }) => '• ' + item.label + ': ' + item.value + '/' + item.max),
      'Quer que eu te diga o ajuste mais rapido para aumentar esse score esta semana?'
    ].join('\n');
    await logConversation(p.customerId, 'outbound', outText, { intent: 'financial-score' });
    return { replyText: outText, responseBody: { ok: true, to: p.from, replyText: outText, score: scoreData } };
  }

  if (p.intent === 'weekly_score') {
    const locked = await guard('health_score');
    if (locked) return { replyText: locked, responseBody: { ok: true, to: p.from, replyText: locked, blockedFeature: 'health_score' } };
    const evolution = await weeklyFinancialHealthSeries({ customerId: p.customerId, referenceDate: p.now, timezone: config.defaultTimezone, weeks: 6 });
    const latest = evolution.points[evolution.points.length - 1];
    const trendLabel = evolution.latestDelta > 0 ? 'subiu +' + evolution.latestDelta : evolution.latestDelta < 0 ? 'caiu ' + evolution.latestDelta : 'ficou estavel';
    const outText = [
      '📈 Evolucao semanal do seu score (6 semanas): ' + scoreSparkline(evolution.points.map((pt: { score: number }) => pt.score)),
      'Score atual: ' + (latest?.score ?? 0) + '/1000 (' + trendLabel + ' vs semana passada).',
      ...evolution.points.map((pt: { weekStartDate: string; weekEndDate: string; score: number }, idx: number) =>
        (idx + 1) + ') ' + new Date(pt.weekStartDate + 'T12:00:00.000Z').toLocaleDateString('pt-BR') + ' a ' + new Date(pt.weekEndDate + 'T12:00:00.000Z').toLocaleDateString('pt-BR') + ': ' + pt.score
      ),
      'Quer que eu te mande isso automaticamente toda segunda-feira?'
    ].join('\n');
    await logConversation(p.customerId, 'outbound', outText, { intent: 'score-evolution-weekly' });
    return { replyText: outText, responseBody: { ok: true, to: p.from, replyText: outText, evolution } };
  }

  if (p.intent === 'visual_report') {
    const locked = await guard('visual_monthly_report');
    if (locked) return { replyText: locked, responseBody: { ok: true, to: p.from, replyText: locked, blockedFeature: 'visual_monthly_report' } };
    const month = p.now.getMonth() + 1;
    const year = p.now.getFullYear();
    const report = await monthlyVisualReportData({ customerId: p.customerId, month, year });
    const mood = report.netCents >= 0 ? '💚' : '⚠️';
    const top = report.topCategory ? decorateCategory(report.topCategory.category) + ' (' + report.topCategory.sharePct.toFixed(1) + '%)' : 'sem categoria lider';
    const biggest = report.biggestExpense ? decorateCategory(report.biggestExpense.category) + ' ' + centsToBrl(report.biggestExpense.amountCents) : 'sem gasto destaque';
    const trend = report.monthOverMonthExpensePct === null ? 'Sem comparacao com mes anterior.'
      : report.monthOverMonthExpensePct > 0 ? 'Despesas +' + report.monthOverMonthExpensePct.toFixed(1) + '% vs mes anterior.'
      : report.monthOverMonthExpensePct < 0 ? 'Despesas -' + Math.abs(report.monthOverMonthExpensePct).toFixed(1) + '% vs mes anterior.'
      : 'Despesas estaveis vs mes anterior.';
    const outText = [
      '🎴 Relatorio visual ' + String(report.month).padStart(2, '0') + '/' + report.year,
      mood + ' Receitas: ' + centsToBrl(report.totalIncomeCents) + ' | Despesas: ' + centsToBrl(report.totalExpenseCents) + ' | Saldo: ' + centsToBrl(report.netCents),
      '🏆 Categoria campea: ' + top,
      '💸 Maior gasto: ' + biggest,
      '📊 Tendencia: ' + trend,
      ...report.highlights.slice(0, 2).map((item: string) => '• ' + item)
    ].join('\n');
    await logConversation(p.customerId, 'outbound', outText, { intent: 'monthly-visual-report' });
    return { replyText: outText, responseBody: { ok: true, to: p.from, replyText: outText, report } };
  }

  if (p.intent === 'streak') {
    const locked = await guard('gamification');
    if (locked) return { replyText: locked, responseBody: { ok: true, to: p.from, replyText: locked, blockedFeature: 'gamification' } };
    const [streak, unlockedNow] = await Promise.all([
      getCustomerStreak(p.customerId, p.now, config.defaultTimezone),
      evaluateAndUnlockAchievements(p.customerId, p.now, config.defaultTimezone)
    ]);
    const unlockedLines = unlockedNow.map((item: { title: string }) => '🏅 Nova conquista: ' + item.title);
    const outText = [
      '🔥 Seu streak atual e de ' + streak.currentStreakDays + ' dia(s) seguidos.',
      '🏆 Seu melhor streak foi ' + streak.bestStreakDays + ' dia(s).',
      '📅 Voce teve atividade em ' + streak.activeDaysLast30 + ' dia(s) nos ultimos 30.',
      ...unlockedLines,
      'Quer bater um novo recorde hoje? Me manda um lancamento agora.'
    ].join('\n');
    await logConversation(p.customerId, 'outbound', outText, { intent: 'streak-status' });
    return { replyText: outText, responseBody: { ok: true, to: p.from, replyText: outText, streak } };
  }

  if (p.intent === 'achievements') {
    const locked = await guard('gamification');
    if (locked) return { replyText: locked, responseBody: { ok: true, to: p.from, replyText: locked, blockedFeature: 'gamification' } };
    const achievements = await listCustomerAchievements(p.customerId);
    const outText = achievements.length === 0
      ? 'Voce ainda nao desbloqueou conquistas.\nComece registrando gastos por alguns dias seguidos para liberar seus primeiros badges 🎮'
      : [
        '🎮 Suas conquistas:',
        ...achievements.slice(0, 8).map((item: { title: string; description: string }, idx: number) => (idx + 1) + ') ' + item.title + ' — ' + item.description),
        achievements.length > 8 ? '... e mais ' + (achievements.length - 8) + ' conquista(s).' : '',
        'Bora desbloquear a proxima?'
      ].filter(Boolean).join('\n');
    await logConversation(p.customerId, 'outbound', outText, { intent: 'achievements-list', total: achievements.length });
    return { replyText: outText, responseBody: { ok: true, to: p.from, replyText: outText, achievements } };
  }

  // Fallback (should not happen if caller verifies intent exists)
  return { replyText: '', responseBody: { ok: false } };
}
