import { pool } from '../db/pool.js';
import { upsertCustomerProfileFact } from './ledger.js';

type OnboardingStatus = 'pending' | 'in_progress' | 'snoozed' | 'completed';

type OnboardingState = {
  customerId: string;
  status: OnboardingStatus;
  currentStep: number;
};

type OnboardingStep = {
  key: string;
  question: string;
  parse: (text: string) => string | null;
};

let onboardingSchemaReady: Promise<void> | null = null;

function normalizeText(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function sanitizeFactValue(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 120);
}

function parsePreferredName(text: string): string | null {
  const cleaned = text.trim();
  if (!cleaned) return null;
  const m =
    cleaned.match(/\b(me chamo|me chama|pode me chamar|sou o|sou a)\s+([a-zA-ZÀ-ÿ][a-zA-ZÀ-ÿ'\-\s]{1,30})/i) ??
    cleaned.match(/^([a-zA-ZÀ-ÿ][a-zA-ZÀ-ÿ'\-\s]{1,30})$/i);
  const candidate = (m?.[2] ?? m?.[1] ?? '').trim();
  if (!candidate || candidate.length < 2) return null;
  return sanitizeFactValue(candidate);
}

function parseAge(text: string): string | null {
  const m = text.match(/\b(\d{1,2})\b/);
  if (!m) return null;
  const age = Number(m[1]);
  if (!Number.isFinite(age) || age < 12 || age > 99) return null;
  return String(age);
}

function parseIncomeRange(text: string): string | null {
  const normalized = normalizeText(text);
  const money = text.match(/(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{1,2})?)/);
  if (normalized.includes('ate 2') || normalized.includes('até 2')) return 'até R$2 mil';
  if (normalized.includes('2') && normalized.includes('5')) return 'R$2 mil a R$5 mil';
  if (normalized.includes('5') && normalized.includes('10')) return 'R$5 mil a R$10 mil';
  if (normalized.includes('acima') || normalized.includes('mais de 10')) return 'acima de R$10 mil';
  if (money?.[1]) return sanitizeFactValue(`aprox. R$${money[1]}`);
  if (normalized.length >= 3) return sanitizeFactValue(text);
  return null;
}

function parseMonthlySpendRange(text: string): string | null {
  const normalized = normalizeText(text);
  const money = text.match(/(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{1,2})?)/);
  if (normalized.includes('nao sei') || normalized.includes('não sei')) return 'a definir';
  if (money?.[1]) return sanitizeFactValue(`aprox. R$${money[1]}`);
  if (normalized.length >= 3) return sanitizeFactValue(text);
  return null;
}

function parseNinetyDayGoal(text: string): string | null {
  const cleaned = sanitizeFactValue(text);
  if (cleaned.length < 4) return null;
  return cleaned;
}

const ONBOARDING_STEPS: OnboardingStep[] = [
  {
    key: 'preferred_name',
    question: 'Antes de tudo: como você prefere que eu te chame?',
    parse: parsePreferredName
  },
  {
    key: 'age',
    question: 'Boa. Quantos anos você tem hoje?',
    parse: parseAge
  },
  {
    key: 'income_range',
    question: 'Pra eu te orientar melhor: sua faixa de renda mensal é até R$2 mil, R$2-5 mil, R$5-10 mil ou acima de R$10 mil?',
    parse: parseIncomeRange
  },
  {
    key: 'monthly_spend_range',
    question: 'E seu gasto mensal total hoje está em qual faixa aproximada?',
    parse: parseMonthlySpendRange
  },
  {
    key: 'goal_90d',
    question: 'Última: qual seu principal objetivo financeiro para os próximos 90 dias?',
    parse: parseNinetyDayGoal
  }
];

const ONBOARDING_PAUSE_SIGNALS = /\b(depois|agora nao|agora não|pausa|pausar|pular|deixa pra depois|deixa para depois)\b/i;

export function shouldBypassOnboardingForMessage(text: string): boolean {
  const normalized = normalizeText(text);
  return /\b(gastei|ganhei|recebi|resumo|relatorio|relatório|meta|lembrete|fatura|pix|transferi|saldo|quanto gastei)\b/.test(normalized);
}

async function ensureOnboardingSchema(): Promise<void> {
  if (!onboardingSchemaReady) {
    onboardingSchemaReady = pool.query(`
      CREATE TABLE IF NOT EXISTS customer_onboarding_state (
        customer_id  UUID PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
        status       TEXT NOT NULL DEFAULT 'pending',
        current_step INTEGER NOT NULL DEFAULT 0,
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS idx_customer_onboarding_state_status
        ON customer_onboarding_state(status);
    `).then(() => undefined).catch((error) => {
      onboardingSchemaReady = null;
      throw error;
    });
  }
  await onboardingSchemaReady;
}

async function getOnboardingState(customerId: string): Promise<OnboardingState> {
  await ensureOnboardingSchema();
  const result = await pool.query<{ status: OnboardingStatus; current_step: number }>(
    `SELECT status, current_step FROM customer_onboarding_state WHERE customer_id = $1 LIMIT 1`,
    [customerId]
  );
  if (!result.rows[0]) {
    await pool.query(
      `INSERT INTO customer_onboarding_state (customer_id, status, current_step) VALUES ($1, 'pending', 0)`,
      [customerId]
    );
    return { customerId, status: 'pending', currentStep: 0 };
  }
  return {
    customerId,
    status: result.rows[0].status,
    currentStep: Number(result.rows[0].current_step || 0)
  };
}

async function saveOnboardingState(customerId: string, status: OnboardingStatus, currentStep: number): Promise<void> {
  await ensureOnboardingSchema();
  await pool.query(
    `INSERT INTO customer_onboarding_state (customer_id, status, current_step, updated_at, completed_at)
     VALUES ($1, $2, $3, NOW(), CASE WHEN $2 = 'completed' THEN NOW() ELSE NULL END)
     ON CONFLICT (customer_id) DO UPDATE
       SET status = EXCLUDED.status,
           current_step = EXCLUDED.current_step,
           updated_at = NOW(),
           completed_at = CASE WHEN EXCLUDED.status = 'completed' THEN NOW() ELSE customer_onboarding_state.completed_at END`,
    [customerId, status, currentStep]
  );
}

export async function beginSmartOnboarding(customerId: string): Promise<string> {
  await saveOnboardingState(customerId, 'in_progress', 0);
  return `Perfeito, seu plano já está ativo ✅\n\nPra eu te atender de forma mais inteligente, vou fazer 5 perguntas rápidas.\n${ONBOARDING_STEPS[0].question}`;
}

export async function handleSmartOnboardingReply(params: {
  customerId: string;
  text: string;
}): Promise<string | null> {
  const state = await getOnboardingState(params.customerId);
  if (state.status === 'completed') return null;
  if (state.status === 'pending') return null;
  if (state.status === 'snoozed') return null;

  if (ONBOARDING_PAUSE_SIGNALS.test(normalizeText(params.text))) {
    await saveOnboardingState(params.customerId, 'snoozed', state.currentStep);
    return 'Sem problema. Pauso o onboarding por enquanto e seguimos o fluxo normal. Quando quiser retomar, é só dizer: "retomar onboarding".';
  }

  const currentStep = ONBOARDING_STEPS[state.currentStep];
  if (!currentStep) {
    await saveOnboardingState(params.customerId, 'completed', ONBOARDING_STEPS.length);
    return null;
  }

  const parsed = currentStep.parse(params.text);
  if (!parsed) {
    return `Não captei bem essa resposta. ${currentStep.question}`;
  }

  await upsertCustomerProfileFact({
    customerId: params.customerId,
    key: currentStep.key,
    value: parsed,
    source: 'onboarding'
  });

  const nextStep = state.currentStep + 1;
  if (nextStep >= ONBOARDING_STEPS.length) {
    await saveOnboardingState(params.customerId, 'completed', nextStep);
    return 'Fechamos seu onboarding inicial ✅ Já personalizei seu perfil e vou te orientar com base nisso daqui pra frente.';
  }

  await saveOnboardingState(params.customerId, 'in_progress', nextStep);
  return `Perfeito. ${ONBOARDING_STEPS[nextStep].question}`;
}

export async function resumeSmartOnboarding(customerId: string): Promise<string | null> {
  const state = await getOnboardingState(customerId);
  if (state.status === 'completed') return null;
  const step = Math.max(0, Math.min(state.currentStep, ONBOARDING_STEPS.length - 1));
  await saveOnboardingState(customerId, 'in_progress', step);
  return `Retomando de onde paramos 👇\n${ONBOARDING_STEPS[step].question}`;
}

