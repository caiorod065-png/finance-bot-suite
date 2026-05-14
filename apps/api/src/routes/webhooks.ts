import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  generateScopedSupportReply,
  inferCategory,
  parseIntent,
  extractAndSaveProfileFacts,
  formatProfileFactsForPrompt
} from '../services/parser.js';
import {
  handleSmartOnboardingReply,
  resumeSmartOnboarding,
  shouldBypassOnboardingForMessage
} from '../services/customer-onboarding.js';
import { sendWelcomeActivationMessage } from '../services/whatsapp-outbound.js';
import type { ParsedIntent } from '../types.js';
import {
  activateFamilyMember,
  createFamilyGroup,
  clearFamilySpendingLimit,
  customerDailyFinancialSnapshot,
  createBillReminder,
  createFinancialGoal,
  clearSpendingLimit,
  correctLastTransactionAmount,
  dailyExpenseSummary,
  detectRecurringExpenses,
  deleteLastTransaction,
  evaluateCustomerAccess,
  evaluateAndUnlockAchievements,
  familyMonthlySummary,
  familySpendingLimitStatuses,
  financialGoalsProgress,
  financialHealthScore,
  forecastCashflowMonth,
  getCustomerStreak,
  findCustomerByWhatsappLoose,
  getFamilyContextForCustomer,
  getLastOutboundMessage,
  listActiveCustomerContacts,
  joinFamilyGroupByCode,
  leaveFamilyGroup,
  listCustomerAchievements,
  listFamilySpendingLimits,
  listActiveFinancialGoals,
  listBillReminders,
  listSpendingLimits,
  logConversation,
  monthlyVisualReportData,
  monthlySummary,
  recordSubscriptionPayment,
  recentConversationMessages,
  saveTransaction,
  spendingInsights,
  spendingLimitStatuses,
  setCustomerMonthlyIncome,
  setCustomerPlan,
  setCustomerPreferredName,
  setCustomerTaxId,
  getLastReminderContextReminderId,
  updateBillReminderLeadById,
  updateLatestBillReminderLead,
  upsertSpendingLimit,
  upsertFamilySpendingLimit,
  weeklyFinancialHealthSeries,
  updateLastTransactionContext,
  isOwnerWhatsappNumber,
  upsertCustomerByWhatsapp,
  getTransactionList,
  getCustomerFinancialCapacity,
  createSavingsGoal,
  getActiveSavingsGoals,
  cancelActiveSavingsGoals,
  getSavingsGoalMonthlyProgress,
  createFamilyVault,
  getActiveFamilyVaults,
  cancelActiveFamilyVaults,
  getFamilyVaultProgress,
  getSpendingByCategory,
  detectImpulsivePattern,
  getCustomerProfileFacts
} from '../services/ledger.js';
import { config } from '../config.js';
import { createAsaasCharge } from '../services/billing-asaas.js';
import {
  costOverview,
  latestPreviousMonthCostsSnapshot,
  type CostsOverview,
  type PreviousMonthCostsSnapshot
} from '../services/costs.js';
import { getPlanDefinition, listPlanDefinitions, planHasFeature, type PlanCode, type PlanFeature } from '../services/plans.js';
import {
  ensureJardesSchema,
  getActiveKnowledgeEntries,
  getAwaitingApproval,
  getLastJardesOutboundAgeMinutes,
  getTemplateOverride,
  handleJardesDirectCommand,
  isJardesModeActive,
  processOwnerJardesResponse
} from '../services/jardes-analysis.js';

// ─────────────────────────────────────────────
// Template override helper
// ─────────────────────────────────────────────
async function tpl(key: string, defaultText: string, vars?: Record<string, string>): Promise<string> {
  const override = await getTemplateOverride(key);
  let text = override ?? defaultText;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      text = text.replace(new RegExp(`\\{${k}\\}`, 'g'), v);
    }
  }
  return text;
}

const inboundSchema = z.object({
  from: z.string().min(8),
  text: z.string().min(1),
  timestamp: z.string().optional(),
  name: z.string().optional()
});

type InboundPayload = {
  from: string;
  text: string;
  timestamp?: string;
  name?: string;
};

type MetaStatusPayload = {
  recipientId: string;
  status: string;
  messageId?: string;
  timestamp?: string;
  errorCode?: number;
  errorTitle?: string;
  errorMessage?: string;
};

const twilioInboundSchema = z.object({
  From: z.string().optional(),
  WaId: z.string().optional(),
  Body: z.string().optional(),
  ProfileName: z.string().optional()
}).passthrough();

function extractMetaWebhookPayload(rawBody: unknown): InboundPayload | null {
  const body = rawBody as {
    entry?: Array<{
      changes?: Array<{
        value?: {
          messages?: Array<{ from?: string; text?: { body?: string }; timestamp?: string }>;
          contacts?: Array<{ profile?: { name?: string } }>;
        };
      }>;
    }>;
  };

  const value = body?.entry?.[0]?.changes?.[0]?.value;
  const message = value?.messages?.[0];
  const text = message?.text?.body;
  const from = message?.from;

  if (!from || !text) {
    return null;
  }

  const parsedTs = message.timestamp ? Number(message.timestamp) : Number.NaN;
  const timestampIso = Number.isNaN(parsedTs)
    ? undefined
    : new Date(parsedTs * 1000).toISOString();

  return {
    from,
    text,
    timestamp: timestampIso,
    name: value?.contacts?.[0]?.profile?.name
  };
}

function extractMetaStatusPayload(rawBody: unknown): MetaStatusPayload | null {
  const body = rawBody as {
    entry?: Array<{
      changes?: Array<{
        value?: {
          statuses?: Array<{
            id?: string;
            status?: string;
            timestamp?: string;
            recipient_id?: string;
            errors?: Array<{ code?: number; title?: string; message?: string }>;
          }>;
        };
      }>;
    }>;
  };

  const status = body?.entry?.[0]?.changes?.[0]?.value?.statuses?.[0];
  if (!status?.recipient_id || !status?.status) {
    return null;
  }

  const parsedTs = status.timestamp ? Number(status.timestamp) : Number.NaN;
  const timestampIso = Number.isNaN(parsedTs)
    ? undefined
    : new Date(parsedTs * 1000).toISOString();
  const firstError = status.errors?.[0];

  return {
    recipientId: status.recipient_id,
    status: status.status,
    messageId: status.id,
    timestamp: timestampIso,
    errorCode: firstError?.code,
    errorTitle: firstError?.title,
    errorMessage: firstError?.message
  };
}

function centsToBrl(cents: number): string {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(cents / 100);
}

function scoreSparkline(values: number[]): string {
  if (values.length === 0) return '';
  const levels = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
  return values
    .map((value) => {
      const normalized = Math.max(0, Math.min(1000, value));
      const idx = Math.min(levels.length - 1, Math.floor((normalized / 1000) * (levels.length - 1)));
      return levels[idx];
    })
    .join('');
}

function categoryEmoji(category: string): string {
  const key = normalizeHumanText(category);
  if (key.includes('mercado') || key.includes('supermercado')) return '🛒';
  if (key.includes('alimentacao') || key.includes('lanche') || key.includes('restaurante')) return '🍎';
  if (key.includes('transporte') || key.includes('uber') || key.includes('gasolina')) return '🚚';
  if (key.includes('moradia') || key.includes('aluguel')) return '🏠';
  if (key.includes('educacao') || key.includes('faculdade') || key.includes('curso')) return '📚';
  if (key.includes('beleza') || key.includes('manicure')) return '✂️';
  if (key.includes('shopping')) return '🛍️';
  if (key.includes('saude') || key.includes('farmacia') || key.includes('medico')) return '🏥';
  if (key.includes('lazer') || key.includes('cinema') || key.includes('viagem')) return '🎉';
  if (key.includes('outros')) return '📦';
  return '💸';
}

function decorateCategory(category: string): string {
  return `${categoryEmoji(category)} ${category}`;
}

function periodLabel(period: 'daily' | 'weekly' | 'monthly'): string {
  if (period === 'daily') return 'diário';
  if (period === 'weekly') return 'semanal';
  return 'mensal';
}

function periodEmoji(period: 'daily' | 'weekly' | 'monthly'): string {
  if (period === 'daily') return '📅';
  if (period === 'weekly') return '🗓️';
  return '📆';
}

type CoachingTone = 'soft' | 'standard' | 'strong' | 'max';

function coachingToneByPlan(planCode: string | null | undefined): CoachingTone {
  if (planCode === 'elite') return 'max';
  if (planCode === 'family' || planCode === 'premium') return 'strong';
  if (planCode === 'essential') return 'standard';
  return 'soft';
}

function formatOccurredAtForReply(occurredAtIso: string): { dateLabel: string; timeLabel: string } {
  const occurredAt = new Date(occurredAtIso);
  return {
    dateLabel: occurredAt.toLocaleDateString('pt-BR', { timeZone: config.defaultTimezone }),
    timeLabel: occurredAt.toLocaleTimeString('pt-BR', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      timeZone: config.defaultTimezone
    })
  };
}

function reactionLine(params: {
  kind: 'expense' | 'income';
  amountCents: number;
  category: string;
  customerName?: string | null;
}): string {
  const name = params.customerName ? `, ${params.customerName}` : '';
  if (params.kind === 'income') {
    return `Boa${name}! Entrou grana no caixa 💚`;
  }

  const categoryKey = normalizeHumanText(params.category);
  if (params.amountCents >= 20000) {
    return `Eita${name}, esse valor veio forte hoje 😅`;
  }
  if (categoryKey.includes('alimentacao') || categoryKey.includes('lanche')) {
    return `Lanchinho caprichado${name}? Já deixei tudo organizado 🍔`;
  }
  return `Anotadíssimo${name}. Bora manter o controle em dia 😉`;
}

function limitStatusLine(limit: {
  period: 'daily' | 'weekly' | 'monthly';
  limitCents: number;
  spentCents: number;
  remainingCents: number;
  status: 'near' | 'exceeded' | 'headsup';
  planCode?: string;
}): string {
  const label = periodLabel(limit.period);
  const icon = periodEmoji(limit.period);
  const usagePct = limit.limitCents > 0
    ? Math.min(Math.round((limit.spentCents / limit.limitCents) * 100), 999)
    : 0;

  if (limit.status === 'headsup') {
    if (limit.planCode === 'elite') {
      return `${icon} 🚨 Pré-alerta ${label}: você já consumiu ${usagePct}% do limite. Mantendo esse ritmo, você encosta no teto ainda ${label === 'diário' ? 'hoje' : label === 'semanal' ? 'esta semana' : 'neste mês'}.`;
    }
    return `${icon} 👀 Pré-alerta ${label}: faltam ${centsToBrl(limit.remainingCents)} para o teto de ${centsToBrl(limit.limitCents)}.`;
  }

  if (limit.status === 'near') {
    return `${icon} Atenção no limite ${label}: faltam ${centsToBrl(limit.remainingCents)} para bater seu teto de ${centsToBrl(limit.limitCents)}.`;
  }

  const exceededBy = Math.abs(limit.remainingCents);
  if (limit.planCode === 'elite') {
    return `${icon} 🚨 Limite ${label} ultrapassado em ${centsToBrl(exceededBy)} (teto ${centsToBrl(limit.limitCents)}). Quer que eu monte um ajuste imediato para o restante do período?`;
  }
  return `${icon} ⚠️ Você passou ${centsToBrl(exceededBy)} do limite ${label} (${centsToBrl(limit.limitCents)}). Intervenção sugerida: pause gastos variáveis agora e priorize só o essencial até estabilizar.`;
}

function limitAlertProfileForPlan(planCode: string): {
  includeNear: boolean;
  includeHeadsUp: boolean;
  headsUpRemainingRatio: number;
  headsUpRemainingCents: number;
} {
  if (planCode === 'elite') {
    return { includeNear: true, includeHeadsUp: true, headsUpRemainingRatio: 0.4, headsUpRemainingCents: 50000 };
  }
  if (planCode === 'family') {
    return { includeNear: true, includeHeadsUp: true, headsUpRemainingRatio: 0.28, headsUpRemainingCents: 30000 };
  }
  if (planCode === 'premium') {
    return { includeNear: true, includeHeadsUp: true, headsUpRemainingRatio: 0.2, headsUpRemainingCents: 20000 };
  }
  if (planCode === 'essential') {
    return { includeNear: true, includeHeadsUp: false, headsUpRemainingRatio: 0, headsUpRemainingCents: 0 };
  }
  return { includeNear: false, includeHeadsUp: false, headsUpRemainingRatio: 0, headsUpRemainingCents: 0 };
}

function limitAlertLinesForPlan(
  limits: Array<{
    period: 'daily' | 'weekly' | 'monthly';
    limitCents: number;
    spentCents: number;
    remainingCents: number;
    status: 'ok' | 'near' | 'exceeded';
  }>,
  planCode: string
): string[] {
  const profile = limitAlertProfileForPlan(planCode);
  const lines: string[] = [];

  for (const limit of limits) {
    let targetStatus: 'near' | 'exceeded' | 'headsup' | null = null;

    if (limit.status === 'exceeded') {
      targetStatus = 'exceeded';
    } else if (limit.status === 'near') {
      targetStatus = profile.includeNear ? 'near' : null;
    } else if (profile.includeHeadsUp && limit.limitCents > 0) {
      const remainingRatio = limit.remainingCents / limit.limitCents;
      if (limit.remainingCents <= profile.headsUpRemainingCents || remainingRatio <= profile.headsUpRemainingRatio) {
        targetStatus = 'headsup';
      }
    }

    if (!targetStatus) continue;
    lines.push(limitStatusLine({
      period: limit.period,
      limitCents: limit.limitCents,
      spentCents: limit.spentCents,
      remainingCents: limit.remainingCents,
      status: targetStatus,
      planCode
    }));
  }

  return lines;
}

function decisionQuestionByPlan(planCode: string | null | undefined): string {
  if (planCode === 'elite') {
    return 'Quer que eu já monte um plano de ação para você virar esse cenário hoje?';
  }
  if (planCode === 'family') {
    return 'Quer que eu ajuste um limite da família para proteger esse mês?';
  }
  if (planCode === 'premium') {
    return 'Quer que eu te passe 1 ajuste prático para melhorar isso ainda hoje?';
  }
  return 'Quer que eu te sugira o próximo passo mais inteligente agora?';
}

const MONTHLY_INCOME_PROMPT =
  'Posso te ajudar a ter previsões mais precisas e limites mais inteligentes. Se quiser, me conta sua renda mensal. Se preferir, seguimos sem isso por enquanto.';

function monthlyIncomePromptLine(monthlyIncomeCents: number | null | undefined): string | null {
  return monthlyIncomeCents && monthlyIncomeCents > 0 ? null : MONTHLY_INCOME_PROMPT;
}

async function buildDecisionLines(params: {
  customerId: string;
  now: Date;
  planCode: string;
}): Promise<string[]> {
  const tone = coachingToneByPlan(params.planCode);
  const maxLines = tone === 'max' ? 4 : tone === 'strong' ? 3 : 2;
  const lines: string[] = [];

  const insights = await spendingInsights(params.customerId, params.now, config.defaultTimezone);
  if (insights.monthOverMonthPct !== null) {
    if (insights.monthOverMonthPct >= 18) {
      lines.push(
        tone === 'soft'
          ? `📈 Seus gastos estão ${insights.monthOverMonthPct.toFixed(1)}% acima do mês passado.`
          : `📈 Atenção: seus gastos estão ${insights.monthOverMonthPct.toFixed(1)}% acima do mês passado.`
      );
    } else if (insights.monthOverMonthPct <= -12) {
      lines.push(`📉 Boa: seus gastos estão ${Math.abs(insights.monthOverMonthPct).toFixed(1)}% abaixo do mês passado.`);
    }
  }
  if (insights.topCategory && insights.topCategory.sharePct >= 35) {
    lines.push(`🎯 Seu maior impacto está em ${decorateCategory(insights.topCategory.category)} (${insights.topCategory.sharePct.toFixed(1)}% das despesas do mês).`);
  }

  const forecast = await forecastCashflowMonth(params.customerId, params.now, config.defaultTimezone);
  const daysLeft = Math.max(forecast.daysInMonth - forecast.dayOfMonth, 0);
  if (forecast.projectedNetAfterBillsCents < 0) {
    const deficit = Math.abs(forecast.projectedNetAfterBillsCents);
    const cutPerDay = daysLeft > 0 ? Math.ceil(deficit / daysLeft) : deficit;
    const moneyOutDay = Math.max(daysLeft - Math.ceil(deficit / Math.max(Math.ceil(forecast.projectedExpenseCents / Math.max(forecast.daysInMonth, 1)), 1)), 0);
    if (tone === 'max') {
      lines.push(`🚨 Risco alto: no ritmo atual, vai faltar dinheiro neste mês (${centsToBrl(deficit)} de déficit projetado).`);
    } else if (tone === 'strong' || tone === 'standard') {
      lines.push(`⚠️ Risco: se continuar nesse ritmo, vai faltar dinheiro neste mês (${centsToBrl(deficit)} de déficit projetado).`);
    } else {
      lines.push(`👀 Tendência: no ritmo atual, o mês pode fechar negativo em ${centsToBrl(deficit)}.`);
    }
    if (moneyOutDay > 0) {
      lines.push(
        tone === 'soft'
          ? `🔮 Projeção: o aperto pode começar em cerca de ${moneyOutDay} dia(s).`
          : `🔮 Projeção: mantendo o ritmo atual, o aperto deve começar em cerca de ${moneyOutDay} dia(s).`
      );
    }
    if (cutPerDay > 0 && tone !== 'soft') {
      const actionLine = tone === 'max'
        ? `🛠️ Intervenção recomendada agora: corte ~${centsToBrl(cutPerDay)}/dia até o fechamento do mês para virar o cenário.`
        : `🛠️ Ajuste sugerido: reduza cerca de ${centsToBrl(cutPerDay)} por dia até o fechamento do mês.`;
      lines.push(actionLine);
    }
  } else if (forecast.projectedNetAfterBillsCents > 0) {
    lines.push(`🔮 Previsão de saldo: no ritmo atual, você fecha o mês com ${centsToBrl(forecast.projectedNetAfterBillsCents)} após contas previstas.`);
    if (forecast.projectedNetAfterBillsCents > 0 && lines.length < maxLines && tone !== 'soft') {
      const reserveSuggestion = Math.max(Math.floor(forecast.projectedNetAfterBillsCents * 0.2), 0);
      if (reserveSuggestion > 0) {
        lines.push(`🛠️ Sugestão automática: se reservar ${centsToBrl(reserveSuggestion)} desse saldo, você fortalece sua margem do próximo mês.`);
      }
    }
  } else {
    lines.push('🔮 Previsão de saldo: tendência de fechar o mês no zero a zero. Qualquer gasto fora do padrão pode te puxar para o vermelho.');
  }

  const unique = lines.filter((line, index) => lines.indexOf(line) === index);
  return unique.slice(0, maxLines);
}

function daysBetweenInclusiveIso(startIso: string, endDate: Date): number {
  const [sy, sm, sd] = startIso.split('-').map(Number);
  const start = new Date(Date.UTC(sy || 1970, (sm || 1) - 1, sd || 1));
  const end = new Date(Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), endDate.getUTCDate()));
  const ms = end.getTime() - start.getTime();
  const days = Math.floor(ms / (24 * 60 * 60 * 1000)) + 1;
  return Math.max(days, 1);
}

function normalizeCategoryKey(text: string): string {
  return normalizeHumanText(text)
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const categoryAliasMap: Record<string, string[]> = {
  alimentacao: ['alimentacao', 'lanche', 'comida', 'ifood', 'restaurante', 'esfiha', 'esfirra', 'pizza', 'hamburguer', 'hamburg'],
  transporte: ['transporte', 'uber', 'gasolina', 'combustivel', 'onibus', 'metro'],
  mercado: ['mercado', 'supermercado', 'compra'],
  educacao: ['educacao', 'faculdade', 'curso', 'escola'],
  beleza: ['beleza', 'manicure', 'salao'],
  moradia: ['moradia', 'aluguel', 'condominio', 'casa'],
  shopping: ['shopping'],
  outros: ['outros', 'diversos']
};

function canonicalCategory(term: string): string {
  const normalized = normalizeCategoryKey(term);
  if (!normalized) return 'outros';

  for (const [canonical, aliases] of Object.entries(categoryAliasMap)) {
    if (aliases.some((alias) => normalized === alias || normalized.includes(alias) || alias.includes(normalized))) {
      return canonical;
    }
  }

  return normalized;
}

function parseCategorySpendQuestion(text: string): { categories: string[] } | null {
  const normalized = normalizeHumanText(text);
  const looksLikeSpendQuestion =
    (/\b(quanto|total|soma)\b/.test(normalized) && /\b(gastei|gasto|despesa|despesas)\b/.test(normalized)) ||
    /\bquanto(?:\s+eu)?\s+gastei\b/.test(normalized);

  if (!looksLikeSpendQuestion) {
    return null;
  }

  const patterns = [
    /(?:quanto(?:\s+eu)?\s+gastei(?:\s+(?:de|com|em))?\s+)(.+)$/i,
    /(?:total(?:\s+que)?\s+gastei(?:\s+(?:de|com|em))?\s+)(.+)$/i,
    /(?:soma(?:\s+dos)?\s+gastos?(?:\s+(?:de|com|em))?\s+)(.+)$/i
  ];

  let segment = '';
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match?.[1]) {
      segment = match[1];
      break;
    }
  }

  if (!segment) {
    return null;
  }

  const cleanedSegment = segment
    .replace(/\?/g, ' ')
    .replace(/\b(hoje|ontem|mes|mês|nesse mes|neste mes|desse mes|deste mes)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleanedSegment) {
    return null;
  }

  const rawTerms = cleanedSegment
    .split(/\s*(?:,| e |\/|\+|&)\s*/g)
    .map((term) => term.trim())
    .filter((term) => term.length > 1 && !/^\d+(?:[.,]\d+)?$/.test(term));

  const categories = Array.from(
    new Set(
      rawTerms
        .map((term) => canonicalCategory(term))
        .filter((term) => term.length > 0)
    )
  );

  if (categories.length === 0) {
    return null;
  }

  return { categories };
}

const numberWordsPt: Record<string, number> = {
  zero: 0,
  um: 1,
  uma: 1,
  dois: 2,
  duas: 2,
  tres: 3,
  quatro: 4,
  cinco: 5,
  seis: 6,
  sete: 7,
  oito: 8,
  nove: 9,
  dez: 10,
  onze: 11,
  doze: 12,
  treze: 13,
  quatorze: 14,
  catorze: 14,
  quinze: 15,
  dezesseis: 16,
  dezessete: 17,
  dezoito: 18,
  dezenove: 19,
  vinte: 20,
  trinta: 30,
  quarenta: 40,
  cinquenta: 50,
  sessenta: 60,
  setenta: 70,
  oitenta: 80,
  noventa: 90,
  cem: 100,
  cento: 100,
  duzentos: 200,
  trezentos: 300,
  quatrocentos: 400,
  quinhentos: 500,
  seiscentos: 600,
  setecentos: 700,
  oitocentos: 800,
  novecentos: 900,
  mil: 1000
};

function parsePtWordsInteger(phrase: string): number | null {
  const normalized = normalizeHumanText(phrase);
  const tokens = normalized.split(/\s+/).filter(Boolean);
  let total = 0;
  let found = false;

  for (const token of tokens) {
    if (token === 'e') continue;
    const value = numberWordsPt[token];
    if (value === undefined) {
      return null;
    }
    total += value;
    found = true;
  }

  return found ? total : null;
}

function parseMoneyCentsNatural(text: string): number | null {
  const normalized = text.replace(/\./g, '').replace(/,/g, '.');
  const numericMatch = normalized.match(/(\d+(?:\.\d{1,2})?)/);
  if (numericMatch) {
    const value = Number(numericMatch[1]);
    if (!Number.isNaN(value) && value > 0) {
      return Math.round(value * 100);
    }
  }

  const hasMoneyHint = /\b(real|reais|r\$|rs)\b/i.test(normalizeHumanText(text));
  if (!hasMoneyHint) return null;

  const wordsPattern = new RegExp(`\\b(?:${Object.keys(numberWordsPt).join('|')})(?:\\s+e\\s+(?:${Object.keys(numberWordsPt).join('|')}))*\\b`, 'gi');
  const matches = normalizeHumanText(text).match(wordsPattern);
  if (!matches || matches.length === 0) return null;
  const value = parsePtWordsInteger(matches[matches.length - 1]);
  return value && value > 0 ? value * 100 : null;
}

function parseDateFlexible(text: string, referenceDate = new Date()): string | null {
  const normalized = normalizeHumanText(text);
  const baseUtc = new Date(Date.UTC(
    referenceDate.getUTCFullYear(),
    referenceDate.getUTCMonth(),
    referenceDate.getUTCDate(),
    12,
    0,
    0
  ));

  if (/\b(depois de amanha|depois de amanhã)\b/.test(normalized)) {
    const due = new Date(baseUtc);
    due.setUTCDate(due.getUTCDate() + 2);
    return due.toISOString().slice(0, 10);
  }

  if (/\b(amanha|amanhã)\b/.test(normalized)) {
    const due = new Date(baseUtc);
    due.setUTCDate(due.getUTCDate() + 1);
    return due.toISOString().slice(0, 10);
  }

  if (/\bhoje\b/.test(normalized)) {
    return baseUtc.toISOString().slice(0, 10);
  }

  const explicit = normalized.match(/\b(\d{1,2})[\/.-](\d{1,2})(?:[\/.-](\d{2,4}))?\b/);
  if (explicit) {
    const day = Number(explicit[1]);
    const month = Number(explicit[2]);
    const yearRaw = explicit[3];
    let year = referenceDate.getFullYear();
    if (yearRaw) {
      const y = Number(yearRaw);
      year = yearRaw.length === 2 ? 2000 + y : y;
    }

    const candidate = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
    if (!Number.isNaN(candidate.getTime()) && candidate.getUTCDate() === day && candidate.getUTCMonth() === month - 1) {
      if (!yearRaw && candidate < referenceDate) {
        candidate.setUTCFullYear(candidate.getUTCFullYear() + 1);
      }
      return candidate.toISOString().slice(0, 10);
    }
  }

  const inMonths = normalized.match(/\bem\s+(\d{1,2})\s+mes(?:es)?\b/);
  if (inMonths) {
    const months = Number(inMonths[1]);
    if (!Number.isNaN(months) && months > 0) {
      const due = new Date(referenceDate);
      due.setMonth(due.getMonth() + months);
      return due.toISOString().slice(0, 10);
    }
  }

  return null;
}

function localDateIso(referenceDate: Date, timezone = config.defaultTimezone): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(referenceDate);
  const year = Number(parts.find((part) => part.type === 'year')?.value ?? '1970');
  const month = Number(parts.find((part) => part.type === 'month')?.value ?? '1');
  const day = Number(parts.find((part) => part.type === 'day')?.value ?? '1');
  const safe = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  return safe.toISOString().slice(0, 10);
}

function inferReminderDueDateFromTime(
  dueTime: string,
  referenceDate: Date,
  timezone = config.defaultTimezone
): string {
  const [hourRaw, minuteRaw] = dueTime.split(':');
  const dueHour = Number(hourRaw);
  const dueMinute = Number(minuteRaw);
  const nowParts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(referenceDate);
  const nowHour = Number(nowParts.find((part) => part.type === 'hour')?.value ?? '0');
  const nowMinute = Number(nowParts.find((part) => part.type === 'minute')?.value ?? '0');
  const nowMinutes = (Number.isNaN(nowHour) ? 0 : nowHour * 60) + (Number.isNaN(nowMinute) ? 0 : nowMinute);
  const dueMinutes = (Number.isNaN(dueHour) ? 0 : dueHour * 60) + (Number.isNaN(dueMinute) ? 0 : dueMinute);

  const todayIso = localDateIso(referenceDate, timezone);
  if (dueMinutes >= nowMinutes) return todayIso;

  const [yearRaw, monthRaw, dayRaw] = todayIso.split('-');
  const base = new Date(Date.UTC(Number(yearRaw), Number(monthRaw) - 1, Number(dayRaw), 12, 0, 0));
  base.setUTCDate(base.getUTCDate() + 1);
  return base.toISOString().slice(0, 10);
}

function parseTimeFlexible(text: string): string | null {
  const normalized = normalizeHumanText(text);

  const hhmm = normalized.match(/\b(?:as|a|às)\s*(\d{1,2})[:h](\d{2})\b/);
  if (hhmm) {
    const hour = Number(hhmm[1]);
    const minute = Number(hhmm[2]);
    if (!Number.isNaN(hour) && !Number.isNaN(minute) && hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    }
  }

  const hourOnly = normalized.match(/\b(?:as|a|às)\s*(\d{1,2})\b/);
  if (hourOnly) {
    const hour = Number(hourOnly[1]);
    if (!Number.isNaN(hour) && hour >= 0 && hour <= 23) {
      return `${String(hour).padStart(2, '0')}:00`;
    }
  }

  return null;
}

function parseGoalCommand(text: string, referenceDate = new Date()): {
  title: string;
  targetCents: number;
  deadlineDate: string;
} | null {
  const normalized = normalizeHumanText(text);
  if (!/\bmeta\b/.test(normalized)) return null;
  const explicitCreate = /\b(cria|criar|define|definir|quero|quero criar|estabelecer|meta)\b/.test(normalized);
  const questionLike = text.includes('?') || /\b(como|por que|por quê|funciona|isso mesmo)\b/.test(normalized);
  if (!explicitCreate || questionLike) return null;

  const targetCents = parseMoneyCentsNatural(text);
  const deadlineDate = parseDateFlexible(text, referenceDate);
  if (!targetCents || !deadlineDate) return null;

  const draftTitle = extractGoalTitleFromText(text, normalized);
  const title = (draftTitle ?? 'meta financeira').slice(0, 120);

  return {
    title: title.length > 0 ? title : 'meta financeira',
    targetCents,
    deadlineDate
  };
}

function extractGoalTitleFromText(text: string, normalizedText?: string): string | null {
  const normalized = normalizedText ?? normalizeHumanText(text);
  const paraIndex = normalized.search(/\b(para|pra)\b/);
  if (paraIndex < 0) return null;

  const originalTail = text.slice(paraIndex).replace(/^(para|pra)\s+/i, '').trim();
  const title = originalTail
    .replace(/\s+(ate|até)\s+.+$/i, '')
    .replace(/\s+em\s+\d{1,2}\s+mes(?:es)?\b.*$/i, '')
    .replace(/\s+(nesse|neste|esse|este)\s+mes\b.*$/i, '')
    .replace(/[?!.]+$/g, '')
    .trim();

  if (!title) return null;
  const normalizedTitle = normalizeHumanText(title);
  if (/^(o\s+)?mes$/.test(normalizedTitle) || /^(esse|neste)\s+mes$/.test(normalizedTitle)) {
    return null;
  }

  return title.slice(0, 120);
}

function parseGoalDraft(text: string, referenceDate = new Date()): {
  title: string | null;
  targetCents: number | null;
  deadlineDate: string | null;
} | null {
  const normalized = normalizeHumanText(text);
  if (!/\bmeta\b/.test(normalized)) return null;
  const explicitCreate = /\b(cria|criar|define|definir|quero|quero criar|estabelecer|meta)\b/.test(normalized);
  const questionLike = text.includes('?') || /\b(como|por que|por quê|funciona|isso mesmo)\b/.test(normalized);
  if (!explicitCreate || questionLike) return null;

  return {
    title: extractGoalTitleFromText(text, normalized),
    targetCents: parseMoneyCentsNatural(text),
    deadlineDate: parseDateFlexible(text, referenceDate)
  };
}

function isGoalProgressRequest(text: string): boolean {
  const normalized = normalizeHumanText(text);
  return /\b(minhas metas|meu progresso|progresso da meta|status da meta|como esta minha meta)\b/.test(normalized);
}

function parseReminderCreateCommand(text: string, referenceDate = new Date()): {
  title: string;
  dueDate: string;
  dueTime: string | null;
  remindDaysBefore: number;
  remindMinutesBefore: number | null;
  recurrence: 'none' | 'monthly';
  amountCents: number | null;
  needsLeadTimeConfirmation: boolean;
  suggestedRemindMinutesBefore: number | null;
} | null {
  const normalized = normalizeHumanText(text);
  const reminderTopicSignal = /\b(lembrete|vencimento|conta|lembre|lembrar|lembra|nao esquecer|não esquecer)\b/.test(normalized);
  if (!reminderTopicSignal) return null;
  const explicitCreate = /\b(cria|criar|adiciona|adicionar|define|definir|quero|cadastrar|lembre|lembra|lembrar|me lembre)\b/.test(normalized);
  const questionLike = text.includes('?') || /\b(como|por que|por quê|funciona|isso mesmo|vai me lembrar|você vai me lembrar|voce vai me lembrar)\b/.test(normalized);
  const strongCreateSignal = /\b(quero\s+(um\s+)?lembrete|quero\s+criar\s+lembrete|quero\s+anotar\s+(um\s+)?lembrete|cria\s+(um\s+)?lembrete|adiciona\s+(um\s+)?lembrete|anota\s+(um\s+)?lembrete|anotar\s+(um\s+)?lembrete|cadastro\s+de\s+lembrete|cadastrar\s+lembrete|me\s+lembre|me\s+lembra)\b/.test(normalized);
  if (!explicitCreate) return null;
  if (questionLike && !strongCreateSignal) return null;

  const recurrence: 'none' | 'monthly' = /\b(todo mes|todo mês|mensal)\b/.test(normalized) ? 'monthly' : 'none';
  const dueTime = parseTimeFlexible(text);
  const dayOnly = normalized.match(/\bdia\s+(\d{1,2})\b/);
  let dueDate = parseDateFlexible(text, referenceDate);
  if (!dueDate && recurrence === 'monthly' && dayOnly) {
    const day = Number(dayOnly[1]);
    if (day >= 1 && day <= 31) {
      const base = new Date(referenceDate);
      base.setDate(day);
      if (base < referenceDate) {
        base.setMonth(base.getMonth() + 1);
      }
      dueDate = base.toISOString().slice(0, 10);
    }
  }
  if (!dueDate && dueTime && strongCreateSignal) {
    dueDate = inferReminderDueDateFromTime(dueTime, referenceDate, config.defaultTimezone);
  }
  if (!dueDate) return null;

  const rememberDirectMatch = text.match(/\b(?:me\s+lembre|me\s+lembra|lembrar)\s+(?:de|que)\s+(.+?)(?:[?!.]|$)/i);
  const titleMatch = text.match(/\b(?:lembrete|conta|vencimento)\s+(?:de\s+|para\s+)?(.+?)(?:\s+(?:vence|vencimento|dia|em)\b|$)/i);
  let title = sanitizeReminderTitleCandidate((rememberDirectMatch?.[1] ?? '').trim());
  if (!title) {
    title = sanitizeReminderTitleCandidate((titleMatch?.[1] ?? '').trim());
  }
  if (!title) {
    const fallback = text
      .replace(/^.*?\b(?:me\s+lembre|me\s+lembra|lembrete|lembrar|lembra|vencimento|conta)\b\s*(?:de|que)?\s*/i, '')
      .replace(/\b(amanha|amanhã|hoje|depois de amanha|depois de amanhã)\b/gi, ' ')
      .replace(/\b(\d{1,2}[\/.-]\d{1,2}(?:[\/.-]\d{2,4})?|dia\s+\d{1,2}|lembrar\s+\d{1,2}\s+dias?\s+antes)\b/gi, ' ')
      .replace(/\b(?:as|a|às)\s*\d{1,2}(?::\d{2})?\s*(?:h|hs|hora|horas)?\b/gi, ' ')
      .replace(/\b(preciso|tenho que|quero)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    title = sanitizeReminderTitleCandidate(fallback);
  }
  title = title.slice(0, 120);

  const beforeMatch = normalized.match(/\b(\d{1,2})\s+dias?\s+antes\b/);
  const beforeMinutesMatch = normalized.match(/\b(\d{1,3})\s*(?:min|mins|minuto|minutos)\s+antes\b/);
  const explicitLeadByDays = beforeMatch ? Math.min(Math.max(Number(beforeMatch[1]), 0), 30) : null;
  const explicitLeadByMinutes = beforeMinutesMatch
    ? Math.min(Math.max(Number(beforeMinutesMatch[1]), 0), 240)
    : null;
  const defaultTimedLeadMinutes = dueTime ? 10 : null;

  const remindMinutesBefore = explicitLeadByMinutes ?? defaultTimedLeadMinutes;
  const remindDaysBefore = explicitLeadByDays ?? (remindMinutesBefore !== null ? 0 : 2);
  const needsLeadTimeConfirmation = Boolean(dueTime) && explicitLeadByDays === null && explicitLeadByMinutes === null;

  const hasExplicitMoney = /\b(r\$|reais|real|rs|valor)\b/i.test(normalized);
  const amountCents = hasExplicitMoney ? parseMoneyCentsNatural(text) : null;

  return {
    title: title.length > 0 ? title : 'conta',
    dueDate,
    dueTime,
    remindDaysBefore,
    remindMinutesBefore,
    recurrence,
    amountCents: amountCents ?? null,
    needsLeadTimeConfirmation,
    suggestedRemindMinutesBefore: needsLeadTimeConfirmation ? defaultTimedLeadMinutes : null
  };
}

function sanitizeReminderTitleCandidate(candidate: string): string {
  if (!candidate) return '';
  return candidate
    .replace(/\b(consigo|consegue|pode|poderia)\s+me\s+lembrar\s+(?:de|que)\b/gi, ' ')
    .replace(/\bme\s+lembrar\s+(?:de|que)\b/gi, ' ')
    .replace(/\b(amanha|amanhã|hoje|depois de amanha|depois de amanhã)\b/gi, ' ')
    .replace(/\b(?:as|a|às)\s*\d{1,2}(?::\d{2})?\s*(?:h|hs|hora|horas)?\b/gi, ' ')
    .replace(/\b(\d{1,2}[\/.-]\d{1,2}(?:[\/.-]\d{2,4})?|dia\s+\d{1,2})\b/gi, ' ')
    .replace(/^(para|pra)\s+/i, '')
    .replace(/[?!.]+$/g, '')
    .replace(/^[,:;\-\s]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isReminderListRequest(text: string): boolean {
  const normalized = normalizeHumanText(text);
  return /\b(meus lembretes|contas a vencer|vencimentos|lembretes)\b/.test(normalized);
}

function isReminderCreateIntentEvenIfMissingFields(text: string): boolean {
  const normalized = normalizeHumanText(text);
  const hasReminderSignal = /\b(lembrete|vencimento|conta|lembre|lembrar|lembra|nao esquecer|não esquecer)\b/.test(normalized);
  if (!hasReminderSignal) return false;

  const explicitCreate = /\b(cria|criar|adiciona|adicionar|define|definir|quero|cadastrar|lembre|lembra|lembrar|me lembre|me lembra)\b/.test(normalized);
  if (!explicitCreate) return false;

  const strongCreateSignal = /\b(quero\s+(um\s+)?lembrete|quero\s+criar\s+lembrete|quero\s+anotar\s+(um\s+)?lembrete|cria\s+(um\s+)?lembrete|adiciona\s+(um\s+)?lembrete|anota\s+(um\s+)?lembrete|anotar\s+(um\s+)?lembrete|cadastro\s+de\s+lembrete|cadastrar\s+lembrete|me\s+lembre|me\s+lembra)\b/.test(normalized);
  const questionLike = text.includes('?') || /\b(como|por que|por quê|funciona|isso mesmo|vai me lembrar|você vai me lembrar|voce vai me lembrar)\b/.test(normalized);
  if (questionLike && !strongCreateSignal) return false;

  return true;
}

function isReminderCreateConfirmationFromContext(text: string): boolean {
  const normalized = normalizeHumanText(text);
  return (
    /\b(criar|cria|adicionar|adiciona|cadastrar)\b/.test(normalized) &&
    /\b(esse lembrete|este lembrete|isso|esse aviso|esse)\b/.test(normalized)
  );
}

function isShortAffirmativeForAction(text: string): boolean {
  const normalized = normalizeHumanText(text).replace(/[!?.,]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!normalized) return false;
  if (normalized.length > 32) return false;
  return /^(quero|sim|isso|isso mesmo|pode|pode sim|vamos|fechado|manda ver|ok|blz|beleza)$/.test(normalized);
}

function isDeleteLastOfferFromAssistant(lastAssistantMessage: string | null | undefined): boolean {
  if (!lastAssistantMessage) return false;
  const normalized = normalizeHumanText(lastAssistantMessage);
  const offeredDeleteLast =
    /\b(apagar o ultimo gasto|apague o ultimo gasto|apagar o ultimo lancamento|apague o ultimo lancamento)\b/.test(normalized) ||
    /\b(comecar pelo ultimo lancamento|comecar pelo ultimo lançamento|fazer isso agora)\b/.test(normalized);
  const cameFromDeleteAllFallback = /\b(nao tenho como apagar todo o historico|não tenho como apagar todo o histórico)\b/.test(normalized);
  return offeredDeleteLast && cameFromDeleteAllFallback;
}

function shouldConfirmDeleteLastFromContext(params: {
  text: string;
  lastAssistantMessage?: string | null;
}): boolean {
  return isShortAffirmativeForAction(params.text) && isDeleteLastOfferFromAssistant(params.lastAssistantMessage);
}

function extractReminderDraftFromRecentInboundMessages(
  messages: Array<{ direction: 'inbound' | 'outbound'; message: string }>,
  currentMessage: string,
  referenceDate: Date
): ReturnType<typeof parseReminderCreateCommand> {
  let skippedCurrent = false;
  let seenFirstOutboundAfterCurrent = false;
  const contextWindowCandidates: string[] = [];
  const fallbackCandidates: string[] = [];

  for (const entry of messages) {
    if (entry.direction === 'inbound') {
      if (!skippedCurrent && normalizeReplyForComparison(entry.message) === normalizeReplyForComparison(currentMessage)) {
        skippedCurrent = true;
        continue;
      }

      fallbackCandidates.push(entry.message);
      if (seenFirstOutboundAfterCurrent) {
        contextWindowCandidates.push(entry.message);
      }
      continue;
    }

    if (!seenFirstOutboundAfterCurrent) {
      seenFirstOutboundAfterCurrent = true;
      continue;
    }

    // Limit search to the immediate previous conversational turn.
    if (contextWindowCandidates.length > 0) {
      break;
    }
  }

  const orderedCandidates = contextWindowCandidates.length > 0
    ? contextWindowCandidates
    : fallbackCandidates;

  for (const candidate of orderedCandidates) {
    const normalizedEntry = normalizeHumanText(candidate);
    const reminderSignal = /\b(lembrete|lembrar|lembra|me lembre|me lembra|vencimento|conta)\b/.test(normalizedEntry);
    if (!reminderSignal) continue;
    const parsed = parseReminderCreateCommand(candidate, referenceDate);
    if (parsed) return parsed;

    // If the newest candidate looks like an incomplete creation command,
    // do not fallback to older reminder drafts (prevents stale reminder reuse).
    const explicitButIncomplete =
      isReminderCreateIntentEvenIfMissingFields(candidate) ||
      isReminderCreateConfirmationFromContext(candidate);
    if (explicitButIncomplete) return null;
  }
  return null;
}

function isReminderStatusRequest(text: string): boolean {
  const normalized = normalizeHumanText(text);
  const hasReminderSignal = /\b(lembrete|lembrar|lembra|vencimento|conta)\b/.test(normalized);
  if (!hasReminderSignal) return false;
  const hasQuestionSignal = text.includes('?') || /\b(vai me lembrar|voce vai me lembrar|você vai me lembrar|quando voce lembra|quando você lembra|amanha voce|amanhã você|esta anotado|está anotado)\b/.test(normalized);
  return hasQuestionSignal;
}

function parseReminderLeadUpdateCommand(text: string): {
  remindDaysBefore: number;
  remindMinutesBefore: number | null;
} | null {
  const normalized = normalizeHumanText(text);
  const hasLeadSignal = /\b(aviso|lembrete|lembrar|antecedencia|antecedência)\b/.test(normalized);
  if (!hasLeadSignal) return null;

  // If message contains a due date ("vence 13/05"), it's a CREATE intent, not a lead-time update
  const hasDueDateCreate = /\b(vence|vencimento)\b/.test(normalized) && /\d{1,2}[\/.-]\d{1,2}/.test(text);
  if (hasDueDateCreate) return null;

  const minutesMatch = normalized.match(/\b(\d{1,3})\s*(?:min|mins|minuto|minutos)\s+antes\b/);
  if (minutesMatch) {
    const minutes = Math.min(Math.max(Number(minutesMatch[1]), 0), 240);
    return {
      remindDaysBefore: 0,
      remindMinutesBefore: minutes
    };
  }

  const daysMatch = normalized.match(/\b(\d{1,2})\s+dias?\s+antes\b/);
  if (daysMatch) {
    const days = Math.min(Math.max(Number(daysMatch[1]), 0), 30);
    return {
      remindDaysBefore: days,
      remindMinutesBefore: null
    };
  }

  return null;
}

function getPastDateRegistrationHint(text: string): string | null {
  const normalized = normalizeHumanText(text);
  const hasPastDayRef =
    /\b(segunda|terca|terça|quarta|quinta|sexta|sabado|sábado|domingo)(\s+passad[ao]|\s+da semana passada)?\b/i.test(normalized) ||
    /\b(semana passada|anteontem|dias? atras|dias? atrás)\b/.test(normalized);
  const hasHowToQuestion =
    /\b(como|tem como|consegue|posso|da pra|dá pra|e possivel|é possível|consigo)\b/.test(normalized) &&
    /\b(registrar|anotar|lancar|lançar|colocar|adicionar|gasto|despesa)\b/.test(normalized);
  const isQuestion = text.includes('?') || /\b(tem como|posso|consigo|da pra|dá pra)\b/.test(normalized);
  if (!hasPastDayRef || !hasHowToQuestion || !isQuestion) return null;
  const dayMatch = text.match(/\b(segunda|ter[cç]a|quarta|quinta|sexta|s[aá]bado|domingo)(?:\s+passad[ao])?\b/i);
  const weekMatch = text.match(/\b(semana passada|anteontem)\b/i);
  return dayMatch?.[0] ?? weekMatch?.[0] ?? 'quinta passada';
}

type ReminderLeadTargetDecision =
  | { type: 'none' }
  | {
      type: 'update';
      reminder: {
        id: string;
        title: string;
        effectiveDueDate: string;
        dueTime: string | null;
      };
      reason: 'focused' | 'single-active';
    }
  | {
      type: 'ambiguous';
      options: Array<{
        id: string;
        title: string;
        effectiveDueDate: string;
        dueTime: string | null;
      }>;
    };

type ReminderLeadCandidate = {
  id: string;
  title: string;
  effectiveDueDate: string;
  dueTime: string | null;
};

type ReminderDraft = Exclude<ReturnType<typeof parseReminderCreateCommand>, null>;

function normalizeReminderTitleForMatch(value: string): string {
  return normalizeHumanText(value)
    .replace(/\b(para|pra|de|do|da|dos|das|o|a|os|as|um|uma|uns|umas|que)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function reminderTitlesLikelyMatch(left: string, right: string): boolean {
  const normalizedLeft = normalizeReminderTitleForMatch(left);
  const normalizedRight = normalizeReminderTitleForMatch(right);
  if (!normalizedLeft || !normalizedRight) return false;
  if (normalizedLeft === normalizedRight) return true;
  if (normalizedLeft.length >= 6 && normalizedRight.includes(normalizedLeft)) return true;
  if (normalizedRight.length >= 6 && normalizedLeft.includes(normalizedRight)) return true;
  return false;
}

function findReminderByDraft(
  activeReminders: ReminderLeadCandidate[],
  draft: ReminderDraft
): ReminderLeadCandidate | null {
  const exact = activeReminders.find((item) => {
    const sameDate = item.effectiveDueDate === draft.dueDate;
    const sameTime = (item.dueTime ?? null) === (draft.dueTime ?? null);
    const sameTitle = reminderTitlesLikelyMatch(item.title, draft.title);
    return sameDate && sameTime && sameTitle;
  });
  if (exact) return exact;

  const relaxed = activeReminders.find((item) => {
    const sameDate = item.effectiveDueDate === draft.dueDate;
    const sameTitle = reminderTitlesLikelyMatch(item.title, draft.title);
    return sameDate && sameTitle;
  });
  if (relaxed) return relaxed;

  return null;
}

function selectReminderForLeadUpdate(params: {
  activeReminders: ReminderLeadCandidate[];
  focusedReminderId: string | null;
}): ReminderLeadTargetDecision {
  const { activeReminders, focusedReminderId } = params;
  if (activeReminders.length === 0) {
    return { type: 'none' };
  }

  if (focusedReminderId) {
    const focused = activeReminders.find((item) => item.id === focusedReminderId);
    if (focused) {
      return { type: 'update', reminder: focused, reason: 'focused' };
    }
  }

  if (activeReminders.length === 1) {
    return {
      type: 'update',
      reminder: activeReminders[0],
      reason: 'single-active'
    };
  }

  return {
    type: 'ambiguous',
    options: activeReminders.slice(0, 5)
  };
}

function isInsightsRequest(text: string): boolean {
  const normalized = normalizeHumanText(text);
  return /\b(insights|analise|análise|comportamento|como estou gastando)\b/.test(normalized);
}

function isRecurringRequest(text: string): boolean {
  const normalized = normalizeHumanText(text);
  return /\b(assinaturas|recorrentes|gastos recorrentes|cobrancas recorrentes|cobranças recorrentes)\b/.test(normalized);
}

function isCashflowForecastRequest(text: string): boolean {
  const normalized = normalizeHumanText(text);
  return /\b(previsao de saldo|previsão de saldo|fluxo de caixa|saldo projetado|projecao do mes|projeção do mês)\b/.test(normalized);
}

function parseInvestmentSimulatorCommand(text: string): {
  monthlyContributionCents: number;
  months: number;
  monthlyRatePct: number;
} | null {
  const normalized = normalizeHumanText(text);
  if (!/\b(simular|simulador|investimento|renderia|renda fixa)\b/.test(normalized)) return null;

  const monthlyContributionCents = parseMoneyCentsNatural(text);
  if (!monthlyContributionCents) return null;

  const monthsMatch = normalized.match(/\b(\d{1,3})\s*(?:mes|meses)\b/);
  const yearsMatch = normalized.match(/\b(\d{1,2})\s*(?:ano|anos)\b/);
  const months = monthsMatch
    ? Number(monthsMatch[1])
    : yearsMatch
      ? Number(yearsMatch[1]) * 12
      : 12;
  if (!months || Number.isNaN(months) || months <= 0) return null;

  const rateMatch = normalized.match(/\b(\d+(?:[.,]\d+)?)\s*%\s*(?:ao mes|a.m|am|mensal|ao mês)\b/);
  const monthlyRatePct = rateMatch
    ? Number(rateMatch[1].replace(',', '.'))
    : 0.8;

  return {
    monthlyContributionCents,
    months,
    monthlyRatePct: Number.isNaN(monthlyRatePct) ? 0.8 : monthlyRatePct
  };
}

function blockMessage(access: {
  reason: string;
  amountDueCents?: number;
  dueDate?: string | null;
  trialEndDate?: string | null;
  planCode?: PlanCode;
  planName?: string;
  monthlyMessageLimit?: number;
  messagesUsedThisMonth?: number;
}, context?: {
  now?: Date;
  customerName?: string | null;
  selectedPlanCode?: PlanCode | null;
}): string {
  const hello = context?.now ? greetingByTime(context.now) : 'Olá';
  const namePart = context?.customerName ? `, ${context.customerName}` : '';
  const plan = getPlanDefinition(access.planCode ?? 'essential');
  const selectedPlanLine = context?.selectedPlanCode
    ? `Perfeito${namePart}, deixei o plano ${getPlanDefinition(context.selectedPlanCode).name} pré-selecionado para sua ativação.`
    : null;

  if (access.reason === 'monthly_message_limit_reached') {
    const planName = access.planName ?? 'seu plano atual';
    const limit = access.monthlyMessageLimit ?? 0;
    const used = access.messagesUsedThisMonth ?? 0;
    return [
      `Você atingiu o limite mensal de mensagens do plano ${planName}. ⚠️`,
      `Uso atual: ${used}/${limit} mensagens neste mês.`,
      'Para continuar agora, faça upgrade do plano.',
      'Se quiser, eu te mostro os planos disponíveis e a diferença de limite.'
    ].join('\n');
  }

  if (access.reason === 'trial_expired') {
    const endDate = access.trialEndDate
      ? new Date(`${access.trialEndDate}T12:00:00.000Z`).toLocaleDateString('pt-BR')
      : 'hoje';
    const activationLine = plan.setupFeeCents > 0
      ? `Para continuar no ${plan.name}, a ativação é ${centsToBrl(access.amountDueCents ?? plan.setupFeeCents)} (única).`
      : null;
    return [
      `${hello}${namePart}! Seu período de teste terminou. ⏳`,
      `Fim do teste: ${endDate}.`,
      ...(selectedPlanLine ? [selectedPlanLine] : []),
      ...(activationLine ? [activationLine] : []),
      `Mensalidade do ${plan.name}: ${centsToBrl(plan.monthlyFeeCents)}/mês.`,
      'Se quiser, eu comparo os planos para você decidir com segurança antes do Pix.'
    ].join('\n');
  }

  if (access.reason === 'setup_payment_required') {
    const hasSetupFee = plan.setupFeeCents > 0;
    const activationLine = hasSetupFee
      ? `Ativação desse plano: ${centsToBrl(access.amountDueCents ?? plan.setupFeeCents)} (pagamento único).`
      : null;
    return [
      `${hello}${namePart}! Vi que seu acesso ainda não está ativo. 🙂`,
      'No seu cadastro ainda não há plano ativo liberado.',
      `Plano pré-selecionado no momento: ${plan.name}.`,
      ...(selectedPlanLine ? [selectedPlanLine] : []),
      ...(activationLine ? [activationLine] : []),
      `Mensalidade do ${plan.name}: ${centsToBrl(plan.monthlyFeeCents)}/mês.`,
      'Se quiser, eu te explico a diferença entre os planos e te recomendo o melhor para seu perfil.',
      'Quando o Pix confirmar, eu libero automático e já te dou boas-vindas no seu plano.'
    ].join('\n');
  }

  if (access.reason === 'monthly_payment_overdue') {
    const dueDate = access.dueDate ? new Date(`${access.dueDate}T12:00:00.000Z`).toLocaleDateString('pt-BR') : 'data não informada';
    return [
      `${hello}${namePart}! Seu plano está com mensalidade em atraso. ⚠️`,
      `Vencimento: ${dueDate}`,
      `Plano: ${plan.name}.`,
      `Valor atual da mensalidade: ${centsToBrl(access.amountDueCents ?? plan.monthlyFeeCents)}.`,
      'Assim que o pagamento for confirmado, o bot volta a responder imediatamente.'
    ].join('\n');
  }

  if (access.reason === 'canceled') {
    return `${hello}${namePart}! Sua assinatura está cancelada. Para reativar, regularize o plano.`;
  }

  return `${hello}${namePart}! Seu acesso está inativo no momento. Fale comigo para regularizar seu plano.`;
}

function isOnboardingQuestion(text: string): boolean {
  const normalized = normalizeHumanText(text);
  return (
    /\b(como funciona|como que funciona|me explica|explica direito|como assinar|como contratar|como ativa|como ativar)\b/.test(normalized) ||
    /\b(comandos|o que pode fazer|o que voce pode fazer|o que vc pode fazer|como devo usar|como usar)\b/.test(normalized) ||
    /\b(quero organizar|minha vida financeira|me organizar financeiramente)\b/.test(normalized) ||
    /\b(quanto custa|qual valor|preco|preço|planos?)\b/.test(normalized) ||
    /\b(o que voce faz|o que vc faz|como voce me ajuda|como vc me ajuda)\b/.test(normalized)
  );
}

function isPricingQuestion(text: string): boolean {
  const normalized = normalizeHumanText(text);
  return /\b(quanto custa|qual valor|preco|preço|planos?|mensalidade|upgrade|assinatura)\b/.test(normalized);
}

function isPlanConsultingRequest(text: string): boolean {
  const normalized = normalizeHumanText(text);
  return /\b(detalhes? do plano|diferenca|diferença|comparar|comparativo|qual melhor plano|qual plano|plano ideal|duvida de plano|dúvida de plano|me explica o plano|me explica.*plano|como funciona.*plano|como funciona o plano|plano familia|plano essencial|plano premium|plano elite|sobre o plano|entender o plano|o que inclui|o que tem no plano|o que o plano|funcionalidade do plano|beneficio do plano|benefício do plano|me fala do plano|fala sobre o plano|conta sobre o plano)\b/.test(normalized);
}

function isActivationRequest(text: string): boolean {
  const normalized = normalizeHumanText(text);
  return /\b(quero assinar|quero contratar|quero ativar|quero pagar|quero comecar|vamos comecar|me manda pix|enviar pix|gerar pix)\b/.test(normalized);
}

function detectExplicitPlanChoice(text: string): PlanCode | null {
  const normalized = normalizeHumanText(text);
  const mentioned = extractMentionedPlans(text);
  if (mentioned.length !== 1) return null;

  if (
    /\b(quero|vou de|prefiro|escolho|me coloca|me põe|me poe|assinar|contratar|ativar|plano|upgrade)\b/.test(normalized) ||
    /^((plano\s+)?(gratuito|gratis|free|essencial|essential|premium|familia|família|elite))$/.test(normalized.trim())
  ) {
    return mentioned[0];
  }

  return null;
}

function aiTierLabel(tier: 'basic' | 'assistida' | 'avancada' | 'colaborativa' | 'proativa'): string {
  const labels: Record<typeof tier, string> = {
    basic: 'IA básica',
    assistida: 'IA assistida',
    avancada: 'IA avançada',
    colaborativa: 'IA colaborativa',
    proativa: 'IA proativa'
  };
  return labels[tier];
}

function proactiveLevelLabel(level: 'none' | 'standard' | 'advanced' | 'max'): string {
  if (level === 'max') return 'máxima';
  if (level === 'advanced') return 'alta';
  if (level === 'standard') return 'média';
  return 'básica';
}

function planCatalogLines(): string[] {
  return listPlanDefinitions().map((plan) => {
    const monthly = plan.monthlyFeeCents > 0 ? `${centsToBrl(plan.monthlyFeeCents)}/mês` : 'R$ 0,00';
    const setup = plan.setupFeeCents > 0 ? ` + entrada ${centsToBrl(plan.setupFeeCents)}` : '';
    return `• ${plan.name}: ${monthly}${setup} | ${plan.monthlyMessageLimit} msg/mês | ${aiTierLabel(plan.aiTier)}`;
  });
}

function planCatalogSummaryInline(): string {
  return listPlanDefinitions()
    .map((plan) => {
      const parts = [
        `${plan.name}(${plan.monthlyMessageLimit} msg/mês`,
        `mensal ${centsToBrl(plan.monthlyFeeCents)}`,
        `${aiTierLabel(plan.aiTier)}`,
        `proatividade ${proactiveLevelLabel(plan.proactiveLevel)}`
      ];
      if (plan.code === 'family') {
        parts.push(`3 membros inclusos, membro extra R$29,90/mês`);
      }
      return `${parts.join(', ')})`;
    })
    .join(' | ');
}

function extractMentionedPlans(text: string): PlanCode[] {
  const normalized = normalizeHumanText(text);
  const found: PlanCode[] = [];

  if (/\b(gratuito|gratis|free)\b/.test(normalized)) found.push('free');
  if (/\b(essencial|essential)\b/.test(normalized)) found.push('essential');
  if (/\b(premium)\b/.test(normalized)) found.push('premium');
  if (/\b(familia|família)\b/.test(normalized)) found.push('family');
  if (/\b(elite)\b/.test(normalized)) found.push('elite');

  return found.filter((plan, index) => found.indexOf(plan) === index);
}

function planFeatureHighlights(planCode: PlanCode): string {
  const plan = getPlanDefinition(planCode);
  if (plan.features.length === 0) return 'recursos básicos';
  return plan.features.map((item) => featureLabel(item)).slice(0, 5).join(', ');
}

function planCommercialPitch(planCode: PlanCode): {
  audience: string;
  promise: string;
  cta: string;
} {
  if (planCode === 'free') {
    return {
      audience: 'para quem quer testar sem custo e sentir a rotina da Iara',
      promise: 'controle básico de gastos, metas e score para começar no seu ritmo',
      cta: 'Se quiser evoluir depois, eu te mostro o Essencial em 1 minuto.'
    };
  }
  if (planCode === 'essential') {
    return {
      audience: 'para uso pessoal diário com foco em organização',
      promise: 'você recebe estrutura, lembretes e acompanhamento consistente sem complexidade',
      cta: 'Se quiser, eu já ativo o Essencial e te passo o próximo passo.'
    };
  }
  if (planCode === 'premium') {
    return {
      audience: 'para quem quer análise de verdade e decisões mais inteligentes',
      promise: 'insights, previsão de saldo e simulador para parar de decidir no escuro',
      cta: 'Se você busca performance financeira, o Premium é o melhor custo-benefício.'
    };
  }
  if (planCode === 'family') {
    return {
      audience: 'para casal/família que quer visão compartilhada do dinheiro',
      promise: 'gestão em grupo com limites familiares, metas coletivas e visão única',
      cta: 'Quer que eu te explique como configurar o Família com os membros?'
    };
  }
  return {
    audience: 'para quem quer a experiência máxima da Iara com IA proativa',
    promise: 'camada completa de previsões, alertas fortes e Open Banking para operação avançada',
    cta: 'Se quiser o topo de desempenho, eu te coloco no Elite agora.'
  };
}

function planReadyText(planCode: PlanCode): string {
  const plan = getPlanDefinition(planCode);
  const pitch = planCommercialPitch(planCode);
  const monthly = plan.monthlyFeeCents > 0 ? `${centsToBrl(plan.monthlyFeeCents)}/mês` : 'R$ 0,00';
  const setup = plan.setupFeeCents > 0 ? ` + ${centsToBrl(plan.setupFeeCents)} de ativação` : '';
  return [
    `📌 ${plan.name} — ${monthly}${setup}`,
    `Para quem é: ${pitch.audience}.`,
    `O que entrega: ${pitch.promise}.`,
    `Limites e IA: ${plan.monthlyMessageLimit} msg/mês | ${aiTierLabel(plan.aiTier)} | proatividade ${proactiveLevelLabel(plan.proactiveLevel)}.`,
    `Recursos-chave: ${planFeatureHighlights(planCode)}.`,
    pitch.cta
  ].join('\n');
}

function planComparisonMessage(planA: PlanCode, planB: PlanCode): string {
  const a = getPlanDefinition(planA);
  const b = getPlanDefinition(planB);
  const extras = b.features.filter((item) => !a.features.includes(item)).map((item) => featureLabel(item));
  const higher = b.monthlyFeeCents >= a.monthlyFeeCents ? b : a;
  const lower = higher.code === a.code ? b : a;
  const extrasText = extras.length > 0 ? extras.join(', ') : 'principalmente mais capacidade de uso';

  return [
    `Comparativo direto: ${a.name} x ${b.name} 👇`,
    `• ${a.name}: ${centsToBrl(a.monthlyFeeCents)}/mês | ${a.monthlyMessageLimit} msg/mês | ${aiTierLabel(a.aiTier)}.`,
    `• ${b.name}: ${centsToBrl(b.monthlyFeeCents)}/mês | ${b.monthlyMessageLimit} msg/mês | ${aiTierLabel(b.aiTier)}.`,
    `${higher.name} adiciona: ${extrasText}.`,
    `Se você quer mais economia e uso pessoal, tende a ficar melhor no ${lower.name}.`,
    `Se você quer mais automação e profundidade, tende a ficar melhor no ${higher.name}.`,
    'Quer que eu te recomende um dos dois com base no seu perfil de uso?'
  ].join('\n');
}

function planRecommendationByProfile(text: string): string | null {
  const normalized = normalizeHumanText(text);
  if (!/\b(qual melhor|qual plano|me recomenda|recomendacao|recomendação|nao sei qual|não sei qual|indeciso)\b/.test(normalized)) {
    return null;
  }

  if (/\b(casal|familia|família|filho|esposa|marido|grupo)\b/.test(normalized)) {
    return 'Pelo seu contexto, o plano Família tende a ser o ideal: gestão compartilhada, mais mensagens e recursos colaborativos. Quer que eu te detalhe o Família?';
  }
  if (/\b(empresa|time|equipe|negocio|negócio|clientes)\b/.test(normalized)) {
    return 'Para operação com volume e decisões rápidas, o Elite tende a ser o ideal. Ele entrega IA mais proativa e teto de uso bem maior. Quer que eu abra Premium x Elite para você comparar?';
  }
  if (/\b(testar|comecar|começar|inicio|início|basico|básico|economizar)\b/.test(normalized)) {
    return 'Para começar com segurança de custo, vá de Essencial. Se quiser análise mais pesada, o próximo passo é o Premium. Quer que eu te mostre a diferença em 30 segundos?';
  }

  return [
    'Te recomendo assim, de forma prática:',
    '• Essencial: rotina pessoal com custo menor;',
    '• Premium: decisões com mais inteligência e previsão;',
    '• Família: gestão compartilhada;',
    '• Elite: máxima automação e profundidade.',
    'Me diz seu cenário (pessoal, casal/família ou operação com muitos clientes) e eu te indico o plano ideal.'
  ].join('\n');
}

function planAdvisorMessage(params: {
  text: string;
  customerName?: string | null;
  currentPlanName?: string;
  messagesUsedThisMonth?: number;
  monthlyMessageLimit?: number;
}): string {
  const helloName = params.customerName ? `, ${params.customerName}` : '';
  const mentioned = extractMentionedPlans(params.text);
  const recommendation = planRecommendationByProfile(params.text);
  if (recommendation) {
    return recommendation;
  }

  if (mentioned.length >= 2) {
    return planComparisonMessage(mentioned[0], mentioned[1]);
  }

  if (mentioned.length === 1) {
    const currentUsage = params.currentPlanName
      ? `Seu plano atual: ${params.currentPlanName} (${params.messagesUsedThisMonth ?? 0}/${params.monthlyMessageLimit ?? 0} msg no mês).`
      : null;
    return [
      `Perfeito${helloName}!`,
      planReadyText(mentioned[0]),
      ...(currentUsage ? [currentUsage] : []),
      'Se quiser, eu também comparo esse plano com outro para te ajudar a decidir sem dúvida.'
    ].join('\n');
  }

  return [
    `Perfeito${helloName}! Aqui está o guia rápido de planos da Iara:`,
    '',
    planReadyText('free'),
    '',
    planReadyText('essential'),
    '',
    planReadyText('premium'),
    '',
    planReadyText('family'),
    '',
    planReadyText('elite'),
    '',
    'Se quiser, me diga: "compara premium e elite" ou "qual melhor plano para mim?".'
  ].join('\n');
}

function pricingMessage(params: {
  customerName?: string | null;
  currentPlanName?: string;
  messagesUsedThisMonth?: number;
  monthlyMessageLimit?: number;
}): string {
  const usageLine = params.currentPlanName
    ? `Seu plano atual: ${params.currentPlanName} (${params.messagesUsedThisMonth ?? 0}/${params.monthlyMessageLimit ?? 0} msg usadas no mês).`
    : null;

  return [
    `Perfeito${params.customerName ? `, ${params.customerName}` : ''}! 💸`,
    'Estes são os planos da Iara hoje:',
    ...planCatalogLines(),
    ...(usageLine ? [usageLine] : []),
    'Se quiser, me diga qual plano você quer (ex: "quero o Premium") que eu já te guio no próximo passo.'
  ].join('\n');
}

function onboardingInfoMessage(params: {
  now: Date;
  customerName?: string | null;
  accessReason: string;
  planCode?: PlanCode;
  planName?: string;
  monthlyIncomeCents?: number | null;
}): string {
  const hello = greetingByTime(params.now);
  const namePart = params.customerName ? `, ${params.customerName}` : '';
  const plan = getPlanDefinition(params.planCode ?? 'essential');
  const monthlyLabel = params.accessReason === 'monthly_payment_overdue'
    ? 'mensalidade pendente do seu plano atual'
    : `entrada única de ${centsToBrl(plan.setupFeeCents)} + mensalidade de ${centsToBrl(plan.monthlyFeeCents)}/mês no plano ${params.planName ?? plan.name}`;
  const promptLine = monthlyIncomePromptLine(params.monthlyIncomeCents);

  return [
    `${hello}${namePart}! ✨ Eu sou a Iara, sua assistente financeira.`,
    'Eu te ajudo a organizar sua vida financeira: registrar gastos/receitas, corrigir lançamentos e mostrar resumos com clareza.',
    'No momento você ainda não tem nenhum plano ativo liberado no cadastro.',
    `Plano pré-selecionado: ${params.planName ?? plan.name}.`,
    `Para ativar seu acesso: ${monthlyLabel}.`,
    '',
    'Planos disponíveis:',
    ...planCatalogLines(),
    '',
    'Funciona assim:',
    '1) Você me envia seu CPF ou CNPJ;',
    '2) Eu gero o link Pix automático na hora;',
    '3) Pagamento confirmado = acesso liberado automaticamente.',
    ...(promptLine ? [promptLine] : []),
    'Se quiser, já me manda agora: "quero plano essencial" (ou premium/família/elite) + "CPF 123.456.789-00" 🙂'
  ].join('\n');
}

function activationPromptMessage(params: {
  now: Date;
  customerName?: string | null;
  planCode?: PlanCode;
  planName?: string;
}): string {
  const hello = greetingByTime(params.now);
  const namePart = params.customerName ? `, ${params.customerName}` : '';
  const plan = getPlanDefinition(params.planCode ?? 'essential');
  const selectedName = params.planName ?? plan.name;
  return [
    `${hello}${namePart}! Perfeito, vamos ativar seu acesso 🚀`,
    `Plano selecionado: ${selectedName} (${centsToBrl(plan.monthlyFeeCents)}/mês + ${centsToBrl(plan.setupFeeCents)} de ativação).`,
    'Antes do Pix, me diga qual plano você quer:',
    ...planCatalogLines(),
    'Me envie seu CPF ou CNPJ para eu gerar seu Pix automático agora.',
    'Exemplos:',
    '• "quero plano premium"',
    '• "CPF 123.456.789-00"',
    '• "CNPJ 12.345.678/0001-99"'
  ].join('\n');
}

type AutoChargeResult = {
  paymentType: 'setup' | 'monthly';
  amountCents: number;
  dueDate: string;
  invoiceUrl: string | null;
  created: boolean;
} | null;

type AutoChargeAttempt = {
  charge: AutoChargeResult;
  failed: boolean;
  errorCode?: 'missing_tax_id' | 'provider_error';
};

async function tryAutoCreateCharge(params: {
  customerId: string;
  accessReason: string;
  dueDate?: string | null;
}): Promise<AutoChargeAttempt> {
  try {
    if (!config.asaasApiKey) {
      return { charge: null, failed: false };
    }

    if (params.accessReason === 'setup_payment_required' || params.accessReason === 'trial_expired') {
      // Todos os planos têm setup_fee = 0; o primeiro pagamento é sempre a mensalidade
      const paymentType = params.accessReason === 'trial_expired' ? 'monthly' : 'monthly';
      const charge = await createAsaasCharge({
        customerId: params.customerId,
        paymentType
      });

      return {
        charge: {
          paymentType,
          amountCents: charge.amountCents,
          dueDate: charge.dueDate,
          invoiceUrl: charge.invoiceUrl,
          created: charge.created
        },
        failed: false
      };
    }

    if (params.accessReason === 'monthly_payment_overdue') {
      const charge = await createAsaasCharge({
        customerId: params.customerId,
        paymentType: 'monthly',
        dueDate: params.dueDate ?? undefined
      });

      return {
        charge: {
          paymentType: 'monthly',
          amountCents: charge.amountCents,
          dueDate: charge.dueDate,
          invoiceUrl: charge.invoiceUrl,
          created: charge.created
        },
        failed: false
      };
    }

    return { charge: null, failed: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (/cpf|cnpj/i.test(message)) {
      return { charge: null, failed: true, errorCode: 'missing_tax_id' };
    }
    return { charge: null, failed: true, errorCode: 'provider_error' };
  }
}

function enrichBlockMessageWithCharge(baseMessage: string, attempt: AutoChargeAttempt): string {
  if (!attempt.charge) {
    if (attempt.failed) {
      if (attempt.errorCode === 'missing_tax_id') {
        return [
          baseMessage,
          'Para gerar seu Pix automático, preciso do seu CPF ou CNPJ.',
          'Me envie agora assim: "CPF 123.456.789-00" ou "CNPJ 12.345.678/0001-99".'
        ].join('\n');
      }
      return [
        baseMessage,
        'Não consegui gerar o link de pagamento automático agora.',
        'Me chama no suporte para eu te liberar o link em segundos.'
      ].join('\n');
    }
    return baseMessage;
  }

  const charge = attempt.charge;
  const chargeLabel = charge.paymentType === 'setup' ? 'entrada' : 'mensalidade';
  const lines = [baseMessage];

  if (charge.invoiceUrl) {
    lines.push(
      `💳 Cobrança de ${chargeLabel} pronta (${centsToBrl(charge.amountCents)}).`,
      `Link Pix: ${charge.invoiceUrl}`,
      'Assim que o pagamento for confirmado, seu acesso é liberado automaticamente.'
    );
  } else {
    lines.push(
      `💳 Cobrança de ${chargeLabel} já foi gerada.`,
      'Assim que o pagamento for confirmado, seu acesso é liberado automaticamente.'
    );
  }

  return lines.join('\n');
}

function minimumPlanForFeature(feature: PlanFeature): string {
  if (feature === 'reminders') return 'Essencial';
  if (feature === 'insights' || feature === 'recurring' || feature === 'cashflow' || feature === 'investment_simulator' || feature === 'visual_monthly_report') {
    return 'Premium';
  }
  if (feature === 'family_mode') return 'Família';
  if (feature === 'open_banking_import') return 'Elite';
  return 'Gratuito';
}

const allPlanFeatures: PlanFeature[] = [
  'goals',
  'reminders',
  'insights',
  'recurring',
  'cashflow',
  'investment_simulator',
  'gamification',
  'health_score',
  'family_mode',
  'visual_monthly_report',
  'open_banking_import'
];

function featureLabel(feature: PlanFeature): string {
  const labels: Record<PlanFeature, string> = {
    goals: 'metas',
    reminders: 'lembretes de contas',
    insights: 'insights inteligentes',
    recurring: 'detecção de recorrências',
    cashflow: 'previsão de saldo',
    investment_simulator: 'simulador de investimentos',
    gamification: 'gamificação',
    health_score: 'score financeiro',
    family_mode: 'modo família',
    visual_monthly_report: 'relatório visual mensal',
    open_banking_import: 'importação por Open Banking'
  };
  return labels[feature];
}

function aiPlanFeatureContext(planCode: PlanCode): {
  allowedFeaturesSummary: string;
  blockedFeaturesSummary: string;
} {
  const allowed = allPlanFeatures.filter((feature) => planHasFeature(planCode, feature)).map((feature) => featureLabel(feature));
  const blocked = allPlanFeatures.filter((feature) => !planHasFeature(planCode, feature)).map((feature) => featureLabel(feature));
  return {
    allowedFeaturesSummary: allowed.length ? allowed.join(', ') : 'nenhum adicional',
    blockedFeaturesSummary: blocked.length ? blocked.join(', ') : 'nenhum'
  };
}

function planLockedReply(params: {
  feature: PlanFeature;
  planName?: string;
  customerName?: string | null;
}): string {
  const required = minimumPlanForFeature(params.feature);
  const current = params.planName ?? 'atual';
  const firstName = params.customerName?.trim().split(/\s+/)[0];
  const namePrefix = firstName ? `${firstName}, ` : '';
  return [
    `${namePrefix}esse recurso (${featureLabel(params.feature)}) ainda não está no seu plano ${current}.`,
    `Para liberar, você precisa do plano ${required} ou superior.`,
    'Se quiser, eu te mostro em 30 segundos qual upgrade faz mais sentido para o seu uso.'
  ].join('\n');
}

function normalizeHumanText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function normalizeReplyForComparison(text: string): string {
  return normalizeHumanText(text).replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

function isOwnerDailyReportScheduleQuestion(text: string): boolean {
  const normalized = normalizeHumanText(text);
  const asksTime = /\b(que horas|qual horario|qual horario|quando|a que horas)\b/.test(normalized);
  const mentionsReport = /\b(relatorio|resumo)\b/.test(normalized);
  const mentionsDay = /\b(diario|dia|todo dia)\b/.test(normalized);
  return asksTime && mentionsReport && mentionsDay;
}

type OwnerCostScope = 'openai' | 'twilio' | 'supabase' | 'total';
type OwnerCostWindow = 'mtd' | 'projected' | 'both';

type OwnerCostIntent = {
  scopes: OwnerCostScope[];
  window: OwnerCostWindow;
};

function parseOwnerCostIntent(text: string): OwnerCostIntent | null {
  const normalized = normalizeHumanText(text)
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return null;

  const hasQuestionSignal = text.includes('?') ||
    /\b(quanto|qual|quais|me mostra|mostra|mostre|me fala|me diga|me passa|passa|quero ver|consulta|resumo|status|ver)\b/.test(normalized);
  const hasCostSignal = /\b(custo|custos|gasto|gastos|despesa|despesas|queima|burn|valor|valores)\b/.test(normalized);
  const hasMtdSignal = /\b(mtd|mes atual|neste mes|nesse mes|este mes|esse mes|ate agora|acumulad[oa])\b/.test(normalized);
  const hasMtdHardSignal = /\b(mtd|ate agora|acumulad[oa])\b/.test(normalized);
  const hasProjectedSignal = /\b(projetad[oa]|projecao|estimad[oa]|previsao|fim do mes|fechamento|run rate)\b/.test(normalized);
  const hasTotalSignal = /\b(total|geral|consolidado|somado)\b/.test(normalized);
  const hasOpsContext = /\b(api|apis|plataforma|sistema|operacao|infra|infraestrutura|stack|servico|provedor|fornecedor)\b/.test(normalized);

  const scopes: OwnerCostScope[] = [];
  if (/\b(openai|open ai)\b/.test(normalized)) {
    scopes.push('openai');
  }
  if (/\b(twilio)\b/.test(normalized) || /\b(whatsapp api|api do whatsapp)\b/.test(normalized)) {
    scopes.push('twilio');
  }
  if (/\b(supabase)\b/.test(normalized)) {
    scopes.push('supabase');
  }

  const hasQuerySignal = hasQuestionSignal || hasCostSignal || hasMtdSignal || hasProjectedSignal;
  if (scopes.length > 0 && !hasQuerySignal) {
    return null;
  }

  if (scopes.length === 0) {
    const looksLikeTotalOpsCostQuery =
      (
        hasOpsContext &&
        (hasCostSignal || hasQuestionSignal) &&
        (hasTotalSignal || hasMtdSignal || hasProjectedSignal)
      ) || (
        hasCostSignal &&
        hasTotalSignal &&
        (hasMtdHardSignal || hasProjectedSignal)
      );
    if (!looksLikeTotalOpsCostQuery) {
      return null;
    }
    scopes.push('total');
  } else {
    const askedGeneralTotalAlongsideProviders =
      hasTotalSignal && /\b(geral|consolidado|todos|somado)\b/.test(normalized);
    if (askedGeneralTotalAlongsideProviders) {
      scopes.push('total');
    }
  }

  const uniqueScopes = Array.from(new Set(scopes));
  const window: OwnerCostWindow = hasMtdSignal && !hasProjectedSignal
    ? 'mtd'
    : hasProjectedSignal && !hasMtdSignal
      ? 'projected'
      : 'both';

  return {
    scopes: uniqueScopes,
    window
  };
}

function usdMoney(value: number): string {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(value);
}

function usdToBrlCents(usd: number, fxUsdBrlRate: number): number {
  return Math.round(usd * fxUsdBrlRate * 100);
}

function providerOriginHint(provider: CostsOverview['providers'][number] | undefined): string {
  if (!provider) return ' (sem dados no momento)';
  if (provider.status !== 'ok') {
    return provider.note ? ` (obs: ${provider.note})` : ' (sem dados confiáveis)';
  }
  if (provider.source === 'local_estimate') return ' (estimativa local)';
  if (provider.source === 'fixed') return ' (alocação fixa)';
  return '';
}

function ownerScopeLabel(scope: OwnerCostScope): string {
  if (scope === 'openai') return 'OpenAI API';
  if (scope === 'twilio') return 'Twilio';
  if (scope === 'supabase') return 'Supabase';
  return 'Operação total';
}

function ownerScopeValues(
  overview: CostsOverview,
  scope: OwnerCostScope
): {
  mtdUsd: number;
  projectedUsd: number;
  provider?: CostsOverview['providers'][number];
} {
  if (scope === 'total') {
    return {
      mtdUsd: overview.totals.mtdUsd,
      projectedUsd: overview.totals.projectedUsd
    };
  }
  const provider = overview.providers.find((item) => item.provider === scope);
  return {
    mtdUsd: provider?.mtdUsd ?? 0,
    projectedUsd: provider?.projectedUsd ?? 0,
    provider
  };
}

function ownerPreviousProjectedUsd(
  previousMonth: PreviousMonthCostsSnapshot | null,
  scope: OwnerCostScope
): number | null {
  if (!previousMonth) return null;
  if (scope === 'total') {
    return previousMonth.overview.totals.projectedUsd;
  }
  const provider = previousMonth.overview.providers.find((item) => item.provider === scope);
  return provider?.projectedUsd ?? null;
}

function ownerVariationLabel(currentProjectedUsd: number, previousProjectedUsd: number | null): string {
  if (previousProjectedUsd === null || previousProjectedUsd <= 0) {
    return 'sem base suficiente do mês anterior';
  }
  const pct = ((currentProjectedUsd - previousProjectedUsd) / previousProjectedUsd) * 100;
  const signal = pct >= 0 ? '+' : '';
  return `${signal}${pct.toFixed(1)}% (mês anterior: ${usdMoney(previousProjectedUsd)})`;
}

function buildOwnerCostReply(
  overview: CostsOverview,
  intent: OwnerCostIntent,
  previousMonth: PreviousMonthCostsSnapshot | null
): string {
  const supabase = overview.providers.find((item) => item.provider === 'supabase');
  const fx = overview.fxUsdBrlRate;
  const usdWithBrl = (usd: number): string => `${usdMoney(usd)} (~${centsToBrl(usdToBrlCents(usd, fx))})`;

  const lines: string[] = [
    `📉 Custos operacionais ${String(overview.period.month).padStart(2, '0')}/${overview.period.year} (dia ${overview.period.dayOfMonth}/${overview.period.daysInMonth}):`
  ];

  const scopes = intent.scopes.length > 0 ? intent.scopes : (['total'] as OwnerCostScope[]);
  for (const scope of scopes) {
    const current = ownerScopeValues(overview, scope);
    const previousProjectedUsd = ownerPreviousProjectedUsd(previousMonth, scope);
    const variation = ownerVariationLabel(current.projectedUsd, previousProjectedUsd);
    const suffix = scope === 'supabase'
      ? providerOriginHint(supabase)
      : providerOriginHint(current.provider);
    lines.push(
      `• ${ownerScopeLabel(scope)} — MTD: ${usdWithBrl(current.mtdUsd)} | Projeção: ${usdWithBrl(current.projectedUsd)}${suffix}.`
    );
    lines.push(`  Variação vs mês anterior: ${variation}.`);
  }

  if (!scopes.includes('total')) {
    lines.push(`• Operação total — MTD: ${usdWithBrl(overview.totals.mtdUsd)} | Projeção: ${usdWithBrl(overview.totals.projectedUsd)}.`);
  }

  const generatedAtLabel = new Date(overview.period.generatedAt).toLocaleString('pt-BR', {
    timeZone: config.defaultTimezone
  });
  lines.push(`Atualizado em ${generatedAtLabel}.`);
  return lines.join('\n');
}

async function resolveOwnerCostIntentReply(params: {
  text: string;
  isOwner: boolean;
  loadOverview: () => Promise<CostsOverview>;
  loadPreviousMonthSnapshot?: () => Promise<PreviousMonthCostsSnapshot | null>;
}): Promise<{
  intent: OwnerCostIntent;
  replyText: string;
  denied?: boolean;
  error?: boolean;
  totals?: CostsOverview['totals'];
  providers?: CostsOverview['providers'];
  period?: CostsOverview['period'];
  failureReason?: string;
} | null> {
  const ownerCostIntent = parseOwnerCostIntent(params.text);
  if (!ownerCostIntent) {
    return null;
  }

  if (!params.isOwner) {
    return {
      intent: ownerCostIntent,
      replyText: 'Essa consulta de custo operacional é exclusiva do número administrador.',
      denied: true
    };
  }

  try {
    const overview = await params.loadOverview();
    const previousMonth = params.loadPreviousMonthSnapshot
      ? await params.loadPreviousMonthSnapshot().catch(() => null)
      : null;
    return {
      intent: ownerCostIntent,
      replyText: buildOwnerCostReply(overview, ownerCostIntent, previousMonth),
      totals: overview.totals,
      providers: overview.providers
        .filter((item) => item.provider === 'openai' || item.provider === 'twilio' || item.provider === 'supabase'),
      period: overview.period
    };
  } catch (error) {
    return {
      intent: ownerCostIntent,
      replyText: 'Não consegui consultar os custos operacionais agora. Tente novamente em alguns instantes.',
      error: true,
      failureReason: error instanceof Error ? error.message : 'unknown_error'
    };
  }
}

function extractPhoneDigitsFromText(text: string): string | null {
  const matches = text.match(/(?:\+?\d[\d\s().-]{7,}\d)/g) ?? [];
  const candidates = matches
    .map((item) => item.replace(/\D/g, ''))
    .filter((digits) => digits.length >= 10)
    .sort((a, b) => b.length - a.length);
  return candidates[0] ?? null;
}

function extractOwnerStatusQueryTarget(text: string): { targetPhone: string } | null {
  const normalized = normalizeHumanText(text);
  const asksOtherNumber = /\b(numero|numero do|contato|telefone)\b/.test(normalized);
  const asksToday = /\b(hoje|agora|dia)\b/.test(normalized);
  const asksFinancialStatus = /\b(anotou|registrou|lancou|lançou|gasto|gastos|receita|receitas|movimentou)\b/.test(normalized);
  if (!asksOtherNumber || !asksToday || !asksFinancialStatus) {
    return null;
  }

  const targetPhone = extractPhoneDigitsFromText(text);
  if (!targetPhone) {
    return null;
  }

  return { targetPhone };
}

type OwnerGrantAccessCommand = {
  targetPhone: string | null;
  planCode: PlanCode | null;
};

function normalizeWhatsappStorageNumber(rawDigits: string): string {
  const digits = rawDigits.replace(/\D/g, '');
  if (!digits) return digits;
  if (digits.startsWith('55')) return digits;
  return `55${digits}`;
}

function parseOwnerGrantAccessCommand(text: string): OwnerGrantAccessCommand | null {
  const normalized = normalizeHumanText(text);
  const asksGrant = /\b(libera|liberar|libere|ativa|ativar|ative|habilita|habilitar|autoriza|autorizar|desbloqueia|desbloquear|concede|conceder)\b/.test(normalized) &&
    /\b(acesso|numero|número|cliente|contato|plano)\b/.test(normalized);
  if (!asksGrant) {
    return null;
  }

  const targetPhone = extractPhoneDigitsFromText(text);
  const explicitPlan = detectExplicitPlanChoice(text);
  const mentionedPlans = extractMentionedPlans(text);
  const planCode = explicitPlan ?? (mentionedPlans.length === 1 ? mentionedPlans[0] : null);

  return {
    targetPhone: targetPhone ?? null,
    planCode
  };
}

function formatWhatsappNumberForReply(digits: string): string {
  const normalized = digits.replace(/\D/g, '');
  if (!normalized) return digits;
  return normalized.startsWith('55') ? `+${normalized}` : `+55${normalized}`;
}

function formatWhatsappNumberPretty(digits: string): string {
  const normalized = digits.replace(/\D/g, '');
  if (!normalized) return digits;

  const withCountry = normalized.startsWith('55') ? normalized : `55${normalized}`;
  if (!withCountry.startsWith('55') || withCountry.length < 12) {
    return formatWhatsappNumberForReply(digits);
  }

  const ddd = withCountry.slice(2, 4);
  const local = withCountry.slice(4);
  if (local.length === 9) {
    return `+55 ${ddd} ${local.slice(0, 5)}-${local.slice(5)}`;
  }
  if (local.length === 8) {
    return `+55 ${ddd} ${local.slice(0, 4)}-${local.slice(4)}`;
  }

  return `+${withCountry}`;
}

function isOwnerCustomersCountQuestion(text: string): boolean {
  const normalized = normalizeHumanText(text);
  const asksCount = /\b(quantos|quantidade|qtd|total)\b/.test(normalized);
  const mentionsContacts = /\b(numero(?:s|\(s\))?|contatos?|clientes?|cadastros?)\b/.test(normalized);
  const mentionsSystem = /\b(cadastrad|sistema|acesso|ativos?)\b/.test(normalized);
  return asksCount && mentionsContacts && mentionsSystem;
}

function isOwnerCustomersListQuestion(text: string, lastAssistantMessage?: string | null): boolean {
  const normalized = normalizeHumanText(text)
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const hasListAction = /\b(me mostra|me mostre|mostra|mostre|lista|listar|quais(?:\s+sao)?|me fale|me fala|me diga|me passa|me envia|envia|manda|quero ver|quero saber|detalha|detalhar|ver)\b/.test(normalized);
  const mentionsContacts = /\b(numero(?:s|\(s\))?|contatos?|clientes?|cadastros?|telefones?)\b/.test(normalized);
  const directCountReference = /\b(esses?|essas?|aqueles?|aquelas?)\s+\d+\s+(numero(?:s)?|contatos?|clientes?|telefones?)\b/.test(normalized);
  const explicitList = (hasListAction && mentionsContacts) || directCountReference;
  if (explicitList) return true;

  const usesPronoun = /\b(eles|esses|essas|aqueles|aquelas)\b/.test(normalized) &&
    /\b(me mostra|me mostre|mostra|mostre|quais sao|quais são|me fale|me fala|me diga|quero saber)\b/.test(normalized);
  if (!usesPronoun) return false;

  const lastNormalized = normalizeHumanText(lastAssistantMessage ?? '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const lastMentionsContacts = /\b(numero(?:s|\(s\))?|contatos?|clientes?)\b/.test(lastNormalized);
  const lastMentionsCount = /\b\d+\s+numero(?:s)?\b/.test(lastNormalized);
  return (lastMentionsContacts || lastMentionsCount) &&
    /\b(cadastrados|ativos|acesso|sistema)\b/.test(lastNormalized);
}

function normalizeOwnerContactName(rawName: string | null): string | null {
  const trimmed = rawName?.trim() || '';
  if (!trimmed) return null;

  const normalized = normalizeHumanText(trimmed);
  if (/^(sem nome|contato sem nome|unknown|null|n\/a|na|indefinido|sem identificacao)$/.test(normalized)) {
    return null;
  }

  if (/^[xX\-\s().]+$/.test(trimmed)) {
    return null;
  }

  const digits = trimmed.replace(/\D/g, '');
  if (digits.length >= 8) {
    return null;
  }

  return trimmed;
}

function normalizeOwnerContacts(
  contacts: Array<{ id: string; name: string | null; whatsappNumber: string }>
): Array<{ id: string; name: string | null; whatsappNumber: string }> {
  const cleaned = contacts
    .map((item) => ({
      id: item.id,
      name: normalizeOwnerContactName(item.name),
      whatsappNumber: item.whatsappNumber.replace(/\D/g, '')
    }))
    .filter((item) => item.whatsappNumber.length >= 10);

  return Array.from(new Map(cleaned.map((item) => [item.whatsappNumber, item])).values());
}

function ownerContactLabel(item: { name: string | null; whatsappNumber: string }): string {
  const formatted = formatWhatsappNumberPretty(item.whatsappNumber);
  const safeNumber = /\d/.test(formatted) ? formatted : formatWhatsappNumberForReply(item.whatsappNumber);
  if (item.name) {
    return `${item.name} — ${safeNumber}`;
  }
  const last4 = item.whatsappNumber.slice(-4) || '---';
  return `Contato sem nome (final ${last4}) — ${safeNumber}`;
}

function ownerCountLabel(total: number): string {
  return total === 1 ? '1 número ativo' : `${total} números ativos`;
}

function pickByHash(seed: string, options: string[]): string {
  if (options.length === 0) return '';
  let hash = 0;
  for (const ch of seed) {
    hash = ((hash << 5) - hash + ch.charCodeAt(0)) | 0;
  }
  const idx = Math.abs(hash) % options.length;
  return options[idx];
}

function varyRepeatedReply(current: string, options?: { ownerMode?: boolean }): string {
  const normalized = normalizeHumanText(current);
  const ownerMode = options?.ownerMode ?? false;

  if (ownerMode) {
    let ownerVariants = [
      'Se quiser, sigo com a próxima consulta objetiva.',
      'Me diga a próxima verificação e eu respondo direto.',
      'Posso continuar com resumo, limites ou status específico.'
    ];

    if (/\b(limite|semanal|diario|mensal)\b/.test(normalized)) {
      ownerVariants = [
        'Se quiser, já trago os limites ativos e pontos de ajuste.',
        'Posso revisar limites por período em uma resposta curta.',
        'Me diga qual período você quer revisar agora.'
      ];
    } else if (/\b(resumo|gastos de hoje|categoria|total)\b/.test(normalized)) {
      ownerVariants = [
        'Se quiser, já abro o próximo recorte (dia, semana ou mês).',
        'Posso detalhar por categoria em seguida.',
        'Me diga o próximo filtro que você quer.'
      ];
    }

    const ownerPick = pickByHash(`${normalized}|${Date.now()}`, ownerVariants);
    return `${current}\n${ownerPick}`;
  }

  let variants = [
    'Se quiser, já me manda: "gastei 45 no mercado ontem".',
    'Posso seguir por gasto, receita, resumo do mês ou limites. Qual você prefere agora?',
    'Me fala sua próxima ação financeira e eu organizo pra você na hora.'
  ];

  if (/\b(limite|semanal|diario|mensal)\b/.test(normalized)) {
    variants = [
      'Quer definir agora um limite diário, semanal ou mensal?',
      'Se quiser, já ajusto seus limites com você em 1 mensagem.',
      'Posso te mostrar seus limites ativos agora também.'
    ];
  } else if (/\b(resumo|gastos de hoje|categoria|total)\b/.test(normalized)) {
    variants = [
      'Se quiser, eu já te mostro os gastos de hoje.',
      'Posso abrir agora seu resumo do mês com categorias.',
      'Quer que eu compare seus gastos com seus limites?'
    ];
  } else if (/\b(iara|assistente|comandos|funciona)\b/.test(normalized)) {
    variants = [
      'Quer que eu te mostre os 3 comandos mais usados agora?',
      'Me manda um exemplo de gasto e eu te mostro na prática.',
      'Se preferir, já começamos com "gastos de hoje".'
    ];
  } else if (/\b(meta|objetivo|prazo)\b/.test(normalized)) {
    variants = [
      'Se quiser, eu já te ajudo a definir o prazo ideal dessa meta.',
      'Posso calcular agora quanto você precisa guardar por semana para bater essa meta.',
      'Quer que eu já deixe um lembrete de acompanhamento dessa meta também?'
    ];
  }

  const pick = pickByHash(`${normalized}|${Date.now()}`, variants);
  return `${current}\n${pick}`;
}

function helpVariant(text: string, ownerMode = false): string {
  if (ownerMode) {
    return [
      'Me diga a consulta de forma objetiva e eu respondo direto.',
      'Exemplos úteis: "gastos de hoje", "resumo do mês", "status +55...", "clientes ativos".'
    ].join('\n');
  }

  const base = [
    [
      'Não entendi direitinho essa mensagem 😅',
      'Me diz o que você quer fazer:',
      '• lançar gasto/receita',
      '• ver gastos de hoje',
      '• ver resumo do mês',
      '• definir ou ver limites',
      '• ver score financeiro / streak / conquistas',
      '• usar modo família',
      '• relatório visual mensal',
      '• criar meta financeira',
      '• cadastrar lembrete de vencimento',
      '• ver insights / previsão de saldo',
      '• apagar último gasto ou corrigir valor',
      'Posso começar por qual opção?'
    ],
    [
      'Quero te ajudar, só preciso de um pouco mais de contexto 🙂',
      'Você quer:',
      '• registrar um gasto/receita',
      '• consultar resumo',
      '• corrigir/apagar lançamento',
      '• ajustar limites?',
      '• ver score / streak?',
      '• ativar família?',
      '• criar meta ou lembrete?',
      'Me responde com uma dessas opções.'
    ],
    [
      'Ainda não ficou claro pra mim 🤔',
      'Me manda em um desses formatos:',
      '• "hoje gastei 30 no mercado"',
      '• "resumo do mês"',
      '• "gastos de hoje"',
      '• "limite semanal 800"',
      '• "meu score" / "meu streak"',
      '• "criar família"',
      '• "relatório mensal visual"',
      '• "meta 5000 para viagem até 31/12/2026"',
      '• "lembrete aluguel vence 10/04"',
      'Qual você quer agora?'
    ]
  ].map((parts) => parts.join('\n'));

  let hash = 0;
  for (const ch of text) {
    hash = ((hash << 5) - hash + ch.charCodeAt(0)) | 0;
  }
  const idx = Math.abs(hash) % base.length;
  return base[idx];
}

function parseAmountToCentsLoose(text: string): number | null {
  const normalized = text.replace(/\./g, '').replace(/,/g, '.');
  const match = normalized.match(/(\d+(?:\.\d{1,2})?)/);
  if (!match) return null;
  const value = Number(match[1]);
  if (Number.isNaN(value) || value <= 0) return null;
  return Math.round(value * 100);
}

function parseMonthlyIncomeCents(text: string): number | null {
  const normalized = normalizeHumanText(text);

  const milMatch = normalized.match(/(\d+(?:[.,]\d{1,2})?)\s*mil\b/);
  if (milMatch?.[1]) {
    const base = Number(milMatch[1].replace(',', '.'));
    if (!Number.isNaN(base) && base > 0) {
      return Math.round(base * 1000 * 100);
    }
  }

  return parseAmountToCentsLoose(text);
}

function parseMonthlyIncomeIntent(text: string): { action: 'set'; amountCents: number } | { action: 'skip' } | null {
  const normalized = normalizeHumanText(text);
  const skip = /\b(sem isso|sem renda|prefiro sem|seguimos sem|depois eu falo|depois eu informo|nao quero informar|não quero informar)\b/.test(normalized);
  if (skip) {
    return { action: 'skip' };
  }

  const hasIncomeContext = /\b(renda|salario|salário|ganho|recebo|receita fixa)\b/.test(normalized);
  if (!hasIncomeContext) {
    return null;
  }

  const amountCents = parseMonthlyIncomeCents(text);
  if (!amountCents || amountCents <= 0) {
    return null;
  }

  return { action: 'set', amountCents };
}

function isLimitsHowItWorksQuestion(text: string): boolean {
  const normalized = normalizeHumanText(text);
  const asksLimits = /\b(limite|limites)\b/.test(normalized);
  if (!asksLimits) return false;

  if (/\b(como funciona|como funcina|como e|como é|explica|me explica|entender|duvida|dúvida)\b/.test(normalized)) {
    return true;
  }
  return /\b(questao|questão)\b/.test(normalized);
}

function limitsHowItWorksMessage(params: {
  planCode: string;
  monthlyIncomeCents: number | null | undefined;
}): string {
  const profile = limitAlertProfileForPlan(params.planCode);
  const headsUpPct = Math.round((1 - profile.headsUpRemainingRatio) * 100);
  const promptLine = monthlyIncomePromptLine(params.monthlyIncomeCents);

  return [
    'Funciona assim, de forma simples 👇',
    '1) Você define teto diário, semanal ou mensal (ex: "limite semanal 800").',
    '2) Eu comparo cada novo gasto com esse teto em tempo real.',
    `3) Quando você encosta no limite, eu aviso antes (pré-alerta em torno de ${headsUpPct}% de uso).`,
    '4) Se passar do limite, eu alerto na hora e já sugiro ajuste prático para não descontrolar.',
    'Comandos úteis: "limite diário 80", "limite mensal 2000", "meus limites", "remover limite semanal".',
    ...(promptLine ? [promptLine] : [])
  ].join('\n');
}

function extractTaxId(text: string): string | null {
  const normalized = normalizeHumanText(text);
  const digits = text.replace(/\D/g, '');
  const onlyDigitsText = /^\s*[\d.\-\/\s]+\s*$/.test(text);
  const hasKeyword = /\b(cpf|cnpj)\b/.test(normalized);

  if ((hasKeyword || onlyDigitsText) && (digits.length === 11 || digits.length === 14)) {
    return digits;
  }

  return null;
}

function extractContextDescription(text: string): string | null {
  const patterns = [
    /\b(?:foi|era|ficou|gastei|paguei|comprei)\s+(?:de|do|da|no|na|em|com)\s+(.+)$/i,
    /\b(?:foi|era|ficou)\s+(.+)$/i
  ];

  for (const pattern of patterns) {
    const match = text.trim().match(pattern);
    if (!match?.[1]) continue;

    const cleaned = match[1]
      .replace(/[.!?]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!cleaned || cleaned.length < 2) continue;
    if (/^\d+(?:[.,]\d{1,2})?$/.test(cleaned)) continue;

    return cleaned;
  }

  return null;
}

function parseContextualCorrection(text: string): {
  amountCents?: number;
  category?: string;
  description?: string;
  ambiguous: boolean;
} | null {
  const normalized = normalizeHumanText(text);
  const hasReference = /\b(esse|esses|essa|essas|isso|isto|aquele|aqueles|aquela|aquelas|este|estes|esta|estas)\b/.test(normalized);
  const startsWithAmountReference = /^\d+(?:[.,]\d{1,2})?\s+(foi|era|ficou|gastei|paguei|comprei)\b/.test(normalized);
  const hasCorrectionCue = /\b(foi|era|ficou|gastei|paguei|comprei|corrige|corrigir|ajusta|ajustar|altera|alterar|na verdade)\b/.test(normalized);

  if ((!hasReference && !startsWithAmountReference) || !hasCorrectionCue) {
    return null;
  }

  const amountCents = parseAmountToCentsLoose(text) ?? undefined;
  const inferredCategory = inferCategory(normalized);
  const category = inferredCategory !== 'outros' ? inferredCategory : undefined;
  const description = extractContextDescription(text) ?? undefined;
  const ambiguous = !amountCents && !category && !description;

  return { amountCents, category, description, ambiguous };
}

function isGreetingMessage(text: string): boolean {
  const normalized = normalizeHumanText(text).replace(/[!?.,]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!normalized) return false;

  if (['oi', 'ola', 'olá', 'bom dia', 'boa tarde', 'boa noite', 'e ai', 'eai', 'opa', 'tudo bem'].includes(normalized)) {
    return true;
  }

  return /^(oi|ola|olá|bom dia|boa tarde|boa noite|tudo bem|como voce esta|como vc ta)\b/.test(normalized);
}

function hasFinanceHint(text: string): boolean {
  const normalized = normalizeHumanText(text);
  return /\b(gastei|paguei|comprei|recebi|ganhei|despesa|gasto|resumo|limite|categoria|receita|corrige|corrigir|apaga|apagar|deleta|deletar|saldo|total|mensal|semanal|diario|diário)\b/.test(normalized);
}

function hasQuestionSignalForSafety(text: string): boolean {
  const normalized = normalizeHumanText(text);
  if (text.includes('?')) return true;
  if (/\b(só tenho|so tenho|até agora|ate agora|isso mesmo|tem certeza|como assim|por quê|por que|não entendi|nao entendi|quer dizer que)\b/.test(normalized)) {
    return true;
  }
  return /\b(quanto|qual|quais|como|porque|por que|por quê)\b/.test(normalized);
}

function hasExplicitWriteSignal(text: string): boolean {
  const normalized = normalizeHumanText(text);
  return /\b(gastei|paguei|comprei|recebi|ganhei|anota|anotar|registra|registrar|coloca|colocar|adiciona|adicionar|adicione|lancar|lançar|corrige|corrigir|apaga|apagar|deleta|deletar|remove|remover|cria|criar|define|definir)\b/.test(normalized);
}

function isSafeTransactionalExecution(intent: ParsedIntent, text: string): { safe: boolean; reason?: string } {
  if (
    intent.type !== 'register-transaction' &&
    intent.type !== 'correct-last-transaction' &&
    intent.type !== 'delete-last-transaction' &&
    intent.type !== 'set-spending-limit' &&
    intent.type !== 'clear-spending-limit'
  ) {
    return { safe: true };
  }

  const questionLike = hasQuestionSignalForSafety(text);

  // Spending limit commands are self-evidently explicit ("limite semanal 500") — no write verb needed
  if (intent.type === 'set-spending-limit' || intent.type === 'clear-spending-limit') {
    return questionLike ? { safe: false, reason: 'question-like-message' } : { safe: true };
  }

  const explicit = hasExplicitWriteSignal(text);

  if (!explicit || questionLike) {
    return {
      safe: false,
      reason: questionLike ? 'question-like-message' : 'missing-explicit-write-signal'
    };
  }

  return { safe: true };
}

function isCasualSmallTalkMessage(text: string): boolean {
  const normalized = normalizeHumanText(text).replace(/[!?.,]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!normalized || hasFinanceHint(normalized)) return false;
  if (/\d/.test(normalized) || normalized.length > 80) return false;

  return /\b(tudo bem|tudo bom|tudo otimo|tudo ótimo|to bem|estou bem|blz|beleza|de boa|e voce|e vc|como voce esta|como vc ta|obrigado|obrigada)\b/.test(normalized);
}

function detectPreferredName(text: string): string | null {
  const patterns = [
    /(?:meu nome e|meu nome é|pode me chamar de|me chama de)\s+(.+)/i,
    /(?:sou o|sou a|sou)\s+(.+)/i
  ];

  for (const pattern of patterns) {
    const match = text.trim().match(pattern);
    if (!match?.[1]) continue;

    const cleaned = match[1]
      .replace(/[.!?,;:]/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/[^\p{L}\s'-]/gu, '')
      .trim();

    if (cleaned.length < 2) continue;

    return cleaned
      .split(' ')
      .slice(0, 3)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
      .join(' ');
  }

  return null;
}

function isTodayExpenseRequest(text: string): boolean {
  const normalized = normalizeHumanText(text);
  return (
    normalized.includes('gastos de hoje') ||
    normalized.includes('meus gastos hoje') ||
    normalized.includes('quanto gastei hoje') ||
    normalized.includes('o que gastei hoje') ||
    normalized.includes('resumo de hoje') ||
    normalized.includes('listar gastos de hoje')
  );
}

function isStreakRequest(text: string): boolean {
  const normalized = normalizeHumanText(text);
  return /\b(streak|sequencia|sequência|dias seguidos)\b/.test(normalized);
}

function isAchievementsRequest(text: string): boolean {
  const normalized = normalizeHumanText(text);
  return /\b(conquistas|conquista|trofeus|troféus|badges?)\b/.test(normalized);
}

function isScoreRequest(text: string): boolean {
  const normalized = normalizeHumanText(text);
  if (/\b(evolucao|evolução|historico|histórico)\b/.test(normalized)) {
    return false;
  }
  return /\b(score|saude financeira|saúde financeira|nota financeira)\b/.test(normalized);
}

function parseFamilyCreate(text: string): { name?: string } | null {
  const normalized = normalizeHumanText(text);
  if (!/\b(criar|novo|abrir)\b/.test(normalized) || !/\b(familia|família|grupo familiar)\b/.test(normalized)) {
    return null;
  }

  const match = text.match(/\b(?:familia|família|grupo)\s*(?:com nome|nome)?\s*[:\-]?\s*(.+)$/i);
  const name = match?.[1]?.trim();
  if (!name) return {};
  return { name: name.slice(0, 100) };
}

function parseFamilyJoinCode(text: string): { code: string } | null {
  const normalized = text.trim();

  const explicitCode = normalized.match(/\b(?:codigo|código)\s*[:\-]?\s*([A-Z0-9]{6,12})\b/i);
  if (explicitCode?.[1]) {
    return { code: explicitCode[1].toUpperCase() };
  }

  const joinWithCode = normalized.match(/\b(?:entrar|participar|juntar|join)\b[\s:,-]*(?:na|no|em)?[\s:,-]*(?:familia|família|grupo)?[\s:,-]*([A-Z0-9]{6,12})\b/i);
  if (joinWithCode?.[1]) {
    return { code: joinWithCode[1].toUpperCase() };
  }

  const codePhrase = normalized.match(/\b(?:tenho|meu|usar?|receb[ei]|pegar?|fui\s+convidado)\b.{0,30}(?:codigo|código)[:\s]+([A-Z0-9]{6,12})\b/i);
  if (codePhrase?.[1]) {
    return { code: codePhrase[1].toUpperCase() };
  }

  // Código sozinho na mensagem (6-12 chars alfanuméricos, sem espaços)
  const standalone = normalized.match(/^([A-Z0-9]{6,12})$/i);
  if (standalone?.[1]) {
    return { code: standalone[1].toUpperCase() };
  }

  return null;
}

function isFamilyLeaveRequest(text: string): boolean {
  const normalized = normalizeHumanText(text);
  return /\b(sair|deixar)\b/.test(normalized) && /\b(familia|família|grupo)\b/.test(normalized);
}

function isFamilySummaryRequest(text: string): boolean {
  const normalized = normalizeHumanText(text);
  return /\b(resumo|gastos|saldo)\b/.test(normalized) && /\b(familia|família|familiar|grupo)\b/.test(normalized);
}

function isFamilyInfoRequest(text: string): boolean {
  const normalized = normalizeHumanText(text);
  return /\b(minha familia|minha família|grupo familiar|dados da familia|dados da família)\b/.test(normalized);
}

function isPlanInfoRequest(text: string): boolean {
  const normalized = normalizeHumanText(text);
  return /\b(meu plano|plano atual|limite de mensagens|quantas mensagens|mensagens restantes)\b/.test(normalized);
}

function parseFamilySetLimit(text: string): { period: 'daily' | 'weekly' | 'monthly'; amountCents: number } | null {
  const normalized = normalizeHumanText(text);
  const hasLimit = /\b(limite)\b/.test(normalized);
  const hasFamily = /\b(familia|família|grupo)\b/.test(normalized);
  if (!hasLimit || !hasFamily) return null;

  const period = /\b(semanal|semana)\b/.test(normalized)
    ? 'weekly'
    : /\b(mensal|mes|mês)\b/.test(normalized)
      ? 'monthly'
      : /\b(diario|diária|diaria|dia|diário)\b/.test(normalized)
        ? 'daily'
        : null;
  if (!period) return null;

  const amount = parseAmountToCentsLoose(text);
  if (!amount || amount <= 0) return null;
  return { period, amountCents: amount };
}

function parseFamilyClearLimit(text: string): { period: 'daily' | 'weekly' | 'monthly' } | null {
  const normalized = normalizeHumanText(text);
  const hasAction = /\b(remover|remove|apagar|limpar|cancelar)\b/.test(normalized);
  const hasLimit = /\b(limite)\b/.test(normalized);
  const hasFamily = /\b(familia|família|grupo)\b/.test(normalized);
  if (!hasAction || !hasLimit || !hasFamily) return null;

  const period = /\b(semanal|semana)\b/.test(normalized)
    ? 'weekly'
    : /\b(mensal|mes|mês)\b/.test(normalized)
      ? 'monthly'
      : /\b(diario|diária|diaria|dia|diário)\b/.test(normalized)
        ? 'daily'
        : null;
  if (!period) return null;
  return { period };
}

function isFamilyListLimitsRequest(text: string): boolean {
  const normalized = normalizeHumanText(text);
  return /\b(limites?)\b/.test(normalized) && /\b(familia|família|grupo)\b/.test(normalized);
}

function isWeeklyScoreEvolutionRequest(text: string): boolean {
  const normalized = normalizeHumanText(text);
  return /\b(evolucao|evolução|historico|histórico)\b/.test(normalized) && /\b(score)\b/.test(normalized);
}

function isVisualMonthlyReportRequest(text: string): boolean {
  const normalized = normalizeHumanText(text);
  return /\b(relatorio|relatório|wrapped|resumo visual)\b/.test(normalized) && /\b(mensal|mes|mês)\b/.test(normalized);
}

function isConnectBankRequest(text: string): boolean {
  const normalized = normalizeHumanText(text);
  return (
    /\b(conectar?|ligar|vincular|integrar)\b/.test(normalized) &&
    /\b(banco|conta|open.?finance|pluggy)\b/.test(normalized)
  ) || /\b(conectar? meu banco|linkar? banco|abrir? open.?finance)\b/.test(normalized);
}

function isDisconnectBankRequest(text: string): boolean {
  const normalized = normalizeHumanText(text);
  return (
    /\b(desconectar?|desvincular|remover?|cancelar?)\b/.test(normalized) &&
    /\b(banco|conta|open.?finance|pluggy)\b/.test(normalized)
  );
}

function isAskBankStatusRequest(text: string): boolean {
  const normalized = normalizeHumanText(text);
  return /\b(banco conectado|banco esta conectado|banco está conectado|status do banco|meu banco esta|meu banco está)\b/.test(normalized);
}

function greetingByTime(now: Date): string {
  const hourParts = new Intl.DateTimeFormat('en-GB', {
    timeZone: config.defaultTimezone,
    hour: '2-digit',
    hour12: false
  }).formatToParts(now);
  const hour = Number(hourParts.find((part) => part.type === 'hour')?.value ?? '0');
  if (hour < 12) return 'Bom dia';
  if (hour < 18) return 'Boa tarde';
  return 'Boa noite';
}

function welcomeMessage(
  now: Date,
  customerName?: string | null,
  monthlyIncomeCents?: number | null,
  ownerMode = false
): string {
  const hello = greetingByTime(now);
  const namePart = customerName ? `, ${customerName}` : '';
  const intro = `${hello}${namePart}! ✨ Eu sou a Iara, sua assistente financeira.`;
  const promptLine = monthlyIncomePromptLine(monthlyIncomeCents);

  if (ownerMode) {
    return [
      intro,
      'Modo operacional ativo.',
      'Me diga a consulta financeira que você quer agora e eu respondo direto.',
      ...(promptLine ? [promptLine] : [])
    ].join('\n');
  }

  if (customerName) {
    return [
      intro,
      'Como você está hoje?',
      'Se quiser, já começamos com seu primeiro registro do dia ou com uma meta rápida.',
      ...(promptLine ? [promptLine] : []),
      'Exemplo: "hoje gastei 30 no mercado" ou "meta 300 até o fim do mês".'
    ].join('\n');
  }

  return [
    intro,
    'Tudo bem com você?',
    'Como você quer que eu te chame? 💬',
    'Depois disso, já te ajudo a registrar gastos e definir sua primeira meta.',
    ...(promptLine ? [promptLine] : [])
  ].join('\n');
}

function trialWelcomeMessage(params: {
  now: Date;
  customerName?: string | null;
  trialDaysLeft?: number;
  trialEndDate?: string | null;
  monthlyIncomeCents?: number | null;
  ownerMode?: boolean;
}): string {
  const hello = greetingByTime(params.now);
  const namePart = params.customerName ? `, ${params.customerName}` : '';
  const endDate = params.trialEndDate
    ? new Date(`${params.trialEndDate}T12:00:00.000Z`).toLocaleDateString('pt-BR')
    : 'em breve';
  const daysLeft = params.trialDaysLeft ?? 0;

  const trialLine = daysLeft > 0
    ? `Você está no período de teste (${daysLeft} dia(s) restante(s), até ${endDate}).`
    : `Você está no período de teste até ${endDate}.`;
  const promptLine = monthlyIncomePromptLine(params.monthlyIncomeCents);

  if (params.ownerMode) {
    return [
      `${hello}${namePart}! ✨ Eu sou a Iara, sua assistente financeira.`,
      trialLine,
      'Modo operacional ativo. Me passe a consulta que você quer e eu respondo em formato direto.',
      ...(promptLine ? [promptLine] : [])
    ].join('\n');
  }

  return [
    `${hello}${namePart}! ✨ Eu sou a Iara, sua assistente financeira.`,
    trialLine,
    'Vou te ajudar com foco total em clareza e ação prática.',
    ...(promptLine ? [promptLine] : []),
    'Quer começar registrando um gasto de hoje ou definindo uma meta da semana?'
  ].join('\n');
}

function activeHowItWorksMessage(params: {
  now: Date;
  customerName?: string | null;
  trialActive?: boolean;
  trialDaysLeft?: number;
  triggerText?: string;
  monthlyIncomeCents?: number | null;
  ownerMode?: boolean;
}): string {
  const hello = greetingByTime(params.now);
  const namePart = params.customerName ? `, ${params.customerName}` : '';
  const trialLine = params.trialActive
    ? `🧪 Você está em teste (${params.trialDaysLeft ?? 0} dia(s) restantes).`
    : null;
  const promptLine = monthlyIncomePromptLine(params.monthlyIncomeCents);

  if (params.ownerMode) {
    return [
      `${hello}${namePart}! ✨ Eu sou a Iara, sua assistente financeira.`,
      'Funciono por consulta direta: você pede e eu respondo com dado + ação objetiva.',
      ...(trialLine ? [trialLine] : []),
      ...(promptLine ? [promptLine] : []),
      'Você pode pedir: resumo, gastos de hoje, limites, metas, lembretes ou status por número.'
    ].join('\n');
  }

  const ctas = [
    'Me manda um comando que eu já te ajudo agora 💬',
    'Se quiser, já começamos com: "gastos de hoje".',
    'Pode testar agora e eu já organizo seu primeiro lançamento.'
  ];
  const closeLine = pickByHash(
    `${params.customerName ?? 'anon'}|${normalizeHumanText(params.triggerText ?? '')}|${params.now.toISOString()}`,
    ctas
  );

  return [
    `${hello}${namePart}! ✨ Eu sou a Iara, sua assistente financeira.`,
    'Tô aqui para pensar seu financeiro com você: registrar, analisar e te orientar no próximo passo.',
    ...(trialLine ? [trialLine] : []),
    ...(promptLine ? [promptLine] : []),
    'Se quiser, já começamos agora com 1 ação: anotar um gasto, definir meta ou ajustar limite.',
    closeLine
  ].join('\n');
}

function smallTalkRedirectMessage(
  now: Date,
  customerName?: string | null,
  monthlyIncomeCents?: number | null,
  ownerMode = false
): string {
  const hello = greetingByTime(now);
  const namePart = customerName ? `, ${customerName}` : '';
  const promptLine = monthlyIncomePromptLine(monthlyIncomeCents);

  if (ownerMode) {
    return [
      `${hello}${namePart}! Tudo certo por aqui.`,
      'Quando quiser, me manda a consulta e eu respondo no formato mais objetivo possível.',
      ...(promptLine ? [promptLine] : [])
    ].join('\n');
  }

  return [
    `${hello}${namePart}! 😊 Estou bem e pronta para te ajudar com suas decisões financeiras.`,
    'Se você quiser, já me conta um gasto de hoje ou uma meta que quer bater este mês.',
    ...(promptLine ? [promptLine] : []),
    'Exemplo rápido: "gastei 42 no mercado" ou "meta 500 até o fim do mês".'
  ].join('\n');
}

async function sendWhatsAppTextMessage(to: string, body: string): Promise<void> {
  if (!config.whatsappToken || !config.whatsappPhoneNumberId) {
    throw new Error('Missing WhatsApp config (WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID).');
  }

  const response = await fetch(`https://graph.facebook.com/v22.0/${config.whatsappPhoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.whatsappToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: {
        body
      }
    })
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`WhatsApp send failed (${response.status}): ${details}`);
  }
}

function normalizePhone(value: string): string | null {
  const digits = value.replace(/\D/g, '');
  return digits.length >= 8 ? digits : null;
}

function extractTwilioWebhookPayload(rawBody: unknown): InboundPayload | null {
  const parsed = twilioInboundSchema.safeParse(rawBody);
  if (!parsed.success) {
    return null;
  }

  const bodyText = parsed.data.Body?.trim();
  if (!bodyText) {
    return null;
  }

  const from = parsed.data.WaId ?? (parsed.data.From ? normalizePhone(parsed.data.From) : null);
  if (!from) {
    return null;
  }

  return {
    from,
    text: bodyText,
    name: parsed.data.ProfileName
  };
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function twimlResponse(message?: string): string {
  if (!message) {
    return '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
  }
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(message)}</Message></Response>`;
}

async function processInboundMessage(payload: InboundPayload): Promise<{
  responseBody: Record<string, unknown>;
  replyText: string;
}> {
  const now = payload.timestamp ? new Date(payload.timestamp) : new Date();
  const isOwnerMode = isOwnerWhatsappNumber(payload.from);

  const customer = await upsertCustomerByWhatsapp(payload.from, payload.name);
  let monthlyIncomeCents = customer.monthlyIncomeCents;
  await logConversation(customer.id, 'inbound', payload.text, { from: payload.from });

  const taxId = extractTaxId(payload.text);
  if (taxId) {
    await setCustomerTaxId(customer.id, taxId);
  }

  // ── Roteamento Jardes (somente owner) ────────────────────────────────────
  if (isOwnerMode) {
    const isJardesCommand = /^jard[aes]s?\b/i.test(payload.text.trim());

    // Comando direto → Jardes responde sempre, independente do modo
    if (isJardesCommand) {
      const jardesReply = await handleJardesDirectCommand({ rawMessage: payload.text, ownerCustomerId: customer.id });
      return { replyText: jardesReply, responseBody: { ok: true, jardesHandled: true } };
    }

    // Comando de saída do modo Jardes → devolve para a Iara
    const isJardesExit =
      /\b(agora\s+(passa|é|vai|a)\s*(para|pra)\s*(a\s+)?iara|passa\s*(para|pra)\s*(a\s+)?iara)\b/i.test(payload.text) ||
      /\b(sai\s+do\s+(modo\s+)?jardes|deixa\s+(a\s+)?iara|volta\s*(para|pra)\s*(a\s+)?iara|iara\s+agora|agora\s+iara)\b/i.test(payload.text) ||
      /^(iara|ol[aá]\s+iara|oi\s+iara|fala\s+iara)\b/i.test(payload.text.trim()) ||
      /\b(bom\s+dia|boa\s+tarde|boa\s+noite|oi|ol[aá])\s+iara\b/i.test(payload.text) ||
      /\biara[\s,!.]*$/i.test(payload.text.trim());

    if (!isJardesExit) {
      // Resposta a proposta pendente do Jardes
      const pendingApproval = await getAwaitingApproval();
      if (pendingApproval) {
        const jardesReply = await processOwnerJardesResponse({
          ownerMessage: payload.text,
          pendingApproval,
          ownerCustomerId: customer.id
        });
        return { replyText: jardesReply, responseBody: { ok: true, jardesHandled: true } };
      }

      // Modo Jardes permanente — ativo enquanto a última resposta não-automática foi do Jardes
      const jardesMode = await isJardesModeActive(customer.id);
      if (jardesMode) {
        const jardesReply = await handleJardesDirectCommand({ rawMessage: payload.text, ownerCustomerId: customer.id });
        return { replyText: jardesReply, responseBody: { ok: true, jardesHandled: true } };
      }
    }

    // Quando é comando de saída explícito (não apenas "Iara" em uma saudação),
    // confirmamos a transição antes de deixar a Iara assumir
    const isExplicitExit =
      /\b(agora\s+(passa|é|vai|a)\s*(para|pra)\s*(a\s+)?iara|passa\s*(para|pra)\s*(a\s+)?iara)\b/i.test(payload.text) ||
      /\b(sai\s+do\s+(modo\s+)?jardes|deixa\s+(a\s+)?iara|volta\s*(para|pra)\s*(a\s+)?iara|iara\s+agora|agora\s+iara)\b/i.test(payload.text);
    if (isExplicitExit) {
      const handoff = 'Saindo de cena 👋 A Iara assume a partir de agora.';
      await logConversation(customer.id, 'outbound', handoff, { source: 'jardes-handoff' });
      return { replyText: handoff, responseBody: { ok: true, jardesHandled: true } };
    }
  }
  // ─────────────────────────────────────────────────────────────────────────

  let access = await evaluateCustomerAccess(customer.id, now);
  const ownerGrantAccessIntent = parseOwnerGrantAccessCommand(payload.text);
  const selectedPlanCode = detectExplicitPlanChoice(payload.text);

  // Injeta aprendizados do Jardes na resposta da IA
  let jardesKnowledge: string | undefined;
  {
    const entries = await getActiveKnowledgeEntries();
    if (entries.length > 0) {
      jardesKnowledge = entries.map(e => `• [${e.topic}] ${e.rule}`).join('\n');
    }
  }

  const conversationHistoryPromise = recentConversationMessages(customer.id, 8);
  const profileFactsPromise = isOwnerMode ? Promise.resolve([]) : getCustomerProfileFacts(customer.id);

  // Fire-and-forget: extrai fatos do perfil do cliente em background (não bloqueia resposta)
  if (!isOwnerMode) {
    void conversationHistoryPromise.then(msgs =>
      extractAndSaveProfileFacts({ customerId: customer.id, recentMessages: msgs })
    ).catch(() => { /* ignora falha — nunca bloqueia */ });
  }

  const supportReply = async (params: Parameters<typeof generateScopedSupportReply>[0]): Promise<string | null> => {
    const [conversationHistory, profileFacts] = await Promise.all([
      conversationHistoryPromise,
      profileFactsPromise
    ]);
    return generateScopedSupportReply({
      ...params,
      conversationHistory,
      replyMode: isOwnerMode ? 'owner' : 'default',
      jardesKnowledge,
      customerProfileFacts: formatProfileFactsForPrompt(profileFacts)
    });
  };

  if (!ownerGrantAccessIntent && selectedPlanCode && selectedPlanCode !== access.planCode) {
    await setCustomerPlan(customer.id, selectedPlanCode);
    access = await evaluateCustomerAccess(customer.id, now);
  }
  if (!access.allowed) {
    // Verificar convite de família ANTES do bloqueio — membros sem assinatura própria podem entrar
    const earlyFamilyJoin = parseFamilyJoinCode(payload.text);
    if (earlyFamilyJoin) {
      try {
        const joined = await joinFamilyGroupByCode({
          customerId: customer.id,
          inviteCode: earlyFamilyJoin.code
        });
        await activateFamilyMember(customer.id);
        access = await evaluateCustomerAccess(customer.id, now);
        const firstName = customer.name?.trim().split(/\s+/)[0] ?? 'você';
        const outText = [
          `Olá, ${firstName}! 👋 Você acabou de entrar no grupo familiar "${joined.groupName}". Bem-vindo(a)! ✅`,
          '',
          'Eu sou a Iara, sua assistente financeira no WhatsApp. O que posso fazer por você:',
          '• Anotar gastos e receitas (ex: "gastei 80 no mercado")',
          '• Mostrar seu resumo do mês',
          '• Criar lembretes de contas a vencer',
          '• Definir metas financeiras',
          '• Ver o resumo da família (ex: "resumo da família")',
          '',
          `Membros no grupo: ${joined.activeMembers}/${joined.memberLimit}${joined.remainingSlots > 0 ? ` — ainda tem ${joined.remainingSlots} vaga(s)` : ' — grupo completo'}.`,
          'Me manda qualquer dúvida ou já começa registrando um gasto! 🚀'
        ].join('\n');
        await logConversation(customer.id, 'outbound', outText, { intent: 'family-join-early', groupId: joined.groupId });
        return {
          replyText: outText,
          responseBody: { ok: true, to: payload.from, replyText: outText, familyGroup: joined }
        };
      } catch (error) {
        if (error instanceof Error && error.message === 'family_group_full') {
          const outText = [
            'O grupo familiar já está completo! 😕',
            'O dono do grupo pode adicionar vagas extras (R$29,90/mês por membro adicional).',
            'Peça ao dono para falar comigo sobre isso.'
          ].join('\n');
          await logConversation(customer.id, 'outbound', outText, { intent: 'family-join-early', status: 'full' });
          return {
            replyText: outText,
            responseBody: { ok: true, to: payload.from, replyText: outText, status: 'family_group_full' }
          };
        }
        if (!(error instanceof Error && error.message === 'family_group_not_found')) {
          throw error;
        }
        // Código não encontrado — cai no fluxo normal de onboarding
      }
    }

    if (isPlanConsultingRequest(payload.text)) {
      const staticAdvisor = planAdvisorMessage({
        customerName: customer.name,
        text: payload.text,
        currentPlanName: access.planName,
        messagesUsedThisMonth: access.messagesUsedThisMonth,
        monthlyMessageLimit: access.monthlyMessageLimit
      });
      const aiAdvisor = await supportReply({
        text: [
          payload.text,
          'Contexto extra:',
          '- Usuário ainda sem acesso ativo (onboarding comercial).',
          '- Explicar planos de forma consultiva, humana e sem menu robótico.',
          `- Plano pré-selecionado atual: ${access.planName ?? 'não definido'}.`,
          `- Catálogo oficial: ${planCatalogSummaryInline()}.`,
          '- Termine com orientação objetiva de ativação (escolher plano + enviar CPF/CNPJ), sem texto repetitivo.'
        ].join('\n'),
        customerName: customer.name,
        now,
        previousAssistantReply: await getLastOutboundMessage(customer.id),
        planName: access.planName,
        planCode: access.planCode,
        monthlyMessageLimit: access.monthlyMessageLimit,
        messagesUsedThisMonth: access.messagesUsedThisMonth,
        availablePlansSummary: planCatalogSummaryInline(),
        allowedFeaturesSummary: 'Sem recursos liberados até ativação do plano.',
        blockedFeaturesSummary: 'Todos os recursos ficam disponíveis após ativação do plano.',
        monthlyIncomeCents
      });
      const outText = [
        ...(selectedPlanCode ? [`Perfeito${customer.name ? `, ${customer.name}` : ''}! Plano ${getPlanDefinition(selectedPlanCode).name} selecionado ✅`] : []),
        aiAdvisor ?? staticAdvisor,
        '',
        'Para ativar agora: me manda seu CPF ou CNPJ que eu gero o Pix automático na hora.',
        'Pagamento confirmado = acesso liberado automaticamente ✅'
      ].join('\n');
      await logConversation(customer.id, 'outbound', outText, { access, intent: 'onboarding-plan-advisor' });
      return {
        replyText: outText,
        responseBody: {
          ok: true,
          blocked: true,
          to: payload.from,
          replyText: outText,
          access,
          autoCharge: null
        }
      };
    }

    if (isOnboardingQuestion(payload.text) && !taxId && selectedPlanCode === null && !isActivationRequest(payload.text)) {
      const aiOnboarding = await supportReply({
        text: [
          payload.text,
          'Contexto extra:',
          '- Usuário sem acesso ativo, em etapa comercial de ativação.',
          '- Explique de forma humana como funciona o bot e como escolher plano.',
          '- Mostre diferença entre planos quando fizer sentido (sem inventar valores).',
          `- Catálogo oficial: ${planCatalogSummaryInline()}.`,
          '- Feche com orientação de ativação clara e curta ("quero plano X" + CPF/CNPJ).'
        ].join('\n'),
        customerName: customer.name,
        now,
        previousAssistantReply: await getLastOutboundMessage(customer.id),
        planName: access.planName,
        planCode: access.planCode,
        monthlyMessageLimit: access.monthlyMessageLimit,
        messagesUsedThisMonth: access.messagesUsedThisMonth,
        availablePlansSummary: planCatalogSummaryInline(),
        allowedFeaturesSummary: 'Sem recursos liberados até ativação do plano.',
        blockedFeaturesSummary: 'Todos os recursos ficam disponíveis após ativação do plano.',
        monthlyIncomeCents
      });
      const outText = aiOnboarding ?? onboardingInfoMessage({
        now,
        customerName: customer.name,
        accessReason: access.reason,
        planCode: access.planCode,
        planName: access.planName,
        monthlyIncomeCents
      });
      await logConversation(customer.id, 'outbound', outText, { access, intent: 'onboarding-info' });
      return {
        replyText: outText,
        responseBody: {
          ok: true,
          blocked: true,
          to: payload.from,
          replyText: outText,
          access,
          autoCharge: null
        }
      };
    }

    if ((isActivationRequest(payload.text) || selectedPlanCode !== null) && !taxId) {
      const outText = activationPromptMessage({
        now,
        customerName: customer.name,
        planCode: access.planCode,
        planName: access.planName
      });
      await logConversation(customer.id, 'outbound', outText, { access, intent: 'onboarding-activation-request' });
      return {
        replyText: outText,
        responseBody: {
          ok: true,
          blocked: true,
          to: payload.from,
          replyText: outText,
          access,
          autoCharge: null
        }
      };
    }

    const autoChargeAttempt = await tryAutoCreateCharge({
      customerId: customer.id,
      accessReason: access.reason,
      dueDate: access.dueDate
    });

    // Tenta responder livremente qualquer pergunta antes de mostrar bloqueio
    const aiFreestyle = await supportReply({
      text: [
        payload.text,
        'Contexto extra:',
        '- Usuário ainda sem plano ativo. Pode tirar qualquer dúvida sobre finanças, o bot ou os planos.',
        '- Responda de forma humana e útil, sem travar na falta de plano.',
        '- Se a pergunta for financeira (ex: como economizar, como organizar gastos, dicas), responda com qualidade.',
        '- Ao final, convide gentilmente para ativar um plano com uma linha curta.',
        `- Catálogo: ${planCatalogSummaryInline()}.`
      ].join('\n'),
      customerName: customer.name,
      now,
      previousAssistantReply: await getLastOutboundMessage(customer.id),
      planName: access.planName,
      planCode: access.planCode,
      monthlyMessageLimit: access.monthlyMessageLimit,
      messagesUsedThisMonth: access.messagesUsedThisMonth,
      availablePlansSummary: planCatalogSummaryInline(),
      allowedFeaturesSummary: 'Sem recursos liberados até ativação do plano.',
      blockedFeaturesSummary: 'Todos os recursos ficam disponíveis após ativação.',
      monthlyIncomeCents
    });

    const outText = enrichBlockMessageWithCharge(
      aiFreestyle ?? blockMessage(access, { now, customerName: customer.name, selectedPlanCode }),
      autoChargeAttempt
    );
    await logConversation(customer.id, 'outbound', outText, { access, autoCharge: autoChargeAttempt });

    return {
      replyText: outText,
      responseBody: {
        ok: true,
        blocked: true,
        to: payload.from,
        replyText: outText,
        access,
        autoCharge: autoChargeAttempt
      }
    };
  }

  const currentPlanCode = access.planCode ?? 'essential';
  const currentPlanName = access.planName ?? 'Essencial';
  const planAiContext = aiPlanFeatureContext(currentPlanCode);

  const monthlyIncomeIntent = parseMonthlyIncomeIntent(payload.text);
  if (monthlyIncomeIntent) {
    if (monthlyIncomeIntent.action === 'skip') {
      await setCustomerMonthlyIncome(customer.id, null);
      monthlyIncomeCents = null;
      const outText = [
        'Perfeito, seguimos sem renda mensal por enquanto 👍',
        'Quando quiser ativar isso, me manda: "minha renda mensal é 4500".',
        'Mesmo sem renda, sigo te ajudando com limites, previsões e alertas.'
      ].join('\n');
      await logConversation(customer.id, 'outbound', outText, { intent: 'set-monthly-income', action: 'skip' });
      return {
        replyText: outText,
        responseBody: { ok: true, to: payload.from, replyText: outText, monthlyIncomeCents: null }
      };
    }

    await setCustomerMonthlyIncome(customer.id, monthlyIncomeIntent.amountCents);
    monthlyIncomeCents = monthlyIncomeIntent.amountCents;
    const outText = [
      `Perfeito! Renda mensal salva em ${centsToBrl(monthlyIncomeIntent.amountCents)} ✅`,
      'Com isso, eu consigo calibrar melhor previsões e limites para sua realidade.',
      'Se quiser, já te sugiro agora um limite semanal inteligente.'
    ].join('\n');
    await logConversation(customer.id, 'outbound', outText, {
      intent: 'set-monthly-income',
      monthlyIncomeCents: monthlyIncomeIntent.amountCents
    });
    return {
      replyText: outText,
      responseBody: { ok: true, to: payload.from, replyText: outText, monthlyIncomeCents: monthlyIncomeIntent.amountCents }
    };
  }

  const featureGuard = async (feature: PlanFeature): Promise<string | null> => {
    if (planHasFeature(currentPlanCode, feature)) {
      return null;
    }
    const outText = planLockedReply({ feature, planName: currentPlanName, customerName: customer.name });
    await logConversation(customer.id, 'outbound', outText, {
      intent: 'feature-locked',
      feature,
      planCode: currentPlanCode
    });
    return outText;
  };

  const preferredName = detectPreferredName(payload.text);
  if (preferredName) {
    await setCustomerPreferredName(customer.id, preferredName);
    const outText = [
      `Perfeito, ${preferredName}! 😊 Já salvei seu nome.`,
      'Quando quiser, me mande um gasto como: "hoje gastei 30 no mercado".',
      'Também posso te mostrar "gastos de hoje" e "resumo do mês".'
    ].join('\n');
    await logConversation(customer.id, 'outbound', outText, { intent: 'set-name' });
    return {
      replyText: outText,
      responseBody: { ok: true, to: payload.from, replyText: outText, intent: { type: 'set-name', name: preferredName } }
    };
  }

  const ownerAsksCustomersCount = isOwnerCustomersCountQuestion(payload.text);
  const ownerListNeedsContext = /\b(eles|esses|essas|aqueles|aquelas)\b/.test(normalizeHumanText(payload.text));
  const ownerListLastOutbound = ownerListNeedsContext ? await getLastOutboundMessage(customer.id) : null;
  const ownerAsksCustomersList = isOwnerCustomersListQuestion(payload.text, ownerListLastOutbound);
  if (ownerAsksCustomersCount || ownerAsksCustomersList) {
    if (!isOwnerWhatsappNumber(payload.from)) {
      const outText = 'Essa consulta é do dono do sistema. Se quiser, eu te mostro só os dados do seu próprio número.';
      await logConversation(customer.id, 'outbound', outText, { intent: 'owner-customers-access-denied' });
      return {
        replyText: outText,
        responseBody: { ok: true, to: payload.from, replyText: outText, denied: true }
      };
    }

    const contacts = await listActiveCustomerContacts(1000);
    const unique = normalizeOwnerContacts(contacts);
    const total = unique.length;

    if (ownerAsksCustomersList && ownerListNeedsContext && !ownerListLastOutbound) {
      const outText = [
        'Entendi seu pedido 👌',
        'Para evitar erro, confirma: você quer a lista dos números ativos com acesso no sistema?',
        'Se sim, me manda: "listar números ativos".'
      ].join('\n');
      await logConversation(customer.id, 'outbound', outText, {
        intent: 'owner-customers-list',
        status: 'needs-context-confirmation'
      });
      return {
        replyText: outText,
        responseBody: { ok: true, to: payload.from, replyText: outText, needsConfirmation: true }
      };
    }

    if (ownerAsksCustomersCount && !ownerAsksCustomersList) {
      const outText = total === 0
        ? 'No momento, não há nenhum número ativo com acesso ao sistema.'
        : `Hoje temos ${ownerCountLabel(total)} com acesso ao sistema. Se quiser, já te mostro a lista completa.`;
      await logConversation(customer.id, 'outbound', outText, { intent: 'owner-customers-count', total });
      return {
        replyText: outText,
        responseBody: { ok: true, to: payload.from, replyText: outText, total }
      };
    }

    if (total === 0) {
      const outText = contacts.length > 0
        ? 'Encontrei cadastros, mas nenhum com telefone válido para WhatsApp. Se quiser, eu te ajudo a corrigir isso no painel.'
        : 'No momento, não existe nenhum número ativo para listar.';
      await logConversation(customer.id, 'outbound', outText, { intent: 'owner-customers-list', total: 0 });
      return {
        replyText: outText,
        responseBody: { ok: true, to: payload.from, replyText: outText, total: 0, contacts: [] }
      };
    }

    const maxRows = 20;
    const shown = unique.slice(0, maxRows);
    const lines = shown.map((item, index) => `${index + 1}) ${ownerContactLabel(item)}`);
    const remaining = total - shown.length;
    const header = remaining > 0
      ? `Perfeito, Felipe. Aqui estão os ${shown.length} primeiros da sua base de ${ownerCountLabel(total)}:`
      : `Perfeito, Felipe. Aqui está a lista completa com ${ownerCountLabel(total)}:`;
    const outText = [
      header,
      ...lines,
      ...(remaining > 0 ? [`... e mais ${remaining} número${remaining === 1 ? '' : 's'}.`] : []),
      'Se quiser, eu detalho o status de qualquer número específico agora.'
    ].join('\n');
    await logConversation(customer.id, 'outbound', outText, {
      intent: 'owner-customers-list',
      total,
      shown: shown.length
    });
    return {
      replyText: outText,
      responseBody: {
        ok: true,
        to: payload.from,
        replyText: outText,
        total,
        contacts: shown.map((item) => ({
          id: item.id,
          name: item.name,
          whatsappNumber: item.whatsappNumber
        }))
      }
    };
  }

  // Owner operational-cost questions must run before generic greeting handling.
  // Example: "Bom dia, quanto estou gastando na OpenAI?" should not fall back to welcome.
  const ownerCostReply = await resolveOwnerCostIntentReply({
    text: payload.text,
    isOwner: isOwnerWhatsappNumber(payload.from),
    loadOverview: costOverview,
    loadPreviousMonthSnapshot: latestPreviousMonthCostsSnapshot
  });
  if (ownerCostReply) {
    if (ownerCostReply.denied) {
      await logConversation(customer.id, 'outbound', ownerCostReply.replyText, { intent: 'owner-costs-access-denied' });
      return {
        replyText: ownerCostReply.replyText,
        responseBody: { ok: true, to: payload.from, replyText: ownerCostReply.replyText, denied: true }
      };
    }

    if (ownerCostReply.error) {
      await logConversation(customer.id, 'outbound', ownerCostReply.replyText, {
        intent: 'owner-costs',
        status: 'error',
        error: ownerCostReply.failureReason ?? 'unknown_error'
      });
      return {
        replyText: ownerCostReply.replyText,
        responseBody: { ok: true, to: payload.from, replyText: ownerCostReply.replyText, error: true }
      };
    }

    await logConversation(customer.id, 'outbound', ownerCostReply.replyText, {
      intent: 'owner-costs',
      scopes: ownerCostReply.intent.scopes,
      window: ownerCostReply.intent.window
    });
    return {
      replyText: ownerCostReply.replyText,
      responseBody: {
        ok: true,
        to: payload.from,
        replyText: ownerCostReply.replyText,
        intent: { type: 'owner-costs', ...ownerCostReply.intent },
        totals: ownerCostReply.totals,
        providers: ownerCostReply.providers,
        period: ownerCostReply.period
      }
    };
  }

  if (ownerGrantAccessIntent) {
    if (!isOwnerWhatsappNumber(payload.from)) {
      const outText = 'Esse comando de liberação é exclusivo do número administrador.';
      await logConversation(customer.id, 'outbound', outText, { intent: 'owner-grant-access-denied' });
      return {
        replyText: outText,
        responseBody: { ok: true, to: payload.from, replyText: outText, denied: true }
      };
    }

    if (!ownerGrantAccessIntent.targetPhone && !ownerGrantAccessIntent.planCode) {
      const outText = [
        'Para eu liberar agora, me manda no formato:',
        '• "libera acesso 11968897750 no plano elite"',
        'Planos válidos: free, essencial, premium, família e elite.'
      ].join('\n');
      await logConversation(customer.id, 'outbound', outText, { intent: 'owner-grant-access', status: 'missing-phone-and-plan' });
      return {
        replyText: outText,
        responseBody: { ok: true, to: payload.from, replyText: outText, status: 'missing_phone_and_plan' }
      };
    }

    if (!ownerGrantAccessIntent.targetPhone) {
      const outText = 'Me passa o número (com DDD) que você quer liberar. Ex.: 11968897750.';
      await logConversation(customer.id, 'outbound', outText, { intent: 'owner-grant-access', status: 'missing-phone' });
      return {
        replyText: outText,
        responseBody: { ok: true, to: payload.from, replyText: outText, status: 'missing_phone' }
      };
    }

    if (!ownerGrantAccessIntent.planCode) {
      const outText = [
        `Recebi o número ${formatWhatsappNumberPretty(ownerGrantAccessIntent.targetPhone)}.`,
        'Agora me diga o plano para liberar: free, essencial, premium, família ou elite.'
      ].join('\n');
      await logConversation(customer.id, 'outbound', outText, {
        intent: 'owner-grant-access',
        status: 'missing-plan',
        targetPhone: ownerGrantAccessIntent.targetPhone
      });
      return {
        replyText: outText,
        responseBody: { ok: true, to: payload.from, replyText: outText, status: 'missing_plan' }
      };
    }

    const normalizedTargetPhone = normalizeWhatsappStorageNumber(ownerGrantAccessIntent.targetPhone);
    const existingTarget = await findCustomerByWhatsappLoose(normalizedTargetPhone);
    const target = existingTarget ?? await upsertCustomerByWhatsapp(normalizedTargetPhone);
    const targetId = target.id;
    const targetWhatsapp = existingTarget?.whatsappNumber ?? normalizedTargetPhone;

    const planResult = await setCustomerPlan(targetId, ownerGrantAccessIntent.planCode);
    if (planResult.planCode !== 'free') {
      await recordSubscriptionPayment({
        customerId: targetId,
        paymentType: 'setup',
        amountCents: 0,
        gateway: 'owner_manual_whatsapp',
        externalReference: `owner-manual:${targetId}:${Date.now()}`,
        metadata: {
          source: 'owner_whatsapp_command',
          ownerWhatsapp: payload.from,
          grantedPlanCode: ownerGrantAccessIntent.planCode
        }
      });
    }

    // Envia boas-vindas ao cliente no número liberado
    void sendWelcomeActivationMessage({
      to: targetWhatsapp,
      customerName: existingTarget?.name ?? null,
      planCode: planResult.planCode
    });

    const outText = [
      `Fechado ✅ acesso liberado para ${formatWhatsappNumberPretty(targetWhatsapp)}.`,
      `Plano aplicado: ${planResult.planName}.`,
      'Mensagem de boas-vindas enviada para o cliente. A partir de agora ele já pode usar a Iara normalmente.'
    ].join('\n');

    await logConversation(customer.id, 'outbound', outText, {
      intent: 'owner-grant-access',
      status: 'ok',
      targetCustomerId: targetId,
      targetPhone: targetWhatsapp,
      planCode: planResult.planCode
    });

    return {
      replyText: outText,
      responseBody: {
        ok: true,
        to: payload.from,
        replyText: outText,
        target: {
          id: targetId,
          whatsappNumber: targetWhatsapp
        },
        plan: planResult
      }
    };
  }

  if (!isOwnerMode && access.allowed) {
    const wantsResumeOnboarding = /\b(retomar onboarding|continuar onboarding|voltar onboarding)\b/i.test(payload.text);
    if (wantsResumeOnboarding) {
      const resumed = await resumeSmartOnboarding(customer.id);
      if (resumed) {
        await logConversation(customer.id, 'outbound', resumed, { intent: 'onboarding-resume' });
        return {
          replyText: resumed,
          responseBody: { ok: true, to: payload.from, replyText: resumed, intent: { type: 'onboarding-resume' } }
        };
      }
    }

    if (!shouldBypassOnboardingForMessage(payload.text)) {
      const onboardingReply = await handleSmartOnboardingReply({
        customerId: customer.id,
        text: payload.text
      });
      if (onboardingReply) {
        await logConversation(customer.id, 'outbound', onboardingReply, { intent: 'onboarding-step' });
        return {
          replyText: onboardingReply,
          responseBody: { ok: true, to: payload.from, replyText: onboardingReply, intent: { type: 'onboarding-step' } }
        };
      }
    }
  }

  if (isGreetingMessage(payload.text)) {
    const lastOutbound = await getLastOutboundMessage(customer.id);
    const recentMessages = await recentConversationMessages(customer.id, 6);
    const recentInboundTexts = recentMessages
      .filter((entry) => entry.direction === 'inbound')
      .map((entry) => entry.message)
      .slice(0, 4);
    const aiGreeting = await supportReply({
      text: [
        payload.text,
        'Contexto extra:',
        '- O usuário está apenas cumprimentando.',
        '- Responda como humana, calorosa e curta.',
        '- NÃO envie menu grande de comandos.',
        isOwnerMode
          ? '- Modo dono: resposta curta e utilitária, sem CTA genérico.'
          : '- Se fizer sentido, feche com próximo passo financeiro curto e contextual (evite repetir "anotar gasto").'
      ].join('\n'),
      customerName: customer.name,
      now,
      previousAssistantReply: lastOutbound,
      recentUserMessages: recentInboundTexts,
      planName: currentPlanName,
      planCode: currentPlanCode,
      monthlyMessageLimit: access.monthlyMessageLimit,
      messagesUsedThisMonth: access.messagesUsedThisMonth,
      availablePlansSummary: planCatalogSummaryInline(),
      allowedFeaturesSummary: planAiContext.allowedFeaturesSummary,
      blockedFeaturesSummary: planAiContext.blockedFeaturesSummary,
      monthlyIncomeCents
    });
    const fallback = access.reason === 'trial_active'
      ? trialWelcomeMessage({
        now,
        customerName: customer.name,
        trialDaysLeft: access.trialDaysLeft,
        trialEndDate: access.trialEndDate,
        monthlyIncomeCents,
        ownerMode: isOwnerMode
      })
      : welcomeMessage(now, customer.name, monthlyIncomeCents, isOwnerMode);
    const candidate = aiGreeting ?? fallback;
    const outText = lastOutbound && normalizeReplyForComparison(lastOutbound) === normalizeReplyForComparison(candidate)
      ? varyRepeatedReply(candidate, { ownerMode: isOwnerMode })
      : candidate;
    await logConversation(customer.id, 'outbound', outText, { intent: 'welcome' });
    return {
      replyText: outText,
      responseBody: { ok: true, to: payload.from, replyText: outText, intent: { type: 'welcome' } }
    };
  }

  if (isCasualSmallTalkMessage(payload.text)) {
    const lastOutbound = await getLastOutboundMessage(customer.id);
    const recentMessages = await recentConversationMessages(customer.id, 6);
    const recentInboundTexts = recentMessages
      .filter((entry) => entry.direction === 'inbound')
      .map((entry) => entry.message)
      .slice(0, 4);
    const aiSmallTalk = await supportReply({
      text: [
        payload.text,
        'Contexto extra:',
        '- Conversa casual curta.',
        '- Responda natural como pessoa.',
        '- Evite texto robótico e sem lista longa.',
        isOwnerMode
          ? '- Modo dono: responda de forma direta, sem convite genérico.'
          : '- Se fizer sentido, direcione para um próximo passo financeiro objetivo sem repetir CTA padrão.'
      ].join('\n'),
      customerName: customer.name,
      now,
      previousAssistantReply: lastOutbound,
      recentUserMessages: recentInboundTexts,
      planName: currentPlanName,
      planCode: currentPlanCode,
      monthlyMessageLimit: access.monthlyMessageLimit,
      messagesUsedThisMonth: access.messagesUsedThisMonth,
      availablePlansSummary: planCatalogSummaryInline(),
      allowedFeaturesSummary: planAiContext.allowedFeaturesSummary,
      blockedFeaturesSummary: planAiContext.blockedFeaturesSummary,
      monthlyIncomeCents
    });
    const candidate = aiSmallTalk ?? smallTalkRedirectMessage(now, customer.name, monthlyIncomeCents, isOwnerMode);
    const outText = lastOutbound && normalizeReplyForComparison(lastOutbound) === normalizeReplyForComparison(candidate)
      ? varyRepeatedReply(candidate, { ownerMode: isOwnerMode })
      : candidate;
    await logConversation(customer.id, 'outbound', outText, { intent: 'small-talk-redirect' });
    return {
      replyText: outText,
      responseBody: { ok: true, to: payload.from, replyText: outText, intent: { type: 'small-talk-redirect' } }
    };
  }

  if (isPlanInfoRequest(payload.text)) {
    const currentPlan = getPlanDefinition(currentPlanCode);
    const unlocked = allPlanFeatures
      .filter((item) => planHasFeature(currentPlanCode, item))
      .map((item) => featureLabel(item));
    const used = access.messagesUsedThisMonth ?? 0;
    const limit = access.monthlyMessageLimit ?? 0;
    const remaining = limit > 0 ? Math.max(limit - used, 0) : 0;
    const fallback = [
      `📦 Seu plano atual: ${currentPlanName}`,
      `🤖 Nível de IA: ${aiTierLabel(currentPlan.aiTier)}.`,
      `📣 Proatividade: ${proactiveLevelLabel(currentPlan.proactiveLevel)}.`,
      `💬 Uso de mensagens no mês: ${used}/${limit} (restantes: ${remaining}).`,
      `✅ Recursos liberados: ${unlocked.join(', ')}.`,
      '',
      '📚 Catálogo de planos:',
      ...planCatalogLines(),
      'Se quiser upgrade, me diga: "quero plano premium" (ou família/elite).'
    ].join('\n');
    const recentMessages = await recentConversationMessages(customer.id, 6);
    const recentInboundTexts = recentMessages
      .filter((entry) => entry.direction === 'inbound')
      .map((entry) => entry.message)
      .slice(0, 4);
    const aiPlanInfo = await supportReply({
      text: [
        payload.text,
        'Contexto extra:',
        '- O usuário quer entender os detalhes do plano atual.',
        `- Plano atual: ${currentPlanName} (${currentPlanCode}).`,
        `- Nível da IA atual: ${aiTierLabel(currentPlan.aiTier)}.`,
        `- Proatividade atual: ${proactiveLevelLabel(currentPlan.proactiveLevel)}.`,
        `- Uso de mensagens no mês: ${used}/${limit} (restantes: ${remaining}).`,
        `- Recursos liberados agora: ${unlocked.join(', ')}.`,
        `- Catálogo de planos disponível: ${planCatalogSummaryInline()}.`,
        '- Responda como consultora financeira, com linguagem humana e sem menu robótico.',
        '- Explique o que ele já pode fazer agora no plano atual e qual próximo plano faz sentido pelo cenário.'
      ].join('\n'),
      customerName: customer.name,
      now,
      previousAssistantReply: await getLastOutboundMessage(customer.id),
      recentUserMessages: recentInboundTexts,
      planName: currentPlanName,
      planCode: currentPlanCode,
      monthlyMessageLimit: access.monthlyMessageLimit,
      messagesUsedThisMonth: access.messagesUsedThisMonth,
      availablePlansSummary: planCatalogSummaryInline(),
      allowedFeaturesSummary: planAiContext.allowedFeaturesSummary,
      blockedFeaturesSummary: planAiContext.blockedFeaturesSummary,
      monthlyIncomeCents
    });
    const outText = aiPlanInfo ?? fallback;
    await logConversation(customer.id, 'outbound', outText, { intent: 'plan-info', planCode: currentPlanCode });
    return {
      replyText: outText,
      responseBody: { ok: true, to: payload.from, replyText: outText, planCode: currentPlanCode, used, limit }
    };
  }

  if (isPricingQuestion(payload.text) || isPlanConsultingRequest(payload.text)) {
    const staticPlanAdvisor = planAdvisorMessage({
      customerName: customer.name,
      text: payload.text,
      currentPlanName,
      messagesUsedThisMonth: access.messagesUsedThisMonth,
      monthlyMessageLimit: access.monthlyMessageLimit
    });
    const aiPlanAdvisor = await supportReply({
      text: [
        payload.text,
        'Contexto extra:',
        '- O usuário está pedindo detalhes/dúvidas de plano.',
        `- Use APENAS os planos e limites aqui: ${planCatalogSummaryInline()}.`,
        isOwnerMode
          ? '- Modo dono: resposta curta e consultiva, sem CTA genérico.'
          : '- Explique com clareza; se fizer sentido, finalize com próximo passo curto e contextual.'
      ].join('\n'),
      customerName: customer.name,
      now,
      previousAssistantReply: await getLastOutboundMessage(customer.id),
      planName: currentPlanName,
      planCode: currentPlanCode,
      monthlyMessageLimit: access.monthlyMessageLimit,
      messagesUsedThisMonth: access.messagesUsedThisMonth,
      availablePlansSummary: planCatalogSummaryInline(),
      allowedFeaturesSummary: planAiContext.allowedFeaturesSummary,
      blockedFeaturesSummary: planAiContext.blockedFeaturesSummary,
      monthlyIncomeCents
    });
    const outText = aiPlanAdvisor ?? staticPlanAdvisor;
    await logConversation(customer.id, 'outbound', outText, { intent: 'pricing', planCode: currentPlanCode });
    return {
      replyText: outText,
      responseBody: { ok: true, to: payload.from, replyText: outText, intent: { type: 'pricing' } }
    };
  }

  if (isLimitsHowItWorksQuestion(payload.text)) {
    const fallback = limitsHowItWorksMessage({
      planCode: currentPlanCode,
      monthlyIncomeCents
    });
    const aiLimits = await supportReply({
      text: [
        payload.text,
        'Contexto extra:',
        '- O usuário quer entender como funcionam os limites.',
        '- Explique em tom humano, sem parecer texto técnico.',
        '- Traga um exemplo prático de limite diário/semanal.',
        isOwnerMode
          ? '- Modo dono: mantenha utilitário e objetivo, sem CTA genérico.'
          : '- Se fizer sentido, ofereça um próximo passo curto e contextual.'
      ].join('\n'),
      customerName: customer.name,
      now,
      previousAssistantReply: await getLastOutboundMessage(customer.id),
      planName: currentPlanName,
      planCode: currentPlanCode,
      monthlyMessageLimit: access.monthlyMessageLimit,
      messagesUsedThisMonth: access.messagesUsedThisMonth,
      availablePlansSummary: planCatalogSummaryInline(),
      allowedFeaturesSummary: planAiContext.allowedFeaturesSummary,
      blockedFeaturesSummary: planAiContext.blockedFeaturesSummary,
      monthlyIncomeCents
    });
    const outText = aiLimits ?? fallback;
    await logConversation(customer.id, 'outbound', outText, { intent: 'limits-how-it-works', planCode: currentPlanCode });
    return {
      replyText: outText,
      responseBody: { ok: true, to: payload.from, replyText: outText, intent: { type: 'limits-how-it-works' } }
    };
  }

  if (isOnboardingQuestion(payload.text)) {
    const lastOutbound = await getLastOutboundMessage(customer.id);
    const fallback = activeHowItWorksMessage({
      now,
      customerName: customer.name,
      trialActive: access.reason === 'trial_active',
      trialDaysLeft: access.trialDaysLeft,
      triggerText: payload.text,
      monthlyIncomeCents,
      ownerMode: isOwnerMode
    });
    const recentMessages = await recentConversationMessages(customer.id, 6);
    const recentInboundTexts = recentMessages
      .filter((entry) => entry.direction === 'inbound')
      .map((entry) => entry.message)
      .slice(0, 4);
    const aiOnboardingActive = await supportReply({
      text: [
        payload.text,
        'Contexto extra:',
        '- O usuário está perguntando como a Iara funciona.',
        '- Explique de forma simples, humana e objetiva.',
        '- Não enviar lista longa de comandos.',
        isOwnerMode
          ? '- Modo dono: resposta operacional, sem convite genérico.'
          : '- Se fizer sentido, feche com um convite prático curto e contextual.'
      ].join('\n'),
      customerName: customer.name,
      now,
      previousAssistantReply: lastOutbound,
      recentUserMessages: recentInboundTexts,
      planName: currentPlanName,
      planCode: currentPlanCode,
      monthlyMessageLimit: access.monthlyMessageLimit,
      messagesUsedThisMonth: access.messagesUsedThisMonth,
      availablePlansSummary: planCatalogSummaryInline(),
      allowedFeaturesSummary: planAiContext.allowedFeaturesSummary,
      blockedFeaturesSummary: planAiContext.blockedFeaturesSummary,
      monthlyIncomeCents
    });
    const candidate = aiOnboardingActive ?? fallback;
    const outText = lastOutbound && normalizeReplyForComparison(lastOutbound) === normalizeReplyForComparison(candidate)
      ? varyRepeatedReply(candidate, { ownerMode: isOwnerMode })
      : candidate;
    await logConversation(customer.id, 'outbound', outText, { intent: 'how-it-works-active' });
    return {
      replyText: outText,
      responseBody: { ok: true, to: payload.from, replyText: outText, intent: { type: 'how-it-works-active' } }
    };
  }

  if (isOwnerDailyReportScheduleQuestion(payload.text)) {
    const outText = isOwnerWhatsappNumber(payload.from)
      ? [
        `Relatório diário do coordenador: ${String(config.ownerDailyReportHour).padStart(2, '0')}:${String(config.ownerDailyReportMinute).padStart(2, '0')} (${config.defaultTimezone}).`,
        'Se quiser, eu já te entrego um resumo parcial agora mesmo.'
      ].join('\n')
      : 'O relatório diário automático é enviado para o número administrador. Para você, posso trazer um resumo agora sob demanda.';
    await logConversation(customer.id, 'outbound', outText, { intent: 'owner-daily-report-schedule' });
    return {
      replyText: outText,
      responseBody: { ok: true, to: payload.from, replyText: outText }
    };
  }

  const ownerStatusTarget = extractOwnerStatusQueryTarget(payload.text);
  if (ownerStatusTarget) {
    if (!isOwnerWhatsappNumber(payload.from)) {
      const outText = 'Esse tipo de consulta é restrito ao número administrador. Se quiser, eu te mostro seus próprios lançamentos de hoje.';
      await logConversation(customer.id, 'outbound', outText, { intent: 'owner-customer-status-denied' });
      return {
        replyText: outText,
        responseBody: { ok: true, to: payload.from, replyText: outText, denied: true }
      };
    }

    const targetCustomer = await findCustomerByWhatsappLoose(ownerStatusTarget.targetPhone);
    if (!targetCustomer) {
      const outText = `Não encontrei cadastro ativo para ${formatWhatsappNumberForReply(ownerStatusTarget.targetPhone)}.`;
      await logConversation(customer.id, 'outbound', outText, {
        intent: 'owner-customer-status',
        status: 'not-found',
        targetPhone: ownerStatusTarget.targetPhone
      });
      return {
        replyText: outText,
        responseBody: { ok: true, to: payload.from, replyText: outText, found: false }
      };
    }

    const snapshot = await customerDailyFinancialSnapshot(targetCustomer.id, now, config.defaultTimezone);
    const dateLabel = now.toLocaleDateString('pt-BR', { timeZone: config.defaultTimezone });
    const displayName = targetCustomer.name?.trim() || formatWhatsappNumberForReply(targetCustomer.whatsappNumber);
    const outText = snapshot.expenseCount === 0 && snapshot.incomeCount === 0
      ? `${displayName} não anotou nenhum gasto ou receita hoje (${dateLabel}).`
      : [
        `Hoje (${dateLabel}), ${displayName} registrou:`,
        `• Gastos: ${snapshot.expenseCount} lançamento(s), total ${centsToBrl(snapshot.expenseCents)}.`,
        `• Receitas: ${snapshot.incomeCount} lançamento(s), total ${centsToBrl(snapshot.incomeCents)}.`,
        'Se quiser, eu abro também o detalhamento por categoria desse número.'
      ].join('\n');
    await logConversation(customer.id, 'outbound', outText, {
      intent: 'owner-customer-status',
      status: 'ok',
      targetPhone: targetCustomer.whatsappNumber,
      targetCustomerId: targetCustomer.id
    });
    return {
      replyText: outText,
      responseBody: {
        ok: true,
        to: payload.from,
        replyText: outText,
        target: {
          id: targetCustomer.id,
          name: targetCustomer.name,
          whatsappNumber: targetCustomer.whatsappNumber
        },
        snapshot
      }
    };
  }

  if (isTodayExpenseRequest(payload.text)) {
    const summary = await dailyExpenseSummary(customer.id, now, config.defaultTimezone);
    const dateLabel = now.toLocaleDateString('pt-BR', { timeZone: config.defaultTimezone });
    const decisionLines = await buildDecisionLines({
      customerId: customer.id,
      now,
      planCode: currentPlanCode
    });

    let outText: string;
    if (summary.items.length === 0) {
      outText = `Hoje (${dateLabel}) ainda não encontrei gastos registrados. 👀`;
    } else {
      const lines = summary.items.slice(0, 12).map((item, index) => {
        const hour = new Date(item.occurredAt).toLocaleTimeString('pt-BR', {
          hour: '2-digit',
          minute: '2-digit',
          timeZone: config.defaultTimezone
        });
        return `${index + 1}. ${hour} | ${decorateCategory(item.category)} | ${centsToBrl(item.amountCents)}`;
      });
      if (summary.items.length > 12) {
        lines.push(`... e mais ${summary.items.length - 12} lançamento(s).`);
      }

      outText = [
        `📋 Gastos de hoje (${dateLabel}):`,
        '# | Hora | Categoria | Valor',
        ...lines,
        `Total do dia: ${centsToBrl(summary.totalExpenseCents)}`,
        ...decisionLines,
        ...(!isOwnerMode ? [decisionQuestionByPlan(currentPlanCode)] : [])
      ].join('\n');
    }

    await logConversation(customer.id, 'outbound', outText, { intent: 'daily-summary' });
    return {
      replyText: outText,
      responseBody: { ok: true, to: payload.from, replyText: outText, summary }
    };
  }

  const categorySpendQuestion = parseCategorySpendQuestion(payload.text);
  if (categorySpendQuestion) {
    const reference = now;
    const month = reference.getMonth() + 1;
    const year = reference.getFullYear();
    const summary = await monthlySummary(customer.id, month, year);

    const amountsByCanonical = new Map<string, number>();
    for (const row of summary.byCategory) {
      const canonical = canonicalCategory(row.category);
      amountsByCanonical.set(canonical, (amountsByCanonical.get(canonical) ?? 0) + row.amountCents);
    }

    const lines = categorySpendQuestion.categories.map((category) => {
      const amount = amountsByCanonical.get(category) ?? 0;
      return `• ${decorateCategory(category)}: ${centsToBrl(amount)}`;
    });
    const totalAsked = categorySpendQuestion.categories
      .reduce((acc, category) => acc + (amountsByCanonical.get(category) ?? 0), 0);

    const decisionLines = await buildDecisionLines({
      customerId: customer.id,
      now,
      planCode: currentPlanCode
    });

    const outText = [
      `📌 No mês ${String(month).padStart(2, '0')}/${year}, você gastou:`,
      ...lines,
      `Total (categorias pedidas): ${centsToBrl(totalAsked)}`,
      ...decisionLines,
      ...(!isOwnerMode ? [decisionQuestionByPlan(currentPlanCode)] : [])
    ].join('\n');

    await logConversation(customer.id, 'outbound', outText, {
      intent: 'category-spend-summary',
      categories: categorySpendQuestion.categories
    });

    return {
      replyText: outText,
      responseBody: {
        ok: true,
        to: payload.from,
        replyText: outText,
        summary: {
          month,
          year,
          categories: categorySpendQuestion.categories,
          totalAsked
        }
      }
    };
  }

  const normalizedText = normalizeHumanText(payload.text);
  const reminderLeadUpdate = parseReminderLeadUpdateCommand(payload.text);
  if (reminderLeadUpdate) {
    const locked = await featureGuard('reminders');
    if (locked) {
      return {
        replyText: locked,
        responseBody: { ok: true, to: payload.from, replyText: locked, blockedFeature: 'reminders' }
      };
    }

    const recentMessages = await recentConversationMessages(customer.id, 8);
    const reminderDraftFromContext = extractReminderDraftFromRecentInboundMessages(recentMessages, payload.text, now);
    const activeReminders = await listBillReminders(customer.id, now);

    if (isReminderCreateConfirmationFromContext(payload.text)) {
      const reminderDraft = reminderDraftFromContext;
      if (!reminderDraft) {
        const outText = [
          'Quero criar certinho sem risco de pegar um lembrete antigo 👀',
          'Me manda em uma frase completa com horário e objetivo.',
          'Exemplo: "me lembre hoje às 18:00 de ir para a faculdade".'
        ].join('\n');
        await logConversation(customer.id, 'outbound', outText, {
          intent: 'create-reminder-from-context-missing-draft'
        });
        return {
          replyText: outText,
          responseBody: { ok: true, to: payload.from, replyText: outText }
        };
      }

      const existing = findReminderByDraft(activeReminders, reminderDraft);

      const createdOrExisting = existing
        ? {
          id: existing.id,
          title: existing.title,
          dueDate: existing.effectiveDueDate,
          dueTime: existing.dueTime
        }
        : await createBillReminder({
          customerId: customer.id,
          title: reminderDraft.title,
          dueDate: reminderDraft.dueDate,
          dueTime: reminderDraft.dueTime,
          remindDaysBefore: reminderLeadUpdate.remindDaysBefore,
          remindMinutesBefore: reminderLeadUpdate.remindMinutesBefore,
          recurrence: reminderDraft.recurrence,
          amountCents: reminderDraft.amountCents
        });

      const updatedReminder = await updateBillReminderLeadById({
        customerId: customer.id,
        reminderId: createdOrExisting.id,
        remindDaysBefore: reminderLeadUpdate.remindDaysBefore,
        remindMinutesBefore: reminderLeadUpdate.remindMinutesBefore
      });

      const outText = updatedReminder
        ? [
          'Perfeito! Criei e ajustei seu lembrete ✅',
          `• Lembrete: ${updatedReminder.title}`,
          `• Vencimento: ${new Date(`${updatedReminder.dueDate}T12:00:00.000Z`).toLocaleDateString('pt-BR')}${updatedReminder.dueTime ? ` às ${updatedReminder.dueTime}` : ''}`,
          `• Nova antecedência: ${
            updatedReminder.remindMinutesBefore !== null
              ? `${updatedReminder.remindMinutesBefore} minuto(s) antes`
              : `${updatedReminder.remindDaysBefore} dia(s) antes`
          }`
        ].join('\n')
        : 'Não consegui ajustar esse lembrete agora. Se quiser, me manda novamente a frase completa.';

      await logConversation(customer.id, 'outbound', outText, {
        intent: 'create-reminder-from-context',
        reminderId: updatedReminder?.id
      });
      return {
        replyText: outText,
        responseBody: { ok: true, to: payload.from, replyText: outText }
      };
    }

    const focusedReminderId = await getLastReminderContextReminderId(customer.id);
    let targetDecision: ReminderLeadTargetDecision = {
      type: 'none'
    };

    let updatedReminder: Awaited<ReturnType<typeof updateLatestBillReminderLead>> = null;
    let usedDraftMatch = false;
    let createdFromContextDraft = false;

    const reminderMatchedByDraft = reminderDraftFromContext
      ? findReminderByDraft(activeReminders, reminderDraftFromContext)
      : null;

    if (reminderMatchedByDraft) {
      usedDraftMatch = true;
      updatedReminder = await updateBillReminderLeadById({
        customerId: customer.id,
        reminderId: reminderMatchedByDraft.id,
        remindDaysBefore: reminderLeadUpdate.remindDaysBefore,
        remindMinutesBefore: reminderLeadUpdate.remindMinutesBefore
      });
    }

    if (!updatedReminder) {
      targetDecision = selectReminderForLeadUpdate({
        activeReminders,
        focusedReminderId
      });

      if (targetDecision.type === 'update') {
        updatedReminder = await updateBillReminderLeadById({
          customerId: customer.id,
          reminderId: targetDecision.reminder.id,
          remindDaysBefore: reminderLeadUpdate.remindDaysBefore,
          remindMinutesBefore: reminderLeadUpdate.remindMinutesBefore
        });
      } else {
        const explicitContextReference = /\b(esse lembrete|este lembrete|esse aviso|so esse lembrete|só esse lembrete)\b/.test(normalizedText);
        const canCreateFromDraft =
          Boolean(reminderDraftFromContext) &&
          (targetDecision.type === 'none' || explicitContextReference);

        if (canCreateFromDraft && reminderDraftFromContext) {
          const created = await createBillReminder({
            customerId: customer.id,
            title: reminderDraftFromContext.title,
            dueDate: reminderDraftFromContext.dueDate,
            dueTime: reminderDraftFromContext.dueTime,
            remindDaysBefore: reminderLeadUpdate.remindDaysBefore,
            remindMinutesBefore: reminderLeadUpdate.remindMinutesBefore,
            recurrence: reminderDraftFromContext.recurrence,
            amountCents: reminderDraftFromContext.amountCents
          });
          createdFromContextDraft = true;
          updatedReminder = {
            id: created.id,
            title: created.title,
            dueDate: created.dueDate,
            dueTime: created.dueTime,
            remindDaysBefore: created.remindDaysBefore,
            remindMinutesBefore: created.remindMinutesBefore
          };
        }
      }
    }

    const outText = targetDecision.type === 'ambiguous' && !updatedReminder
      ? [
        'Quero ajustar certinho para não mexer no lembrete errado. 👀',
        'Tenho mais de um lembrete ativo. Me diga qual você quer ajustar (pode ser pelo nome):',
        ...targetDecision.options.map((item, index) => {
          const due = new Date(`${item.effectiveDueDate}T12:00:00.000Z`).toLocaleDateString('pt-BR');
          const dueWithTime = item.dueTime ? `${due} às ${item.dueTime}` : due;
          return `${index + 1}. ${item.title} (${dueWithTime})`;
        }),
        'Exemplo: "ajusta o lembrete tomar banho para 5 minutos antes".'
      ].join('\n')
      : updatedReminder
      ? createdFromContextDraft
        ? [
          'Fechado! Criei esse lembrete e já deixei o aviso no ponto ✅',
          `• Lembrete: ${updatedReminder.title}`,
          `• Vencimento: ${new Date(`${updatedReminder.dueDate}T12:00:00.000Z`).toLocaleDateString('pt-BR')}${updatedReminder.dueTime ? ` às ${updatedReminder.dueTime}` : ''}`,
          `• Nova antecedência: ${
            updatedReminder.remindMinutesBefore !== null
              ? `${updatedReminder.remindMinutesBefore} minuto(s) antes`
              : `${updatedReminder.remindDaysBefore} dia(s) antes`
          }`
        ].join('\n')
        : usedDraftMatch
          ? [
            'Perfeito! Ajustei o aviso do lembrete que você acabou de citar ✅',
            `• Lembrete: ${updatedReminder.title}`,
            `• Vencimento: ${new Date(`${updatedReminder.dueDate}T12:00:00.000Z`).toLocaleDateString('pt-BR')}${updatedReminder.dueTime ? ` às ${updatedReminder.dueTime}` : ''}`,
            `• Nova antecedência: ${
              updatedReminder.remindMinutesBefore !== null
                ? `${updatedReminder.remindMinutesBefore} minuto(s) antes`
                : `${updatedReminder.remindDaysBefore} dia(s) antes`
            }`
          ].join('\n')
          : [
            'Perfeito! Ajustei seu aviso ✅',
            `• Lembrete: ${updatedReminder.title}`,
            `• Vencimento: ${new Date(`${updatedReminder.dueDate}T12:00:00.000Z`).toLocaleDateString('pt-BR')}${updatedReminder.dueTime ? ` às ${updatedReminder.dueTime}` : ''}`,
            `• Nova antecedência: ${
              updatedReminder.remindMinutesBefore !== null
                ? `${updatedReminder.remindMinutesBefore} minuto(s) antes`
                : `${updatedReminder.remindDaysBefore} dia(s) antes`
            }`
          ].join('\n')
      : 'Ainda não encontrei lembrete ativo para ajustar. Se quiser, já crio um agora para você.';

    await logConversation(customer.id, 'outbound', outText, {
      intent: updatedReminder
        ? createdFromContextDraft
          ? 'update-reminder-lead-created-from-context'
          : usedDraftMatch
            ? 'update-reminder-lead-by-context-match'
            : 'update-reminder-lead'
        : targetDecision.type === 'ambiguous'
          ? 'update-reminder-lead-ambiguous'
          : 'update-reminder-lead-not-found',
      reminderId: updatedReminder?.id
    });
    return {
      replyText: outText,
      responseBody: { ok: true, to: payload.from, replyText: outText }
    };
  }

  const goalSetup = parseGoalCommand(payload.text, now);
  const goalDraft = parseGoalDraft(payload.text, now);
  if (goalSetup) {
    const locked = await featureGuard('goals');
    if (locked) {
      return {
        replyText: locked,
        responseBody: { ok: true, to: payload.from, replyText: locked, blockedFeature: 'goals' }
      };
    }

    const createdGoal = await createFinancialGoal({
      customerId: customer.id,
      title: goalSetup.title,
      targetCents: goalSetup.targetCents,
      deadlineDate: goalSetup.deadlineDate
    });
    const progress = await financialGoalsProgress(customer.id, now, config.defaultTimezone);
    const goal = progress.find((item) => item.id === createdGoal.id);

    let projectionLine = '';
    let riskLine = '';
    let adjustLine = '';
    if (goal) {
      const daysElapsed = daysBetweenInclusiveIso(goal.startDate, now);
      const avgSavedPerDay = daysElapsed > 0 ? Math.floor(goal.progressCents / daysElapsed) : 0;
      const projectedAtDeadline = goal.progressCents + (avgSavedPerDay * Math.max(goal.daysLeft, 0));
      if (projectedAtDeadline < goal.targetCents) {
        const projectedGap = goal.targetCents - projectedAtDeadline;
        const extraPerDay = goal.daysLeft > 0 ? Math.ceil(projectedGap / goal.daysLeft) : projectedGap;
        projectionLine = `🔮 Projeção: no ritmo atual, você chega em ${centsToBrl(projectedAtDeadline)} até o prazo.`;
        riskLine = `⚠️ Risco: pode faltar ${centsToBrl(projectedGap)} para bater sua meta.`;
        adjustLine = extraPerDay > 0
          ? `🛠️ Ajuste sugerido: aumente sua reserva em ~${centsToBrl(extraPerDay)}/dia (ou ${centsToBrl(goal.requiredPerWeekCents)}/semana).`
          : '';
      } else {
        projectionLine = `🔮 Projeção: mantendo esse ritmo, você alcança a meta antes do prazo.`;
        adjustLine = '🛠️ Sugestão: mantenha constância semanal para garantir a meta sem pressão no fim.';
      }
    }

    const outText = [
      `Meta criada com sucesso 🎯`,
      `• Objetivo: ${createdGoal.title}`,
      `• Meta: ${centsToBrl(createdGoal.targetCents)}`,
      `• Prazo: ${new Date(`${createdGoal.deadlineDate}T12:00:00.000Z`).toLocaleDateString('pt-BR')}`,
      goal
        ? `• Ritmo sugerido: ${centsToBrl(goal.requiredPerWeekCents)}/semana`
        : '',
      projectionLine,
      riskLine,
      adjustLine,
      'Vou te avisar quando seu ritmo de economia ficar abaixo do necessário.'
    ].filter(Boolean).join('\n');

    await logConversation(customer.id, 'outbound', outText, { intent: 'create-goal', goalId: createdGoal.id });
    return {
      replyText: outText,
      responseBody: {
        ok: true,
        to: payload.from,
        replyText: outText,
        goal: createdGoal
      }
    };
  }

  if (/\bmeta\b/.test(normalizedText)) {
    const locked = await featureGuard('goals');
    if (locked) {
      return {
        replyText: locked,
        responseBody: { ok: true, to: payload.from, replyText: locked, blockedFeature: 'goals' }
      };
    }

    const firstName = customer.name?.trim().split(/\s+/)[0] ?? 'você';
    const lastOutbound = await getLastOutboundMessage(customer.id);
    const recentMessages = await recentConversationMessages(customer.id, 6);
    const recentInboundTexts = recentMessages
      .filter((entry) => entry.direction === 'inbound')
      .map((entry) => entry.message)
      .slice(0, 4);

    const aiGoalClarification = async (contextLines: string[]): Promise<string | null> => supportReply({
      text: [
        payload.text,
        'Contexto extra:',
        '- O usuário quer criar uma meta, mas faltam dados.',
        '- Não repita menu longo; faça pergunta objetiva para completar a meta.',
        '- Se couber, ofereça lembrete da meta de forma natural (sem insistir).',
        ...contextLines
      ].join('\n'),
      customerName: customer.name,
      now,
      previousAssistantReply: lastOutbound,
      recentUserMessages: recentInboundTexts,
      planName: currentPlanName,
      planCode: currentPlanCode,
      monthlyMessageLimit: access.monthlyMessageLimit,
      messagesUsedThisMonth: access.messagesUsedThisMonth,
      availablePlansSummary: planCatalogSummaryInline(),
      allowedFeaturesSummary: planAiContext.allowedFeaturesSummary,
      blockedFeaturesSummary: planAiContext.blockedFeaturesSummary,
      monthlyIncomeCents
    });

    let outText: string;
    let intentLabel = 'create-goal-missing-fields';
    if (goalDraft?.targetCents && goalDraft.title && !goalDraft.deadlineDate) {
      const fallback = [
        `Perfeito, ${firstName}! Meta de ${centsToBrl(goalDraft.targetCents)} para "${goalDraft.title}" ficou ótima 🎯`,
        'Agora me diz o prazo para eu fechar isso certinho:',
        '• pode ser uma data (ex: 31/12/2026) ou',
        '• um período (ex: em 6 meses).',
        'Se quiser, também já deixo um lembrete da meta no caminho.'
      ].join('\n');
      const ai = await aiGoalClarification([
        `- Valor identificado: ${centsToBrl(goalDraft.targetCents)}.`,
        `- Objetivo identificado: ${goalDraft.title}.`,
        '- Campo faltando: prazo.'
      ]);
      outText = ai ?? fallback;
      intentLabel = 'create-goal-missing-deadline';
    } else if (goalDraft?.targetCents && !goalDraft.title) {
      const fallback = [
        `Boa, ${firstName}! Já peguei o valor da meta: ${centsToBrl(goalDraft.targetCents)}.`,
        'Agora me conta o objetivo dessa meta (ex: viagem, reserva, quitar dívida) e o prazo.'
      ].join('\n');
      const ai = await aiGoalClarification([
        `- Valor identificado: ${centsToBrl(goalDraft.targetCents)}.`,
        '- Campo faltando: objetivo.',
        '- Campo faltando: prazo.'
      ]);
      outText = ai ?? fallback;
      intentLabel = 'create-goal-missing-title-deadline';
    } else if (!goalDraft?.targetCents && goalDraft?.title) {
      const fallback = [
        `Perfeito, ${firstName}! Entendi que seu objetivo é "${goalDraft.title}".`,
        'Agora me manda o valor da meta e o prazo (data ou meses) para eu montar seu plano certinho.'
      ].join('\n');
      const ai = await aiGoalClarification([
        `- Objetivo identificado: ${goalDraft.title}.`,
        '- Campo faltando: valor.',
        '- Campo faltando: prazo.'
      ]);
      outText = ai ?? fallback;
      intentLabel = 'create-goal-missing-amount-deadline';
    } else {
      const fallback = [
        'Perfeito! Vamos criar sua meta 🎯',
        'Me mande assim:',
        '• "meta 5000 para viagem até 31/12/2026"',
        'ou',
        '• "quero meta de 3000 para quitar dívida em 6 meses"'
      ].join('\n');
      const ai = await aiGoalClarification([
        '- Não foi possível identificar valor/objetivo/prazo suficientes.',
        '- Pedir uma frase única com valor + objetivo + prazo.'
      ]);
      outText = ai ?? fallback;
    }

    const finalText = lastOutbound && normalizeReplyForComparison(lastOutbound) === normalizeReplyForComparison(outText)
      ? varyRepeatedReply(outText, { ownerMode: isOwnerMode })
      : outText;
    await logConversation(customer.id, 'outbound', finalText, { intent: intentLabel });
    return {
      replyText: finalText,
      responseBody: { ok: true, to: payload.from, replyText: finalText }
    };
  }

  if (isGoalProgressRequest(payload.text)) {
    const locked = await featureGuard('goals');
    if (locked) {
      return {
        replyText: locked,
        responseBody: { ok: true, to: payload.from, replyText: locked, blockedFeature: 'goals' }
      };
    }

    const goals = await financialGoalsProgress(customer.id, now, config.defaultTimezone);
    const outText = goals.length === 0
      ? [
        'Você ainda não tem metas ativas.',
        'Crie assim: "meta 5000 para viagem até 31/12/2026".'
      ].join('\n')
      : [
        '📈 Suas metas ativas:',
        ...goals.slice(0, 4).map((goal, index) => {
          const pct = Math.round(goal.progressRatio * 1000) / 10;
          return `${index + 1}) ${goal.title}: ${centsToBrl(goal.progressCents)} de ${centsToBrl(goal.targetCents)} (${pct}%). Faltam ${centsToBrl(goal.remainingCents)} em ${goal.daysLeft} dia(s).`;
        }),
        'Quer que eu te lembre semanalmente do progresso?'
      ].join('\n');

    await logConversation(customer.id, 'outbound', outText, { intent: 'goals-progress', count: goals.length });
    return {
      replyText: outText,
      responseBody: { ok: true, to: payload.from, replyText: outText, goals }
    };
  }

  const reminderCreate = parseReminderCreateCommand(payload.text, now);
  if (reminderCreate) {
    const locked = await featureGuard('reminders');
    if (locked) {
      return {
        replyText: locked,
        responseBody: { ok: true, to: payload.from, replyText: locked, blockedFeature: 'reminders' }
      };
    }

    const reminder = await createBillReminder({
      customerId: customer.id,
      title: reminderCreate.title,
      dueDate: reminderCreate.dueDate,
      dueTime: reminderCreate.dueTime,
      remindDaysBefore: reminderCreate.remindDaysBefore,
      remindMinutesBefore: reminderCreate.remindMinutesBefore,
      recurrence: reminderCreate.recurrence,
      amountCents: reminderCreate.amountCents
    });

    const dueDateLabel = new Date(`${reminder.dueDate}T12:00:00.000Z`).toLocaleDateString('pt-BR');
    const leadLabel = reminder.remindMinutesBefore !== null
      ? `${reminder.remindMinutesBefore} minuto(s) antes`
      : `${reminder.remindDaysBefore} dia(s) antes`;
    const outText = [
      'Lembrete criado ✅',
      `• Conta: ${reminder.title}`,
      `• Vencimento: ${dueDateLabel}${reminder.dueTime ? ` às ${reminder.dueTime}` : ''}`,
      `• Aviso: ${leadLabel}`,
      `• Recorrência: ${reminder.recurrence === 'monthly' ? 'mensal' : 'pontual'}`,
      reminder.amountCents ? `• Valor: ${centsToBrl(reminder.amountCents)}` : '• Valor: não informado',
      reminderCreate.needsLeadTimeConfirmation
        ? 'Se preferir outro tempo, eu ajusto agora (ex: "mudar aviso para 15 minutos antes").'
        : ''
    ].join('\n');

    await logConversation(customer.id, 'outbound', outText, { intent: 'create-reminder', reminderId: reminder.id });
    return {
      replyText: outText,
      responseBody: { ok: true, to: payload.from, replyText: outText, reminder }
    };
  }

  if (isReminderCreateIntentEvenIfMissingFields(payload.text)) {
    const locked = await featureGuard('reminders');
    if (locked) {
      return {
        replyText: locked,
        responseBody: { ok: true, to: payload.from, replyText: locked, blockedFeature: 'reminders' }
      };
    }

    const outText = [
      'Vamos cadastrar seu lembrete 📅',
      'Me mande assim:',
      '• "lembrete aluguel vence 10/04 lembrar 3 dias antes"',
      '• "lembrete cartão dia 15 todo mês"'
    ].join('\n');
    await logConversation(customer.id, 'outbound', outText, { intent: 'create-reminder-missing-fields' });
    return {
      replyText: outText,
      responseBody: { ok: true, to: payload.from, replyText: outText }
    };
  }

  if (isReminderListRequest(payload.text)) {
    const locked = await featureGuard('reminders');
    if (locked) {
      return {
        replyText: locked,
        responseBody: { ok: true, to: payload.from, replyText: locked, blockedFeature: 'reminders' }
      };
    }

    const reminders = await listBillReminders(customer.id, now);
    const outText = reminders.length === 0
      ? [
        'Você não tem lembretes ativos.',
        'Exemplo: "lembrete aluguel vence 10/04 lembrar 2 dias antes".'
      ].join('\n')
      : [
        '🧾 Contas e vencimentos:',
        ...reminders.slice(0, 8).map((item, index) => {
          const when = new Date(`${item.effectiveDueDate}T12:00:00.000Z`).toLocaleDateString('pt-BR');
          const amount = item.amountCents ? ` | ${centsToBrl(item.amountCents)}` : '';
          const lead = item.remindMinutesBefore !== null
            ? `${item.remindMinutesBefore} min antes`
            : `${item.remindDaysBefore} dia(s) antes`;
          const dueWithTime = item.dueTime ? `${when} às ${item.dueTime}` : when;
          return `${index + 1}) ${item.title} vence em ${dueWithTime} (faltam ${item.daysUntilDue} dia(s) | aviso ${lead})${amount}`;
        }),
        'Quer que eu crie mais algum lembrete?'
      ].join('\n');

    await logConversation(customer.id, 'outbound', outText, { intent: 'list-reminders', count: reminders.length });
    return {
      replyText: outText,
      responseBody: { ok: true, to: payload.from, replyText: outText, reminders }
    };
  }

  if (isReminderStatusRequest(payload.text)) {
    const locked = await featureGuard('reminders');
    if (locked) {
      return {
        replyText: locked,
        responseBody: { ok: true, to: payload.from, replyText: locked, blockedFeature: 'reminders' }
      };
    }

    const reminders = await listBillReminders(customer.id, now);
    const lastOutbound = await getLastOutboundMessage(customer.id);
    const recentMessages = await recentConversationMessages(customer.id, 6);
    const recentInboundTexts = recentMessages
      .filter((entry) => entry.direction === 'inbound')
      .map((entry) => entry.message)
      .slice(0, 4);

    const buildReminderAiReply = async (facts: string[]): Promise<string | null> => supportReply({
      text: [
        payload.text,
        'Contexto extra:',
        '- O usuário está tirando dúvida sobre lembretes.',
        '- Responda em tom humano, direto e com confirmação clara.',
        '- Não invente lembretes: use apenas os fatos abaixo.',
        ...facts,
        isOwnerMode
          ? '- Modo dono: mantenha resposta objetiva e sem CTA genérico.'
          : '- Se fizer sentido, feche com próximo passo curto e contextual.'
      ].join('\n'),
      customerName: customer.name,
      now,
      previousAssistantReply: lastOutbound,
      recentUserMessages: recentInboundTexts,
      planName: currentPlanName,
      planCode: currentPlanCode,
      monthlyMessageLimit: access.monthlyMessageLimit,
      messagesUsedThisMonth: access.messagesUsedThisMonth,
      availablePlansSummary: planCatalogSummaryInline(),
      allowedFeaturesSummary: planAiContext.allowedFeaturesSummary,
      blockedFeaturesSummary: planAiContext.blockedFeaturesSummary,
      monthlyIncomeCents
    });

    if (reminders.length === 0) {
      const fallback = [
        'Ainda não tenho nenhum lembrete ativo para você.',
        'Se quiser, já deixo um pronto agora. Exemplo:',
        '"me lembra que amanhã preciso comprar remédio".'
      ].join('\n');
      const aiReply = await buildReminderAiReply([
        '- Lembretes ativos encontrados: 0.'
      ]);
      const outText = aiReply ?? fallback;
      await logConversation(customer.id, 'outbound', outText, { intent: 'reminder-status', status: 'no-reminders' });
      return {
        replyText: outText,
        responseBody: { ok: true, to: payload.from, replyText: outText, reminders: [] }
      };
    }

    const dateHint = parseDateFlexible(payload.text, now);
    const scoped = dateHint
      ? reminders.filter((item) => item.effectiveDueDate === dateHint)
      : reminders;

    if (dateHint && scoped.length === 0) {
      const nextReminders = reminders
        .slice(0, 3)
        .map((item) => {
          const when = new Date(`${item.effectiveDueDate}T12:00:00.000Z`).toLocaleDateString('pt-BR');
          return `• ${item.title} (${when})`;
        });
      const fallback = [
        `Para ${new Date(`${dateHint}T12:00:00.000Z`).toLocaleDateString('pt-BR')}, não achei lembrete programado.`,
        'Os próximos lembretes ativos são:',
        ...nextReminders,
        'Se quiser, já crio um lembrete para essa data.'
      ].join('\n');
      const aiReply = await buildReminderAiReply([
        `- Data perguntada: ${dateHint}.`,
        `- Lembretes ativos totais: ${reminders.length}.`,
        '- Resultado: não existe lembrete para essa data específica.'
      ]);
      const outText = aiReply ?? fallback;
      await logConversation(customer.id, 'outbound', outText, {
        intent: 'reminder-status',
        status: 'date-not-found',
        dateHint
      });
      return {
        replyText: outText,
        responseBody: { ok: true, to: payload.from, replyText: outText, reminders: scoped }
      };
    }

    const reminderLines = scoped.slice(0, 5).map((item) => {
      const due = new Date(`${item.effectiveDueDate}T12:00:00.000Z`).toLocaleDateString('pt-BR');
      const amount = item.amountCents ? ` | ${centsToBrl(item.amountCents)}` : '';
      const lead = item.remindMinutesBefore !== null
        ? `${item.remindMinutesBefore} min antes`
        : `${item.remindDaysBefore} dia(s) antes`;
      const dueWithTime = item.dueTime ? `${due} às ${item.dueTime}` : due;
      return `• ${item.title} vence em ${dueWithTime} | aviso ${lead}${amount}`;
    });

    const fallback = [
      dateHint
        ? `Sim, vou te lembrar no prazo certo para ${new Date(`${dateHint}T12:00:00.000Z`).toLocaleDateString('pt-BR')} ✅`
        : 'Sim, seus lembretes estão ativos ✅',
      ...reminderLines,
      'Se quiser, ajusto o aviso para mais ou menos antecedência (ex: 1 ou 3 dias antes).'
    ].join('\n');
    const aiReply = await buildReminderAiReply([
      `- Lembretes ativos totais: ${reminders.length}.`,
      dateHint
        ? `- Data perguntada: ${dateHint}.`
        : '- Sem data específica na pergunta.',
      `- Lembretes que batem com a consulta: ${scoped.length}.`,
      ...scoped.slice(0, 5).map((item) => {
        const lead = item.remindMinutesBefore !== null
          ? `${item.remindMinutesBefore} min antes`
          : `${item.remindDaysBefore} dia(s) antes`;
        return `- ${item.title} | vence ${item.effectiveDueDate}${item.dueTime ? ` ${item.dueTime}` : ''} | aviso ${lead}.`;
      })
    ]);
    const outText = aiReply ?? fallback;

    await logConversation(customer.id, 'outbound', outText, {
      intent: 'reminder-status',
      status: 'ok',
      dateHint: dateHint ?? null,
      count: scoped.length
    });
    return {
      replyText: outText,
      responseBody: { ok: true, to: payload.from, replyText: outText, reminders: scoped }
    };
  }

  if (isInsightsRequest(payload.text)) {
    const locked = await featureGuard('insights');
    if (locked) {
      return {
        replyText: locked,
        responseBody: { ok: true, to: payload.from, replyText: locked, blockedFeature: 'insights' }
      };
    }

    const insights = await spendingInsights(customer.id, now, config.defaultTimezone);
    const monthLabel = `${String(insights.month).padStart(2, '0')}/${insights.year}`;
    const trend = insights.monthOverMonthPct === null
      ? 'Sem base suficiente para comparar com mês anterior.'
      : insights.monthOverMonthPct >= 0
        ? `Seus gastos subiram ${insights.monthOverMonthPct.toFixed(1)}% vs mês anterior.`
        : `Seus gastos caíram ${Math.abs(insights.monthOverMonthPct).toFixed(1)}% vs mês anterior.`;

    const outText = [
      `📊 Insights de ${monthLabel}:`,
      `• Despesas no mês: ${centsToBrl(insights.expenseMtdCents)}`,
      `• ${trend}`,
      insights.topCategory
        ? `• Categoria líder: ${decorateCategory(insights.topCategory.category)} (${centsToBrl(insights.topCategory.amountCents)} | ${insights.topCategory.sharePct.toFixed(1)}%)`
        : '• Ainda sem categoria líder no mês.',
      insights.topWeekday
        ? `• Dia com mais gasto: ${insights.topWeekday.weekday} (${centsToBrl(insights.topWeekday.amountCents)})`
        : '• Ainda sem padrão semanal identificado.',
      'Quer que eu te sugira um limite semanal com base nisso?'
    ].join('\n');

    await logConversation(customer.id, 'outbound', outText, { intent: 'spending-insights' });
    return {
      replyText: outText,
      responseBody: { ok: true, to: payload.from, replyText: outText, insights }
    };
  }

  if (isRecurringRequest(payload.text)) {
    const locked = await featureGuard('recurring');
    if (locked) {
      return {
        replyText: locked,
        responseBody: { ok: true, to: payload.from, replyText: locked, blockedFeature: 'recurring' }
      };
    }

    const recurring = await detectRecurringExpenses(customer.id, now, config.defaultTimezone);
    const outText = recurring.length === 0
      ? [
        'Ainda não encontrei gastos recorrentes claros.',
        'Quando houver mais histórico, eu te aviso assinaturas suspeitas automaticamente.'
      ].join('\n')
      : [
        '🔁 Possíveis gastos recorrentes detectados:',
        ...recurring.map((item, index) => {
          const nextDate = new Date(`${item.nextEstimatedDate}T12:00:00.000Z`).toLocaleDateString('pt-BR');
          return `${index + 1}) ${decorateCategory(item.category)} | ${centsToBrl(item.amountCentsMedian)} | ${item.occurrences}x | próximo ~ ${nextDate}`;
        }),
        'Se quiser, eu transformo isso em lembretes de vencimento.'
      ].join('\n');

    await logConversation(customer.id, 'outbound', outText, { intent: 'recurring-detection', count: recurring.length });
    return {
      replyText: outText,
      responseBody: { ok: true, to: payload.from, replyText: outText, recurring }
    };
  }

  if (isCashflowForecastRequest(payload.text)) {
    const locked = await featureGuard('cashflow');
    if (locked) {
      return {
        replyText: locked,
        responseBody: { ok: true, to: payload.from, replyText: locked, blockedFeature: 'cashflow' }
      };
    }

    const forecast = await forecastCashflowMonth(customer.id, now, config.defaultTimezone);
    const monthLabel = `${String(forecast.month).padStart(2, '0')}/${forecast.year}`;
    const outText = [
      `🔮 Previsão de saldo (${monthLabel}):`,
      `• Receita projetada: ${centsToBrl(forecast.projectedIncomeCents)}`,
      `• Despesa projetada: ${centsToBrl(forecast.projectedExpenseCents)}`,
      `• Saldo projetado: ${centsToBrl(forecast.projectedNetCents)}`,
      `• Contas a vencer no mês: ${centsToBrl(forecast.upcomingBillsCents)}`,
      `• Saldo após vencimentos: ${centsToBrl(forecast.projectedNetAfterBillsCents)}`,
      'Quer que eu te recomende um teto semanal para segurar esse saldo?'
    ].join('\n');

    await logConversation(customer.id, 'outbound', outText, { intent: 'cashflow-forecast' });
    return {
      replyText: outText,
      responseBody: { ok: true, to: payload.from, replyText: outText, forecast }
    };
  }

  const investmentSimulation = parseInvestmentSimulatorCommand(payload.text);
  if (investmentSimulation) {
    const locked = await featureGuard('investment_simulator');
    if (locked) {
      return {
        replyText: locked,
        responseBody: { ok: true, to: payload.from, replyText: locked, blockedFeature: 'investment_simulator' }
      };
    }

    const monthlyContribution = investmentSimulation.monthlyContributionCents / 100;
    const rate = investmentSimulation.monthlyRatePct / 100;
    const months = investmentSimulation.months;
    const futureValue = rate === 0
      ? monthlyContribution * months
      : monthlyContribution * ((Math.pow(1 + rate, months) - 1) / rate);
    const invested = monthlyContribution * months;
    const earnings = Math.max(futureValue - invested, 0);

    const outText = [
      '💰 Simulação rápida de investimento:',
      `• Aporte mensal: ${centsToBrl(investmentSimulation.monthlyContributionCents)}`,
      `• Prazo: ${months} mês(es)`,
      `• Taxa usada: ${investmentSimulation.monthlyRatePct.toFixed(2)}% ao mês`,
      `• Total investido: ${centsToBrl(Math.round(invested * 100))}`,
      `• Valor estimado final: ${centsToBrl(Math.round(futureValue * 100))}`,
      `• Rendimentos estimados: ${centsToBrl(Math.round(earnings * 100))}`,
      'Quer que eu simule também com outro valor mensal?'
    ].join('\n');

    await logConversation(customer.id, 'outbound', outText, { intent: 'investment-simulator' });
    return {
      replyText: outText,
      responseBody: { ok: true, to: payload.from, replyText: outText, investmentSimulation }
    };
  }

  if (isScoreRequest(payload.text)) {
    const locked = await featureGuard('health_score');
    if (locked) {
      return {
        replyText: locked,
        responseBody: { ok: true, to: payload.from, replyText: locked, blockedFeature: 'health_score' }
      };
    }

    const scoreData = await financialHealthScore(customer.id, now, config.defaultTimezone);
    const scoreText = scoreData.score >= 800
      ? 'Excelente fase! 🟢'
      : scoreData.score >= 600
        ? 'Boa evolução! 🟡'
        : 'Vamos subir esse placar juntos 💪';
    const outText = [
      `🧠 Seu score financeiro (${String(scoreData.month).padStart(2, '0')}/${scoreData.year}) é ${scoreData.score}/1000.`,
      scoreText,
      ...scoreData.components.map((item) => `• ${item.label}: ${item.value}/${item.max}`),
      'Quer que eu te diga o ajuste mais rápido para aumentar esse score esta semana?'
    ].join('\n');
    await logConversation(customer.id, 'outbound', outText, { intent: 'financial-score' });
    return {
      replyText: outText,
      responseBody: { ok: true, to: payload.from, replyText: outText, score: scoreData }
    };
  }

  if (isWeeklyScoreEvolutionRequest(payload.text)) {
    const locked = await featureGuard('health_score');
    if (locked) {
      return {
        replyText: locked,
        responseBody: { ok: true, to: payload.from, replyText: locked, blockedFeature: 'health_score' }
      };
    }

    const evolution = await weeklyFinancialHealthSeries({
      customerId: customer.id,
      referenceDate: now,
      timezone: config.defaultTimezone,
      weeks: 6
    });
    const latest = evolution.points[evolution.points.length - 1];
    const trendLabel = evolution.latestDelta > 0
      ? `subiu +${evolution.latestDelta}`
      : evolution.latestDelta < 0
        ? `caiu ${evolution.latestDelta}`
        : 'ficou estável';
    const outText = [
      `📈 Evolução semanal do seu score (6 semanas): ${scoreSparkline(evolution.points.map((p) => p.score))}`,
      `Score atual: ${latest?.score ?? 0}/1000 (${trendLabel} vs semana passada).`,
      ...evolution.points.map((point, index) => `${index + 1}) ${new Date(`${point.weekStartDate}T12:00:00.000Z`).toLocaleDateString('pt-BR')} a ${new Date(`${point.weekEndDate}T12:00:00.000Z`).toLocaleDateString('pt-BR')}: ${point.score}`),
      'Quer que eu te mande isso automaticamente toda segunda-feira?'
    ].join('\n');
    await logConversation(customer.id, 'outbound', outText, { intent: 'score-evolution-weekly' });
    return {
      replyText: outText,
      responseBody: { ok: true, to: payload.from, replyText: outText, evolution }
    };
  }

  if (isVisualMonthlyReportRequest(payload.text)) {
    const locked = await featureGuard('visual_monthly_report');
    if (locked) {
      return {
        replyText: locked,
        responseBody: { ok: true, to: payload.from, replyText: locked, blockedFeature: 'visual_monthly_report' }
      };
    }

    const month = now.getMonth() + 1;
    const year = now.getFullYear();
    const report = await monthlyVisualReportData({ customerId: customer.id, month, year });
    const mood = report.netCents >= 0 ? '💚' : '⚠️';
    const top = report.topCategory
      ? `${decorateCategory(report.topCategory.category)} (${report.topCategory.sharePct.toFixed(1)}%)`
      : 'sem categoria líder';
    const biggest = report.biggestExpense
      ? `${decorateCategory(report.biggestExpense.category)} ${centsToBrl(report.biggestExpense.amountCents)}`
      : 'sem gasto destaque';
    const trend = report.monthOverMonthExpensePct === null
      ? 'Sem comparação com mês anterior.'
      : report.monthOverMonthExpensePct > 0
        ? `Despesas +${report.monthOverMonthExpensePct.toFixed(1)}% vs mês anterior.`
        : report.monthOverMonthExpensePct < 0
          ? `Despesas -${Math.abs(report.monthOverMonthExpensePct).toFixed(1)}% vs mês anterior.`
          : 'Despesas estáveis vs mês anterior.';
    const outText = [
      `🎴 Relatório visual ${String(report.month).padStart(2, '0')}/${report.year}`,
      `${mood} Receitas: ${centsToBrl(report.totalIncomeCents)} | Despesas: ${centsToBrl(report.totalExpenseCents)} | Saldo: ${centsToBrl(report.netCents)}`,
      `🏆 Categoria campeã: ${top}`,
      `💸 Maior gasto: ${biggest}`,
      `📊 Tendência: ${trend}`,
      ...report.highlights.slice(0, 2).map((item) => `• ${item}`)
    ].join('\n');
    await logConversation(customer.id, 'outbound', outText, { intent: 'monthly-visual-report' });
    return {
      replyText: outText,
      responseBody: { ok: true, to: payload.from, replyText: outText, report }
    };
  }

  if (isStreakRequest(payload.text)) {
    const locked = await featureGuard('gamification');
    if (locked) {
      return {
        replyText: locked,
        responseBody: { ok: true, to: payload.from, replyText: locked, blockedFeature: 'gamification' }
      };
    }

    const [streak, unlockedNow] = await Promise.all([
      getCustomerStreak(customer.id, now, config.defaultTimezone),
      evaluateAndUnlockAchievements(customer.id, now, config.defaultTimezone)
    ]);
    const unlockedLines = unlockedNow.map((item) => `🏅 Nova conquista: ${item.title}`);
    const outText = [
      `🔥 Seu streak atual é de ${streak.currentStreakDays} dia(s) seguidos.`,
      `🏆 Seu melhor streak foi ${streak.bestStreakDays} dia(s).`,
      `📅 Você teve atividade em ${streak.activeDaysLast30} dia(s) nos últimos 30.`,
      ...unlockedLines,
      'Quer bater um novo recorde hoje? Me manda um lançamento agora.'
    ].join('\n');
    await logConversation(customer.id, 'outbound', outText, { intent: 'streak-status' });
    return {
      replyText: outText,
      responseBody: { ok: true, to: payload.from, replyText: outText, streak }
    };
  }

  if (isAchievementsRequest(payload.text)) {
    const locked = await featureGuard('gamification');
    if (locked) {
      return {
        replyText: locked,
        responseBody: { ok: true, to: payload.from, replyText: locked, blockedFeature: 'gamification' }
      };
    }

    const achievements = await listCustomerAchievements(customer.id);
    const outText = achievements.length === 0
      ? [
        'Você ainda não desbloqueou conquistas.',
        'Comece registrando gastos por alguns dias seguidos para liberar seus primeiros badges 🎮'
      ].join('\n')
      : [
        '🎮 Suas conquistas:',
        ...achievements.slice(0, 8).map((item, index) => `${index + 1}) ${item.title} — ${item.description}`),
        achievements.length > 8 ? `... e mais ${achievements.length - 8} conquista(s).` : '',
        'Bora desbloquear a próxima?'
      ].filter(Boolean).join('\n');
    await logConversation(customer.id, 'outbound', outText, {
      intent: 'achievements-list',
      total: achievements.length
    });
    return {
      replyText: outText,
      responseBody: { ok: true, to: payload.from, replyText: outText, achievements }
    };
  }

  const familyCreate = parseFamilyCreate(payload.text);
  if (familyCreate) {
    const locked = await featureGuard('family_mode');
    if (locked) {
      return {
        replyText: locked,
        responseBody: { ok: true, to: payload.from, replyText: locked, blockedFeature: 'family_mode' }
      };
    }

    const fallbackName = customer.name ? `Família ${customer.name}` : 'Minha Família';
    const group = await createFamilyGroup({
      ownerCustomerId: customer.id,
      name: familyCreate.name || fallbackName
    });
    const outText = [
      `👨‍👩‍👧‍👦 Grupo familiar pronto: ${group.name}`,
      `Código de convite: ${group.inviteCode}`,
      'Para entrar, a outra pessoa pode mandar: "entrar na família CÓDIGO".'
    ].join('\n');
    await logConversation(customer.id, 'outbound', outText, {
      intent: 'family-create',
      groupId: group.groupId
    });
    return {
      replyText: outText,
      responseBody: { ok: true, to: payload.from, replyText: outText, familyGroup: group }
    };
  }

  const familyJoin = parseFamilyJoinCode(payload.text);
  if (familyJoin) {
    const locked = await featureGuard('family_mode');
    if (locked) {
      return {
        replyText: locked,
        responseBody: { ok: true, to: payload.from, replyText: locked, blockedFeature: 'family_mode' }
      };
    }

    try {
      const joined = await joinFamilyGroupByCode({
        customerId: customer.id,
        inviteCode: familyJoin.code
      });
      const firstName = customer.name?.trim().split(/\s+/)[0] ?? 'você';
      const outText = [
        `Olá, ${firstName}! 👋 Vi que você entrou no grupo familiar "${joined.groupName}". Bem-vindo(a)! ✅`,
        '',
        'Eu sou a Iara, sua assistente financeira no WhatsApp. Aqui está o que posso fazer por você:',
        '• Anotar seus gastos e receitas (ex: "gastei 80 no mercado")',
        '• Mostrar seu resumo do mês',
        '• Criar lembretes de contas a vencer',
        '• Definir metas financeiras',
        '• Ver o resumo da família (ex: "resumo da família")',
        '',
        `Membros no grupo: ${joined.activeMembers}/${joined.memberLimit}${joined.remainingSlots > 0 ? ` (${joined.remainingSlots} vaga(s) sobrando)` : ''}.`,
        'Me manda qualquer dúvida ou já começa registrando um gasto! 🚀'
      ].join('\n');
      await logConversation(customer.id, 'outbound', outText, {
        intent: 'family-join',
        groupId: joined.groupId
      });
      return {
        replyText: outText,
        responseBody: { ok: true, to: payload.from, replyText: outText, familyGroup: joined }
      };
    } catch (error) {
      if (error instanceof Error && error.message === 'family_group_not_found') {
        const outText = 'Não encontrei esse código de família. Confere o código e tenta de novo.';
        await logConversation(customer.id, 'outbound', outText, { intent: 'family-join', status: 'not-found' });
        return {
          replyText: outText,
          responseBody: { ok: true, to: payload.from, replyText: outText, status: 'family_group_not_found' }
        };
      }
      if (error instanceof Error && error.message === 'family_group_full') {
        const outText = [
          'O grupo familiar já está lotado! 😕',
          'O dono do grupo pode comprar vagas extras (R$29,90/mês por membro adicional) para liberar mais membros.',
          'Peça ao dono para entrar em contato comigo sobre isso.'
        ].join('\n');
        await logConversation(customer.id, 'outbound', outText, { intent: 'family-join', status: 'full' });
        return {
          replyText: outText,
          responseBody: { ok: true, to: payload.from, replyText: outText, status: 'family_group_full' }
        };
      }
      throw error;
    }
  }

  const familySetLimit = parseFamilySetLimit(payload.text);
  if (familySetLimit) {
    const locked = await featureGuard('family_mode');
    if (locked) {
      return {
        replyText: locked,
        responseBody: { ok: true, to: payload.from, replyText: locked, blockedFeature: 'family_mode' }
      };
    }

    try {
      const limit = await upsertFamilySpendingLimit({
        actorCustomerId: customer.id,
        period: familySetLimit.period,
        amountCents: familySetLimit.amountCents
      });
      const outText = [
        `Fechado ✅ limite familiar ${periodLabel(limit.period)} definido em ${centsToBrl(limit.amountCents)}.`,
        'Vou alertar quando o grupo estiver perto de estourar esse teto.'
      ].join('\n');
      await logConversation(customer.id, 'outbound', outText, { intent: 'family-set-limit', period: limit.period });
      return {
        replyText: outText,
        responseBody: { ok: true, to: payload.from, replyText: outText, limit }
      };
    } catch (error) {
      if (error instanceof Error && error.message === 'family_owner_required') {
        const outText = 'Só o dono do grupo pode definir limite familiar.';
        await logConversation(customer.id, 'outbound', outText, { intent: 'family-set-limit', status: 'owner-required' });
        return {
          replyText: outText,
          responseBody: { ok: true, to: payload.from, replyText: outText, status: 'family_owner_required' }
        };
      }
      if (error instanceof Error && error.message === 'family_group_not_found') {
        const outText = 'Você ainda não está em uma família. Mande "criar família" primeiro.';
        await logConversation(customer.id, 'outbound', outText, { intent: 'family-set-limit', status: 'no-group' });
        return {
          replyText: outText,
          responseBody: { ok: true, to: payload.from, replyText: outText, status: 'family_group_not_found' }
        };
      }
      throw error;
    }
  }

  const familyClearLimit = parseFamilyClearLimit(payload.text);
  if (familyClearLimit) {
    const locked = await featureGuard('family_mode');
    if (locked) {
      return {
        replyText: locked,
        responseBody: { ok: true, to: payload.from, replyText: locked, blockedFeature: 'family_mode' }
      };
    }

    try {
      const removed = await clearFamilySpendingLimit({
        actorCustomerId: customer.id,
        period: familyClearLimit.period
      });
      const outText = removed.removed
        ? `Removi o limite familiar ${periodLabel(familyClearLimit.period)}.`
        : `Não havia limite familiar ${periodLabel(familyClearLimit.period)} ativo para remover.`;
      await logConversation(customer.id, 'outbound', outText, { intent: 'family-clear-limit', removed: removed.removed });
      return {
        replyText: outText,
        responseBody: { ok: true, to: payload.from, replyText: outText, removed }
      };
    } catch (error) {
      if (error instanceof Error && error.message === 'family_owner_required') {
        const outText = 'Só o dono do grupo pode remover limites familiares.';
        await logConversation(customer.id, 'outbound', outText, { intent: 'family-clear-limit', status: 'owner-required' });
        return {
          replyText: outText,
          responseBody: { ok: true, to: payload.from, replyText: outText, status: 'family_owner_required' }
        };
      }
      if (error instanceof Error && error.message === 'family_group_not_found') {
        const outText = 'Você ainda não está em uma família ativa.';
        await logConversation(customer.id, 'outbound', outText, { intent: 'family-clear-limit', status: 'no-group' });
        return {
          replyText: outText,
          responseBody: { ok: true, to: payload.from, replyText: outText, status: 'family_group_not_found' }
        };
      }
      throw error;
    }
  }

  if (isFamilyListLimitsRequest(payload.text)) {
    const locked = await featureGuard('family_mode');
    if (locked) {
      return {
        replyText: locked,
        responseBody: { ok: true, to: payload.from, replyText: locked, blockedFeature: 'family_mode' }
      };
    }

    const [limits, statuses] = await Promise.all([
      listFamilySpendingLimits(customer.id),
      familySpendingLimitStatuses({
        actorCustomerId: customer.id,
        referenceDate: now,
        timezone: config.defaultTimezone
      })
    ]);
    if (!limits.groupId) {
      const outText = 'Você ainda não está em um grupo familiar. Mande "criar família".';
      await logConversation(customer.id, 'outbound', outText, { intent: 'family-limits', status: 'no-group' });
      return {
        replyText: outText,
        responseBody: { ok: true, to: payload.from, replyText: outText, limits: [] }
      };
    }

    const actives = limits.items.filter((item) => item.isActive);
    const outText = actives.length === 0
      ? [
        'Seu grupo ainda não tem limites familiares ativos.',
        limits.role === 'owner'
          ? 'Exemplo: "limite família semanal 1800".'
          : 'Peça ao dono do grupo para definir um limite familiar.'
      ].join('\n')
      : [
        `Limites familiares (${limits.role === 'owner' ? 'dono' : 'membro'}):`,
        ...actives.map((item) => {
          const status = statuses.statuses.find((s) => s.period === item.period);
          const statusLabel = status?.status === 'near'
            ? ` (atenção: faltam ${centsToBrl(status.remainingCents)})`
            : status?.status === 'exceeded'
              ? ` (estourado em ${centsToBrl(Math.abs(status.remainingCents))})`
              : '';
          return `• ${periodEmoji(item.period)} ${periodLabel(item.period)}: ${centsToBrl(item.amountCents)}${statusLabel}`;
        })
      ].join('\n');
    await logConversation(customer.id, 'outbound', outText, {
      intent: 'family-limits',
      activeCount: actives.length
    });
    return {
      replyText: outText,
      responseBody: { ok: true, to: payload.from, replyText: outText, limits, statuses }
    };
  }

  if (isFamilySummaryRequest(payload.text)) {
    const locked = await featureGuard('family_mode');
    if (locked) {
      return {
        replyText: locked,
        responseBody: { ok: true, to: payload.from, replyText: locked, blockedFeature: 'family_mode' }
      };
    }

    const summary = await familyMonthlySummary(customer.id, now, config.defaultTimezone);
    if (!summary) {
      const outText = [
        'Você ainda não está em um grupo familiar.',
        'Para começar, mande: "criar família".'
      ].join('\n');
      await logConversation(customer.id, 'outbound', outText, { intent: 'family-summary', status: 'no-group' });
      return {
        replyText: outText,
        responseBody: { ok: true, to: payload.from, replyText: outText, summary: null }
      };
    }

    const categories = summary.byCategory.length > 0
      ? summary.byCategory.map((item) => `• ${decorateCategory(item.category)}: ${centsToBrl(item.amountCents)}`)
      : ['• Sem despesas em categorias neste mês.'];
    const memberRanking = summary.memberExpenses.length > 0
      ? summary.memberExpenses.map((item, index) => `${index + 1}) ${(item.name ?? 'Sem nome')}: ${centsToBrl(item.amountCents)}`)
      : ['Sem despesas por membro no período.'];
    const familyLimitLines = summary.limitStatuses.length > 0
      ? summary.limitStatuses.map((item) => {
        if (item.status === 'near') {
          return `• ${periodEmoji(item.period)} ${periodLabel(item.period)}: faltam ${centsToBrl(item.remainingCents)} para ${centsToBrl(item.limitCents)}.`;
        }
        if (item.status === 'exceeded') {
          return `• ${periodEmoji(item.period)} ${periodLabel(item.period)}: estourado em ${centsToBrl(Math.abs(item.remainingCents))} (limite ${centsToBrl(item.limitCents)}).`;
        }
        return `• ${periodEmoji(item.period)} ${periodLabel(item.period)}: ${centsToBrl(item.spentCents)} de ${centsToBrl(item.limitCents)}.`;
      })
      : ['• Sem limite familiar ativo.'];
    const outText = [
      `👨‍👩‍👧‍👦 Resumo da família ${String(summary.month).padStart(2, '0')}/${summary.year}:`,
      `• Receitas: ${centsToBrl(summary.totalIncomeCents)}`,
      `• Despesas: ${centsToBrl(summary.totalExpenseCents)}`,
      `• Saldo: ${centsToBrl(summary.netCents)}`,
      `• Membros: ${summary.members.map((m) => m.name || m.whatsappNumber).join(', ')}`,
      'Categorias:',
      ...categories,
      'Ranking de gastos do grupo:',
      ...memberRanking,
      'Status dos limites do grupo:',
      ...familyLimitLines
    ].join('\n');
    await logConversation(customer.id, 'outbound', outText, { intent: 'family-summary' });
    return {
      replyText: outText,
      responseBody: { ok: true, to: payload.from, replyText: outText, summary }
    };
  }

  if (isFamilyInfoRequest(payload.text)) {
    const locked = await featureGuard('family_mode');
    if (locked) {
      return {
        replyText: locked,
        responseBody: { ok: true, to: payload.from, replyText: locked, blockedFeature: 'family_mode' }
      };
    }

    const context = await getFamilyContextForCustomer(customer.id);
    const limitInfo = context
      ? await listFamilySpendingLimits(customer.id)
      : null;
    const outText = !context
      ? 'Você ainda não faz parte de um grupo familiar. Mande "criar família" para começar.'
      : [
        `Seu grupo: ${context.groupName}`,
        `Código de convite: ${context.inviteCode}`,
        `Seu papel: ${context.role === 'owner' ? 'dono(a)' : 'membro'}`,
        `Membros (${context.members.length}): ${context.members.map((m) => m.name || m.whatsappNumber).join(', ')}`,
        `Limites familiares ativos: ${limitInfo?.items.filter((item) => item.isActive).length ?? 0}`,
        context.role === 'owner'
          ? 'Como dono(a), você pode definir limites: "limite família semanal 2000".'
          : 'Somente o dono pode alterar limites do grupo.'
      ].join('\n');
    await logConversation(customer.id, 'outbound', outText, {
      intent: 'family-info',
      hasGroup: Boolean(context)
    });
    return {
      replyText: outText,
      responseBody: { ok: true, to: payload.from, replyText: outText, family: context }
    };
  }

  if (isFamilyLeaveRequest(payload.text)) {
    const locked = await featureGuard('family_mode');
    if (locked) {
      return {
        replyText: locked,
        responseBody: { ok: true, to: payload.from, replyText: locked, blockedFeature: 'family_mode' }
      };
    }

    const left = await leaveFamilyGroup(customer.id);
    const outText = left.left
      ? 'Você saiu do grupo familiar. Se quiser voltar, use um novo código de convite.'
      : 'Você não estava em nenhum grupo familiar ativo.';
    await logConversation(customer.id, 'outbound', outText, {
      intent: 'family-leave',
      left: left.left
    });
    return {
      replyText: outText,
      responseBody: { ok: true, to: payload.from, replyText: outText, left }
    };
  }

  const contextualCorrection = parseContextualCorrection(payload.text);
  if (contextualCorrection) {
    if (contextualCorrection.ambiguous) {
      const outText = [
        'Não entendi 100% 🤔',
        'Seria uma correção do seu último gasto?',
        'Se for isso, me manda assim:',
        '• "esse 158 foi de esfiha"',
        '• "corrige, era 158 e foi 32,50"'
      ].join('\n');
      await logConversation(customer.id, 'outbound', outText, { intent: 'contextual-correction', status: 'ambiguous' });
      return {
        replyText: outText,
        responseBody: { ok: true, to: payload.from, replyText: outText, intent: { type: 'contextual-correction', status: 'ambiguous' } }
      };
    }

    const corrected = await updateLastTransactionContext({
      customerId: customer.id,
      kind: 'expense',
      amountCents: contextualCorrection.amountCents,
      category: contextualCorrection.category,
      description: contextualCorrection.description
    });

    if (!corrected) {
      const amountLabel = contextualCorrection.amountCents ? centsToBrl(contextualCorrection.amountCents) : 'esse valor';
      const outText = [
        `Não achei um gasto com ${amountLabel} para corrigir. 🤔`,
        'Seria para ajustar o último gasto registrado?',
        'Você pode mandar: "corrige meu último gasto para 32,50 em alimentação".'
      ].join('\n');
      await logConversation(customer.id, 'outbound', outText, { intent: 'contextual-correction', status: 'not-found' });
      return {
        replyText: outText,
        responseBody: { ok: true, to: payload.from, replyText: outText, intent: { type: 'contextual-correction', status: 'not-found' } }
      };
    }

    const categoryLabel = decorateCategory(corrected.category);
    const detail = contextualCorrection.description ? ` (${contextualCorrection.description})` : '';
    const outText = [
      'Perfeito! Ajustei esse lançamento ✅',
      `Agora ficou: ${centsToBrl(corrected.amountCents)} em ${categoryLabel}${detail}.`
    ].join('\n');
    await logConversation(customer.id, 'outbound', outText, { intent: 'contextual-correction', correctedId: corrected.id });
    return {
      replyText: outText,
      responseBody: { ok: true, to: payload.from, replyText: outText, corrected }
    };
  }

  const lastOutbound = await getLastOutboundMessage(customer.id);
  const recentMessages = await recentConversationMessages(customer.id, 6);
  const recentInboundTexts = recentMessages
    .filter((entry) => entry.direction === 'inbound')
    .map((entry) => entry.message)
    .slice(0, 4);

  if (shouldConfirmDeleteLastFromContext({ text: payload.text, lastAssistantMessage: lastOutbound })) {
    const deleted = await deleteLastTransaction(customer.id, 'expense');
    const outText = deleted
      ? `Fechou, ${customer.name?.trim().split(/\s+/)[0] ?? 'você'} ✅ Apaguei seu último gasto (${centsToBrl(deleted.amountCents)} em ${decorateCategory(deleted.category)}). Se quiser, já me manda o valor correto e eu ajusto agora.`
      : 'Tentei apagar seu último gasto, mas não encontrei lançamento recente por aqui. Se quiser, te mostro os últimos gastos para escolher qual apagar.';
    await logConversation(customer.id, 'outbound', outText, {
      intent: 'delete-last-transaction-context-confirmed',
      confirmedBy: 'short-affirmative',
      deletedId: deleted?.id ?? null
    });
    return {
      replyText: outText,
      responseBody: {
        ok: true,
        to: payload.from,
        replyText: outText,
        deleted: deleted ?? null
      }
    };
  }

  // ── Open Finance (bank connection) intents ────────────────────────────────
  if (isConnectBankRequest(payload.text)) {
    const { isPluggyConfigured } = await import('../services/pluggy.js');
    if (!isPluggyConfigured()) {
      const outText = 'Open Finance ainda não está disponível. Em breve você poderá conectar seu banco aqui! 🏦';
      await logConversation(customer.id, 'outbound', outText, { intent: 'connect-bank', reason: 'not-configured' });
      return { replyText: outText, responseBody: { ok: true, to: payload.from, replyText: outText } };
    }
    const { getBankConnectionByCustomer, deleteBankConnection } = await import('../services/ledger.js');
    const { createConnectToken } = await import('../services/pluggy.js');
    const existing = await getBankConnectionByCustomer(customer.id);
    if (existing && existing.status === 'connected') {
      const outText = `Você já tem o *${existing.institutionName ?? 'seu banco'}* conectado! 🏦\n\nSe quiser trocar, me diga "desconectar banco" primeiro.`;
      await logConversation(customer.id, 'outbound', outText, { intent: 'connect-bank', reason: 'already-connected' });
      return { replyText: outText, responseBody: { ok: true, to: payload.from, replyText: outText } };
    }
    const webhookUrl = `${process.env.API_PUBLIC_URL ?? ''}/openfinance/webhook/pluggy`;
    const token = await createConnectToken({ webhookUrl });
    const link = `https://connect.pluggy.ai?token=${token}`;
    const outText = `🏦 *Conectar seu banco à Iara*\n\nClique no link abaixo, escolha seu banco e autorize o acesso. Leva menos de 1 minuto:\n\n${link}\n\n_O link expira em 30 minutos._`;
    await logConversation(customer.id, 'outbound', outText, { intent: 'connect-bank' });
    return { replyText: outText, responseBody: { ok: true, to: payload.from, replyText: outText } };
  }

  if (isDisconnectBankRequest(payload.text)) {
    const { getBankConnectionByCustomer, deleteBankConnection } = await import('../services/ledger.js');
    const { deleteItem } = await import('../services/pluggy.js');
    const conn = await getBankConnectionByCustomer(customer.id);
    if (!conn) {
      const outText = 'Não encontrei nenhum banco conectado na sua conta. 🤔';
      await logConversation(customer.id, 'outbound', outText, { intent: 'disconnect-bank', reason: 'not-found' });
      return { replyText: outText, responseBody: { ok: true, to: payload.from, replyText: outText } };
    }
    try { await deleteItem(conn.pluggyItemId); } catch { /* ignora erro Pluggy */ }
    await deleteBankConnection(customer.id);
    const outText = `Banco desconectado com sucesso! ✅\n\nSe quiser conectar novamente, é só me dizer "conectar banco".`;
    await logConversation(customer.id, 'outbound', outText, { intent: 'disconnect-bank' });
    return { replyText: outText, responseBody: { ok: true, to: payload.from, replyText: outText } };
  }

  if (isAskBankStatusRequest(payload.text)) {
    const { getBankConnectionByCustomer } = await import('../services/ledger.js');
    const conn = await getBankConnectionByCustomer(customer.id);
    let outText: string;
    if (!conn) {
      outText = 'Você ainda não tem um banco conectado. 🏦\n\nQuer conectar agora? É só me dizer "conectar banco"!';
    } else if (conn.status === 'connected') {
      outText = `Seu *${conn.institutionName ?? 'banco'}* está conectado e funcionando! ✅\n\nSuas transações são importadas automaticamente.`;
    } else {
      outText = `O status do seu banco é: *${conn.status}*. Se houver problema, me diga "desconectar banco" e tente conectar novamente.`;
    }
    await logConversation(customer.id, 'outbound', outText, { intent: 'ask-bank-status' });
    return { replyText: outText, responseBody: { ok: true, to: payload.from, replyText: outText } };
  }
  // ── fim Open Finance ──────────────────────────────────────────────────────

  const intent = await parseIntent(payload.text, now, {
    context: {
      lastAssistantMessage: lastOutbound,
      recentUserMessages: recentInboundTexts
    }
  });

  if (intent.type === 'register-transaction-missing-info') {
    const firstName = customer.name?.trim().split(/\s+/)[0] ?? 'você';
    const outText = await supportReply({
      text: [
        `O usuário quer registrar um gasto mas não informou o valor nem a categoria.`,
        `Responda de forma natural e humana pedindo essas informações em 1 linha só.`,
        `Exemplos: "Claro, ${firstName}! Me conta: quanto foi e em quê?" — "Boa! Quanto você gastou e com o quê?"`,
        `Não use frases robóticas nem bullets. Seja quente, direto, humano.`
      ].join('\n'),
      customerName: customer.name,
      now,
      previousAssistantReply: lastOutbound,
      recentUserMessages: recentInboundTexts
    }) ?? `Claro, ${firstName}! Me conta: quanto foi e em quê? 😊`;
    await logConversation(customer.id, 'outbound', outText, { intent: intent.type });
    return {
      replyText: outText,
      responseBody: { ok: true, to: payload.from, replyText: outText, intent }
    };
  }

  if (intent.type === 'confirm-transaction-action') {
    const amountLabel = intent.amountCents ? centsToBrl(intent.amountCents) : 'esse valor';
    const categoryLabel = intent.category ? ` em ${decorateCategory(intent.category)}` : '';
    const [askLine, hintLine] = await Promise.all([
      tpl(
        'confirm-transaction-ask',
        'Só para confirmar: você quer que eu registre {amount}{category}?',
        { amount: amountLabel, category: categoryLabel }
      ),
      tpl(
        'confirm-transaction-hint',
        'Se sim, me manda: "anota esse gasto".\nSe era só dúvida, me fala: "era pergunta".'
      )
    ]);
    const outText = [askLine, hintLine].join('\n');
    await logConversation(customer.id, 'outbound', outText, {
      intent: intent.type,
      reason: intent.reason
    });
    return {
      replyText: outText,
      responseBody: { ok: true, to: payload.from, replyText: outText, intent }
    };
  }

  if (intent.type === 'help' && intent.reason === 'sleep-farewell') {
    const firstName = customer.name?.trim().split(/\s+/)[0] ?? 'você';
    const outText = [
      `Boa noite, ${firstName}. Descansa bem 😴`,
      'Amanhã eu te chamo para organizarmos seus gastos com tranquilidade.',
      'Mais ou menos que horário você prefere que eu te procure?'
    ].join('\n');
    await logConversation(customer.id, 'outbound', outText, {
      intent: intent.type,
      reason: intent.reason
    });
    return {
      replyText: outText,
      responseBody: { ok: true, to: payload.from, replyText: outText, intent }
    };
  }

  if (intent.type === 'ask-current-total' || intent.type === 'ask-confirmation' || intent.type === 'ask-month-summary') {
    const month = now.getMonth() + 1;
    const year = now.getFullYear();
    const summary = await monthlySummary(customer.id, month, year);
    const totalItems = summary.byCategory.reduce((acc, item) => acc + (item.amountCents > 0 ? 1 : 0), 0);
    const fallbackText = [
      `Até agora, no mês ${String(month).padStart(2, '0')}/${year}, você tem ${centsToBrl(summary.totalExpenseCents)} em despesas e ${centsToBrl(summary.totalIncomeCents)} em receitas.`,
      totalItems > 0
        ? `Se quiser, eu te mostro o detalhamento por categoria agora.`
        : 'Ainda não encontrei despesas por categoria neste mês.',
      'Quer que eu abra esse detalhamento?'
    ].join('\n');
    const aiSummaryReply = await supportReply({
      text: [
        payload.text,
        'Contexto extra:',
        '- O usuário está consultando/confimando o estado atual dos dados (não é novo lançamento).',
        `- Mês de referência: ${String(month).padStart(2, '0')}/${year}.`,
        `- Despesas no mês: ${centsToBrl(summary.totalExpenseCents)}.`,
        `- Receitas no mês: ${centsToBrl(summary.totalIncomeCents)}.`,
        `- Total de categorias com gasto: ${totalItems}.`,
        '- Responda de forma humana e assertiva, sem texto robótico.',
        isOwnerMode
          ? '- Modo dono: responda exatamente o que foi perguntado, de forma direta e sem CTA genérico.'
          : '- Responda exatamente a pergunta do usuário primeiro; se fizer sentido, finalize com 1 próximo passo curto.'
      ].join('\n'),
      customerName: customer.name,
      now,
      previousAssistantReply: lastOutbound,
      recentUserMessages: recentInboundTexts,
      planName: currentPlanName,
      planCode: currentPlanCode,
      monthlyMessageLimit: access.monthlyMessageLimit,
      messagesUsedThisMonth: access.messagesUsedThisMonth,
      availablePlansSummary: planCatalogSummaryInline(),
      allowedFeaturesSummary: planAiContext.allowedFeaturesSummary,
      blockedFeaturesSummary: planAiContext.blockedFeaturesSummary,
      monthlyIncomeCents
    });
    const candidate = aiSummaryReply ?? fallbackText;
    const outText = lastOutbound && normalizeReplyForComparison(lastOutbound) === normalizeReplyForComparison(candidate)
      ? varyRepeatedReply(candidate, { ownerMode: isOwnerMode })
      : candidate;
    await logConversation(customer.id, 'outbound', outText, {
      intent: intent.type
    });
    return {
      replyText: outText,
      responseBody: { ok: true, to: payload.from, replyText: outText, intent, month, year }
    };
  }

  if (intent.type === 'ask-breakdown') {
    const summary = await monthlySummary(customer.id, intent.month, intent.year);
    const categories = summary.byCategory
      .filter((item) => item.amountCents > 0)
      .slice(0, 8)
      .map((item) => `• ${decorateCategory(item.category)}: ${centsToBrl(item.amountCents)}`);
    const outText = categories.length > 0
      ? [
        `Detalhamento ${String(intent.month).padStart(2, '0')}/${intent.year}:`,
        ...categories,
        'Se quiser, eu explico também o que mais pesou no seu mês.'
      ].join('\n')
      : `Ainda não há categorias com gastos em ${String(intent.month).padStart(2, '0')}/${intent.year}. Quer lançar um gasto agora?`;
    await logConversation(customer.id, 'outbound', outText, {
      intent: intent.type,
      month: intent.month,
      year: intent.year
    });
    return {
      replyText: outText,
      responseBody: { ok: true, to: payload.from, replyText: outText, intent }
    };
  }

  if (intent.type === 'ask-expense-period') {
    const outText = [
      'Claro! Qual período você quer consultar?',
      '',
      '1️⃣ Este mês',
      '2️⃣ Mês passado',
      '3️⃣ Esta semana',
      '4️⃣ Hoje',
      '5️⃣ Últimos 2 meses',
      '6️⃣ Últimos 3 meses'
    ].join('\n');
    await logConversation(customer.id, 'outbound', outText, { intent: intent.type });
    return {
      replyText: outText,
      responseBody: { ok: true, to: payload.from, replyText: outText, intent }
    };
  }

  if (intent.type === 'full-expense-list') {
    const tz = config.defaultTimezone ?? 'America/Sao_Paulo';
    const nowLocal = new Date(now.toLocaleString('en-US', { timeZone: tz }));
    const startOfDay = new Date(nowLocal);
    startOfDay.setHours(0, 0, 0, 0);

    let since: Date;
    let until: Date;
    let periodLabel: string;

    if (intent.period === 'today') {
      since = new Date(now.getTime() - (nowLocal.getTime() - startOfDay.getTime()));
      until = new Date(since.getTime() + 86400000);
      periodLabel = `Hoje (${String(nowLocal.getDate()).padStart(2, '0')}/${String(nowLocal.getMonth() + 1).padStart(2, '0')}/${nowLocal.getFullYear()})`;
    } else if (intent.period === 'this-week') {
      const dow = nowLocal.getDay();
      const monday = new Date(startOfDay.getTime() - (dow === 0 ? 6 : dow - 1) * 86400000);
      const diff = nowLocal.getTime() - startOfDay.getTime();
      since = new Date(now.getTime() - diff - (dow === 0 ? 6 : dow - 1) * 86400000);
      until = new Date(since.getTime() + 7 * 86400000);
      periodLabel = `Esta semana`;
    } else if (intent.period === 'this-month') {
      const m = nowLocal.getMonth() + 1;
      const y = nowLocal.getFullYear();
      since = new Date(`${y}-${String(m).padStart(2, '0')}-01T00:00:00`);
      until = new Date(m === 12 ? `${y + 1}-01-01T00:00:00` : `${y}-${String(m + 1).padStart(2, '0')}-01T00:00:00`);
      periodLabel = `${String(m).padStart(2, '0')}/${y}`;
    } else if (intent.period === 'last-month') {
      const m = nowLocal.getMonth() === 0 ? 12 : nowLocal.getMonth();
      const y = nowLocal.getMonth() === 0 ? nowLocal.getFullYear() - 1 : nowLocal.getFullYear();
      since = new Date(`${y}-${String(m).padStart(2, '0')}-01T00:00:00`);
      until = new Date(`${nowLocal.getFullYear()}-${String(nowLocal.getMonth() + 1).padStart(2, '0')}-01T00:00:00`);
      periodLabel = `${String(m).padStart(2, '0')}/${y}`;
    } else if (intent.period === 'last-2-months') {
      const curM = nowLocal.getMonth() + 1;
      const curY = nowLocal.getFullYear();
      const startM = curM <= 2 ? curM + 10 : curM - 2;
      const startY = curM <= 2 ? curY - 1 : curY;
      since = new Date(`${startY}-${String(startM).padStart(2, '0')}-01T00:00:00`);
      until = new Date(curM === 12 ? `${curY + 1}-01-01T00:00:00` : `${curY}-${String(curM + 1).padStart(2, '0')}-01T00:00:00`);
      periodLabel = `Últimos 2 meses`;
    } else {
      // last-3-months
      const curM = nowLocal.getMonth() + 1;
      const curY = nowLocal.getFullYear();
      const startM = curM <= 3 ? curM + 9 : curM - 3;
      const startY = curM <= 3 ? curY - 1 : curY;
      since = new Date(`${startY}-${String(startM).padStart(2, '0')}-01T00:00:00`);
      until = new Date(curM === 12 ? `${curY + 1}-01-01T00:00:00` : `${curY}-${String(curM + 1).padStart(2, '0')}-01T00:00:00`);
      periodLabel = `Últimos 3 meses`;
    }

    const transactions = await getTransactionList(customer.id, { since, until });

    if (transactions.length === 0) {
      const outText = `📋 Extrato — ${periodLabel}:\n\nNenhum lançamento encontrado neste período.`;
      await logConversation(customer.id, 'outbound', outText, { intent: intent.type, period: intent.period });
      return { replyText: outText, responseBody: { ok: true, to: payload.from, replyText: outText, intent } };
    }

    const totalExpenseCents = transactions.filter(t => t.kind === 'expense').reduce((s, t) => s + t.amountCents, 0);
    const totalIncomeCents = transactions.filter(t => t.kind === 'income').reduce((s, t) => s + t.amountCents, 0);

    const formatLine = (t: typeof transactions[0]): string => {
      const d = new Date(t.occurredAt);
      const localStr = d.toLocaleString('pt-BR', { timeZone: tz, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
      const [datePart, timePart] = localStr.split(', ');
      const prefix = t.kind === 'income' ? '💰' : '💸';
      return `${datePart} ${timePart ?? ''} — ${categoryEmoji(t.category)} ${t.category} — ${prefix} ${centsToBrl(t.amountCents)}`;
    };

    const displayed = transactions.slice(0, 50);
    const truncated = transactions.length > 50;

    const lines = [
      `📋 Extrato — ${periodLabel}:`,
      '',
      ...displayed.map(formatLine),
      ...(truncated ? [`\n(mostrando 50 de ${transactions.length} lançamentos)`] : []),
      '',
      `💸 Total gastos: ${centsToBrl(totalExpenseCents)}`,
      ...(totalIncomeCents > 0 ? [`💰 Total receitas: ${centsToBrl(totalIncomeCents)}`] : []),
      `📦 ${transactions.length} lançamento(s)`
    ];

    const outText = lines.join('\n');
    await logConversation(customer.id, 'outbound', outText, { intent: intent.type, period: intent.period, count: transactions.length });
    return { replyText: outText, responseBody: { ok: true, to: payload.from, replyText: outText, intent } };
  }

  if (intent.type === 'set-savings-goal') {
    const capacity = await getCustomerFinancialCapacity(customer.id);
    const deadlineDate = new Date(intent.deadlineIso + 'T23:59:59');
    const monthsRemaining = Math.max(
      1,
      (deadlineDate.getFullYear() - now.getFullYear()) * 12 + (deadlineDate.getMonth() - now.getMonth()) + 1
    );
    const idealMonthlyTargetCents = Math.ceil(intent.targetAmountCents / monthsRemaining);
    const surplusCents = capacity.avgMonthlySurplusCents;
    const feasible = surplusCents >= idealMonthlyTargetCents;
    const monthlyTargetCents = Math.min(idealMonthlyTargetCents, Math.max(surplusCents, 0));

    const goalId = await createSavingsGoal({
      customerId: customer.id,
      description: intent.description,
      targetCents: intent.targetAmountCents,
      deadlineDate: new Date(intent.deadlineIso + 'T12:00:00'),
      monthlyTargetCents: idealMonthlyTargetCents
    });

    const deadlineFmt = new Date(intent.deadlineIso + 'T12:00:00').toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
    const lines: string[] = [
      `🎯 Meta criada: *${intent.description}*`,
      `💰 Valor alvo: ${centsToBrl(intent.targetAmountCents)}`,
      `📅 Prazo: ${deadlineFmt} (${monthsRemaining} mes${monthsRemaining > 1 ? 'es' : ''})`,
      `📊 Meta mensal: ${centsToBrl(idealMonthlyTargetCents)}`,
      ''
    ];

    if (feasible) {
      lines.push(`✅ Seu histórico mostra sobra média de ${centsToBrl(surplusCents)}/mês — você consegue cumprir essa meta!`);
    } else if (surplusCents > 0) {
      const realisticMonths = Math.ceil(intent.targetAmountCents / surplusCents);
      lines.push(`⚠️ Sua sobra média é ${centsToBrl(surplusCents)}/mês. Para este valor, você precisaria de ~${realisticMonths} meses.`);
      lines.push(`Vou te acompanhar e avisar se os gastos estiverem ameaçando o objetivo.`);
    } else {
      lines.push(`⚠️ Seu histórico não mostra sobra clara ainda. Vou monitorar e te alertar se os gastos ameaçarem a meta.`);
    }

    lines.push('');
    lines.push(`Vou te acompanhar todo mês e avisar quando algo estiver fora do trilho. 💪`);

    const outText = lines.join('\n');
    await logConversation(customer.id, 'outbound', outText, { intent: intent.type, goalId });
    return { replyText: outText, responseBody: { ok: true, to: payload.from, replyText: outText, intent } };
  }

  if (intent.type === 'ask-savings-goal-status') {
    const goals = await getActiveSavingsGoals(customer.id);
    if (goals.length === 0) {
      const outText = `Você não tem nenhuma meta de poupança ativa no momento. 📭\n\nQuer criar uma? Me diz quanto quer guardar e para quando!`;
      await logConversation(customer.id, 'outbound', outText, { intent: intent.type });
      return { replyText: outText, responseBody: { ok: true, to: payload.from, replyText: outText, intent } };
    }

    const goal = goals[0];
    const progress = await getSavingsGoalMonthlyProgress({ customerId: customer.id, goalCreatedAt: goal.createdAt });
    const deadlineDate = goal.deadlineDate;
    const monthsRemaining = Math.max(
      1,
      (deadlineDate.getFullYear() - now.getFullYear()) * 12 + (deadlineDate.getMonth() - now.getMonth()) + 1
    );
    const projectedTotal = progress.avgMonthlySurplusCents * monthsRemaining;
    const onTrack = projectedTotal >= goal.targetCents;
    const deadlineFmt = deadlineDate.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });

    const lines = [
      `🎯 Meta: *${goal.description}*`,
      `💰 Alvo: ${centsToBrl(goal.targetCents)} até ${deadlineFmt}`,
      `📊 Meta mensal: ${centsToBrl(goal.monthlyTargetCents)}`,
      `📈 Sobra este mês: ${centsToBrl(progress.currentMonthSurplusCents)}`,
      `📉 Média histórica de sobra: ${centsToBrl(progress.avgMonthlySurplusCents)}`,
      '',
      onTrack
        ? `✅ Você está no caminho certo! Projetando ${centsToBrl(projectedTotal)} até o prazo.`
        : `⚠️ Risco de não bater a meta. Projetando ${centsToBrl(projectedTotal)} — faltam ${centsToBrl(goal.targetCents - projectedTotal)} para cobrir.`
    ];

    const outText = lines.join('\n');
    await logConversation(customer.id, 'outbound', outText, { intent: intent.type, goalId: goal.id });
    return { replyText: outText, responseBody: { ok: true, to: payload.from, replyText: outText, intent } };
  }

  if (intent.type === 'cancel-savings-goal') {
    const cancelled = await cancelActiveSavingsGoals(customer.id);
    const outText = cancelled > 0
      ? `Meta cancelada. ✅ Se quiser criar uma nova, é só me dizer quanto quer guardar e para quando!`
      : `Você não tem nenhuma meta ativa para cancelar. 📭`;
    await logConversation(customer.id, 'outbound', outText, { intent: intent.type, cancelled });
    return { replyText: outText, responseBody: { ok: true, to: payload.from, replyText: outText, intent } };
  }

  // ── Cofres familiares ────────────────────────────────────────────────────
  if (intent.type === 'set-family-vault') {
    let vaultResult: { vaultId: string; groupId: string } | null = null;
    try {
      const deadlineDate = new Date(intent.deadlineIso + 'T12:00:00');
      const deadlineDate2 = new Date(intent.deadlineIso + 'T23:59:59');
      const monthsRemaining = Math.max(
        1,
        (deadlineDate.getFullYear() - now.getFullYear()) * 12 + (deadlineDate.getMonth() - now.getMonth()) + 1
      );
      const monthlyTargetCents = Math.ceil(intent.targetAmountCents / monthsRemaining);
      vaultResult = await createFamilyVault({
        customerId: customer.id,
        description: intent.description,
        targetCents: intent.targetAmountCents,
        deadlineDate: deadlineDate2,
        monthlyTargetCents
      });
      const deadlineFmt = deadlineDate.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
      const outText = [
        `🏦 Cofre criado para a família: *${intent.description}*`,
        `💰 Alvo: ${centsToBrl(intent.targetAmountCents)} até ${deadlineFmt}`,
        `📊 Meta mensal da família: ${centsToBrl(monthlyTargetCents)}`,
        ``,
        `Todos os membros contribuem juntos. Vou monitorar e avisar se o ritmo estiver fora do trilho. 💪`
      ].join('\n');
      await logConversation(customer.id, 'outbound', outText, { intent: intent.type, vaultId: vaultResult.vaultId });
      return { replyText: outText, responseBody: { ok: true, to: payload.from, replyText: outText, intent } };
    } catch (err) {
      const isNoGroup = err instanceof Error && err.message === 'family_group_not_found';
      const outText = isNoGroup
        ? `Você precisa estar em um grupo familiar para criar cofres compartilhados. Crie um grupo primeiro com "criar grupo familiar"! 👨‍👩‍👧`
        : `Não consegui criar o cofre agora. Tente novamente.`;
      await logConversation(customer.id, 'outbound', outText, { intent: intent.type });
      return { replyText: outText, responseBody: { ok: true, to: payload.from, replyText: outText, intent } };
    }
  }

  if (intent.type === 'ask-family-vault-status') {
    const vaults = await getActiveFamilyVaults(customer.id);
    if (vaults.length === 0) {
      const outText = `A família não tem nenhum cofre ativo no momento. 📭\n\nQuer criar um? É só dizer: "cofre familiar de R$X para [objetivo] em [mês]"!`;
      await logConversation(customer.id, 'outbound', outText, { intent: intent.type });
      return { replyText: outText, responseBody: { ok: true, to: payload.from, replyText: outText, intent } };
    }

    const lines: string[] = [`🏦 *Cofres da família:*`, ``];
    for (const vault of vaults) {
      const progress = await getFamilyVaultProgress({ groupId: vault.groupId, vaultCreatedAt: vault.createdAt, now });
      const deadlineDate = vault.deadlineDate;
      const monthsRemaining = Math.max(
        1,
        (deadlineDate.getFullYear() - now.getFullYear()) * 12 + (deadlineDate.getMonth() - now.getMonth()) + 1
      );
      const projected = progress.avgMonthlySurplusCents * monthsRemaining;
      const onTrack = projected >= vault.targetCents;
      const deadlineFmt = deadlineDate.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
      lines.push(
        `🎯 *${vault.description}*`,
        `   Alvo: ${centsToBrl(vault.targetCents)} até ${deadlineFmt}`,
        `   Meta/mês: ${centsToBrl(vault.monthlyTargetCents)} | Sobra atual: ${centsToBrl(progress.currentMonthSurplusCents)}`,
        onTrack
          ? `   ✅ No caminho certo (projeção: ${centsToBrl(projected)})`
          : `   ⚠️ Em risco (projeção: ${centsToBrl(projected)}, faltam ${centsToBrl(vault.targetCents - projected)})`,
        ``
      );
    }

    const outText = lines.join('\n');
    await logConversation(customer.id, 'outbound', outText, { intent: intent.type, vaultCount: vaults.length });
    return { replyText: outText, responseBody: { ok: true, to: payload.from, replyText: outText, intent } };
  }

  if (intent.type === 'cancel-family-vault') {
    const cancelled = await cancelActiveFamilyVaults(customer.id);
    const outText = cancelled > 0
      ? `Cofre(s) da família cancelado(s). ✅`
      : `Não há cofres familiares ativos para cancelar. 📭`;
    await logConversation(customer.id, 'outbound', outText, { intent: intent.type, cancelled });
    return { replyText: outText, responseBody: { ok: true, to: payload.from, replyText: outText, intent } };
  }

  if (intent.type === 'ask-family-meeting') {
    const summary = await familyMonthlySummary(customer.id, now, config.defaultTimezone ?? 'America/Sao_Paulo');
    if (!summary) {
      const outText = `Você não está em um grupo familiar ainda. Crie um grupo para usar essa função! 👨‍👩‍👧`;
      await logConversation(customer.id, 'outbound', outText, { intent: intent.type });
      return { replyText: outText, responseBody: { ok: true, to: payload.from, replyText: outText, intent } };
    }

    const monthName = new Date(summary.year, summary.month - 1, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
    const topCategories = summary.byCategory.slice(0, 5)
      .map(c => `   • ${c.category}: ${centsToBrl(c.amountCents)}`).join('\n');
    const memberLines = summary.memberExpenses
      .map(m => `   • ${m.name ?? 'Membro'}: ${centsToBrl(m.amountCents)}`).join('\n');

    const statusLine = summary.netCents >= 0
      ? `✅ Saldo positivo: ${centsToBrl(summary.netCents)}`
      : `⚠️ Saldo negativo: ${centsToBrl(Math.abs(summary.netCents))}`;

    const outText = [
      `📋 *Reunião Financeira — ${monthName}*`,
      ``,
      `💰 Entradas: ${centsToBrl(summary.totalIncomeCents)}`,
      `💸 Saídas: ${centsToBrl(summary.totalExpenseCents)}`,
      `${statusLine}`,
      ``,
      `📊 *Top categorias:*`,
      topCategories || `   Sem dados`,
      ``,
      `👥 *Gastos por membro:*`,
      memberLines || `   Sem dados`,
      ``,
      `🎯 *Meta para o próximo mês:*`,
      summary.netCents < 0
        ? `   Cortar ${centsToBrl(Math.abs(summary.netCents))} dos gastos para equilibrar a casa.`
        : `   Destinar ${centsToBrl(Math.round(summary.netCents * 0.3))} para os cofres da família.`
    ].join('\n');

    await logConversation(customer.id, 'outbound', outText, { intent: intent.type, month: summary.month, year: summary.year });
    return { replyText: outText, responseBody: { ok: true, to: payload.from, replyText: outText, intent } };
  }

  if (intent.type === 'simulate-decision') {
    const categories = await getSpendingByCategory(customer.id, 3);
    const categorySummary = categories.length > 0
      ? categories.map(c => `${c.category}: média ${centsToBrl(c.avgMonthlyCents)}/mês`).join(', ')
      : 'sem histórico de gastos';

    const simulationReply = await supportReply({
      text: [
        payload.text,
        '',
        'Contexto financeiro do usuário (últimos 3 meses):',
        `Gastos por categoria: ${categorySummary}`,
        '',
        'Instruções para simular:',
        '- Responda a simulação de forma direta e objetiva.',
        '- Calcule o impacto real em reais por mês e no período pedido.',
        '- Se o usuário perguntar sobre cortar/reduzir uma categoria específica, mostre o quanto sobra por mês e em 12 meses.',
        '- Se a categoria não existir nos dados, diga que não há histórico e estime com base no que o usuário informou.',
        '- Finalize com 1 recomendação prática e concreta.',
        '- Use linguagem humana, direta, sem rodeios.',
        '- Máximo 6 linhas.'
      ].join('\n'),
      customerName: customer.name,
      now,
      previousAssistantReply: lastOutbound,
      recentUserMessages: recentInboundTexts,
      planName: currentPlanName,
      planCode: currentPlanCode,
      monthlyMessageLimit: access.monthlyMessageLimit,
      messagesUsedThisMonth: access.messagesUsedThisMonth,
      availablePlansSummary: planCatalogSummaryInline(),
      allowedFeaturesSummary: planAiContext.allowedFeaturesSummary,
      blockedFeaturesSummary: planAiContext.blockedFeaturesSummary,
      monthlyIncomeCents
    });

    const fallbackSimulation = categories.length === 0
      ? `Ainda não tenho histórico de gastos suficiente para simular. Registre alguns gastos e tente novamente!`
      : `Simulação pronta! Baseada na sua média dos últimos 3 meses:\n${categories.slice(0, 3).map(c => `• ${c.category}: ${centsToBrl(c.avgMonthlyCents)}/mês`).join('\n')}\nMe diga qual categoria ou valor você quer ajustar e eu calculo o impacto exato.`;

    const outText = simulationReply ?? fallbackSimulation;
    await logConversation(customer.id, 'outbound', outText, { intent: intent.type, query: intent.rawQuery });
    return { replyText: outText, responseBody: { ok: true, to: payload.from, replyText: outText, intent } };
  }

  if (intent.type === 'ask-couple-balance') {
    const summary = await familyMonthlySummary(customer.id, now, config.defaultTimezone ?? 'America/Sao_Paulo');
    if (!summary || summary.members.length < 2) {
      const outText = summary
        ? `Preciso de pelo menos 2 membros no grupo familiar para mostrar o balanço do casal. Convide seu parceiro(a)! 💑`
        : `Você não está em um grupo familiar ainda. Crie um grupo e convide seu parceiro(a) para usar o modo casal! 💑`;
      await logConversation(customer.id, 'outbound', outText, { intent: intent.type });
      return { replyText: outText, responseBody: { ok: true, to: payload.from, replyText: outText, intent } };
    }

    const sorted = [...summary.memberExpenses].sort((a, b) => b.amountCents - a.amountCents);
    const [first, second] = sorted;
    const diff = (first?.amountCents ?? 0) - (second?.amountCents ?? 0);
    const monthName = new Date(summary.year, summary.month - 1, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });

    const memberLines = sorted.map(m => `   • ${m.name ?? 'Membro'}: ${centsToBrl(m.amountCents)}`).join('\n');
    const balanceLine = diff === 0
      ? `   ✅ Gastos equilibrados entre vocês!`
      : `   ${first?.name ?? 'Membro 1'} gastou ${centsToBrl(diff)} a mais que ${second?.name ?? 'Membro 2'}.`;

    const outText = [
      `💑 *Balanço do Casal — ${monthName}*`,
      ``,
      `💸 *Gastos por pessoa:*`,
      memberLines,
      ``,
      balanceLine,
      ``,
      `📊 Total do grupo: ${centsToBrl(summary.totalExpenseCents)}`,
      `💰 Entradas: ${centsToBrl(summary.totalIncomeCents)}`,
      summary.netCents >= 0
        ? `✅ Saldo do casal: ${centsToBrl(summary.netCents)}`
        : `⚠️ Déficit do casal: ${centsToBrl(Math.abs(summary.netCents))}`
    ].join('\n');

    await logConversation(customer.id, 'outbound', outText, { intent: intent.type, month: summary.month, year: summary.year });
    return { replyText: outText, responseBody: { ok: true, to: payload.from, replyText: outText, intent } };
  }

  if (intent.type === 'ask-explanation' || intent.type === 'ask-projection-reason') {
    const forecast = await forecastCashflowMonth(customer.id, now, config.defaultTimezone);
    const fallbackText = [
      `Te explicando de forma direta: a projeção usa seu ritmo até hoje (${forecast.dayOfMonth}/${forecast.daysInMonth}).`,
      `Entradas no mês: ${centsToBrl(forecast.incomeMtdCents)} | Saídas: ${centsToBrl(forecast.expenseMtdCents)}.`,
      `Mantendo esse ritmo, a projeção final fica em ${centsToBrl(forecast.projectedNetAfterBillsCents)} (já considerando contas previstas).`,
      'Se quiser, eu te mostro exatamente o ajuste diário para virar esse cenário.'
    ].join('\n');
    const aiExplanationReply = await supportReply({
      text: [
        payload.text,
        'Contexto extra:',
        '- O usuário pediu explicação de cálculo/projeção.',
        `- Dia atual do mês: ${forecast.dayOfMonth}/${forecast.daysInMonth}.`,
        `- Entradas MTD: ${centsToBrl(forecast.incomeMtdCents)}.`,
        `- Saídas MTD: ${centsToBrl(forecast.expenseMtdCents)}.`,
        `- Saldo projetado após contas: ${centsToBrl(forecast.projectedNetAfterBillsCents)}.`,
        '- Responda de forma humana, clara e com certividade.',
        '- Não desvie do tema; explique o cálculo em linguagem simples e finalize com 1 ação prática.'
      ].join('\n'),
      customerName: customer.name,
      now,
      previousAssistantReply: lastOutbound,
      recentUserMessages: recentInboundTexts,
      planName: currentPlanName,
      planCode: currentPlanCode,
      monthlyMessageLimit: access.monthlyMessageLimit,
      messagesUsedThisMonth: access.messagesUsedThisMonth,
      availablePlansSummary: planCatalogSummaryInline(),
      allowedFeaturesSummary: planAiContext.allowedFeaturesSummary,
      blockedFeaturesSummary: planAiContext.blockedFeaturesSummary,
      monthlyIncomeCents
    });
    const candidate = aiExplanationReply ?? fallbackText;
    const outText = lastOutbound && normalizeReplyForComparison(lastOutbound) === normalizeReplyForComparison(candidate)
      ? varyRepeatedReply(candidate, { ownerMode: isOwnerMode })
      : candidate;
    await logConversation(customer.id, 'outbound', outText, {
      intent: intent.type
    });
    return {
      replyText: outText,
      responseBody: { ok: true, to: payload.from, replyText: outText, intent }
    };
  }

  if (intent.type === 'set-spending-limit-missing-amount') {
    const outText = [
      `Claro! Qual será o limite ${periodLabel(intent.period)}? 🙂`,
      `Você pode mandar assim: "limite ${periodLabel(intent.period)} 800".`
    ].join('\n');
    await logConversation(customer.id, 'outbound', outText, { intent: intent.type, period: intent.period });
    return {
      replyText: outText,
      responseBody: { ok: true, to: payload.from, replyText: outText, intent }
    };
  }

  if (intent.type === 'set-spending-limit') {
    const safeExecution = isSafeTransactionalExecution(intent, payload.text);
    if (!safeExecution.safe) {
      const outText = 'Entendi sua dúvida. Quer que eu defina um limite agora? Se sim, me manda no formato: "limite semanal 800".';
      await logConversation(customer.id, 'outbound', outText, {
        intent: intent.type,
        blockedWriteReason: safeExecution.reason
      });
      return {
        replyText: outText,
        responseBody: { ok: true, to: payload.from, replyText: outText, intent, blockedWriteReason: safeExecution.reason }
      };
    }

    const updated = await upsertSpendingLimit({
      customerId: customer.id,
      period: intent.period,
      amountCents: intent.amountCents
    });
    const promptLine = monthlyIncomePromptLine(monthlyIncomeCents);
    const limitOkText = await tpl(
      'spending-limit-ok',
      'Fechou! ✅ Limite {period} definido em {amount}.\nQuando você estiver perto do limite (ou passar), eu te aviso na hora.',
      { period: periodLabel(updated.period), amount: centsToBrl(updated.amountCents) }
    );
    const outText = [
      limitOkText,
      'Quer definir também os limites diário e mensal?',
      ...(promptLine ? [promptLine] : [])
    ].join('\n');
    await logConversation(customer.id, 'outbound', outText, { intent: intent.type, limit: updated });
    return {
      replyText: outText,
      responseBody: { ok: true, to: payload.from, replyText: outText, limit: updated }
    };
  }

  if (intent.type === 'clear-spending-limit') {
    const safeExecution = isSafeTransactionalExecution(intent, payload.text);
    if (!safeExecution.safe) {
      const outText = 'Parece que você está consultando. Se quiser remover limite, me manda: "remover limite semanal".';
      await logConversation(customer.id, 'outbound', outText, {
        intent: intent.type,
        blockedWriteReason: safeExecution.reason
      });
      return {
        replyText: outText,
        responseBody: { ok: true, to: payload.from, replyText: outText, intent, blockedWriteReason: safeExecution.reason }
      };
    }

    const removed = await clearSpendingLimit(customer.id, intent.period);
    const outText = removed
      ? `Pronto! Removi seu limite ${periodLabel(intent.period)}.`
      : `Não encontrei limite ${periodLabel(intent.period)} ativo para remover.`;
    await logConversation(customer.id, 'outbound', outText, { intent: intent.type, period: intent.period, removed });
    return {
      replyText: outText,
      responseBody: { ok: true, to: payload.from, replyText: outText, removed, period: intent.period }
    };
  }

  if (intent.type === 'list-spending-limits') {
    const limits = await listSpendingLimits(customer.id);
    const active = limits.filter((item) => item.isActive);
    const promptLine = monthlyIncomePromptLine(monthlyIncomeCents);
    const outText = active.length === 0
      ? [
        'Você ainda não tem limites ativos 🙂',
        'Exemplos para configurar:',
        '• "limite diário 80"',
        '• "limite semanal 450"',
        '• "limite mensal 1800"',
        'Quer que eu te sugira um limite com base nos seus gastos?',
        ...(promptLine ? [promptLine] : [])
      ].join('\n')
      : [
        'Seus limites ativos:',
        ...active.map((item) => `• ${periodEmoji(item.period)} ${periodLabel(item.period)}: ${centsToBrl(item.amountCents)}`),
        'Quer ajustar algum deles agora?',
        ...(promptLine ? [promptLine] : [])
      ].join('\n');
    await logConversation(customer.id, 'outbound', outText, { intent: intent.type, activeCount: active.length });
    return {
      replyText: outText,
      responseBody: { ok: true, to: payload.from, replyText: outText, limits: active }
    };
  }

  if (intent.type === 'register-transaction') {
    const safeExecution = isSafeTransactionalExecution(intent, payload.text);
    if (!safeExecution.safe) {
      const pastDateHintEarly = getPastDateRegistrationHint(payload.text);
      if (pastDateHintEarly) {
        const outText = [
          `Sim! Basta mencionar o dia direto na mensagem.`,
          `Exemplo: "${pastDateHintEarly} gastei 50 no mercado" — eu já registro com a data certa.`,
          `Também funciona com "ontem", "anteontem", "semana passada", ou uma data como "dia 10".`
        ].join('\n');
        await logConversation(customer.id, 'outbound', outText, { intent: intent.type, reason: 'past-date-registration-howto' });
        return {
          replyText: outText,
          responseBody: { ok: true, to: payload.from, replyText: outText, intent }
        };
      }
      const outText = [
        'Entendi como dúvida, então não registrei nada ainda.',
        `Se você quiser registrar, me manda de forma explícita: "gastei ${centsToBrl(intent.amountCents)} em ${intent.category}".`
      ].join('\n');
      await logConversation(customer.id, 'outbound', outText, {
        intent: intent.type,
        blockedWriteReason: safeExecution.reason
      });
      return {
        replyText: outText,
        responseBody: { ok: true, to: payload.from, replyText: outText, intent, blockedWriteReason: safeExecution.reason }
      };
    }

    await saveTransaction({
      customerId: customer.id,
      kind: intent.kind,
      amountCents: intent.amountCents,
      category: intent.category,
      description: intent.description,
      occurredAtIso: intent.occurredAtIso,
      sourceMessage: payload.text
    });

    const [unlockedAchievements, impulsePattern] = await Promise.all([
      planHasFeature(currentPlanCode, 'gamification')
        ? evaluateAndUnlockAchievements(customer.id, now, config.defaultTimezone)
        : Promise.resolve([]),
      intent.kind === 'expense'
        ? detectImpulsivePattern({
            customerId: customer.id,
            category: intent.category,
            amountCents: intent.amountCents,
            occurredAtIso: intent.occurredAtIso,
            timezone: config.defaultTimezone
          })
        : Promise.resolve(null)
    ]);

    const action = intent.kind === 'expense' ? 'gasto' : 'receita';
    const categoryLabel = decorateCategory(intent.category);
    const occurred = formatOccurredAtForReply(intent.occurredAtIso);
    const mainLine = await tpl(
      'register-transaction-ok',
      'Anotado! ✅ {action} de {amount} em {category}. Data do gasto: {dateLabel}. Horário: {timeLabel}.',
      {
        action,
        amount: centsToBrl(intent.amountCents),
        category: categoryLabel,
        dateLabel: occurred.dateLabel,
        timeLabel: occurred.timeLabel
      }
    );
    const vibeLine = reactionLine({
      kind: intent.kind,
      amountCents: intent.amountCents,
      category: intent.category,
      customerName: customer.name
    });

    let limitAlertLines: string[] = [];
    if (intent.kind === 'expense') {
      const limitStatuses = await spendingLimitStatuses({
        customerId: customer.id,
        referenceDate: now,
        timezone: config.defaultTimezone
      });
      limitAlertLines = limitAlertLinesForPlan(limitStatuses, currentPlanCode);
    }
    const decisionLines = await buildDecisionLines({
      customerId: customer.id,
      now,
      planCode: currentPlanCode
    });

    const trialLine = access.reason === 'trial_active'
      ? `🧪 Teste ativo: ${access.trialDaysLeft ?? 0} dia(s) restantes.`
      : null;
    const achievementLines = unlockedAchievements.map((item) => `🏅 Nova conquista: ${item.title}`);
    const sentinelaLine = impulsePattern?.isPattern
      ? `🔍 Padrão detectado: ${impulsePattern.patternLabel}.`
      : null;

    const outText = [
      mainLine,
      vibeLine,
      ...limitAlertLines,
      ...(sentinelaLine ? [sentinelaLine] : []),
      ...decisionLines,
      ...achievementLines,
      ...(trialLine ? [trialLine] : []),
      ...(!isOwnerMode ? [decisionQuestionByPlan(currentPlanCode)] : [])
    ].join('\n');
    await logConversation(customer.id, 'outbound', outText, { intent: intent.type });

    return {
      replyText: outText,
      responseBody: { ok: true, to: payload.from, replyText: outText, intent }
    };
  }

  if (intent.type === 'monthly-summary') {
    const summary = await monthlySummary(customer.id, intent.month, intent.year);
    const decisionLines = await buildDecisionLines({
      customerId: customer.id,
      now,
      planCode: currentPlanCode
    });
    const net = summary.totalIncomeCents - summary.totalExpenseCents;
    const totalExp = summary.totalExpenseCents || 1;
    const categoryLines = summary.byCategory.slice(0, 6).map((item) => {
      const pct = Math.round((item.amountCents / totalExp) * 100);
      return `${decorateCategory(item.category)}: ${centsToBrl(item.amountCents)} (${pct}%)`;
    });
    const categoryBlock = categoryLines.length > 0 ? categoryLines.join('\n') : 'Sem despesas registradas';

    const firstName = customer.name?.trim().split(/\s+/)[0] ?? 'Felipe';
    const monthName = new Date(intent.year, intent.month - 1).toLocaleDateString('pt-BR', { month: 'long' });

    const outText = [
      `📊 *${firstName}, seus gastos em ${monthName} — ${centsToBrl(summary.totalExpenseCents)}:*`,
      '',
      categoryBlock,
      '',
      summary.totalIncomeCents > 0
        ? `💰 Receitas: ${centsToBrl(summary.totalIncomeCents)} | Saldo: ${centsToBrl(net)}`
        : '⚠️ Nenhuma receita registrada ainda este mês.',
      net < 0 ? 'No ritmo atual pode faltar dinheiro no fim do mês. Quer que eu te ajude a cortar alguma categoria?' : 'Saldo positivo, bom trabalho! 😄',
      ...decisionLines,
      ...(!isOwnerMode ? [decisionQuestionByPlan(currentPlanCode)] : [])
    ].join('\n');

    await logConversation(customer.id, 'outbound', outText, { intent: intent.type });
    return {
      replyText: outText,
      responseBody: { ok: true, to: payload.from, replyText: outText, summary }
    };
  }

  if (intent.type === 'delete-last-transaction') {
    const safeExecution = isSafeTransactionalExecution(intent, payload.text);
    if (!safeExecution.safe) {
      const outText = 'Perfeito. Como sua mensagem parece uma dúvida, não apaguei nada. Se quiser apagar, me manda: "apaga meu último gasto".';
      await logConversation(customer.id, 'outbound', outText, {
        intent: intent.type,
        blockedWriteReason: safeExecution.reason
      });
      return {
        replyText: outText,
        responseBody: { ok: true, to: payload.from, replyText: outText, intent, blockedWriteReason: safeExecution.reason }
      };
    }

    const deleted = await deleteLastTransaction(customer.id, intent.kind);

    if (!deleted) {
      const outText = intent.kind === 'expense'
        ? 'Não encontrei gasto para apagar.'
        : 'Não encontrei receita para apagar.';
      await logConversation(customer.id, 'outbound', outText, { intent: intent.type, found: false });
      return {
        replyText: outText,
        responseBody: { ok: true, to: payload.from, replyText: outText, intent }
      };
    }

    const outText = intent.kind === 'expense'
      ? `Feito. Apaguei seu último gasto de ${centsToBrl(deleted.amountCents)} em ${deleted.category} (${new Date(deleted.occurredAt).toLocaleString('pt-BR')}). Quer lançar o valor correto agora?`
      : `Feito. Apaguei sua última receita de ${centsToBrl(deleted.amountCents)} em ${deleted.category} (${new Date(deleted.occurredAt).toLocaleString('pt-BR')}). Quer lançar o valor correto agora?`;
    await logConversation(customer.id, 'outbound', outText, { intent: intent.type, deletedId: deleted.id });
    return {
      replyText: outText,
      responseBody: { ok: true, to: payload.from, replyText: outText, deleted }
    };
  }

  if (intent.type === 'correct-last-transaction') {
    const safeExecution = isSafeTransactionalExecution(intent, payload.text);
    if (!safeExecution.safe) {
      const outText = 'Entendi sua mensagem como pergunta. Se quiser corrigir, me manda no formato: "corrige, era 80 e foi 60".';
      await logConversation(customer.id, 'outbound', outText, {
        intent: intent.type,
        blockedWriteReason: safeExecution.reason
      });
      return {
        replyText: outText,
        responseBody: { ok: true, to: payload.from, replyText: outText, intent, blockedWriteReason: safeExecution.reason }
      };
    }

    const corrected = await correctLastTransactionAmount({
      customerId: customer.id,
      kind: intent.kind,
      category: intent.category,
      newAmountCents: intent.newAmountCents
    });

    if (!corrected) {
      const base = intent.kind === 'expense' ? 'gasto' : 'receita';
      const scope = intent.category ? ` em ${intent.category}` : '';
      const outText = `Não encontrei ${base}${scope} para corrigir.`;
      await logConversation(customer.id, 'outbound', outText, { intent: intent.type, found: false });
      return {
        replyText: outText,
        responseBody: { ok: true, to: payload.from, replyText: outText, intent }
      };
    }

    const base = intent.kind === 'expense' ? 'gasto' : 'receita';
    const outText = `Corrigido. Seu último ${base} em ${corrected.category} foi atualizado de ${centsToBrl(corrected.previousAmountCents)} para ${centsToBrl(corrected.amountCents)}. Quer ver como ficou o total de hoje?`;
    await logConversation(customer.id, 'outbound', outText, { intent: intent.type, correctedId: corrected.id });
    return {
      replyText: outText,
      responseBody: { ok: true, to: payload.from, replyText: outText, corrected }
    };
  }

  const pastDateHint = getPastDateRegistrationHint(payload.text);
  if (pastDateHint) {
    const outText = [
      `Sim! Basta mencionar o dia direto na mensagem.`,
      `Exemplo: "${pastDateHint} gastei 50 no mercado" — eu já registro com a data certa.`,
      `Também funciona com "ontem", "anteontem", "semana passada", ou uma data como "dia 10".`
    ].join('\n');
    await logConversation(customer.id, 'outbound', outText, { intent: intent.type, reason: 'past-date-registration-howto' });
    return {
      replyText: outText,
      responseBody: { ok: true, to: payload.from, replyText: outText, intent }
    };
  }

  const aiSupportText = await supportReply({
    text: payload.text,
    customerName: customer.name,
    now,
    previousAssistantReply: lastOutbound,
    recentUserMessages: recentInboundTexts,
    planName: currentPlanName,
    planCode: currentPlanCode,
    monthlyMessageLimit: access.monthlyMessageLimit,
    messagesUsedThisMonth: access.messagesUsedThisMonth,
    availablePlansSummary: planCatalogSummaryInline(),
    allowedFeaturesSummary: planAiContext.allowedFeaturesSummary,
    blockedFeaturesSummary: planAiContext.blockedFeaturesSummary,
    monthlyIncomeCents
  });

  const candidateHelpText = aiSupportText ?? helpVariant(payload.text, isOwnerMode);
  const helpText = lastOutbound && normalizeReplyForComparison(lastOutbound) === normalizeReplyForComparison(candidateHelpText)
    ? varyRepeatedReply(candidateHelpText, { ownerMode: isOwnerMode })
    : candidateHelpText;
  await logConversation(customer.id, 'outbound', helpText, {
    intent: intent.type,
    reason: 'reason' in intent ? intent.reason : undefined,
    supportMode: aiSupportText ? 'ai' : 'default'
  });
  return {
    replyText: helpText,
    responseBody: { ok: true, to: payload.from, replyText: helpText, intent }
  };
}

export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  app.get('/webhooks/whatsapp', async (request, reply) => {
    const query = request.query as Record<string, unknown> & {
      hub?: { mode?: string; challenge?: string; verify_token?: string };
    };

    // Some tunnels/proxies normalize dotted query keys (hub.mode) into
    // underscore keys (hub_mode) or nested objects (hub.mode -> hub.mode).
    const mode = String(
      query['hub.mode'] ??
      query.hub?.mode ??
      query['hub_mode'] ??
      ''
    );
    const challenge = String(
      query['hub.challenge'] ??
      query.hub?.challenge ??
      query['hub_challenge'] ??
      ''
    );
    const verifyToken = String(
      query['hub.verify_token'] ??
      query.hub?.verify_token ??
      query['hub_verify_token'] ??
      ''
    );

    if (mode === 'subscribe' && challenge && verifyToken === config.whatsappVerifyToken) {
      return reply.status(200).send(challenge);
    }

    return reply.status(403).send({ error: 'forbidden' });
  });

  app.post('/webhooks/whatsapp', async (request, reply) => {
    const directPayload = inboundSchema.safeParse(request.body);
    const metaPayload = directPayload.success ? null : extractMetaWebhookPayload(request.body);
    const metaStatus = directPayload.success ? null : extractMetaStatusPayload(request.body);
    const payload = directPayload.success ? directPayload.data : metaPayload;
    const isMetaIncoming = !directPayload.success && Boolean(metaPayload);

    if (!payload) {
      if (metaStatus) {
        if (metaStatus.status === 'failed') {
          request.log.error(
            {
              recipientId: metaStatus.recipientId,
              messageId: metaStatus.messageId,
              status: metaStatus.status,
              errorCode: metaStatus.errorCode,
              errorTitle: metaStatus.errorTitle,
              errorMessage: metaStatus.errorMessage,
              timestamp: metaStatus.timestamp
            },
            'whatsapp_delivery_status'
          );
        } else {
          request.log.info(
            {
              recipientId: metaStatus.recipientId,
              messageId: metaStatus.messageId,
              status: metaStatus.status,
              timestamp: metaStatus.timestamp
            },
            'whatsapp_delivery_status'
          );
        }
        return { ok: true, ignored: true, reason: 'delivery_status', metaStatus };
      }
      return { ok: true, ignored: true, reason: 'no_user_message' };
    }

    const processed = await processInboundMessage(payload);
    if (isMetaIncoming && processed.replyText) {
      await sendWhatsAppTextMessage(payload.from, processed.replyText);
    }


    return processed.responseBody;
  });

  app.post('/webhooks/whatsapp/twilio', async (request, reply) => {
    const payload = extractTwilioWebhookPayload(request.body);

    if (!payload) {
      return reply
        .header('Content-Type', 'text/xml; charset=utf-8')
        .send(twimlResponse());
    }

    const processed = await processInboundMessage(payload);
    return reply
      .header('Content-Type', 'text/xml; charset=utf-8')
      .send(twimlResponse(processed.replyText));
  });
}

export const __webhooksTestables = {
  parseReminderCreateCommand,
  isReminderCreateIntentEvenIfMissingFields,
  parseReminderLeadUpdateCommand,
  isReminderStatusRequest,
  isOwnerDailyReportScheduleQuestion,
  parseOwnerCostIntent,
  resolveOwnerCostIntentReply,
  extractOwnerStatusQueryTarget,
  parseOwnerGrantAccessCommand,
  isOwnerCustomersCountQuestion,
  isOwnerCustomersListQuestion,
  formatWhatsappNumberPretty,
  selectReminderForLeadUpdate,
  findReminderByDraft,
  isReminderCreateConfirmationFromContext,
  extractReminderDraftFromRecentInboundMessages,
  shouldConfirmDeleteLastFromContext
};
