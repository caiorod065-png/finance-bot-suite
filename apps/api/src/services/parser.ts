import OpenAI from 'openai';
import { z } from 'zod';
import { config } from '../config.js';
import type { ParsedIntent, SpendingLimitPeriod } from '../types.js';
import { recordOpenAiUsageFromResponse } from './openai-usage.js';
import { getCustomerProfileFacts, upsertCustomerProfileFact } from './ledger.js';

const client = config.openAiApiKey ? new OpenAI({ apiKey: config.openAiApiKey }) : null;

const aiSchema = z.object({
  type: z.enum([
    'register-transaction',
    'monthly-summary',
    'delete-last-transaction',
    'correct-last-transaction',
    'set-spending-limit',
    'set-spending-limit-missing-amount',
    'clear-spending-limit',
    'list-spending-limits',
    'ask-current-total',
    'ask-month-summary',
    'ask-explanation',
    'ask-confirmation',
    'ask-breakdown',
    'ask-projection-reason',
    'confirm-transaction-action',
    'register-transaction-missing-info',
    'help'
  ]),
  kind: z.enum(['expense', 'income']).optional(),
  amountCents: z.number().int().positive().optional(),
  newAmountCents: z.number().int().positive().optional(),
  period: z.enum(['daily', 'weekly', 'monthly']).optional(),
  category: z.string().optional(),
  description: z.string().optional(),
  occurredAtIso: z.string().datetime().optional(),
  month: z.number().int().min(1).max(12).optional(),
  year: z.number().int().min(2020).max(2100).optional(),
  action: z.enum(['register-transaction']).optional(),
  reason: z.string().optional()
});

type AiIntent = z.infer<typeof aiSchema>;

export type ParseIntentContext = {
  lastAssistantMessage?: string | null;
  recentUserMessages?: string[];
};

type ParseIntentOptions = {
  disableAi?: boolean;
  context?: ParseIntentContext;
};

function currentMonthYear(reference: Date): { month: number; year: number } {
  return { month: reference.getMonth() + 1, year: reference.getFullYear() };
}

const ptNumberWords: Record<string, number> = {
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
  dezasseis: 16,
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

const ptNumberWordKeys = Object.keys(ptNumberWords);
const ptNumberWordPattern = new RegExp(
  `\\b(?:${ptNumberWordKeys.join('|')})(?:\\s+e\\s+(?:${ptNumberWordKeys.join('|')}))*\\b`,
  'g'
);

function normalizePtText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function parsePtIntegerWords(phrase: string): number | null {
  const tokens = phrase.split(/\s+/).filter(Boolean);
  let total = 0;
  let hasNumber = false;

  for (const token of tokens) {
    if (token === 'e') continue;
    const value = ptNumberWords[token];
    if (value === undefined) {
      return null;
    }
    total += value;
    hasNumber = true;
  }

  return hasNumber ? total : null;
}

function parseWrittenAmountToCents(text: string): number | null {
  const normalized = normalizePtText(text);

  // Mixed numeric style: "30 e dois reais" => 32,00
  const mixedReais = normalized.match(
    new RegExp(`\\b(\\d{1,6})\\s+e\\s+(${ptNumberWordKeys.join('|')})\\s+reais?\\b`)
  );
  if (mixedReais) {
    const integerPart = Number(mixedReais[1]);
    const plusPart = ptNumberWords[mixedReais[2]];
    if (!Number.isNaN(integerPart) && plusPart !== undefined) {
      return (integerPart + plusPart) * 100;
    }
  }

  // Mixed written style: "trinta e 3 reais" => 33,00
  const mixedLeadingWord = normalized.match(
    new RegExp(`\\b(${ptNumberWordKeys.join('|')})\\s+e\\s+(\\d{1,2})(?:\\s+reais?)?\\b`)
  );
  if (mixedLeadingWord) {
    const base = ptNumberWords[mixedLeadingWord[1]];
    const add = Number(mixedLeadingWord[2]);
    if (base !== undefined && !Number.isNaN(add)) {
      return (base + add) * 100;
    }
  }

  const matches = normalized.match(ptNumberWordPattern);
  if (!matches || matches.length === 0) {
    return null;
  }

  const candidate = matches[matches.length - 1].trim();

  // "um/uma" alone is almost always an indefinite article, not a number.
  // Only treat it as 1 if there's explicit monetary context or a transaction verb.
  if ((candidate === 'um' || candidate === 'uma') &&
      !/\b(real|reais|r\$|rs)\b/.test(normalized) &&
      !/\b(gastei|paguei|comprei|recebi|ganhei|custou|foi|deu|custa)\b/.test(normalized)) {
    return null;
  }

  const tokens = candidate.split(/\s+/).filter(Boolean);
  const conjunctionCount = tokens.filter((token) => token === 'e').length;

  // Two conjunctions usually means "X e Y e Z" => (X e Y).(Z)
  // Example: "trinta e dois e cinquenta" => 32,50
  if (conjunctionCount >= 2) {
    const lastConjunction = candidate.lastIndexOf(' e ');
    if (lastConjunction > 0) {
      const reaisPart = candidate.slice(0, lastConjunction).trim();
      const centsPart = candidate.slice(lastConjunction + 3).trim();
      const reais = parsePtIntegerWords(reaisPart);
      const cents = parsePtIntegerWords(centsPart);
      if (reais !== null && cents !== null && cents >= 0 && cents < 100) {
        return reais * 100 + cents;
      }
    }
  }

  const integer = parsePtIntegerWords(candidate);
  if (integer !== null) {
    return integer * 100;
  }

  return null;
}

function parseAmountToCents(text: string): number | null {
  const normalizedMoney = text.replace(/\./g, '').replace(/,/g, '.');
  const normalizedText = normalizePtText(text);

  // 1) Prefer explicit currency patterns first (avoids accidental "uma" => 1)
  const currencyAfterNumber = normalizedMoney.match(/\b(\d+(?:\.\d{1,2})?)\s*(?:r\$|rs|reais?|real)\b/i);
  if (currencyAfterNumber) {
    const value = Number(currencyAfterNumber[1]);
    if (!Number.isNaN(value) && value > 0) return Math.round(value * 100);
  }

  const currencyBeforeNumber = normalizedMoney.match(/\b(?:r\$|rs)\s*(\d+(?:\.\d{1,2})?)\b/i);
  if (currencyBeforeNumber) {
    const value = Number(currencyBeforeNumber[1]);
    if (!Number.isNaN(value) && value > 0) return Math.round(value * 100);
  }

  // 2) Strong verb-context numeric capture (works even if date appears first)
  const verbAnchored = normalizedMoney.match(
    /\b(?:gastei|paguei|comprei|recebi|ganhei|custou|foi|deu)\b[^\d]{0,20}(\d+(?:\.\d{1,2})?)\b/i
  );
  if (verbAnchored) {
    const value = Number(verbAnchored[1]);
    if (!Number.isNaN(value) && value > 0) return Math.round(value * 100);
  }

  // 3) Generic numeric fallback
  const numericMatch = normalizedMoney.match(/\b(\d+(?:\.\d{1,2})?)\b/);
  if (numericMatch) {
    const value = Number(numericMatch[1]);
    if (!Number.isNaN(value) && value > 0) return Math.round(value * 100);
  }

  // 4) Written amount fallback only when there's monetary hint (or no digits at all)
  const hasMoneyHint = /\b(real|reais|rs|r\$)\b/.test(normalizedText);
  const hasDigits = /\d/.test(normalizedMoney);
  if (!hasMoneyHint && hasDigits) return null;

  const writtenAmount = parseWrittenAmountToCents(text);
  if (writtenAmount && writtenAmount > 0) return writtenAmount;

  return null;
}

function parseAmountsToCents(text: string): number[] {
  const normalized = text.replace(/\./g, '').replace(/,/g, '.');
  const matches = normalized.match(/\d+(?:\.\d{1,2})?/g) ?? [];
  return matches
    .map((match) => Number(match))
    .filter((value) => !Number.isNaN(value))
    .map((value) => Math.round(value * 100));
}

function shiftDate(reference: Date, days: number): Date {
  const result = new Date(reference);
  result.setDate(result.getDate() + days);
  return result;
}

function parseRelativeOccurredAt(text: string, now: Date): string | null {
  const normalized = normalizePtText(text);

  const explicit = normalized.match(/\b(?:dia\s*)?(\d{1,2})[\/.-](\d{1,2})(?:[\/.-](\d{2,4}))?\b/);
  if (explicit) {
    const day = Number(explicit[1]);
    const month = Number(explicit[2]);
    const rawYear = explicit[3];
    let year = now.getFullYear();
    if (rawYear) {
      const y = Number(rawYear);
      year = rawYear.length === 2 ? 2000 + y : y;
    }

    const candidate = new Date(now);
    candidate.setFullYear(year, month - 1, day);
    candidate.setHours(now.getHours(), now.getMinutes(), now.getSeconds(), 0);

    if (!Number.isNaN(candidate.getTime()) && candidate.getDate() === day && candidate.getMonth() === month - 1) {
      return candidate.toISOString();
    }
  }

  if (/\banteontem\b/.test(normalized)) {
    return shiftDate(now, -2).toISOString();
  }

  if (/\bontem\b/.test(normalized)) {
    return shiftDate(now, -1).toISOString();
  }

  if (/\bhoje\b/.test(normalized)) {
    return now.toISOString();
  }

  const weekdayMap: Array<{ day: number; regex: RegExp }> = [
    { day: 0, regex: /\bdomingo\b/ },
    { day: 1, regex: /\bsegunda(?:\s*-?\s*feira)?\b/ },
    { day: 2, regex: /\bterca(?:\s*-?\s*feira)?\b/ },
    { day: 3, regex: /\bquarta(?:\s*-?\s*feira)?\b/ },
    { day: 4, regex: /\bquinta(?:\s*-?\s*feira)?\b/ },
    { day: 5, regex: /\bsexta(?:\s*-?\s*feira)?\b/ },
    { day: 6, regex: /\bsabado\b/ }
  ];

  const weekday = weekdayMap.find((entry) => entry.regex.test(normalized));
  if (weekday) {
    const nowDay = now.getDay();
    let diff = nowDay - weekday.day;
    if (diff < 0) diff += 7;

    const hasPastHint = /\b(passad[ao]|retrasad[ao]|semana passada)\b/.test(normalized);
    if (diff === 0 && hasPastHint) {
      diff = 7;
    }

    return shiftDate(now, -diff).toISOString();
  }

  if (/\bsemana passada\b/.test(normalized)) {
    return shiftDate(now, -7).toISOString();
  }

  return null;
}

export function inferCategory(text: string): string {
  const lower = normalizePtText(text);
  if (lower.includes('mercado') || lower.includes('supermercado')) return 'mercado';
  if (lower.includes('shopping')) return 'shopping';
  if (lower.includes('manicure') || lower.includes('salao') || lower.includes('cabelel') || lower.includes('barbear') || lower.includes('barbearia') || lower.includes('estetica') || lower.includes('spa')) return 'beleza';
  if (
    lower.includes('transporte') ||
    lower.includes('uber') ||
    lower.includes('gasolina') ||
    lower.includes('combust') ||
    lower.includes('onibus') ||
    lower.includes('passagem')
  ) return 'transporte';
  if (lower.includes('aluguel') || lower.includes('condom')) return 'moradia';
  if (
    lower.includes('lanche') ||
    lower.includes('restaurante') ||
    lower.includes('ifood') ||
    lower.includes('esfiha') ||
    lower.includes('esfirra') ||
    lower.includes('pizza') ||
    lower.includes('hamburg') ||
    lower.includes('salgado') ||
    lower.includes('pastel') ||
    lower.includes('cafe') ||
    lower.includes('comida') ||
    lower.includes('refeicao') ||
    lower.includes('almoco') ||
    lower.includes('almocei') ||
    lower.includes('janta') ||
    lower.includes('jantar') ||
    lower.includes('jantei') ||
    lower.includes('comer') ||
    lower.includes('cafe da manha') ||
    lower.includes('cafeteria')
  ) return 'alimentacao';
  if (lower.includes('faculdade') || lower.includes('curso')) return 'educacao';
  return 'outros';
}

function normalizeAiCategory(category?: string): string {
  if (!category) return '';
  return normalizePtText(category).trim();
}

function pickBestCategory(aiCategory: string | undefined, originalText: string): string {
  const inferred = inferCategory(originalText);
  const normalizedAiCategory = normalizeAiCategory(aiCategory);
  if (!normalizedAiCategory) return inferred;

  // If model falls back to generic bucket but text has strong local signal, trust local classifier.
  if ((normalizedAiCategory === 'outros' || normalizedAiCategory === 'diversos') && inferred !== 'outros') {
    return inferred;
  }

  return aiCategory?.trim() || inferred;
}

function inferLimitPeriod(text: string): SpendingLimitPeriod | null {
  const lower = text.toLowerCase();
  if (/\b(semana|semanal)\b/.test(lower)) return 'weekly';
  if (/\b(mes|mês|mensal)\b/.test(lower)) return 'monthly';
  if (/\b(dia|diario|diaria|diário|diária)\b/.test(lower)) return 'daily';
  return null;
}

function wantsLimitList(text: string): boolean {
  const lower = text.toLowerCase();
  if (!/\blimites\b/.test(lower)) return false;
  if (/^\s*meus?\s+limites\b/.test(lower)) return true;
  return /\b(quais|mostrar|listar|lista)\b/.test(lower) && /\blimites\b/.test(lower);
}

function parseLimitAmountToCents(text: string): number | null {
  const normalized = text.replace(/\./g, '').replace(/,/g, '.');
  const numeric = normalized.match(/\b(\d+(?:\.\d{1,2})?)\b/);
  if (numeric) {
    const value = Number(numeric[1]);
    if (!Number.isNaN(value) && value > 0) {
      return Math.round(value * 100);
    }
  }

  // Written amount only when explicitly marked as currency (real/reais/rs/r$)
  const moneyHint = /\b(real|reais|rs|r\$)\b/;
  if (!moneyHint.test(normalizePtText(text))) {
    return null;
  }

  const written = parseWrittenAmountToCents(text);
  if (written && written > 0) {
    return written;
  }

  return null;
}

function looksLikeExpenseStatement(lower: string, amountCents: number | null): boolean {
  if (!amountCents || amountCents <= 0) return false;

  const expenseVerbs = /gastei|paguei|comprei|despesa|gasto|custou|ficou|deu|foi/;
  const categoryHint = inferCategory(lower) !== 'outros';
  const prepositionHint = /\b(no|na|em|de)\b/.test(lower);

  return expenseVerbs.test(lower) || (categoryHint && prepositionHint);
}

function hasExplicitTransactionalSignal(normalized: string): boolean {
  return /\b(gastei|paguei|comprei|recebi|ganhei|anota|anotar|registra|registrar|coloca|colocar|adiciona|adicionar|adicione|lanca|lança|corrige|corrigir|apaga|apagar|deleta|deletar|remove|remover|cria|criar|define|definir)\b/.test(normalized);
}

function hasQuestionSignal(normalized: string, original: string): boolean {
  if (original.includes('?')) return true;
  if (/\b(so tenho|só tenho|ate agora|até agora|isso mesmo|tem certeza|como assim|por que|por quê|esse e meu unico gasto|esse é meu único gasto|eu so gastei isso|eu só gastei isso|nao entendi|não entendi|quer dizer que|como voce chegou|como você chegou|de onde saiu)\b/.test(normalized)) {
    return true;
  }
  return /\b(quanto|qual|quais|como|porque|por que|por quê)\b/.test(normalized);
}

function isFollowUpConversationalQuestion(normalized: string, context?: ParseIntentContext): boolean {
  if (!context?.lastAssistantMessage) return false;
  const lastAssistantNormalized = normalizePtText(context.lastAssistantMessage);
  const referencesBotContext = /\b(mas|entao|então|isso|esse|essa|como assim|de onde|tem certeza|so tenho|só tenho)\b/.test(normalized);
  const assistantHadFinancialState = /\b(resumo|total|saldo|deficit|déficit|projecao|projeção|gasto|categoria)\b/.test(lastAssistantNormalized);
  return referencesBotContext && assistantHadFinancialState;
}

function hasHowToUseSignal(normalized: string): boolean {
  // Perguntas sobre planos específicos não são "como usar o bot"
  if (/\b(plano|familia|family|essencial|essential|premium|elite)\b/.test(normalized)) return false;
  return /\b(como posso|como faco|como faço|como mando|como mandar|como envio|como enviar|como registrar|como anotar|como funciona|quais comandos|quais opcoes|quais opções|me explica|me ensina|o que voce faz|o que você faz)\b/.test(normalized);
}

function hasSocialConversationSignal(normalized: string): boolean {
  return /\b(como vai|como foi seu dia|como esta|como está|tudo bem|tudo certo|boa tarde|bom dia|boa noite|oi iara|ola iara|olá iara|e ai iara|e aí iara)\b/.test(normalized);
}

function hasSleepFarewellSignal(normalized: string): boolean {
  return /\b(vou dormir|vo dormir|vou descansar|to cansado|tô cansado|to cansada|tô cansada|fui dormir|ate amanha|até amanhã|amanha eu te passo|amanhã eu te passo|amanha te falo|amanhã te falo|ate mais amanha|até mais amanhã)\b/.test(normalized);
}

function detectConversationalIntent(params: {
  normalized: string;
  original: string;
  now: Date;
  context?: ParseIntentContext;
}): ParsedIntent | null {
  const { normalized, original, now, context } = params;
  if (hasSleepFarewellSignal(normalized)) {
    return {
      type: 'help',
      reason: 'sleep-farewell'
    };
  }

  const isQuestionLike = hasQuestionSignal(normalized, original);
  if (!isQuestionLike && !isFollowUpConversationalQuestion(normalized, context)) {
    return null;
  }

  if (hasHowToUseSignal(normalized) || hasSocialConversationSignal(normalized)) {
    return {
      type: 'help',
      reason: 'ask-how-to-use'
    };
  }

  if (/\b(lembrete|lembrar|lembra|vencimento|conta)\b/.test(normalized) && isQuestionLike) {
    return {
      type: 'help',
      reason: 'ask-reminder-status'
    };
  }

  if (/\b(como assim|como voce chegou|como você chegou|de onde saiu|deficit|déficit|projecao|projeção)\b/.test(normalized)) {
    return { type: 'ask-projection-reason' };
  }
  if (/\b(categoria|detalhamento|breakdown|detalhe)\b/.test(normalized)) {
    const { month, year } = currentMonthYear(now);
    return { type: 'ask-breakdown', month, year };
  }
  if (/\b(resumo|mes|mês)\b/.test(normalized)) {
    const { month, year } = currentMonthYear(now);
    return { type: 'ask-month-summary', month, year };
  }
  if (/\b(so tenho|só tenho|ate agora|até agora|esse gasto|esse valor|unico gasto|único gasto|ja esta anotado|já está anotado|ja ta salvo|já tá salvo|ja esta salvo|já está salvo|lancou de novo|lançou de novo|lancar de novo|lançar de novo|quer dizer que|isso quer dizer|entao quer dizer|então quer dizer)\b/.test(normalized)) {
    return { type: 'ask-confirmation' };
  }
  if (/\bja gastei\b/.test(normalized) && isQuestionLike) {
    return { type: 'ask-confirmation' };
  }
  if (isFollowUpConversationalQuestion(normalized, context)) {
    return { type: 'ask-explanation' };
  }

  if (hasExplicitTransactionalSignal(normalized)) {
    return null;
  }

  if (/\b(quanto|qual|quais)\b/.test(normalized) && /\b(gastei|gasto|despesa|despesas|total|ate agora|até agora|saldo)\b/.test(normalized)) {
    return { type: 'ask-current-total' };
  }

  return {
    type: 'help',
    reason: 'conversational-question'
  };
}

function detectAmbiguousTransactionalIntent(params: {
  normalized: string;
  original: string;
  now: Date;
}): ParsedIntent | null {
  const { normalized, original, now } = params;
  const isQuestionLike = hasQuestionSignal(normalized, original);
  if (!isQuestionLike) return null;
  if (hasHowToUseSignal(normalized) || hasSocialConversationSignal(normalized)) return null;
  if (/\b(so tenho|só tenho|ate agora|até agora|ja esta anotado|já está anotado|ja ta salvo|já tá salvo|ja esta salvo|já está salvo|lancou de novo|lançou de novo|lancar de novo|lançar de novo|esse gasto)\b/.test(normalized)) {
    return null;
  }

  const amountCents = parseAmountToCents(original);
  if (!amountCents || amountCents <= 0) return null;

  const category = inferCategory(normalized);
  const hasTransactionalShape = category !== 'outros' || /\b(em|no|na|de)\b/.test(normalized);
  if (!hasTransactionalShape) return null;

  return {
    type: 'confirm-transaction-action',
    action: 'register-transaction',
    amountCents,
    kind: 'expense',
    category,
    description: original,
    occurredAtIso: parseRelativeOccurredAt(original, now) ?? now.toISOString(),
    reason: 'ambiguous-question'
  };
}

function resolveExpensePeriodChoice(normalized: string): { type: 'full-expense-list'; period: 'today' | 'this-week' | 'this-month' | 'last-month' | 'last-2-months' | 'last-3-months' } | null {
  const t = normalized.trim();
  if (/^1$|este mes|esse mes|mes atual/.test(t)) return { type: 'full-expense-list', period: 'this-month' };
  if (/^2$|mes passado/.test(t)) return { type: 'full-expense-list', period: 'last-month' };
  if (/^3$|esta semana|essa semana/.test(t)) return { type: 'full-expense-list', period: 'this-week' };
  if (/^4$|^hoje$/.test(t)) return { type: 'full-expense-list', period: 'today' };
  if (/^5$|2 meses|dois meses/.test(t)) return { type: 'full-expense-list', period: 'last-2-months' };
  if (/^6$|3 meses|tres meses/.test(t)) return { type: 'full-expense-list', period: 'last-3-months' };
  return null;
}

const PT_MONTH_MAP: Record<string, number> = {
  janeiro: 1, fevereiro: 2, marco: 3, abril: 4, maio: 5, junho: 6,
  julho: 7, agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12,
  jan: 1, fev: 2, mar: 3, abr: 4, mai: 5, jun: 6,
  jul: 7, ago: 8, set: 9, out: 10, nov: 11, dez: 12
};

function parseSavingsGoalDeadline(normalized: string, now: Date): string | null {
  const relMonths = normalized.match(/\bem\s+(\d+)\s+meses?\b/);
  if (relMonths) {
    const n = Number(relMonths[1]);
    const d = new Date(now.getFullYear(), now.getMonth() + n + 1, 0);
    return d.toISOString().slice(0, 10);
  }

  const monthMatch = normalized.match(/\b(?:em|ate|para|no mes de)\s+([a-z]+)(?:\s+(?:de\s+)?(\d{4}))?\b/);
  if (monthMatch) {
    const monthNum = PT_MONTH_MAP[monthMatch[1]];
    if (monthNum) {
      const explicitYear = monthMatch[2] ? Number(monthMatch[2]) : null;
      let year = explicitYear ?? now.getFullYear();
      if (!explicitYear && monthNum <= now.getMonth() + 1) year = now.getFullYear() + 1;
      const lastDay = new Date(year, monthNum, 0).getDate();
      return `${year}-${String(monthNum).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
    }
  }

  return null;
}

function ruleBased(text: string, now: Date, context?: ParseIntentContext): ParsedIntent {
  const lower = text.toLowerCase();
  const normalized = normalizePtText(text);
  const isIncome = /recebi|ganhei|entrada/.test(lower);
  const isExpense = /gastei|paguei|comprei|despesa|gasto/.test(lower);

  // Resolução de contexto: "Quero/Sim/Ok" em resposta a uma oferta da Iara
  const isSimpleAffirmative = /^(quero|sim|ok|pode|vai|claro|aceito|beleza|vamos|yes|s|topo|manda|manda ver|pode ser|com certeza|vai la|vá lá|vai la|to dentro|tô dentro|quero sim|sim por favor)\s*[!.]*$/.test(normalized.trim());
  if (isSimpleAffirmative && context?.lastAssistantMessage) {
    const lastNorm = normalizePtText(context.lastAssistantMessage);

    // Oferta de criar meta financeira / savings goal
    if (/\b(meta financeira|meta de poupanca|criar uma meta|juntar uma reserva|reserva de emergencia|primeira meta|cofre)\b/.test(lastNorm)) {
      return { type: 'ask-savings-goal-status' };
    }
    // Oferta de ver resumo do mês
    if (/\b(resumo do mes|resumo mensal|ver seus gastos do mes|relatorio do mes|resumo atualizado|olhada no resumo|dar uma olhada)\b/.test(lastNorm)) {
      const { month, year } = currentMonthYear(now);
      return { type: 'monthly-summary', month, year };
    }
    // Oferta de analisar categoria ou período específico
    if (/\b(analise|analis[ae]r|categoria|periodo especif|especific[oa]|quer que eu analise|analisar alguma)\b/.test(lastNorm) ||
        /\b(pode faltar dinheiro|como estao seus gastos|como esta indo|continuar assim)\b/.test(lastNorm)) {
      const { month, year } = currentMonthYear(now);
      return { type: 'monthly-summary', month, year };
    }
    // Oferta de ver extrato / lista de gastos
    if (/\b(extrato|todos os gastos|lista de gastos|ver seus lancamentos)\b/.test(lastNorm)) {
      return { type: 'ask-expense-period' };
    }
    // Oferta de ver limites
    if (/\b(limite|limites de gasto)\b/.test(lastNorm)) {
      return { type: 'list-spending-limits' };
    }
    // Oferta de ver metas/cofres da família
    if (/\b(cofre familiar|cofres da familia|metas da familia)\b/.test(lastNorm)) {
      return { type: 'ask-family-vault-status' };
    }
    // Oferta de reunião financeira familiar
    if (/\b(reuniao financeira|balanco da familia)\b/.test(lastNorm)) {
      return { type: 'ask-family-meeting' };
    }
  }

  // Period selection in response to expense period question
  if (context?.lastAssistantMessage) {
    const lastNorm = normalizePtText(context.lastAssistantMessage);
    if (/qual periodo|1️⃣ este mes|escolha o periodo|extrato.*periodo|periodo.*extrato/.test(lastNorm)) {
      const choice = resolveExpensePeriodChoice(normalized);
      if (choice) return choice;
    }
  }

  // User wants to register a transaction but hasn't provided the amount
  const wantsToRegister = /\b(quero|vou|preciso|posso|vamos)\b.{0,20}\b(anotar|registrar|lancar|adicionar|colocar|botar)\b.{0,20}\b(gasto|despesa|compra|pagamento|lancamento|entrada|receita)\b/i.test(text) ||
    /\b(anotar|registrar|lancar|adicionar)\b.{0,20}\b(um[a]?\s+)?(gasto|despesa|compra|pagamento|lancamento)\b/i.test(text);
  if (wantsToRegister && !parseAmountToCents(text)) {
    return { type: 'register-transaction-missing-info' };
  }

  // Full expense list / extrato
  if (/\b(extrato|todos os gastos|gastos completos|historico de gastos|listar gastos|ver todos os gastos|meus gastos completos|todos os lancamentos|meus gastos todos)\b/.test(normalized)) {
    if (/\b(hoje|dia de hoje)\b/.test(normalized)) return { type: 'full-expense-list', period: 'today' };
    if (/\b(esta semana|essa semana)\b/.test(normalized)) return { type: 'full-expense-list', period: 'this-week' };
    if (/\b(mes passado)\b/.test(normalized)) return { type: 'full-expense-list', period: 'last-month' };
    if (/\b(este mes|esse mes|mes atual)\b/.test(normalized)) return { type: 'full-expense-list', period: 'this-month' };
    if (/\b(2 meses|dois meses)\b/.test(normalized)) return { type: 'full-expense-list', period: 'last-2-months' };
    if (/\b(3 meses|tres meses)\b/.test(normalized)) return { type: 'full-expense-list', period: 'last-3-months' };
    return { type: 'ask-expense-period' };
  }

  // Family vaults (cofres compartilhados)
  const isFamilyCtx = /\b(familia|familiar|da casa|coletivo|compartilhado|juntos|todos nos)\b/.test(normalized);

  if (isFamilyCtx && /\b(cancelar|remover|desistir|apagar)\b/.test(normalized) && /\b(cofre|meta|objetivo|poupanca)\b/.test(normalized)) {
    return { type: 'cancel-family-vault' };
  }

  if (/\b(reuniao financeira|balanco da familia|resumo familiar|reuniao da familia|como foi o mes da familia|relatorio familiar)\b/.test(normalized)) {
    return { type: 'ask-family-meeting' };
  }

  if (isFamilyCtx && /\b(como esta|como vai|status|progresso|cofres?|quanto juntamos|quanto guardamos)\b/.test(normalized)) {
    return { type: 'ask-family-vault-status' };
  }

  if (isFamilyCtx && /\b(cofre|juntar|poupar|guardar|economizar|meta de|objetivo de)\b/.test(normalized)) {
    const amountCents = parseAmountToCents(lower);
    const deadline = parseSavingsGoalDeadline(normalized, now);
    if (amountCents && amountCents > 0 && deadline) {
      const descMatch = lower.match(/\b(?:cofre\s+(?:para|de|do|da)|para|pro|pra)\s+(.+?)(?:\s+(?:em|ate)\s+[a-z]|\s*$)/);
      const description = descMatch ? descMatch[1].trim() : 'cofre familiar';
      return { type: 'set-family-vault', description, targetAmountCents: amountCents, deadlineIso: deadline };
    }
  }

  // Individual savings goals
  if (/\b(cancelar|remover|desistir|abandonar|apagar)\b/.test(normalized) && /\b(meta|objetivo|poupanca|economizar|guardar|juntar)\b/.test(normalized)) {
    return { type: 'cancel-savings-goal' };
  }

  if (/\b(como esta|como vai|status|progresso|andamento|quanto ja juntei|quanto juntei|minha meta|ver meta|minha poupanca|como estou|como vai minha)\b/.test(normalized) && /\b(meta|objetivo|poupanca|poupar|juntando|economizando)\b/.test(normalized)) {
    return { type: 'ask-savings-goal-status' };
  }

  if (/\b(juntar|poupar|guardar|economizar|meta de|objetivo de)\b/.test(normalized)) {
    const amountCents = parseAmountToCents(lower);
    const deadline = parseSavingsGoalDeadline(normalized, now);
    if (amountCents && amountCents > 0 && deadline) {
      const descMatch = lower.match(/\b(?:para|pro|pra)\s+(.+?)(?:\s+(?:em|ate|para)\s+[a-z]|\s*$)/);
      const description = descMatch ? descMatch[1].trim() : 'meta de economia';
      return { type: 'set-savings-goal', description, targetAmountCents: amountCents, deadlineIso: deadline };
    }
  }

  // Simulador de decisões financeiras
  if (/\b(simula|simule|e se|e se eu|se eu cortar|se eu reduzir|se eu parar|se eu guardar|se eu poupar|quanto economizo se|quanto sobra se|em quanto tempo junto|em quanto tempo pago|e se parar)\b/.test(normalized)) {
    return { type: 'simulate-decision', rawQuery: text };
  }

  // Balanço do casal / modo casal
  if (/\b(saldo do casal|balanco do casal|divisao do casal|gastos do casal|modo casal|quem gastou mais|quanto gastou meu parceiro|quanto gastou minha parceira|quanto gastou meu marido|quanto gastou minha esposa|comparativo do casal|comparativo entre nos)\b/.test(normalized)) {
    return { type: 'ask-couple-balance' };
  }

  const ambiguousIntent = detectAmbiguousTransactionalIntent({
    normalized,
    original: text,
    now
  });
  if (ambiguousIntent) {
    return ambiguousIntent;
  }

  const conversationalIntent = detectConversationalIntent({
    normalized,
    original: text,
    now,
    context
  });
  if (conversationalIntent) {
    return conversationalIntent;
  }

  if (/apaga|apagar|deleta|deletar|exclui|excluir|remove|remover/.test(lower) && /ultimo|último/.test(lower)) {
    return {
      type: 'delete-last-transaction',
      kind: isIncome ? 'income' : 'expense'
    };
  }

  if (/corrig|corrige|corrigir|ajusta|ajustar|altera|alterar/.test(lower) && /foi|era|para|pra|deve ser|valor/.test(lower)) {
    const amounts = parseAmountsToCents(lower);
    const newAmountCents = amounts[amounts.length - 1] ?? parseAmountToCents(lower);
    if (newAmountCents && newAmountCents > 0) {
      return {
        type: 'correct-last-transaction',
        kind: isIncome ? 'income' : 'expense',
        category: inferCategory(lower) !== 'outros' ? inferCategory(lower) : undefined,
        newAmountCents
      };
    }
  }

  // Fast correction style: "não, foi 33", "foi 253,50"
  if (/^(nao|não)\s*,?\s*foi\b|^foi\b/.test(lower)) {
    const amounts = parseAmountsToCents(lower);
    const newAmountCents = amounts[amounts.length - 1] ?? parseAmountToCents(lower);
    if (newAmountCents && newAmountCents > 0) {
      return {
        type: 'correct-last-transaction',
        kind: 'expense',
        newAmountCents
      };
    }
  }

  if (wantsLimitList(lower)) {
    return { type: 'list-spending-limits' };
  }

  if (/\blimite/.test(lower)) {
    const period = inferLimitPeriod(lower);
    if (period) {
      if (/\b(remov|apaga|zera|desativa|cancel|sem limite)\b/.test(lower)) {
        return { type: 'clear-spending-limit', period };
      }

      const amountCents = parseLimitAmountToCents(text);
      if (amountCents && amountCents > 0) {
        return {
          type: 'set-spending-limit',
          period,
          amountCents
        };
      }

      return {
        type: 'set-spending-limit-missing-amount',
        period
      };
    }
  }

  if (
    lower.includes('quanto gastei') ||
    lower.includes('resumo') ||
    lower.includes('total do mês') ||
    lower.includes('total do mes') ||
    lower.includes('gastos do mes') ||
    lower.includes('gastos desse mes') ||
    lower.includes('gastos de abril') ||
    lower.includes('meus gastos') ||
    lower.includes('ver meus gastos') ||
    lower.includes('saber dos meus gastos') ||
    lower.includes('como estao meus gastos') ||
    lower.includes('como estão meus gastos')
  ) {
    const { month, year } = currentMonthYear(now);
    return { type: 'monthly-summary', month, year };
  }

  const amountCents = parseAmountToCents(lower);

  if (amountCents && (isIncome || isExpense || looksLikeExpenseStatement(lower, amountCents))) {
    return {
      type: 'register-transaction',
      kind: isIncome ? 'income' : 'expense',
      amountCents,
      category: inferCategory(lower),
      description: text,
      occurredAtIso: parseRelativeOccurredAt(text, now) ?? now.toISOString()
    };
  }

  return {
    type: 'help',
    reason: 'Não consegui entender se você quer lançar uma transação ou pedir resumo do mês.'
  };
}

function parseAiJsonOutput(raw: string): unknown | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;

  try {
    return JSON.parse(candidate);
  } catch {
    const firstBrace = candidate.indexOf('{');
    const lastBrace = candidate.lastIndexOf('}');

    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
      return null;
    }

    try {
      return JSON.parse(candidate.slice(firstBrace, lastBrace + 1));
    } catch {
      return null;
    }
  }
}

function normalizeAiIntent(intent: AiIntent, text: string, now: Date): ParsedIntent {
  const normalized = normalizePtText(text);

  if (
    (intent.type === 'register-transaction' ||
      intent.type === 'set-spending-limit' ||
      intent.type === 'clear-spending-limit' ||
      intent.type === 'delete-last-transaction' ||
      intent.type === 'correct-last-transaction') &&
    hasQuestionSignal(normalized, text) &&
    !hasExplicitTransactionalSignal(normalized)
  ) {
    const safeRule = ruleBased(text, now);
    if (safeRule.type !== 'help') {
      return safeRule;
    }
  }

  if (intent.type === 'register-transaction') {
    // Never trust model-only amount extraction; require value parsable from user text.
    const parsedAmountFromText = parseAmountToCents(text);
    const amountCents = parsedAmountFromText ?? intent.amountCents;
    if (!intent.kind || !amountCents) {
      return ruleBased(text, now);
    }

    const inferredOccurredAtIso = parseRelativeOccurredAt(text, now);

    return {
      type: 'register-transaction',
      kind: intent.kind,
      amountCents,
      category: pickBestCategory(intent.category, text),
      description: intent.description?.trim() || text,
      occurredAtIso: inferredOccurredAtIso ?? intent.occurredAtIso ?? now.toISOString()
    };
  }

  if (intent.type === 'monthly-summary') {
    const { month, year } = currentMonthYear(now);
    return {
      type: 'monthly-summary',
      month: intent.month ?? month,
      year: intent.year ?? year
    };
  }

  if (intent.type === 'delete-last-transaction') {
    return {
      type: 'delete-last-transaction',
      kind: intent.kind ?? 'expense'
    };
  }

  if (intent.type === 'correct-last-transaction') {
    const detected = parseAmountsToCents(text);
    const parsedAmountFromText = detected[detected.length - 1] ?? parseAmountToCents(text);
    const newAmountCents = parsedAmountFromText ?? intent.newAmountCents;
    const explicitCategory = inferCategory(text);
    const category = explicitCategory !== 'outros'
      ? explicitCategory
      : undefined;

    if (!newAmountCents || newAmountCents <= 0) {
      return ruleBased(text, now);
    }

    return {
      type: 'correct-last-transaction',
      kind: intent.kind ?? 'expense',
      category,
      newAmountCents
    };
  }

  if (intent.type === 'set-spending-limit') {
    // Limit amount must be explicitly parseable in message to avoid hallucinated values.
    const amountFromText = parseLimitAmountToCents(text);
    if (!intent.period) {
      return ruleBased(text, now);
    }
    if (!amountFromText || amountFromText <= 0) {
      return {
        type: 'set-spending-limit-missing-amount',
        period: intent.period
      };
    }
    return {
      type: 'set-spending-limit',
      period: intent.period,
      amountCents: amountFromText
    };
  }

  if (intent.type === 'set-spending-limit-missing-amount') {
    return {
      type: 'set-spending-limit-missing-amount',
      period: intent.period ?? 'weekly'
    };
  }

  if (intent.type === 'clear-spending-limit') {
    if (!intent.period) {
      return ruleBased(text, now);
    }
    return {
      type: 'clear-spending-limit',
      period: intent.period
    };
  }

  if (intent.type === 'list-spending-limits') {
    return { type: 'list-spending-limits' };
  }

  if (intent.type === 'ask-current-total') {
    return { type: 'ask-current-total' };
  }

  if (intent.type === 'ask-month-summary') {
    const { month, year } = currentMonthYear(now);
    return {
      type: 'ask-month-summary',
      month: intent.month ?? month,
      year: intent.year ?? year
    };
  }

  if (intent.type === 'ask-breakdown') {
    const { month, year } = currentMonthYear(now);
    return {
      type: 'ask-breakdown',
      month: intent.month ?? month,
      year: intent.year ?? year
    };
  }

  if (intent.type === 'ask-explanation') {
    return { type: 'ask-explanation' };
  }

  if (intent.type === 'ask-confirmation') {
    return { type: 'ask-confirmation' };
  }

  if (intent.type === 'ask-projection-reason') {
    return { type: 'ask-projection-reason' };
  }

  if (intent.type === 'confirm-transaction-action') {
    return {
      type: 'confirm-transaction-action',
      action: 'register-transaction',
      amountCents: parseAmountToCents(text) ?? intent.amountCents,
      kind: 'expense',
      category: pickBestCategory(intent.category, text),
      description: text,
      occurredAtIso: parseRelativeOccurredAt(text, now) ?? intent.occurredAtIso ?? now.toISOString(),
      reason: intent.reason ?? 'ambiguous-question'
    };
  }

  return {
    type: 'help',
    reason: intent.reason ?? 'Não entendi sua solicitação.'
  };
}

export async function parseIntent(text: string, now: Date, options: ParseIntentOptions = {}): Promise<ParsedIntent> {
  const ruleIntent = ruleBased(text, now, options.context);
  const lowered = text.trim().toLowerCase();
  const normalized = normalizePtText(text);
  const isGreeting = /^\s*(oi|ola|olá|bom dia|boa tarde|boa noite|e ai|e aí|fala|teste|ok)\b/i.test(lowered);
  const hasUsageQuestion = hasHowToUseSignal(normalized);
  const hasSleepFarewell = hasSleepFarewellSignal(normalized);
  if (options.disableAi || !client) {
    return ruleIntent;
  }

  // Keep webhook replies fast for providers like Twilio.
  // If rule-based parser already understood the command, skip the AI call.
  if (ruleIntent.type !== 'help' || isGreeting || hasUsageQuestion || hasSleepFarewell) {
    return ruleIntent;
  }

  const prompt = [
    'Você é um classificador de mensagens de finanças pessoais em português do Brasil.',
    'Responda SOMENTE JSON válido (sem markdown e sem texto extra).',
    'Regra crítica: se o usuário estiver perguntando, contestando, confirmando ou pedindo explicação, NÃO classifique como ação transacional.',
    'Números em perguntas NÃO autorizam lançamento automático.',
    'Perguntas sobre lembretes (ex: "amanhã você vai me lembrar?") NÃO são resumo mensal; classifique como help.',
    'Regra importante: perguntas de uso ("como funciona", "como te mando meus gastos", "quais comandos") devem ser type=help.',
    'Regra crítica: se a última mensagem da assistente ofereceu analisar categorias/período de gastos, e o usuário respondeu afirmativamente (ex: "Quero", "Sim"), use type=monthly-summary — NUNCA confirm-transaction-action.',
    'Se houver ambiguidade entre pergunta e registro, use type=confirm-transaction-action.',
    'Estrutura:',
    '- type: register-transaction | monthly-summary | delete-last-transaction | correct-last-transaction | set-spending-limit | set-spending-limit-missing-amount | clear-spending-limit | list-spending-limits | ask-current-total | ask-month-summary | ask-explanation | ask-confirmation | ask-breakdown | ask-projection-reason | confirm-transaction-action | help',
    '- kind: expense | income (obrigatório em register/delete/correct)',
    '- amountCents: inteiro em centavos (register)',
    '- newAmountCents: inteiro em centavos (correct)',
    '- period: daily | weekly | monthly (obrigatório em set/clear-spending-limit)',
    '- category: categoria curta em pt-BR',
    '- description: texto curto (register)',
    '- occurredAtIso: ISO datetime (register)',
    '- month/year (monthly-summary)',
    '- reason (help)',
    '',
    `Mensagem do usuário: "${text}"`,
    `Data de referência: ${now.toISOString()}`,
    `Última resposta do bot: "${options.context?.lastAssistantMessage ?? ''}"`,
    `Últimas mensagens do usuário: ${(options.context?.recentUserMessages ?? []).join(' | ') || 'sem histórico'}`
  ].join('\n');

  try {
    const response = await Promise.race([
      client.responses.create({
        model: config.openAiModel,
        input: prompt,
        temperature: 0,
        max_output_tokens: 260
      }),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('openai_timeout')), 3500);
      })
    ]);

    void recordOpenAiUsageFromResponse(response, config.openAiModel);

    const raw = response.output_text?.trim() ?? '';
    const json = parseAiJsonOutput(raw);
    if (!json) {
      return ruleBased(text, now);
    }

    const parsed = aiSchema.parse(json);
    return normalizeAiIntent(parsed, text, now);
  } catch {
    return ruleBased(text, now, options.context);
  }
}

function sanitizeAssistantReply(text: string): string {
  const cleaned = text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/\s+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (cleaned.length <= 760) {
    return cleaned;
  }

  return `${cleaned.slice(0, 757).trimEnd()}...`;
}

function fallbackSupportReply(params: {
  text: string;
  customerName?: string | null;
  planName?: string;
  replyMode?: 'default' | 'owner';
}): string {
  const normalized = normalizePtText(params.text);
  const firstName = params.customerName?.trim().split(/\s+/)[0] || 'você';
  const replyMode = params.replyMode ?? 'default';

  if (replyMode === 'owner') {
    if (hasSleepFarewellSignal(normalized)) {
      return [
        `Boa noite, ${firstName}.`,
        'Fecho por aqui e seguimos amanhã.',
        'Se quiser, já deixo um resumo operacional pronto para o próximo horário.'
      ].join('\n');
    }

    if (hasHowToUseSignal(normalized)) {
      return [
        `Perfeito, ${firstName}.`,
        'Comandos úteis: "gastos de hoje", "resumo do mês", "limite semanal 800", "status +55...".',
        'Me diga a consulta exata e eu respondo de forma objetiva.'
      ].join('\n');
    }

    if (hasSocialConversationSignal(normalized)) {
      return [
        `Tudo certo por aqui, ${firstName}.`,
        'Se quiser, já me passe a consulta financeira que eu respondo direto.'
      ].join('\n');
    }

    if (/\b(plano|preco|preço|upgrade)\b/.test(normalized)) {
      return [
        `Hoje você está no plano ${params.planName || 'atual'}.`,
        'Se me disser seu uso médio, eu comparo a melhor opção sem rodeio.'
      ].join('\n');
    }

    return [
      `${firstName}, para eu responder com precisão, me diga a consulta em uma frase.`,
      'Exemplo: "resumo do mês", "gastos de hoje", "status +55...".'
    ].join('\n');
  }

  if (hasSleepFarewellSignal(normalized)) {
    return [
      `Boa noite, ${firstName}. Descansa bem 😴`,
      'Amanhã eu te chamo para organizar seus gastos com calma.',
      'Mais ou menos que horário você prefere que eu te lembre?'
    ].join('\n');
  }

  if (hasHowToUseSignal(normalized)) {
    return [
      `Perfeito, ${firstName}. Você já pode me mandar gasto do jeito que fala no dia a dia.`,
      'Exemplo: "hoje gastei 35 no mercado" ou "ontem paguei 18 de transporte".',
      'Se quiser, manda um agora e eu já te devolvo com análise objetiva.'
    ].join('\n');
  }

  if (hasSocialConversationSignal(normalized)) {
    return [
      `Tudo certo por aqui, ${firstName} 🙂`,
      'Bora manter seu controle em dia?',
      'Você prefere começar anotando um gasto de hoje ou definindo uma meta do mês?'
    ].join('\n');
  }

  if (/\b(plano|preco|preço|upgrade)\b/.test(normalized)) {
    return [
      `Posso te explicar os planos em 1 minuto, ${firstName}.`,
      `Hoje você está no plano ${params.planName || 'atual'}.`,
      'Se me contar seu volume de uso, eu te digo qual opção faz mais sentido sem você pagar a mais.'
    ].join('\n');
  }

  return [
    `${firstName}, me diz em 1 frase o que você quer resolver agora.`,
    'Exemplos rápidos: "resumo do mês", "limite semanal 800", "corrigir último gasto".',
    'Eu te devolvo direto com o próximo passo útil, sem enrolar.'
  ].join('\n');
}

function isSupportReplyAlignedWithUserIntent(userText: string, reply: string): boolean {
  const normalizedUser = normalizePtText(userText);
  const normalizedReply = normalizePtText(reply);

  if (hasHowToUseSignal(normalizedUser)) {
    // If user asked how to use, answer must clearly explain execution usage.
    return /\b(como|manda|envia|anota|registr|gasto|exemplo)\b/.test(normalizedReply);
  }

  if (/\b(plano|preco|preço|upgrade|mensal|assinatura|familia|family|essencial|premium|elite)\b/.test(normalizedUser)) {
    return /\b(plano|preco|preço|mensal|limite|recurso|upgrade|membro|r\$|familia|family|essencial|premium|elite|inclusos?|acesso)\b/.test(normalizedReply);
  }

  if (/\b(lembrete|lembrar|lembra|vencimento)\b/.test(normalizedUser)) {
    return /\b(lembrete|aviso|horario|horário|data|antecedencia|antecedência)\b/.test(normalizedReply);
  }

  return true;
}

export async function generateScopedSupportReply(params: {
  text: string;
  customerName?: string | null;
  now?: Date;
  previousAssistantReply?: string | null;
  recentUserMessages?: string[];
  conversationHistory?: Array<{ direction: 'inbound' | 'outbound'; message: string }>;
  planName?: string;
  planCode?: string;
  monthlyMessageLimit?: number;
  messagesUsedThisMonth?: number;
  availablePlansSummary?: string;
  allowedFeaturesSummary?: string;
  blockedFeaturesSummary?: string;
  monthlyIncomeCents?: number | null;
  replyMode?: 'default' | 'owner';
  jardesKnowledge?: string;
  customerProfileFacts?: string;
}): Promise<string | null> {
  if (!client) {
    return null;
  }

  const referenceDate = params.now ?? new Date();
  const userName = params.customerName?.trim() || 'cliente';
  const currentPlanName = params.planName || 'Essencial';
  const currentPlanCode = params.planCode || 'essential';
  const monthlyLimit = Number(params.monthlyMessageLimit || 0);
  const used = Number(params.messagesUsedThisMonth || 0);
  const replyMode = params.replyMode ?? 'default';
  const localDateRef = new Intl.DateTimeFormat('pt-BR', {
    timeZone: config.defaultTimezone,
    dateStyle: 'short',
    timeStyle: 'short'
  }).format(referenceDate);
  const modeInstructions = replyMode === 'owner'
    ? [
      'Modo de resposta: owner-operacional.',
      '- Priorize resposta curta, factual e acionável.',
      '- Não force CTA de engajamento ("anotar gasto", "definir meta", etc.) em toda resposta.',
      '- Só faça pergunta de continuidade se faltar dado para executar algo ou se o usuário pedir recomendação.'
    ]
    : [
      'Modo de resposta: conversacional.',
      '- Se fizer sentido, inclua um próximo passo financeiro curto e contextual.',
      '- Evite repetir convites idênticos em mensagens consecutivas.'
    ];

  const prompt = [
    'Você é Iara, assistente financeira via WhatsApp.',
    'Responda em pt-BR, tom humano, simpático, direto e natural (como uma assistente real).',
    'Você não é um app; você é uma assistente inteligente de gestão financeira e organização de vida.',
    'Você deve conversar com naturalidade, como humana, sem soar robótica.',
    'Seu objetivo principal é reduzir decisões do usuário: transformar dados em direção prática.',
    'Missão: antecipar problemas, reduzir erros, orientar decisões e melhorar comportamento financeiro ao longo do tempo.',
    'Regras obrigatórias:',
    '1) Você pode responder perguntas gerais de forma breve e humana; só proponha próximo passo quando isso agregar valor.',
    '2) Se o usuário pedir algo fora do escopo financeiro, responda curto sem travar a conversa e reconduza para finanças.',
    '3) Próximo passo é opcional: inclua no máximo 1 quando fizer sentido; não force CTA em toda resposta.',
    '4) Use humor leve e respeitoso (no máximo uma frase curta).',
    '5) Limite padrão: 2 a 6 linhas.',
    '6) Não use markdown, não invente capacidades técnicas.',
    '7) Se a mensagem estiver ambígua, faça 1 pergunta curta de clarificação antes de assumir algo.',
    '8) Evite repetir literalmente a última resposta enviada.',
    '9) Se o usuário perguntar "como funciona", explique em linguagem simples e cite no máximo 4 exemplos práticos.',
    '10) Nunca invente que vai apagar/corrigir/lançar algo sem o usuário pedir isso explicitamente.',
    '11) Se o usuário pedir preço/plano, explique os planos disponíveis de forma objetiva, sem inventar valores/limites fora do resumo informado.',
    '12) Se o usuário mandar saudação ("oi", "bom dia", "como vai"), responda como humana primeiro e mantenha a continuidade natural.',
    '13) Quando houver dados suficientes, inclua previsão curta e ação prática ("se continuar assim...", "recomendo...").',
    '14) Não seja passiva: antecipe risco/limite/meta quando houver contexto.',
    '15) Em dúvida de plano, compare no máximo 2 planos por vez e termine perguntando o perfil de uso para recomendar melhor.',
    '16) Evite frases genéricas de chatbot como "como posso te ajudar?" ou "fico feliz em ajudar".',
    '17) Estrutura de resposta preferida: resposta direta + insight + sugestão curta.',
    '18) Se houver risco financeiro, deixe explícito em linguagem simples (ex: "pode faltar dinheiro").',
    '19) Se a mensagem do usuário for pergunta/confirmação/contestação, não trate como novo lançamento. Responda explicando o estado atual.',
    '20) Não envie menu longo automaticamente. Só liste vários comandos se o usuário pedir comandos/funcionamento.',
    '21) Evite linguagem robótica de menu e respostas repetidas.',
    '22) Evite CTA repetitivo (principalmente "anotar gasto"). Varie pelo contexto e pode encerrar sem CTA quando a pergunta já estiver resolvida.',
    '23) Se o usuário pedir algo que não está no plano atual, explique isso de forma humana e curta: diga o que ele consegue fazer agora no plano dele + qual plano libera o recurso.',
    '24) Nunca diga que um recurso está liberado se ele aparecer na lista de recursos bloqueados do plano atual.',
    '25) Quando o usuário pedir ajuda sobre planos, responda como consultora (sem texto engessado), conectando benefício ao cenário dele.',
    '26) Sempre responda primeiro a pergunta exata do usuário e só depois complemente com insight/sugestão.',
    '27) Evite mudar de assunto sem responder o que ele perguntou.',
    '28) Se a pergunta for sobre "como usar", explique com exemplos práticos curtos e objetivos.',
    '29) Se o usuário mostrar insegurança, valide com empatia e proponha um próximo passo simples.',
    '30) Em respostas sobre planos, deixe claro o que o plano atual já faz agora e o que o próximo plano adiciona.',
    '31) Faça perguntas de continuidade inteligentes para coletar contexto útil (renda, objetivo, prazo, frequência), sem interrogatório.',
    '32) Se houver dúvida de interpretação, faça 1 pergunta de confirmação antes de executar qualquer ação transacional.',
    '33) Nunca diga que já criou/anotou/ajustou algo (gasto, meta, limite, lembrete) sem confirmação factual no contexto. Em dúvida, ofereça criar/agendar agora.',
    '34) Certividade: responda com segurança e clareza. Se houver incerteza, declare em 1 frase e faça uma pergunta objetiva para confirmar.',
    '35) Não desvie da pergunta principal do usuário. Responda primeiro exatamente o que ele perguntou, sem trocar por resumo aleatório.',
    '36) Linguagem de WhatsApp: curta, humana, sem cara de central de atendimento.',
    '37) NUNCA repita o nome do usuário em mensagens consecutivas. Se já usou o nome na resposta anterior, OMITA o nome na próxima. Alterne entre usar o nome e não usar — máximo 1 vez a cada 3 respostas.',
    '38) Varie sempre as palavras de abertura. Nunca abra duas respostas seguidas com a mesma palavra ou saudação. Exemplos de variação: "Anotado!", "Registrado!", "Certo,", "Feito!", "Boa,", "Entendido,", "Show,", "Ok,", "Perfeito,", "Pronto!" — escolha conforme o contexto e NÃO repita a mesma nos próximos turnos.',
    '39) Se a mensagem anterior da Iara começou com "Oi" ou usou o nome do usuário, a próxima NÃO deve começar com "Oi" nem usar o nome.',
    '40) Horário brasileiro: use apenas "Bom dia" (6h–12h), "Boa tarde" (12h–18h) ou "Boa noite" (18h–6h). NUNCA use "Boa madrugada" — não existe em português do Brasil.',
    '41) NUNCA invente ou suponha valores financeiros (totais, saldos, limites). Use apenas valores que apareçam explicitamente no contexto de dados fornecidos. Se não tiver os dados, diga que vai verificar.',
    ...modeInstructions,
    '',
    'Capacidades do bot:',
    '- Lançar gasto/receita',
    '- Corrigir lançamento',
    '- Apagar último gasto/receita',
    '- Mostrar gastos de hoje',
    '- Mostrar resumo do mês',
    '- Definir, remover e listar limite diário/semanal/mensal',
    '- Criar e acompanhar metas financeiras',
    '- Criar e listar lembretes de contas/vencimentos',
    '- Exibir insights de comportamento financeiro',
    '- Detectar possíveis gastos recorrentes',
    '- Mostrar previsão de saldo do mês',
    '- Simular investimento simples por aporte mensal',
    '- Modo família: compartilhar gastos com até 3 membros (extensível por membro extra)',
    '',
    'Regras comerciais (use apenas estas — não invente valores):',
    '- Não existe taxa de ativação/setup. O cliente paga apenas a mensalidade mensal.',
    '- Plano Família: inclui 3 membros. Membro extra custa R$34,90/mês cada.',
    '- Para entrar em uma família, o membro envia: "entrar na família CÓDIGO" (código de 6 caracteres).',
    '- O dono do plano família recebe códigos de convite ao ativar o plano.',
    '- Para criar um grupo familiar: "criar família" ou "criar família [nome]".',
    '',
    'Tabela completa de planos (USE ESTES VALORES EXATOS, nunca invente outros):',
    '- Gratuito: R$0/mês | 20 msgs/mês | IA básica | sem proatividade | Goals, Score',
    '- Essencial: R$49,90/mês | 180 msgs/mês | IA assistida | alertas diários | Goals, Lembretes, Score',
    '- Premium: R$99,90/mês | 550 msgs/mês | IA avançada | alertas diários | Goals, Lembretes, Insights, Gastos recorrentes, Previsão de saldo, Simulador de investimento, Score, Relatório visual mensal',
    '- Família: R$179,90/mês | 1200 msgs/mês | IA colaborativa | alertas avançados | Tudo do Premium + Modo Família (3 membros, cofres compartilhados, metas em grupo)',
    '- Elite: R$349,90/mês | 2500 msgs/mês | IA proativa máxima | alertas máximos | Tudo do Família + Open Banking (importar extratos automaticamente)',
    'Ao falar de planos: sempre conecte o benefício ao contexto da pessoa. Ex: se ela gasta muito variável, recomende insights. Se tem família, destaque o plano Família.',
    '',
    'Conhecimento sobre concorrentes (use com naturalidade quando perguntada, sempre verdadeiro e educado):',
    '- Pierre (CloudWalk): só leitura/análise, não registra gastos manualmente, plano pago começa em R$39/mês mas o gratuito conecta apenas 1 banco. Tem multiagentes mas não conversa no estilo WhatsApp natural. Suporte recebe reclamações de falta de atendimento humano e dados inconsistentes. Não é um assistente conversacional, é mais um analista passivo.',
    '- Jota (startup): conta digital + pagamentos (Pix, boleto), gratuito, mas foco é em transações, não em educação financeira nem planejamento. Não te ajuda a entender seu comportamento financeiro.',
    '- Magie (startup): similar ao Jota, foco em pagamentos e Open Finance. Não tem planejamento, metas, limites, insights ou coaching financeiro. Maior volume transacional do mercado mas não é assistente de gestão.',
    '- Meu Assessor (Tittanium): R$29,90/mês, registro manual (sem Open Finance), combina agenda + finanças. IA básica de categorização, sem análise proativa. Útil para organização, mas sem inteligência financeira real.',
    '- Financinha: R$26,90–R$36,90/mês, controle de gastos com foto/áudio/texto, sem Open Finance ainda, sem proatividade. Bom para controle básico.',
    '- ZapGastos: plano básico R$9,90/mês (anual), controle de gastos. Open Finance só no plano mais caro. Sem conversação inteligente.',
    'Diferencial da Iara: assistente conversacional completa que entende linguagem natural, registra, analisa, avisa proativamente, cria metas/limites/lembretes, e evolui com você. Não é só um banco nem só um controlador de gastos — é uma assistente financeira real no WhatsApp.',
    'Tom ao comparar: nunca denigra os concorrentes. Reconheça o que eles fazem bem e destaque o que a Iara faz a mais/diferente de forma que conecte ao perfil de quem pergunta.',
    '',
    `Nome preferido do usuário: ${userName}`,
    `Plano atual: ${currentPlanName} (${currentPlanCode})`,
    `Uso de mensagens no mês: ${used}/${monthlyLimit || 'sem limite'}`,
    `Recursos liberados no plano atual: ${params.allowedFeaturesSummary || 'não informado'}`,
    `Recursos bloqueados no plano atual: ${params.blockedFeaturesSummary || 'não informado'}`,
    `Renda mensal informada: ${params.monthlyIncomeCents && params.monthlyIncomeCents > 0 ? `sim (${(params.monthlyIncomeCents / 100).toFixed(2)})` : 'não'}`,
    `Resumo dos planos disponíveis: ${params.availablePlansSummary || 'não informado'}`,
    `Data de referência: ${referenceDate.toISOString()}`,
    `Data/hora local do usuário (${config.defaultTimezone}): ${localDateRef}`,
    `Última resposta enviada (evitar repetir): "${params.previousAssistantReply ?? ''}"`,
    `Últimas mensagens do usuário: ${(params.recentUserMessages ?? []).join(' | ') || 'sem histórico'}`,
    ...(params.customerProfileFacts ? [
      '',
      '--- PERFIL APRENDIDO DO CLIENTE (use para personalizar respostas) ---',
      params.customerProfileFacts
    ] : []),
    ...(params.jardesKnowledge ? [
      '',
      '--- APRENDIZADOS DO JARDES (APLICAR SEMPRE) ---',
      params.jardesKnowledge
    ] : []),
    ...(params.conversationHistory && params.conversationHistory.length > 0 ? [
      '',
      '--- HISTÓRICO RECENTE DA CONVERSA (do mais antigo ao mais recente) ---',
      ...params.conversationHistory
        .slice()
        .reverse()
        .map(h => h.direction === 'inbound' ? `[USUÁRIO]: ${h.message}` : `[IARA]: ${h.message}`)
    ] : []),
    `Mensagem atual do usuário: "${params.text}"`
  ].join('\n');

  const requestSupport = async (maxOutputTokens: number, timeoutMs: number, temperature: number): Promise<string | null> => {
    const response = await Promise.race([
      client.responses.create({
        model: config.openAiAgentModel,
        input: prompt,
        temperature,
        max_output_tokens: maxOutputTokens
      }),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('openai_support_timeout')), timeoutMs);
      })
    ]);

    void recordOpenAiUsageFromResponse(response, config.openAiAgentModel);
    const raw = response.output_text?.trim();
    if (!raw) return null;
    const reply = sanitizeAssistantReply(raw);
    return reply.length > 0 ? reply : null;
  };

  try {
    const primary = await requestSupport(480, 9000, config.openAiAgentTemperature);
    if (primary && isSupportReplyAlignedWithUserIntent(params.text, primary)) return primary;

    // Retry curto para reduzir quedas ocasionais de resposta vazia.
    try {
      const retry = await requestSupport(360, 6000, Math.max(0.65, Math.min(config.openAiAgentTemperature, 0.9)));
      if (retry && isSupportReplyAlignedWithUserIntent(params.text, retry)) return retry;
    } catch {
      // segue para fallback humano local
    }
    return fallbackSupportReply(params);
  } catch {
    return fallbackSupportReply(params);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Profile fact extraction — detects and persists customer profile from conversation
// ─────────────────────────────────────────────────────────────────────────────

const PROFILE_FACT_KEYS = [
  'profissao',          // MEI, CLT, empresário, freelancer, servidor, desempregado
  'tem_dependentes',    // sim (2 filhos) | não
  'tem_financiamento',  // sim (imóvel) | sim (carro) | não
  'tem_divida',         // sim (empréstimo pessoal) | não
  'objetivo_curto',     // ex: quitar dívida em 18 meses
  'objetivo_longo',     // ex: aposentadoria, comprar imóvel
  'renda_tipo',         // fixa | variável | múltipla
  'estilo_comunicacao', // curto | detalhado | direto | informal
  'situacao_familiar',  // solteiro | casado | tem filhos | divorciado
  'notas_vida',         // ex: mora de aluguel, tem carro financiado, faz freelas
] as const;

export const PROFILE_FACT_KEY_LABELS: Record<string, string> = {
  profissao:          'Profissão',
  tem_dependentes:    'Dependentes',
  tem_financiamento:  'Financiamentos',
  tem_divida:         'Dívidas',
  objetivo_curto:     'Objetivo de curto prazo',
  objetivo_longo:     'Objetivo de longo prazo',
  renda_tipo:         'Tipo de renda',
  estilo_comunicacao: 'Estilo de comunicação preferido',
  situacao_familiar:  'Situação familiar',
  notas_vida:         'Contexto de vida',
};

export function formatProfileFactsForPrompt(facts: Array<{ key: string; value: string }>): string | undefined {
  if (facts.length === 0) return undefined;
  return facts
    .map(f => `• ${PROFILE_FACT_KEY_LABELS[f.key] ?? f.key}: ${f.value}`)
    .join('\n');
}

export async function extractAndSaveProfileFacts(params: {
  customerId: string;
  recentMessages: Array<{ direction: 'inbound' | 'outbound'; message: string }>;
}): Promise<void> {
  if (!client) return;
  const inboundMsgs = params.recentMessages.filter(m => m.direction === 'inbound');
  if (inboundMsgs.length === 0) return;

  // Only extract if the client said something potentially personal
  const inboundText = inboundMsgs.map(m => m.message).join(' ').toLowerCase();
  const hasPersonalSignal = /\b(sou|trabalho|moro|tenho|filho|filha|casad|divorci|soltei|financi|divid|emprest|renda|freela|clt|mei|empresa|autonomo|autônomo|objetivo|meta|sonho|plano|quitar|aposentar)\b/.test(inboundText);
  if (!hasPersonalSignal) return;

  const existingFacts = await getCustomerProfileFacts(params.customerId);
  const existingText = existingFacts.length > 0
    ? '\nFatos já salvos:\n' + existingFacts.map(f => `${f.key}: ${f.value}`).join('\n')
    : '';

  const conversationText = params.recentMessages
    .slice(-6)
    .map(m => `${m.direction === 'inbound' ? 'Cliente' : 'Iara'}: ${m.message.slice(0, 200)}`)
    .join('\n');

  const prompt = [
    'Você extrai fatos objetivos sobre um cliente de uma conversa com uma assistente financeira.',
    '',
    `Chaves permitidas: ${PROFILE_FACT_KEYS.join(', ')}`,
    '',
    'Regras:',
    '- Só extraia o que o CLIENTE explicitamente disse (linhas "Cliente:")',
    '- Se contradizer fato existente, inclua com o novo valor',
    '- Se não houver nada novo ou relevante, retorne {"facts": []}',
    '- Valores: curtos, objetivos (máx 80 caracteres)',
    '- Não infira, não suponha',
    existingText,
    '',
    'Conversa:',
    conversationText,
    '',
    'Retorne APENAS JSON: {"facts": [{"key": "chave_exata", "value": "valor"}]}'
  ].join('\n');

  try {
    const response = await Promise.race([
      client.responses.create({
        model: config.openAiModel,
        input: prompt,
        temperature: 0,
        max_output_tokens: 220
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 3500))
    ]);
    void recordOpenAiUsageFromResponse(response, config.openAiModel);

    const raw = response.output_text?.trim() ?? '';
    const json = parseAiJsonOutput(raw) as { facts?: Array<{ key: string; value: string }> } | null;
    if (!json?.facts || json.facts.length === 0) return;

    for (const fact of json.facts) {
      const key = fact.key?.trim();
      const value = fact.value?.trim();
      if (
        key &&
        value &&
        (PROFILE_FACT_KEYS as readonly string[]).includes(key) &&
        value.length <= 120
      ) {
        await upsertCustomerProfileFact({ customerId: params.customerId, key, value });
      }
    }
  } catch {
    // fire-and-forget — never blocks the response pipeline
  }
}
