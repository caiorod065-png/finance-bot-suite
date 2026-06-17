import { pool } from '../db/pool.js';
import { config } from '../config.js';
import type { SpendingLimitPeriod } from '../types.js';
import {
  FAMILY_EXTRA_MEMBER_MONTHLY_FEE_CENTS,
  getPlanDefinition,
  isPlanCode,
  listPlanDefinitions,
  type PlanCode
} from './plans.js';
import {
  todayIsoDate,
  isoDateInTimezone,
  toIsoDate,
  addDaysIsoDate,
  addMonthsIsoDate,
  addMonthsIsoFromDate,
  daysDiffInclusive,
  nextMonthlyDueDate,
  monthBounds,
  periodBounds,
} from './ledger/utils.js';
import { listBillReminders, financialGoalsProgress } from './ledger/goals-reminders.js';

type SubscriptionRow = {
  id: string;
  customer_id: string;
  status: string;
  setup_fee_cents: number;
  base_monthly_fee_cents: number;
  discounted_monthly_fee_cents: number;
  family_extra_member_slots: number;
  referral_count: number;
  referral_threshold: number;
  has_paid_setup: boolean;
  start_date: string | null;
  next_due_date: string | null;
  last_payment_date: string | null;
  grace_days: number;
  trial_enabled: boolean;
  trial_start_date: string | null;
  trial_end_date: string | null;
  plan_code: string | null;
};

type SpendingLimitRow = {
  period: SpendingLimitPeriod;
  amount_cents: number;
  is_active: boolean;
};

type FamilyLimitRow = {
  period: SpendingLimitPeriod;
  amount_cents: number;
  is_active: boolean;
};

let spendingLimitsSchemaReady: Promise<void> | null = null;
let subscriptionSchemaReady: Promise<void> | null = null;
let customerSchemaReady: Promise<void> | null = null;
let gamificationSchemaReady: Promise<void> | null = null;
let familySchemaReady: Promise<void> | null = null;

async function ensureCustomerSchema(): Promise<void> {
  if (!customerSchemaReady) {
    customerSchemaReady = (async () => {
      await pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS tax_id TEXT`);
      await pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS monthly_income_cents INTEGER`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_customers_tax_id ON customers (tax_id)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_customers_monthly_income ON customers (monthly_income_cents)`);
    })().catch((error) => {
      customerSchemaReady = null;
      throw error;
    });
  }

  await customerSchemaReady;
}

async function ensureSubscriptionSchema(): Promise<void> {
  if (!subscriptionSchemaReady) {
    subscriptionSchemaReady = (async () => {
      await pool.query(`ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS trial_enabled BOOLEAN NOT NULL DEFAULT FALSE`);
      await pool.query(`ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS trial_start_date DATE`);
      await pool.query(`ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS trial_end_date DATE`);
      await pool.query(`ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS plan_code TEXT NOT NULL DEFAULT 'essential'`);
      await pool.query(`ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS family_extra_member_slots INTEGER NOT NULL DEFAULT 0`);
      await pool.query(
        `CREATE INDEX IF NOT EXISTS idx_subscriptions_trial_active
         ON subscriptions (trial_enabled, trial_end_date)`
      );
      await pool.query(
        `CREATE INDEX IF NOT EXISTS idx_subscriptions_plan_code
         ON subscriptions (plan_code)`
      );
    })().catch((error) => {
      subscriptionSchemaReady = null;
      throw error;
    });
  }

  await subscriptionSchemaReady;
}

async function ensureSpendingLimitsSchema(): Promise<void> {
  if (!spendingLimitsSchemaReady) {
    spendingLimitsSchemaReady = (async () => {
      await pool.query(
        `CREATE TABLE IF NOT EXISTS spending_limits (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
          period TEXT NOT NULL CHECK (period IN ('daily', 'weekly', 'monthly')),
          amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
          is_active BOOLEAN NOT NULL DEFAULT TRUE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE(customer_id, period)
        )`
      );
      await pool.query(
        `CREATE INDEX IF NOT EXISTS idx_spending_limits_customer_active
         ON spending_limits (customer_id, is_active, period)`
      );
    })().catch((error) => {
      spendingLimitsSchemaReady = null;
      throw error;
    });
  }

  await spendingLimitsSchemaReady;
}

async function ensureGamificationSchema(): Promise<void> {
  if (!gamificationSchemaReady) {
    gamificationSchemaReady = (async () => {
      await pool.query(
        `CREATE TABLE IF NOT EXISTS customer_achievements (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
          code TEXT NOT NULL,
          title TEXT NOT NULL,
          description TEXT NOT NULL,
          metadata JSONB,
          unlocked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE(customer_id, code)
        )`
      );
      await pool.query(
        `CREATE INDEX IF NOT EXISTS idx_customer_achievements_customer_unlocked
         ON customer_achievements (customer_id, unlocked_at DESC)`
      );
    })().catch((error) => {
      gamificationSchemaReady = null;
      throw error;
    });
  }

  await gamificationSchemaReady;
}

async function ensureFamilySchema(): Promise<void> {
  if (!familySchemaReady) {
    familySchemaReady = (async () => {
      await pool.query(
        `CREATE TABLE IF NOT EXISTS family_groups (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name TEXT NOT NULL,
          invite_code TEXT NOT NULL UNIQUE,
          owner_customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
          extra_member_slots INTEGER NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`
      );
      await pool.query(`ALTER TABLE family_groups ADD COLUMN IF NOT EXISTS extra_member_slots INTEGER NOT NULL DEFAULT 0`);
      await pool.query(
        `CREATE TABLE IF NOT EXISTS family_members (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          family_group_id UUID NOT NULL REFERENCES family_groups(id) ON DELETE CASCADE,
          customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
          role TEXT NOT NULL DEFAULT 'member',
          is_active BOOLEAN NOT NULL DEFAULT TRUE,
          joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE(family_group_id, customer_id)
        )`
      );
      await pool.query(
        `CREATE INDEX IF NOT EXISTS idx_family_members_customer_active
         ON family_members (customer_id, is_active)`
      );
      await pool.query(
        `CREATE TABLE IF NOT EXISTS family_limits (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          family_group_id UUID NOT NULL REFERENCES family_groups(id) ON DELETE CASCADE,
          period TEXT NOT NULL CHECK (period IN ('daily', 'weekly', 'monthly')),
          amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
          is_active BOOLEAN NOT NULL DEFAULT TRUE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE(family_group_id, period)
        )`
      );
      await pool.query(
        `CREATE INDEX IF NOT EXISTS idx_family_limits_group_active
         ON family_limits (family_group_id, is_active, period)`
      );
      await pool.query(
        `CREATE TABLE IF NOT EXISTS family_invites (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          family_group_id UUID NOT NULL REFERENCES family_groups(id) ON DELETE CASCADE,
          code TEXT NOT NULL UNIQUE,
          max_uses INTEGER NOT NULL DEFAULT 1 CHECK (max_uses > 0),
          used_count INTEGER NOT NULL DEFAULT 0 CHECK (used_count >= 0),
          created_by_customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
          expires_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`
      );
      await pool.query(
        `CREATE INDEX IF NOT EXISTS idx_family_invites_group_active
         ON family_invites (family_group_id, used_count, max_uses)`
      );
    })().catch((error) => {
      familySchemaReady = null;
      throw error;
    });
  }

  await familySchemaReady;
}

function normalizePhoneDigits(value: string | null | undefined): string {
  return (value ?? '').replace(/\D/g, '');
}

function phoneDigitsMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  // Aceita variação com/sem DDI/DDD para facilitar cadastro do número dono.
  return a.endsWith(b) || b.endsWith(a);
}

export function isOwnerWhatsappNumber(whatsappNumber: string | null | undefined): boolean {
  const normalized = normalizePhoneDigits(whatsappNumber);
  if (!normalized || config.ownerWhatsappNumbers.length === 0) return false;
  return config.ownerWhatsappNumbers.some((item) => phoneDigitsMatch(item, normalized));
}

export async function isCustomerInsideConversationWindowByWhatsapp(
  whatsappNumber: string | null | undefined,
  windowHours = 24
): Promise<boolean | null> {
  const normalized = normalizePhoneDigits(whatsappNumber);
  if (!normalized) return null;

  const safeWindowHours = Number.isFinite(windowHours)
    ? Math.max(1, Math.min(Math.floor(windowHours), 72))
    : 24;

  const result = await pool.query<{ in_window: boolean }>(
    `SELECT (last_inbound_at IS NOT NULL AND last_inbound_at >= NOW() - ($2::text || ' hours')::INTERVAL) AS in_window
     FROM customers
     WHERE regexp_replace(whatsapp_number, '\D', '', 'g') = $1
     ORDER BY updated_at DESC
     LIMIT 1`,
    [normalized, String(safeWindowHours)]
  );

  if (!result.rows[0]) {
    return null;
  }

  return Boolean(result.rows[0].in_window);
}

function generateInviteCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 6; i += 1) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

function normalizedExtraFamilySlots(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(Math.floor(value), 20));
}

function familyMonthlyAddonCents(extraSlots: number): number {
  return normalizedExtraFamilySlots(extraSlots) * FAMILY_EXTRA_MEMBER_MONTHLY_FEE_CENTS;
}

function effectiveFamilyMemberLimit(planCode: string | null | undefined, extraSlots: number): number {
  const plan = getPlanDefinition(planCode);
  return Math.max(1, plan.groupMemberLimit + normalizedExtraFamilySlots(extraSlots));
}

async function getFamilyExtraMemberSlots(customerId: string): Promise<number> {
  await ensureSubscriptionSchema();
  const result = await pool.query<{ family_extra_member_slots: number | null }>(
    `SELECT COALESCE(family_extra_member_slots, 0) AS family_extra_member_slots
     FROM subscriptions
     WHERE customer_id = $1
     LIMIT 1`,
    [customerId]
  );
  return normalizedExtraFamilySlots(Number(result.rows[0]?.family_extra_member_slots ?? 0));
}

async function syncFamilyGroupExtraSlots(ownerCustomerId: string, extraSlots: number): Promise<void> {
  await ensureFamilySchema();
  await pool.query(
    `UPDATE family_groups
     SET extra_member_slots = $2,
         updated_at = NOW()
     WHERE owner_customer_id = $1`,
    [ownerCustomerId, normalizedExtraFamilySlots(extraSlots)]
  );
}

async function createFamilyInviteCodes(params: {
  familyGroupId: string;
  createdByCustomerId?: string | null;
  count: number;
  maxUses?: number;
}): Promise<string[]> {
  await ensureFamilySchema();
  const safeCount = Math.max(1, Math.min(Math.floor(params.count), 10));
  const safeMaxUses = Math.max(1, Math.min(Math.floor(params.maxUses ?? 1), 10));
  const out: string[] = [];

  for (let i = 0; i < safeCount; i += 1) {
    let guard = 0;
    // Avoid rare collision in invite codes.
    while (guard < 15) {
      const code = generateInviteCode();
      const inserted = await pool.query<{ code: string }>(
        `INSERT INTO family_invites (family_group_id, code, max_uses, used_count, created_by_customer_id)
         VALUES ($1, $2, $3, 0, $4)
         ON CONFLICT (code) DO NOTHING
         RETURNING code`,
        [params.familyGroupId, code, safeMaxUses, params.createdByCustomerId ?? null]
      );
      if (inserted.rows[0]?.code) {
        out.push(inserted.rows[0].code);
        break;
      }
      guard += 1;
    }
  }

  return out;
}

function trialIsActive(subscription: Pick<SubscriptionRow, 'trial_enabled' | 'trial_end_date' | 'has_paid_setup'>, todayIso: string): boolean {
  return Boolean(
    !subscription.has_paid_setup &&
    subscription.trial_enabled &&
    subscription.trial_end_date &&
    todayIso <= subscription.trial_end_date
  );
}

function trialDaysLeft(trialEndDate: string, todayIso: string): number {
  const end = new Date(`${trialEndDate}T12:00:00.000Z`).getTime();
  const today = new Date(`${todayIso}T12:00:00.000Z`).getTime();
  const diff = Math.floor((end - today) / (1000 * 60 * 60 * 24)) + 1;
  return diff > 0 ? diff : 0;
}

function effectiveMonthlyFeeCents(subscription: Pick<SubscriptionRow, 'base_monthly_fee_cents' | 'discounted_monthly_fee_cents' | 'referral_count' | 'referral_threshold' | 'plan_code'>): number {
  const plan = getPlanDefinition(subscription.plan_code);
  if (plan.code === 'free') return 0;

  const baseMonthly = Math.max(subscription.base_monthly_fee_cents, 0);
  const fallbackDiscount = Math.round(baseMonthly * 0.6);
  const discountMonthly = Math.max(subscription.discounted_monthly_fee_cents || fallbackDiscount, 0);
  return subscription.referral_count >= subscription.referral_threshold
    ? discountMonthly
    : baseMonthly;
}

async function ensureSubscription(customerId: string): Promise<SubscriptionRow> {
  await ensureSubscriptionSchema();

  const existing = await pool.query<SubscriptionRow>(
    `SELECT id, customer_id, status, setup_fee_cents, base_monthly_fee_cents, discounted_monthly_fee_cents,
            family_extra_member_slots, referral_count, referral_threshold, has_paid_setup, start_date::text, next_due_date::text,
            last_payment_date::text, grace_days, trial_enabled, trial_start_date::text, trial_end_date::text, plan_code
     FROM subscriptions
     WHERE customer_id = $1
     LIMIT 1`,
    [customerId]
  );

  if (existing.rowCount && existing.rows[0]) {
    return existing.rows[0];
  }

  const created = await pool.query<SubscriptionRow>(
    `INSERT INTO subscriptions (customer_id)
     VALUES ($1)
     RETURNING id, customer_id, status, setup_fee_cents, base_monthly_fee_cents, discounted_monthly_fee_cents,
               family_extra_member_slots, referral_count, referral_threshold, has_paid_setup, start_date::text, next_due_date::text,
               last_payment_date::text, grace_days, trial_enabled, trial_start_date::text, trial_end_date::text, plan_code`,
    [customerId]
  );

  return created.rows[0];
}

export async function currentMonthInboundMessageCount(customerId: string, referenceDate = new Date(), timezone = 'America/Sao_Paulo'): Promise<number> {
  const result = await pool.query<{ total: string }>(
    `SELECT COUNT(*)::text AS total
     FROM conversation_logs
     WHERE customer_id = $1
       AND direction = 'inbound'
       AND DATE_TRUNC('month', created_at AT TIME ZONE $2) = DATE_TRUNC('month', $3::timestamptz AT TIME ZONE $2)`,
    [customerId, timezone, referenceDate.toISOString()]
  );
  return Number(result.rows[0]?.total ?? '0');
}

export async function getCustomerPlan(customerId: string): Promise<{
  planCode: PlanCode;
  planName: string;
  setupFeeCents: number;
  monthlyFeeCents: number;
  monthlyMessageLimit: number;
  features: string[];
}> {
  const subscription = await ensureSubscription(customerId);
  const plan = getPlanDefinition(subscription.plan_code);
  return {
    planCode: plan.code,
    planName: plan.name,
    setupFeeCents: plan.setupFeeCents,
    monthlyFeeCents: plan.monthlyFeeCents,
    monthlyMessageLimit: plan.monthlyMessageLimit,
    features: plan.features
  };
}

export async function setCustomerPlan(customerId: string, planCode: PlanCode): Promise<{
  customerId: string;
  planCode: PlanCode;
  planName: string;
  setupFeeCents: number;
  monthlyFeeCents: number;
  monthlyMessageLimit: number;
  familyExtraMemberSlots: number;
}> {
  await ensureSubscriptionSchema();
  const plan = getPlanDefinition(planCode);
  const currentExtraSlots = await getFamilyExtraMemberSlots(customerId);
  const familyExtraMemberSlots = plan.code === 'family' ? currentExtraSlots : 0;
  const baseMonthlyFeeCents = plan.monthlyFeeCents + familyMonthlyAddonCents(familyExtraMemberSlots);
  const discounted = Math.max(Math.round(baseMonthlyFeeCents * 0.6), 0);

  await pool.query(
    `UPDATE subscriptions
     SET plan_code = $2,
         setup_fee_cents = $3,
         base_monthly_fee_cents = $4,
         discounted_monthly_fee_cents = $5,
         family_extra_member_slots = $6,
         has_paid_setup = CASE
           WHEN $2 = 'free' THEN TRUE
           ELSE has_paid_setup
         END,
         status = CASE
           WHEN $2 = 'free' AND status = 'canceled' THEN status
           WHEN $2 = 'free' THEN 'active'
           ELSE status
         END,
         updated_at = NOW()
     WHERE customer_id = $1`,
    [customerId, plan.code, plan.setupFeeCents, baseMonthlyFeeCents, discounted, familyExtraMemberSlots]
  );

  if (plan.code === 'free') {
    await pool.query(
      `UPDATE customers
       SET is_active = TRUE, updated_at = NOW()
       WHERE id = $1`,
      [customerId]
    );
  }

  return {
    customerId,
    planCode: plan.code,
    planName: plan.name,
    setupFeeCents: plan.setupFeeCents,
    monthlyFeeCents: baseMonthlyFeeCents,
    monthlyMessageLimit: plan.monthlyMessageLimit,
    familyExtraMemberSlots
  };
}

export async function migrateSubscriptionsToCurrentPlanPricing(params?: {
  skipCanceled?: boolean;
  includeFree?: boolean;
  dryRun?: boolean;
  customerLimit?: number;
  planCodes?: PlanCode[];
}): Promise<{
  scanned: number;
  eligible: number;
  wouldUpdate: number;
  updated: number;
  skipped: number;
  dryRun: boolean;
  filters: {
    skipCanceled: boolean;
    includeFree: boolean;
    customerLimit: number;
    planCodes: PlanCode[] | null;
  };
  sample: Array<{
    customerId: string;
    planCode: PlanCode;
    status: string;
    before: {
      setupFeeCents: number;
      baseMonthlyFeeCents: number;
      discountedMonthlyFeeCents: number;
    };
    expected: {
      setupFeeCents: number;
      baseMonthlyFeeCents: number;
      discountedMonthlyFeeCents: number;
    };
    action: 'updated' | 'would_update' | 'already_synced';
  }>;
}> {
  await ensureSubscriptionSchema();

  const skipCanceled = params?.skipCanceled ?? true;
  const includeFree = params?.includeFree ?? false;
  const dryRun = params?.dryRun ?? false;
  const customerLimit = Math.max(1, Math.min(params?.customerLimit ?? 5000, 10000));
  const planCodes = params?.planCodes?.filter((code, index, list) => isPlanCode(code) && list.indexOf(code) === index) ?? null;

  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (skipCanceled) {
    conditions.push(`s.status <> 'canceled'`);
  }
  if (!includeFree) {
    conditions.push(`COALESCE(s.plan_code, 'essential') <> 'free'`);
  }
  if (planCodes && planCodes.length > 0) {
    conditions.push(`COALESCE(s.plan_code, 'essential') = ANY($${idx}::text[])`);
    values.push(planCodes);
    idx += 1;
  }

  const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  values.push(customerLimit);

  const candidates = await pool.query<{
    customer_id: string;
    plan_code: string;
    status: string;
    setup_fee_cents: number;
    base_monthly_fee_cents: number;
    discounted_monthly_fee_cents: number;
  }>(
    `SELECT
      s.customer_id,
      COALESCE(s.plan_code, 'essential') AS plan_code,
      s.status,
      COALESCE(s.setup_fee_cents, 0) AS setup_fee_cents,
      COALESCE(s.base_monthly_fee_cents, 0) AS base_monthly_fee_cents,
      COALESCE(s.discounted_monthly_fee_cents, 0) AS discounted_monthly_fee_cents
     FROM subscriptions s
     ${whereSql}
     ORDER BY s.updated_at DESC
     LIMIT $${idx}`,
    values
  );

  let wouldUpdate = 0;
  let updated = 0;
  let skipped = 0;

  const sample: Array<{
    customerId: string;
    planCode: PlanCode;
    status: string;
    before: {
      setupFeeCents: number;
      baseMonthlyFeeCents: number;
      discountedMonthlyFeeCents: number;
    };
    expected: {
      setupFeeCents: number;
      baseMonthlyFeeCents: number;
      discountedMonthlyFeeCents: number;
    };
    action: 'updated' | 'would_update' | 'already_synced';
  }> = [];

  for (const row of candidates.rows) {
    const plan = getPlanDefinition(row.plan_code);
    const expectedSetup = plan.setupFeeCents;
    const expectedBase = plan.monthlyFeeCents;
    const expectedDiscounted = Math.max(Math.round(plan.monthlyFeeCents * 0.6), 0);
    const needsUpdate =
      row.setup_fee_cents !== expectedSetup ||
      row.base_monthly_fee_cents !== expectedBase ||
      row.discounted_monthly_fee_cents !== expectedDiscounted;

    const before = {
      setupFeeCents: row.setup_fee_cents,
      baseMonthlyFeeCents: row.base_monthly_fee_cents,
      discountedMonthlyFeeCents: row.discounted_monthly_fee_cents
    };
    const expected = {
      setupFeeCents: expectedSetup,
      baseMonthlyFeeCents: expectedBase,
      discountedMonthlyFeeCents: expectedDiscounted
    };

    if (!needsUpdate) {
      skipped += 1;
      if (sample.length < 30) {
        sample.push({
          customerId: row.customer_id,
          planCode: plan.code,
          status: row.status,
          before,
          expected,
          action: 'already_synced'
        });
      }
      continue;
    }

    wouldUpdate += 1;

    if (!dryRun) {
      await setCustomerPlan(row.customer_id, plan.code);
      updated += 1;
    }

    if (sample.length < 30) {
      sample.push({
        customerId: row.customer_id,
        planCode: plan.code,
        status: row.status,
        before,
        expected,
        action: dryRun ? 'would_update' : 'updated'
      });
    }
  }

  const scanned = Number(candidates.rowCount ?? candidates.rows.length);

  return {
    scanned,
    eligible: scanned,
    wouldUpdate,
    updated,
    skipped,
    dryRun,
    filters: {
      skipCanceled,
      includeFree,
      customerLimit,
      planCodes: planCodes && planCodes.length > 0 ? planCodes : null
    },
    sample
  };
}

export function listPlans() {
  return listPlanDefinitions();
}

export async function upsertCustomerByWhatsapp(whatsappNumber: string, name?: string): Promise<{ id: string; name: string | null; monthlyIncomeCents: number | null }> {
  await ensureCustomerSchema();
  const result = await pool.query<{ id: string; name: string | null; monthly_income_cents: number | null }>(
    `INSERT INTO customers (whatsapp_number, name)
     VALUES ($1, $2)
     ON CONFLICT (whatsapp_number) DO UPDATE
       SET name       = COALESCE(EXCLUDED.name, customers.name),
           updated_at = NOW()
     RETURNING id, name, monthly_income_cents`,
    [whatsappNumber, name ?? null]
  );
  const row = result.rows[0];
  await ensureSubscription(row.id);
  return { id: row.id, name: row.name, monthlyIncomeCents: row.monthly_income_cents };
}

export async function findCustomerByWhatsappLoose(whatsappNumber: string): Promise<{
  id: string;
  name: string | null;
  whatsappNumber: string;
} | null> {
  await ensureCustomerSchema();
  const normalized = normalizePhoneDigits(whatsappNumber);
  if (!normalized || normalized.length < 8) {
    return null;
  }

  const found = await pool.query<{
    id: string;
    name: string | null;
    whatsapp_number: string;
  }>(
    `SELECT id, name, whatsapp_number
     FROM customers
     WHERE whatsapp_number = $1
        OR whatsapp_number LIKE ('%' || $1)
        OR $1 LIKE ('%' || whatsapp_number)
     ORDER BY LENGTH(whatsapp_number) DESC, updated_at DESC
     LIMIT 1`,
    [normalized]
  );

  if (!found.rowCount || !found.rows[0]) {
    return null;
  }

  return {
    id: found.rows[0].id,
    name: found.rows[0].name,
    whatsappNumber: found.rows[0].whatsapp_number
  };
}

export async function customerDailyFinancialSnapshot(customerId: string, referenceDate = new Date(), timezone = 'America/Sao_Paulo'): Promise<{
  expenseCents: number;
  incomeCents: number;
  expenseCount: number;
  incomeCount: number;
}> {
  const result = await pool.query<{
    kind: 'expense' | 'income';
    total_cents: string;
    count_rows: string;
  }>(
    `SELECT kind,
            COALESCE(SUM(amount_cents), 0)::text AS total_cents,
            COUNT(*)::text AS count_rows
     FROM transactions
     WHERE customer_id = $1
       AND (occurred_at AT TIME ZONE $2)::date = ($3::timestamptz AT TIME ZONE $2)::date
     GROUP BY kind`,
    [customerId, timezone, referenceDate.toISOString()]
  );

  let expenseCents = 0;
  let incomeCents = 0;
  let expenseCount = 0;
  let incomeCount = 0;

  for (const row of result.rows) {
    if (row.kind === 'expense') {
      expenseCents = Number(row.total_cents);
      expenseCount = Number(row.count_rows);
    }
    if (row.kind === 'income') {
      incomeCents = Number(row.total_cents);
      incomeCount = Number(row.count_rows);
    }
  }

  return {
    expenseCents,
    incomeCents,
    expenseCount,
    incomeCount
  };
}

// ─────────────────────────────────────────────
// Savings Goals
// ─────────────────────────────────────────────

export * from './ledger/savings-goals.js';

// ─── Family vaults (cofres compartilhados) ───────────────────────────────────

async function getCustomerFamilyGroupId(customerId: string): Promise<string | null> {
  const result = await pool.query<{ family_group_id: string }>(
    `SELECT family_group_id FROM family_members WHERE customer_id = $1 AND is_active = TRUE LIMIT 1`,
    [customerId]
  );
  return result.rows[0]?.family_group_id ?? null;
}

async function getFamilyMemberIds(groupId: string): Promise<string[]> {
  const result = await pool.query<{ customer_id: string }>(
    `SELECT customer_id FROM family_members WHERE family_group_id = $1 AND is_active = TRUE`,
    [groupId]
  );
  return result.rows.map(r => r.customer_id);
}

export async function createFamilyVault(params: {
  customerId: string;
  description: string;
  targetCents: number;
  deadlineDate: Date;
  monthlyTargetCents: number;
}): Promise<{ vaultId: string; groupId: string }> {
  const groupId = await getCustomerFamilyGroupId(params.customerId);
  if (!groupId) throw new Error('family_group_not_found');

  const result = await pool.query<{ id: string }>(
    `INSERT INTO savings_goals (customer_id, family_group_id, description, target_cents, deadline_date, monthly_target_cents)
     VALUES ($1, $2, $3, $4, $5::date, $6)
     RETURNING id`,
    [params.customerId, groupId, params.description, params.targetCents, params.deadlineDate.toISOString(), params.monthlyTargetCents]
  );
  return { vaultId: result.rows[0].id, groupId };
}

export async function getActiveFamilyVaults(customerId: string): Promise<Array<{
  id: string;
  description: string;
  targetCents: number;
  deadlineDate: Date;
  monthlyTargetCents: number;
  createdAt: Date;
  groupId: string;
}>> {
  const groupId = await getCustomerFamilyGroupId(customerId);
  if (!groupId) return [];

  const result = await pool.query<{
    id: string; description: string; target_cents: string;
    deadline_date: string; monthly_target_cents: string; created_at: Date; family_group_id: string;
  }>(
    `SELECT id, description, target_cents, deadline_date, monthly_target_cents, created_at, family_group_id
     FROM savings_goals
     WHERE family_group_id = $1 AND status = 'active'
     ORDER BY created_at ASC`,
    [groupId]
  );
  return result.rows.map(r => ({
    id: r.id,
    description: r.description,
    targetCents: Number(r.target_cents),
    deadlineDate: new Date(r.deadline_date),
    monthlyTargetCents: Number(r.monthly_target_cents),
    createdAt: new Date(r.created_at),
    groupId: r.family_group_id
  }));
}

export async function cancelActiveFamilyVaults(customerId: string): Promise<number> {
  const groupId = await getCustomerFamilyGroupId(customerId);
  if (!groupId) return 0;

  const result = await pool.query(
    `UPDATE savings_goals SET status = 'cancelled', updated_at = NOW()
     WHERE family_group_id = $1 AND status = 'active'`,
    [groupId]
  );
  return result.rowCount ?? 0;
}

export async function getFamilyVaultProgress(params: {
  groupId: string;
  vaultCreatedAt: Date;
  now: Date;
}): Promise<{ currentMonthSurplusCents: number; avgMonthlySurplusCents: number }> {
  const memberIds = await getFamilyMemberIds(params.groupId);
  if (memberIds.length === 0) return { currentMonthSurplusCents: 0, avgMonthlySurplusCents: 0 };

  const startOfMonth = new Date(params.now.getFullYear(), params.now.getMonth(), 1);
  const placeholders = memberIds.map((_, i) => `$${i + 1}`).join(', ');
  const base = memberIds.length;

  const [currentResult, avgResult] = await Promise.all([
    pool.query<{ kind: string; total: string }>(
      `SELECT kind, SUM(amount_cents) AS total
       FROM transactions
       WHERE customer_id IN (${placeholders}) AND occurred_at >= $${base + 1}
       GROUP BY kind`,
      [...memberIds, startOfMonth.toISOString()]
    ),
    pool.query<{ kind: string; month: string; total: string }>(
      `SELECT kind, DATE_TRUNC('month', occurred_at) AS month, SUM(amount_cents) AS total
       FROM transactions
       WHERE customer_id IN (${placeholders})
         AND occurred_at >= $${base + 1} AND occurred_at < $${base + 2}
       GROUP BY kind, DATE_TRUNC('month', occurred_at)`,
      [...memberIds, params.vaultCreatedAt.toISOString(), startOfMonth.toISOString()]
    )
  ]);

  let incomeNow = 0, expenseNow = 0;
  for (const r of currentResult.rows) {
    if (r.kind === 'income') incomeNow += Number(r.total);
    else expenseNow += Number(r.total);
  }

  const byMonth: Record<string, { income: number; expense: number }> = {};
  for (const r of avgResult.rows) {
    const m = r.month;
    if (!byMonth[m]) byMonth[m] = { income: 0, expense: 0 };
    if (r.kind === 'income') byMonth[m].income += Number(r.total);
    else byMonth[m].expense += Number(r.total);
  }
  const months = Object.values(byMonth);
  const avgSurplus = months.length > 0
    ? Math.round(months.reduce((s, m) => s + Math.max(0, m.income - m.expense), 0) / months.length)
    : 0;

  return {
    currentMonthSurplusCents: Math.max(0, incomeNow - expenseNow),
    avgMonthlySurplusCents: avgSurplus
  };
}

export async function getFamilyRiskSnapshot(params: {
  customerId: string;
  referenceDate: Date;
  timezone: string;
}): Promise<{
  groupId: string;
  groupName: string;
  memberCount: number;
  totalIncomeCents: number;
  totalExpenseCents: number;
  netCents: number;
  usageRatio: number;
  atRisk: boolean;
} | null> {
  const summary = await familyMonthlySummary(params.customerId, params.referenceDate, params.timezone);
  if (!summary) return null;

  const groupCtx = await getFamilyContextForCustomer(params.customerId);
  if (!groupCtx) return null;

  const usageRatio = summary.totalIncomeCents > 0
    ? summary.totalExpenseCents / summary.totalIncomeCents
    : summary.totalExpenseCents > 0 ? 1 : 0;

  return {
    groupId: groupCtx.groupId,
    groupName: groupCtx.groupName,
    memberCount: summary.members.length,
    totalIncomeCents: summary.totalIncomeCents,
    totalExpenseCents: summary.totalExpenseCents,
    netCents: summary.netCents,
    usageRatio,
    atRisk: usageRatio > 0.85 || summary.netCents < 0
  };
}

export * from './ledger/customer-profile.js';

export async function monthlySummary(customerId: string, month: number, year: number): Promise<{
  totalIncomeCents: number;
  totalExpenseCents: number;
  byCategory: Array<{ category: string; amountCents: number }>;
}> {
  const totals = await pool.query<{ kind: 'income' | 'expense'; total: string }>(
    `SELECT kind, COALESCE(SUM(amount_cents), 0)::text AS total
     FROM transactions
     WHERE customer_id = $1
       AND EXTRACT(MONTH FROM occurred_at) = $2
       AND EXTRACT(YEAR FROM occurred_at) = $3
     GROUP BY kind`,
    [customerId, month, year]
  );

  const byCategory = await pool.query<{ category: string; total: string }>(
    `SELECT category, COALESCE(SUM(amount_cents), 0)::text AS total
     FROM transactions
     WHERE customer_id = $1
       AND kind = 'expense'
       AND EXTRACT(MONTH FROM occurred_at) = $2
       AND EXTRACT(YEAR FROM occurred_at) = $3
     GROUP BY category
     ORDER BY SUM(amount_cents) DESC`,
    [customerId, month, year]
  );

  let totalIncomeCents = 0;
  let totalExpenseCents = 0;

  for (const row of totals.rows) {
    if (row.kind === 'income') totalIncomeCents = Number(row.total);
    if (row.kind === 'expense') totalExpenseCents = Number(row.total);
  }

  return {
    totalIncomeCents,
    totalExpenseCents,
    byCategory: byCategory.rows.map((row) => ({
      category: row.category,
      amountCents: Number(row.total)
    }))
  };
}

export async function dailyExpenseSummary(customerId: string, referenceDate = new Date(), timezone = 'America/Sao_Paulo'): Promise<{
  totalExpenseCents: number;
  items: Array<{
    amountCents: number;
    category: string;
    description: string | null;
    occurredAt: string;
  }>;
}> {
  const result = await pool.query<{
    amount_cents: number;
    category: string;
    description: string | null;
    occurred_at: string;
  }>(
    `SELECT amount_cents, category, description, occurred_at
     FROM transactions
     WHERE customer_id = $1
       AND kind = 'expense'
       AND (occurred_at AT TIME ZONE $2)::date = ($3::timestamptz AT TIME ZONE $2)::date
     ORDER BY occurred_at DESC
     LIMIT 100`,
    [customerId, timezone, referenceDate.toISOString()]
  );

  const items = result.rows.map((row) => ({
    amountCents: row.amount_cents,
    category: row.category,
    description: row.description,
    occurredAt: row.occurred_at
  }));

  const totalExpenseCents = items.reduce((acc, item) => acc + item.amountCents, 0);

  return {
    totalExpenseCents,
    items
  };
}

export * from './ledger/goals-reminders.js';

export async function forecastCashflowMonth(customerId: string, referenceDate = new Date(), timezone = 'America/Sao_Paulo'): Promise<{
  month: number;
  year: number;
  dayOfMonth: number;
  daysInMonth: number;
  incomeMtdCents: number;
  expenseMtdCents: number;
  netMtdCents: number;
  projectedIncomeCents: number;
  projectedExpenseCents: number;
  projectedNetCents: number;
  upcomingBillsCents: number;
  projectedNetAfterBillsCents: number;
}> {
  const month = referenceDate.getMonth() + 1;
  const year = referenceDate.getFullYear();
  const dayOfMonth = referenceDate.getDate();
  const daysInMonth = new Date(year, month, 0).getDate();

  const monthSummary = await monthlySummary(customerId, month, year);
  const incomeMtdCents = monthSummary.totalIncomeCents;
  const expenseMtdCents = monthSummary.totalExpenseCents;
  const netMtdCents = incomeMtdCents - expenseMtdCents;
  const divisor = Math.max(dayOfMonth, 1);
  const projectedIncomeCents = Math.round((incomeMtdCents / divisor) * daysInMonth);
  const projectedExpenseCents = Math.round((expenseMtdCents / divisor) * daysInMonth);
  const projectedNetCents = projectedIncomeCents - projectedExpenseCents;

  const reminders = await listBillReminders(customerId, referenceDate);
  const thisMonthPrefix = `${year}-${String(month).padStart(2, '0')}`;
  const upcomingBillsCents = reminders
    .filter((item) => item.effectiveDueDate.startsWith(thisMonthPrefix) && item.daysUntilDue >= 0)
    .reduce((acc, item) => acc + (item.amountCents ?? 0), 0);

  return {
    month,
    year,
    dayOfMonth,
    daysInMonth,
    incomeMtdCents,
    expenseMtdCents,
    netMtdCents,
    projectedIncomeCents,
    projectedExpenseCents,
    projectedNetCents,
    upcomingBillsCents,
    projectedNetAfterBillsCents: projectedNetCents - upcomingBillsCents
  };
}

export async function spendingInsights(customerId: string, referenceDate = new Date(), timezone = 'America/Sao_Paulo'): Promise<{
  month: number;
  year: number;
  expenseMtdCents: number;
  previousMonthExpenseCents: number;
  monthOverMonthPct: number | null;
  topCategory?: { category: string; amountCents: number; sharePct: number };
  topWeekday?: { weekday: string; amountCents: number };
}> {
  const month = referenceDate.getMonth() + 1;
  const year = referenceDate.getFullYear();

  const current = await monthlySummary(customerId, month, year);
  const previousDate = new Date(referenceDate);
  previousDate.setMonth(previousDate.getMonth() - 1);
  const previous = await monthlySummary(customerId, previousDate.getMonth() + 1, previousDate.getFullYear());

  const expenseMtdCents = current.totalExpenseCents;
  const previousMonthExpenseCents = previous.totalExpenseCents;
  const monthOverMonthPct = previousMonthExpenseCents > 0
    ? ((expenseMtdCents - previousMonthExpenseCents) / previousMonthExpenseCents) * 100
    : null;

  const topCategory = current.byCategory[0]
    ? {
      category: current.byCategory[0].category,
      amountCents: current.byCategory[0].amountCents,
      sharePct: expenseMtdCents > 0 ? (current.byCategory[0].amountCents / expenseMtdCents) * 100 : 0
    }
    : undefined;

  const weekdayStats = await pool.query<{ weekday: number; total: string }>(
    `SELECT EXTRACT(DOW FROM (occurred_at AT TIME ZONE $2))::int AS weekday,
            COALESCE(SUM(amount_cents), 0)::text AS total
     FROM transactions
     WHERE customer_id = $1
       AND kind = 'expense'
       AND DATE_TRUNC('month', occurred_at AT TIME ZONE $2) = DATE_TRUNC('month', $3::timestamptz AT TIME ZONE $2)
     GROUP BY weekday
     ORDER BY SUM(amount_cents) DESC
     LIMIT 1`,
    [customerId, timezone, referenceDate.toISOString()]
  );
  const weekdayMap: Record<number, string> = {
    0: 'domingo',
    1: 'segunda',
    2: 'terça',
    3: 'quarta',
    4: 'quinta',
    5: 'sexta',
    6: 'sábado'
  };
  const topWeekdayRow = weekdayStats.rows[0];
  const topWeekday = topWeekdayRow
    ? { weekday: weekdayMap[topWeekdayRow.weekday] ?? 'dia desconhecido', amountCents: Number(topWeekdayRow.total) }
    : undefined;

  return {
    month,
    year,
    expenseMtdCents,
    previousMonthExpenseCents,
    monthOverMonthPct,
    topCategory,
    topWeekday
  };
}

function normalizeRecurringKey(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 28);
}

export async function detectRecurringExpenses(customerId: string, referenceDate = new Date(), timezone = 'America/Sao_Paulo'): Promise<Array<{
  key: string;
  category: string;
  amountCentsMedian: number;
  occurrences: number;
  avgIntervalDays: number;
  lastOccurredAt: string;
  nextEstimatedDate: string;
}>> {
  const rows = await pool.query<{
    amount_cents: number;
    category: string;
    description: string | null;
    occurred_at: string;
  }>(
    `SELECT amount_cents, category, description, occurred_at
     FROM transactions
     WHERE customer_id = $1
       AND kind = 'expense'
       AND occurred_at >= ($2::timestamptz - INTERVAL '140 days')
     ORDER BY occurred_at DESC`,
    [customerId, referenceDate.toISOString()]
  );

  const groups = new Map<string, Array<{ amount: number; date: Date; category: string }>>();
  for (const row of rows.rows) {
    const keyBase = normalizeRecurringKey(row.description || row.category || 'despesa');
    const bucketAmount = Math.round(row.amount_cents / 100) * 100;
    const key = `${keyBase}|${bucketAmount}`;
    const list = groups.get(key) ?? [];
    list.push({ amount: row.amount_cents, date: new Date(row.occurred_at), category: row.category });
    groups.set(key, list);
  }

  const out: Array<{
    key: string;
    category: string;
    amountCentsMedian: number;
    occurrences: number;
    avgIntervalDays: number;
    lastOccurredAt: string;
    nextEstimatedDate: string;
  }> = [];

  for (const [key, items] of groups.entries()) {
    if (items.length < 2) continue;
    const sorted = [...items].sort((a, b) => a.date.getTime() - b.date.getTime());
    const intervals: number[] = [];
    for (let i = 1; i < sorted.length; i += 1) {
      const diffDays = (sorted[i].date.getTime() - sorted[i - 1].date.getTime()) / (1000 * 60 * 60 * 24);
      intervals.push(diffDays);
    }
    const avgIntervalDays = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    if (avgIntervalDays < 24 || avgIntervalDays > 36) continue;

    const amounts = sorted.map((it) => it.amount).sort((a, b) => a - b);
    const median = amounts[Math.floor(amounts.length / 2)];
    const last = sorted[sorted.length - 1].date;
    const nextEstimatedDate = new Date(last);
    nextEstimatedDate.setDate(nextEstimatedDate.getDate() + Math.round(avgIntervalDays));

    out.push({
      key: key.split('|')[0],
      category: sorted[sorted.length - 1].category,
      amountCentsMedian: median,
      occurrences: sorted.length,
      avgIntervalDays: Math.round(avgIntervalDays * 10) / 10,
      lastOccurredAt: last.toISOString(),
      nextEstimatedDate: nextEstimatedDate.toISOString().slice(0, 10)
    });
  }

  return out.sort((a, b) => b.occurrences - a.occurrences).slice(0, 6);
}

export async function getCustomerStreak(customerId: string, referenceDate = new Date(), timezone = 'America/Sao_Paulo'): Promise<{
  currentStreakDays: number;
  bestStreakDays: number;
  activeDaysLast30: number;
}> {
  const dates = await pool.query<{ day: string }>(
    `SELECT DISTINCT (created_at AT TIME ZONE $2)::date::text AS day
     FROM conversation_logs
     WHERE customer_id = $1
       AND direction = 'inbound'
       AND created_at >= ($3::timestamptz - INTERVAL '380 days')
     ORDER BY day DESC`,
    [customerId, timezone, referenceDate.toISOString()]
  );

  const uniqueDays = dates.rows.map((row) => row.day).filter(Boolean);
  if (uniqueDays.length === 0) {
    return { currentStreakDays: 0, bestStreakDays: 0, activeDaysLast30: 0 };
  }

  const daySet = new Set(uniqueDays);
  const todayIso = todayIsoDate(referenceDate);
  const yesterdayIso = addDaysIsoDate(todayIso, -1);

  let currentBase = daySet.has(todayIso) ? todayIso : daySet.has(yesterdayIso) ? yesterdayIso : null;
  let currentStreakDays = 0;
  while (currentBase && daySet.has(currentBase)) {
    currentStreakDays += 1;
    currentBase = addDaysIsoDate(currentBase, -1);
  }

  let bestStreakDays = 0;
  for (const day of uniqueDays) {
    let len = 1;
    let probe = addDaysIsoDate(day, -1);
    while (daySet.has(probe)) {
      len += 1;
      probe = addDaysIsoDate(probe, -1);
    }
    if (len > bestStreakDays) {
      bestStreakDays = len;
    }
  }

  const from30 = addDaysIsoDate(todayIso, -29);
  const activeDaysLast30 = uniqueDays.filter((day) => day >= from30 && day <= todayIso).length;

  return {
    currentStreakDays,
    bestStreakDays,
    activeDaysLast30
  };
}

export async function listCustomerAchievements(customerId: string): Promise<Array<{
  code: string;
  title: string;
  description: string;
  unlockedAt: string;
}>> {
  await ensureGamificationSchema();
  const rows = await pool.query<{
    code: string;
    title: string;
    description: string;
    unlocked_at: string;
  }>(
    `SELECT code, title, description, unlocked_at::text
     FROM customer_achievements
     WHERE customer_id = $1
     ORDER BY unlocked_at DESC`,
    [customerId]
  );

  return rows.rows.map((row) => ({
    code: row.code,
    title: row.title,
    description: row.description,
    unlockedAt: row.unlocked_at
  }));
}

export async function unlockAchievementIfMissing(params: {
  customerId: string;
  code: string;
  title: string;
  description: string;
  metadata?: Record<string, unknown>;
}): Promise<{ unlocked: boolean; code: string; title: string; description: string }> {
  await ensureGamificationSchema();
  const inserted = await pool.query<{
    code: string;
    title: string;
    description: string;
  }>(
    `INSERT INTO customer_achievements (customer_id, code, title, description, metadata)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (customer_id, code) DO NOTHING
     RETURNING code, title, description`,
    [params.customerId, params.code, params.title, params.description, params.metadata ?? null]
  );

  if (!inserted.rows[0]) {
    return {
      unlocked: false,
      code: params.code,
      title: params.title,
      description: params.description
    };
  }

  return {
    unlocked: true,
    code: inserted.rows[0].code,
    title: inserted.rows[0].title,
    description: inserted.rows[0].description
  };
}

export async function evaluateAndUnlockAchievements(customerId: string, referenceDate = new Date(), timezone = 'America/Sao_Paulo'): Promise<Array<{
  code: string;
  title: string;
  description: string;
}>> {
  const unlockedNow: Array<{ code: string; title: string; description: string }> = [];
  const streak = await getCustomerStreak(customerId, referenceDate, timezone);

  const streakMilestones = [
    { days: 3, code: 'streak_3', title: 'Início Consistente 🔥' },
    { days: 7, code: 'streak_7', title: 'Semana no Foco 🔥' },
    { days: 14, code: 'streak_14', title: 'Duas Semanas de Disciplina 🏅' },
    { days: 30, code: 'streak_30', title: 'Mestre da Rotina Financeira 👑' }
  ];

  for (const milestone of streakMilestones) {
    if (streak.currentStreakDays < milestone.days) continue;
    const unlocked = await unlockAchievementIfMissing({
      customerId,
      code: milestone.code,
      title: milestone.title,
      description: `Você registrou finanças por ${milestone.days} dias seguidos.`,
      metadata: { days: milestone.days }
    });
    if (unlocked.unlocked) unlockedNow.push(unlocked);
  }

  const month = referenceDate.getMonth() + 1;
  const year = referenceDate.getFullYear();
  const summary = await monthlySummary(customerId, month, year);
  const monthlyLimit = (await listSpendingLimits(customerId))
    .find((item) => item.period === 'monthly' && item.isActive);
  if (monthlyLimit && summary.totalExpenseCents <= Math.round(monthlyLimit.amountCents * 0.8)) {
    const code = `economy_master_${year}_${String(month).padStart(2, '0')}`;
    const unlocked = await unlockAchievementIfMissing({
      customerId,
      code,
      title: 'Mestre da Economia 💚',
      description: 'Você gastou até 80% (ou menos) do seu limite mensal.',
      metadata: {
        month,
        year,
        totalExpenseCents: summary.totalExpenseCents,
        monthlyLimitCents: monthlyLimit.amountCents
      }
    });
    if (unlocked.unlocked) unlockedNow.push(unlocked);
  }

  return unlockedNow;
}

export async function financialHealthScore(customerId: string, referenceDate = new Date(), timezone = 'America/Sao_Paulo'): Promise<{
  score: number;
  components: Array<{ key: string; value: number; max: number; label: string }>;
  month: number;
  year: number;
}> {
  const month = referenceDate.getMonth() + 1;
  const year = referenceDate.getFullYear();
  const streak = await getCustomerStreak(customerId, referenceDate, timezone);
  const goals = await financialGoalsProgress(customerId, referenceDate, timezone);
  const monthData = await monthlySummary(customerId, month, year);
  const limits = await spendingLimitStatuses({ customerId, referenceDate, timezone });

  const regularity = Math.round((Math.min(streak.currentStreakDays, 30) / 30) * 250);

  let limitsScore = 120;
  if (limits.length > 0) {
    const perLimit = limits.map((item) => {
      if (item.status === 'ok') return 1;
      if (item.status === 'near') return 0.6;
      return 0.2;
    });
    const avg = perLimit.reduce((acc, value) => acc + value, 0) / perLimit.length;
    limitsScore = Math.round(avg * 250);
  }

  let goalsScore = 120;
  if (goals.length > 0) {
    const avgProgress = goals.reduce((acc, item) => acc + Math.min(item.progressRatio, 1), 0) / goals.length;
    goalsScore = Math.round(avgProgress * 250);
  }

  const net = monthData.totalIncomeCents - monthData.totalExpenseCents;
  let balanceScore = 150;
  if (monthData.totalIncomeCents > 0) {
    const ratio = net / monthData.totalIncomeCents;
    if (ratio >= 0.2) balanceScore = 250;
    else if (ratio >= 0.05) balanceScore = 210;
    else if (ratio >= 0) balanceScore = 180;
    else if (ratio >= -0.15) balanceScore = 120;
    else balanceScore = 70;
  } else if (monthData.totalExpenseCents > 0) {
    balanceScore = 60;
  }

  const score = Math.max(0, Math.min(1000, regularity + limitsScore + goalsScore + balanceScore));

  return {
    score,
    month,
    year,
    components: [
      { key: 'regularity', value: regularity, max: 250, label: 'Regularidade' },
      { key: 'limits', value: limitsScore, max: 250, label: 'Disciplina de limites' },
      { key: 'goals', value: goalsScore, max: 250, label: 'Progresso em metas' },
      { key: 'balance', value: balanceScore, max: 250, label: 'Equilíbrio receita/despesa' }
    ]
  };
}

export async function weeklyFinancialHealthSeries(params: {
  customerId: string;
  weeks?: number;
  referenceDate?: Date;
  timezone?: string;
}): Promise<{
  points: Array<{
    weekStartDate: string;
    weekEndDate: string;
    score: number;
    month: number;
    year: number;
  }>;
  trendDelta: number;
  latestDelta: number;
}> {
  const weeks = Math.max(2, Math.min(params.weeks ?? 6, 16));
  const referenceDate = params.referenceDate ?? new Date();
  const timezone = params.timezone ?? 'America/Sao_Paulo';
  const end = new Date(referenceDate);
  const points: Array<{
    weekStartDate: string;
    weekEndDate: string;
    score: number;
    month: number;
    year: number;
  }> = [];

  const weekEnds = Array.from({ length: weeks }, (_, i) => {
    const weekEnd = new Date(end);
    weekEnd.setDate(end.getDate() - ((weeks - 1 - i) * 7));
    return weekEnd;
  });

  const scores = await Promise.all(
    weekEnds.map(weekEnd => financialHealthScore(params.customerId, weekEnd, timezone))
  );

  for (let i = 0; i < weeks; i++) {
    const weekEndIso = todayIsoDate(weekEnds[i]);
    const weekStartIso = addDaysIsoDate(weekEndIso, -6);
    const score = scores[i];
    points.push({
      weekStartDate: weekStartIso,
      weekEndDate: weekEndIso,
      score: score.score,
      month: score.month,
      year: score.year
    });
  }

  const first = points[0]?.score ?? 0;
  const last = points[points.length - 1]?.score ?? 0;
  const prev = points[points.length - 2]?.score ?? last;

  return {
    points,
    trendDelta: last - first,
    latestDelta: last - prev
  };
}

export async function monthlyVisualReportData(params: {
  customerId: string;
  month: number;
  year: number;
}): Promise<{
  month: number;
  year: number;
  totalIncomeCents: number;
  totalExpenseCents: number;
  netCents: number;
  topCategory: { category: string; amountCents: number; sharePct: number } | null;
  biggestExpense: { amountCents: number; category: string; description: string | null; occurredAt: string } | null;
  monthOverMonthExpensePct: number | null;
  monthOverMonthIncomePct: number | null;
  highlights: string[];
}> {
  const summary = await monthlySummary(params.customerId, params.month, params.year);
  const prevDate = new Date(Date.UTC(params.year, params.month - 2, 1, 12, 0, 0));
  const prev = await monthlySummary(
    params.customerId,
    prevDate.getUTCMonth() + 1,
    prevDate.getUTCFullYear()
  );

  const biggest = await pool.query<{
    amount_cents: number;
    category: string;
    description: string | null;
    occurred_at: string;
  }>(
    `SELECT amount_cents, category, description, occurred_at
     FROM transactions
     WHERE customer_id = $1
       AND kind = 'expense'
       AND EXTRACT(MONTH FROM occurred_at) = $2
       AND EXTRACT(YEAR FROM occurred_at) = $3
     ORDER BY amount_cents DESC, occurred_at DESC
     LIMIT 1`,
    [params.customerId, params.month, params.year]
  );

  const totalExpenseCents = summary.totalExpenseCents;
  const top = summary.byCategory[0];
  const topCategory = top
    ? {
      category: top.category,
      amountCents: top.amountCents,
      sharePct: totalExpenseCents > 0 ? (top.amountCents / totalExpenseCents) * 100 : 0
    }
    : null;

  const monthOverMonthExpensePct = prev.totalExpenseCents > 0
    ? ((summary.totalExpenseCents - prev.totalExpenseCents) / prev.totalExpenseCents) * 100
    : null;
  const monthOverMonthIncomePct = prev.totalIncomeCents > 0
    ? ((summary.totalIncomeCents - prev.totalIncomeCents) / prev.totalIncomeCents) * 100
    : null;

  const highlights: string[] = [];
  if (topCategory) {
    highlights.push(`Categoria campeã: ${topCategory.category} (${topCategory.sharePct.toFixed(1)}% das despesas).`);
  } else {
    highlights.push('Sem despesas registradas no mês.');
  }

  if (biggest.rows[0]) {
    const b = biggest.rows[0];
    highlights.push(`Maior gasto único: ${b.category} (${(b.amount_cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}).`);
  }

  if (monthOverMonthExpensePct !== null) {
    if (monthOverMonthExpensePct > 0) {
      highlights.push(`Despesas subiram ${monthOverMonthExpensePct.toFixed(1)}% vs mês anterior.`);
    } else if (monthOverMonthExpensePct < 0) {
      highlights.push(`Despesas caíram ${Math.abs(monthOverMonthExpensePct).toFixed(1)}% vs mês anterior.`);
    } else {
      highlights.push('Despesas estáveis vs mês anterior.');
    }
  }

  return {
    month: params.month,
    year: params.year,
    totalIncomeCents: summary.totalIncomeCents,
    totalExpenseCents: summary.totalExpenseCents,
    netCents: summary.totalIncomeCents - summary.totalExpenseCents,
    topCategory,
    biggestExpense: biggest.rows[0]
      ? {
        amountCents: biggest.rows[0].amount_cents,
        category: biggest.rows[0].category,
        description: biggest.rows[0].description,
        occurredAt: biggest.rows[0].occurred_at
      }
      : null,
    monthOverMonthExpensePct,
    monthOverMonthIncomePct,
    highlights
  };
}

export async function createFamilyGroup(params: {
  ownerCustomerId: string;
  name: string;
}): Promise<{
  groupId: string;
  name: string;
  inviteCode: string;
  inviteCodes: string[];
  baseMemberLimit: number;
  extraMemberSlots: number;
  memberLimit: number;
}> {
  await ensureFamilySchema();
  const existing = await pool.query<{ group_id: string }>(
    `SELECT family_group_id AS group_id
     FROM family_members
     WHERE customer_id = $1
       AND is_active = TRUE
     LIMIT 1`,
    [params.ownerCustomerId]
  );
  if (existing.rows[0]?.group_id) {
    const group = await pool.query<{
      id: string;
      name: string;
      invite_code: string;
      owner_customer_id: string;
      extra_member_slots: number;
    }>(
      `SELECT id, name, invite_code, owner_customer_id, COALESCE(extra_member_slots, 0) AS extra_member_slots
       FROM family_groups
       WHERE id = $1
       LIMIT 1`,
      [existing.rows[0].group_id]
    );
    const row = group.rows[0];
    const ownerSub = await ensureSubscription(row.owner_customer_id);
    const extraSlots = normalizedExtraFamilySlots(Number(row.extra_member_slots ?? 0));
    const memberLimit = effectiveFamilyMemberLimit(ownerSub.plan_code, extraSlots);
    const baseMemberLimit = Math.max(1, memberLimit - extraSlots);
    const invites = await createFamilyInviteCodes({
      familyGroupId: row.id,
      createdByCustomerId: params.ownerCustomerId,
      count: 2,
      maxUses: 1
    });
    return {
      groupId: row.id,
      name: row.name,
      inviteCode: row.invite_code,
      inviteCodes: invites,
      baseMemberLimit,
      extraMemberSlots: extraSlots,
      memberLimit
    };
  }

  const code = generateInviteCode();
  const group = await pool.query<{ id: string; name: string; invite_code: string }>(
    `INSERT INTO family_groups (name, invite_code, owner_customer_id)
     VALUES ($1, $2, $3)
     RETURNING id, name, invite_code`,
    [params.name.slice(0, 120), code, params.ownerCustomerId]
  );
  const row = group.rows[0];
  await pool.query(
    `INSERT INTO family_members (family_group_id, customer_id, role, is_active)
     VALUES ($1, $2, 'owner', TRUE)
     ON CONFLICT (family_group_id, customer_id)
     DO UPDATE SET is_active = TRUE, role = 'owner'`,
    [row.id, params.ownerCustomerId]
  );
  const ownerSub = await ensureSubscription(params.ownerCustomerId);
  const extraSlots = await getFamilyExtraMemberSlots(params.ownerCustomerId);
  const memberLimit = effectiveFamilyMemberLimit(ownerSub.plan_code, extraSlots);
  const baseMemberLimit = Math.max(1, memberLimit - extraSlots);
  const invites = await createFamilyInviteCodes({
    familyGroupId: row.id,
    createdByCustomerId: params.ownerCustomerId,
    count: 2,
    maxUses: 1
  });

  return {
    groupId: row.id,
    name: row.name,
    inviteCode: row.invite_code,
    inviteCodes: invites,
    baseMemberLimit,
    extraMemberSlots: extraSlots,
    memberLimit
  };
}

export async function joinFamilyGroupByCode(params: {
  customerId: string;
  inviteCode: string;
}): Promise<{
  joined: boolean;
  groupId: string;
  groupName: string;
  inviteCode: string;
  memberLimit: number;
  activeMembers: number;
  remainingSlots: number;
}> {
  await ensureFamilySchema();
  const normalizedCode = params.inviteCode.trim().toUpperCase();
  const inviteLookup = await pool.query<{
    invite_id: string;
    group_id: string;
    group_name: string;
    invite_code: string;
    owner_customer_id: string;
    extra_member_slots: number;
    used_count: number;
    max_uses: number;
  }>(
    `SELECT
       fi.id AS invite_id,
       fg.id AS group_id,
       fg.name AS group_name,
       fi.code AS invite_code,
       fg.owner_customer_id,
       COALESCE(fg.extra_member_slots, 0) AS extra_member_slots,
       fi.used_count,
       fi.max_uses
     FROM family_invites fi
     INNER JOIN family_groups fg ON fg.id = fi.family_group_id
     WHERE fi.code = $1
       AND fi.used_count < fi.max_uses
       AND (fi.expires_at IS NULL OR fi.expires_at > NOW())
     LIMIT 1`,
    [normalizedCode]
  );

  let inviteMode: 'single_use' | 'group_code' = 'single_use';
  let row = inviteLookup.rows[0];
  if (!row) {
    inviteMode = 'group_code';
    const groupLookup = await pool.query<{
      invite_id: string;
      group_id: string;
      group_name: string;
      invite_code: string;
      owner_customer_id: string;
      extra_member_slots: number;
      used_count: number;
      max_uses: number;
    }>(
      `SELECT
         ''::text AS invite_id,
         fg.id AS group_id,
         fg.name AS group_name,
         fg.invite_code,
         fg.owner_customer_id,
         COALESCE(fg.extra_member_slots, 0) AS extra_member_slots,
         0::int AS used_count,
         9999::int AS max_uses
       FROM family_groups fg
       WHERE fg.invite_code = $1
       LIMIT 1`,
      [normalizedCode]
    );
    row = groupLookup.rows[0];
  }

  if (!row) {
    throw new Error('family_group_not_found');
  }

  const ownerSub = await ensureSubscription(row.owner_customer_id);
  const extraSlots = normalizedExtraFamilySlots(Number(row.extra_member_slots ?? 0));
  const memberLimit = effectiveFamilyMemberLimit(ownerSub.plan_code, extraSlots);

  const client = await pool.connect();
  let activeMembersBefore = 0;
  let alreadyActive = false;
  try {
    await client.query('BEGIN');

    // Lock the group row to serialize concurrent joins
    await client.query(
      `SELECT id FROM family_groups WHERE id = $1 FOR UPDATE`,
      [row.group_id]
    );

    const activeCountRes = await client.query<{ total: string }>(
      `SELECT COUNT(*)::text AS total
       FROM family_members
       WHERE family_group_id = $1 AND is_active = TRUE`,
      [row.group_id]
    );
    activeMembersBefore = Number(activeCountRes.rows[0]?.total ?? '0');

    const existingMembership = await client.query<{ is_active: boolean }>(
      `SELECT is_active FROM family_members
       WHERE family_group_id = $1 AND customer_id = $2 LIMIT 1`,
      [row.group_id, params.customerId]
    );
    alreadyActive = Boolean(existingMembership.rows[0]?.is_active);

    if (!alreadyActive && activeMembersBefore >= memberLimit) {
      await client.query('ROLLBACK');
      throw new Error('family_group_full');
    }

    await client.query(
      `INSERT INTO family_members (family_group_id, customer_id, role, is_active)
       VALUES ($1, $2, 'member', TRUE)
       ON CONFLICT (family_group_id, customer_id)
       DO UPDATE SET is_active = TRUE`,
      [row.group_id, params.customerId]
    );

    if (inviteMode === 'single_use' && row.invite_id && !alreadyActive) {
      await client.query(
        `UPDATE family_invites SET used_count = used_count + 1 WHERE id = $1`,
        [row.invite_id]
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }

  const activeMembers = alreadyActive ? activeMembersBefore : activeMembersBefore + 1;
  return {
    joined: true,
    groupId: row.group_id,
    groupName: row.group_name,
    inviteCode: row.invite_code,
    memberLimit,
    activeMembers,
    remainingSlots: Math.max(0, memberLimit - activeMembers)
  };
}

export async function leaveFamilyGroup(customerId: string): Promise<{ left: boolean }> {
  await ensureFamilySchema();
  const updated = await pool.query(
    `UPDATE family_members
     SET is_active = FALSE
     WHERE customer_id = $1
       AND is_active = TRUE`,
    [customerId]
  );
  return { left: (updated.rowCount ?? 0) > 0 };
}

export async function activateFamilyMember(customerId: string): Promise<void> {
  await ensureSubscriptionSchema();
  await pool.query(
    `UPDATE subscriptions
     SET plan_code = 'family',
         setup_fee_cents = 0,
         base_monthly_fee_cents = 0,
         discounted_monthly_fee_cents = 0,
         has_paid_setup = TRUE,
         status = 'active',
         start_date = COALESCE(start_date, CURRENT_DATE),
         updated_at = NOW()
     WHERE customer_id = $1`,
    [customerId]
  );
  await pool.query(
    `UPDATE customers
     SET is_active = TRUE, updated_at = NOW()
     WHERE id = $1`,
    [customerId]
  );
}

export async function getFamilyContextForCustomer(customerId: string): Promise<{
  groupId: string;
  groupName: string;
  inviteCode: string;
  role: string;
  members: Array<{ customerId: string; name: string | null; whatsappNumber: string; role: string }>;
} | null> {
  await ensureFamilySchema();
  const group = await pool.query<{
    group_id: string;
    group_name: string;
    invite_code: string;
    role: string;
  }>(
    `SELECT fg.id AS group_id, fg.name AS group_name, fg.invite_code, fm.role
     FROM family_members fm
     INNER JOIN family_groups fg ON fg.id = fm.family_group_id
     WHERE fm.customer_id = $1
       AND fm.is_active = TRUE
     LIMIT 1`,
    [customerId]
  );
  const base = group.rows[0];
  if (!base) return null;

  const members = await pool.query<{
    customer_id: string;
    name: string | null;
    whatsapp_number: string;
    role: string;
  }>(
    `SELECT fm.customer_id, c.name, c.whatsapp_number, fm.role
     FROM family_members fm
     INNER JOIN customers c ON c.id = fm.customer_id
     WHERE fm.family_group_id = $1
       AND fm.is_active = TRUE
     ORDER BY fm.role DESC, c.name ASC NULLS LAST`,
    [base.group_id]
  );

  return {
    groupId: base.group_id,
    groupName: base.group_name,
    inviteCode: base.invite_code,
    role: base.role,
    members: members.rows.map((item) => ({
      customerId: item.customer_id,
      name: item.name,
      whatsappNumber: item.whatsapp_number,
      role: item.role
    }))
  };
}

export async function familyMonthlySummary(customerId: string, referenceDate = new Date(), timezone = 'America/Sao_Paulo'): Promise<{
  month: number;
  year: number;
  totalIncomeCents: number;
  totalExpenseCents: number;
  netCents: number;
  byCategory: Array<{ category: string; amountCents: number }>;
  members: Array<{ customerId: string; name: string | null; whatsappNumber: string }>;
  memberExpenses: Array<{ customerId: string; name: string | null; amountCents: number }>;
  limitStatuses: Array<{
    period: SpendingLimitPeriod;
    limitCents: number;
    spentCents: number;
    remainingCents: number;
    status: 'ok' | 'near' | 'exceeded';
  }>;
} | null> {
  await ensureFamilySchema();
  const context = await getFamilyContextForCustomer(customerId);
  if (!context) return null;

  const memberIds = context.members.map((item) => item.customerId);
  if (memberIds.length === 0) return null;

  const month = referenceDate.getMonth() + 1;
  const year = referenceDate.getFullYear();
  const bounds = monthBounds(referenceDate);
  const totals = await pool.query<{ income_total: string; expense_total: string }>(
    `SELECT
       COALESCE(SUM(CASE WHEN kind = 'income' THEN amount_cents ELSE 0 END), 0)::text AS income_total,
       COALESCE(SUM(CASE WHEN kind = 'expense' THEN amount_cents ELSE 0 END), 0)::text AS expense_total
     FROM transactions
     WHERE customer_id = ANY($1::uuid[])
       AND (occurred_at AT TIME ZONE $2)::date BETWEEN $3::date AND $4::date`,
    [memberIds, timezone, bounds.startIso, bounds.endIso]
  );
  const byCategory = await pool.query<{ category: string; amount_cents: string }>(
    `SELECT category, COALESCE(SUM(amount_cents), 0)::text AS amount_cents
     FROM transactions
     WHERE customer_id = ANY($1::uuid[])
       AND kind = 'expense'
       AND (occurred_at AT TIME ZONE $2)::date BETWEEN $3::date AND $4::date
     GROUP BY category
     ORDER BY SUM(amount_cents) DESC
     LIMIT 8`,
    [memberIds, timezone, bounds.startIso, bounds.endIso]
  );
  const byMember = await pool.query<{ customer_id: string; name: string | null; amount_cents: string }>(
    `SELECT t.customer_id, c.name, COALESCE(SUM(t.amount_cents), 0)::text AS amount_cents
     FROM transactions t
     INNER JOIN customers c ON c.id = t.customer_id
     WHERE t.customer_id = ANY($1::uuid[])
       AND t.kind = 'expense'
       AND (t.occurred_at AT TIME ZONE $2)::date BETWEEN $3::date AND $4::date
     GROUP BY t.customer_id, c.name
     ORDER BY SUM(t.amount_cents) DESC`,
    [memberIds, timezone, bounds.startIso, bounds.endIso]
  );

  const totalIncomeCents = Number(totals.rows[0]?.income_total ?? '0');
  const totalExpenseCents = Number(totals.rows[0]?.expense_total ?? '0');
  const familyLimits = await familySpendingLimitStatuses({
    actorCustomerId: customerId,
    referenceDate,
    timezone
  });

  return {
    month,
    year,
    totalIncomeCents,
    totalExpenseCents,
    netCents: totalIncomeCents - totalExpenseCents,
    byCategory: byCategory.rows.map((item) => ({
      category: item.category,
      amountCents: Number(item.amount_cents)
    })),
    members: context.members.map((item) => ({
      customerId: item.customerId,
      name: item.name,
      whatsappNumber: item.whatsappNumber
    })),
    memberExpenses: byMember.rows.map((item) => ({
      customerId: item.customer_id,
      name: item.name,
      amountCents: Number(item.amount_cents)
    })),
    limitStatuses: familyLimits.statuses
  };
}

export async function familyPlanOperationalHealth(params?: {
  referenceDate?: Date;
  timezone?: string;
  limit?: number;
}): Promise<{
  generatedAt: string;
  timezone: string;
  summary: {
    totalGroups: number;
    totalMembers: number;
    avgMembersPerGroup: number;
    groupsWithAvailableSlots: number;
    groupsAtCapacity: number;
    groupsWithoutLimits: number;
    groupsNearLimit: number;
    groupsExceededLimit: number;
  };
  recommendations: string[];
  groups: Array<{
    groupId: string;
    groupName: string;
    inviteCode: string;
    ownerCustomerId: string;
    ownerName: string | null;
    ownerWhatsapp: string;
    ownerPlanCode: PlanCode;
    ownerPlanName: string;
    memberCount: number;
    memberLimit: number;
    occupancyRate: number;
    limitsActive: number;
    worstLimitStatus: 'ok' | 'near' | 'exceeded' | 'none';
    limitStatuses: Array<{
      period: SpendingLimitPeriod;
      limitCents: number;
      spentCents: number;
      remainingCents: number;
      status: 'ok' | 'near' | 'exceeded';
    }>;
    createdAt: string;
    lastMemberJoinedAt: string | null;
  }>;
}> {
  await ensureFamilySchema();
  await ensureSubscriptionSchema();

  const referenceDate = params?.referenceDate ?? new Date();
  const timezone = params?.timezone ?? 'America/Sao_Paulo';
  const limit = Math.max(1, Math.min(Math.floor(params?.limit ?? 120), 500));

  const rows = await pool.query<{
    group_id: string;
    group_name: string;
    invite_code: string;
    owner_customer_id: string;
    owner_name: string | null;
    owner_whatsapp: string;
    owner_plan_code: string;
    active_members: number;
    active_limits: number;
    created_at: string;
    last_member_joined_at: string | null;
  }>(
    `SELECT
       fg.id AS group_id,
       fg.name AS group_name,
       fg.invite_code,
       fg.owner_customer_id,
       owner.name AS owner_name,
       owner.whatsapp_number AS owner_whatsapp,
       COALESCE(sub.plan_code, 'essential') AS owner_plan_code,
       COALESCE(mem.active_members, 0)::int AS active_members,
       COALESCE(lim.active_limits, 0)::int AS active_limits,
       fg.created_at,
       mem.last_member_joined_at
     FROM family_groups fg
     INNER JOIN customers owner ON owner.id = fg.owner_customer_id
     LEFT JOIN subscriptions sub ON sub.customer_id = fg.owner_customer_id
     LEFT JOIN LATERAL (
       SELECT COUNT(*)::int AS active_members,
              MAX(joined_at) AS last_member_joined_at
       FROM family_members fm
       WHERE fm.family_group_id = fg.id
         AND fm.is_active = TRUE
     ) mem ON TRUE
     LEFT JOIN LATERAL (
       SELECT COUNT(*)::int AS active_limits
       FROM family_limits fl
       WHERE fl.family_group_id = fg.id
         AND fl.is_active = TRUE
     ) lim ON TRUE
     ORDER BY fg.created_at DESC
     LIMIT $1`,
    [limit]
  );

  const groups = await Promise.all(
    rows.rows.map(async (row) => {
      const ownerPlanCode: PlanCode = isPlanCode(row.owner_plan_code) ? row.owner_plan_code : 'essential';
      const ownerPlan = getPlanDefinition(ownerPlanCode);
      const memberLimit = Math.max(1, ownerPlan.groupMemberLimit || 1);
      const occupancyRate = Math.min(row.active_members / memberLimit, 10);

      const limitData = await familySpendingLimitStatuses({
        actorCustomerId: row.owner_customer_id,
        referenceDate,
        timezone
      });

      const hasExceeded = limitData.statuses.some((item) => item.status === 'exceeded');
      const hasNear = limitData.statuses.some((item) => item.status === 'near');
      const worstLimitStatus: 'ok' | 'near' | 'exceeded' | 'none' = limitData.statuses.length === 0
        ? 'none'
        : hasExceeded
          ? 'exceeded'
          : hasNear
            ? 'near'
            : 'ok';

      return {
        groupId: row.group_id,
        groupName: row.group_name,
        inviteCode: row.invite_code,
        ownerCustomerId: row.owner_customer_id,
        ownerName: row.owner_name,
        ownerWhatsapp: row.owner_whatsapp,
        ownerPlanCode,
        ownerPlanName: ownerPlan.name,
        memberCount: Number(row.active_members || 0),
        memberLimit,
        occupancyRate,
        limitsActive: Number(row.active_limits || 0),
        worstLimitStatus,
        limitStatuses: limitData.statuses,
        createdAt: row.created_at,
        lastMemberJoinedAt: row.last_member_joined_at
      };
    })
  );

  const totalMembers = groups.reduce((sum, item) => sum + item.memberCount, 0);
  const groupsAtCapacity = groups.filter((item) => item.memberCount >= item.memberLimit).length;
  const groupsWithoutLimits = groups.filter((item) => item.limitsActive <= 0).length;
  const groupsNearLimit = groups.filter((item) => item.worstLimitStatus === 'near').length;
  const groupsExceededLimit = groups.filter((item) => item.worstLimitStatus === 'exceeded').length;
  const groupsWithAvailableSlots = Math.max(groups.length - groupsAtCapacity, 0);

  const recommendations: string[] = [];
  if (groupsWithoutLimits > 0) {
    recommendations.push(`${groupsWithoutLimits} grupo(s) sem limite familiar ativo. Priorizar configuração para reduzir risco de gasto descontrolado.`);
  }
  if (groupsExceededLimit > 0) {
    recommendations.push(`${groupsExceededLimit} grupo(s) estouraram limite. Rodar intervenção imediata com revisão de teto e despesas críticas.`);
  }
  if (groupsNearLimit > 0) {
    recommendations.push(`${groupsNearLimit} grupo(s) próximos do limite. Enviar alerta preventivo com sugestão de ajuste semanal.`);
  }
  if (recommendations.length === 0) {
    recommendations.push('Saúde operacional estável. Recomenda-se apenas manutenção e revisão semanal dos grupos.');
  }

  return {
    generatedAt: new Date().toISOString(),
    timezone,
    summary: {
      totalGroups: groups.length,
      totalMembers,
      avgMembersPerGroup: groups.length > 0 ? totalMembers / groups.length : 0,
      groupsWithAvailableSlots,
      groupsAtCapacity,
      groupsWithoutLimits,
      groupsNearLimit,
      groupsExceededLimit
    },
    recommendations,
    groups: groups.sort((a, b) => {
      const score = (item: typeof a) => {
        if (item.worstLimitStatus === 'exceeded') return 3;
        if (item.worstLimitStatus === 'near') return 2;
        if (item.worstLimitStatus === 'none') return 1;
        return 0;
      };
      const scoreDiff = score(b) - score(a);
      if (scoreDiff !== 0) return scoreDiff;
      return b.occupancyRate - a.occupancyRate;
    })
  };
}

export async function weeklySummary(customerId: string, referenceDate = new Date(), timezone = 'America/Sao_Paulo'): Promise<{
  startDate: string;
  endDate: string;
  totalIncomeCents: number;
  totalExpenseCents: number;
  netCents: number;
  byCategory: Array<{ category: string; amountCents: number }>;
}> {
  const totals = await pool.query<{ income_total: string; expense_total: string; start_date: string; end_date: string }>(
    `SELECT
       COALESCE(SUM(CASE WHEN kind = 'income' THEN amount_cents ELSE 0 END), 0)::text AS income_total,
       COALESCE(SUM(CASE WHEN kind = 'expense' THEN amount_cents ELSE 0 END), 0)::text AS expense_total,
       (($2::timestamptz AT TIME ZONE $3)::date - INTERVAL '6 days')::date::text AS start_date,
       ($2::timestamptz AT TIME ZONE $3)::date::text AS end_date
     FROM transactions
     WHERE customer_id = $1
       AND (occurred_at AT TIME ZONE $3)::date BETWEEN (($2::timestamptz AT TIME ZONE $3)::date - INTERVAL '6 days')
                                                   AND (($2::timestamptz AT TIME ZONE $3)::date)`,
    [customerId, referenceDate.toISOString(), timezone]
  );

  const categories = await pool.query<{ category: string; amount_cents: string }>(
    `SELECT category, COALESCE(SUM(amount_cents), 0)::text AS amount_cents
     FROM transactions
     WHERE customer_id = $1
       AND kind = 'expense'
       AND (occurred_at AT TIME ZONE $3)::date BETWEEN (($2::timestamptz AT TIME ZONE $3)::date - INTERVAL '6 days')
                                                   AND (($2::timestamptz AT TIME ZONE $3)::date)
     GROUP BY category
     ORDER BY SUM(amount_cents) DESC
     LIMIT 5`,
    [customerId, referenceDate.toISOString(), timezone]
  );

  const row = totals.rows[0];
  const totalIncomeCents = Number(row?.income_total ?? '0');
  const totalExpenseCents = Number(row?.expense_total ?? '0');
  const startDate = row?.start_date ?? todayIsoDate(referenceDate);
  const endDate = row?.end_date ?? todayIsoDate(referenceDate);

  return {
    startDate,
    endDate,
    totalIncomeCents,
    totalExpenseCents,
    netCents: totalIncomeCents - totalExpenseCents,
    byCategory: categories.rows.map((item) => ({
      category: item.category,
      amountCents: Number(item.amount_cents)
    }))
  };
}

export * from './ledger/conversations.js';

export async function upsertSpendingLimit(params: {
  customerId: string;
  period: SpendingLimitPeriod;
  amountCents: number;
}): Promise<{
  period: SpendingLimitPeriod;
  amountCents: number;
  isActive: boolean;
}> {
  await ensureSpendingLimitsSchema();

  const result = await pool.query<SpendingLimitRow>(
    `INSERT INTO spending_limits (customer_id, period, amount_cents, is_active, updated_at)
     VALUES ($1, $2, $3, TRUE, NOW())
     ON CONFLICT (customer_id, period)
     DO UPDATE SET amount_cents = EXCLUDED.amount_cents,
                   is_active = TRUE,
                   updated_at = NOW()
     RETURNING period, amount_cents, is_active`,
    [params.customerId, params.period, params.amountCents]
  );

  const row = result.rows[0];
  return {
    period: row.period,
    amountCents: row.amount_cents,
    isActive: row.is_active
  };
}

export async function clearSpendingLimit(customerId: string, period: SpendingLimitPeriod): Promise<boolean> {
  await ensureSpendingLimitsSchema();
  const result = await pool.query(
    `UPDATE spending_limits
     SET is_active = FALSE, updated_at = NOW()
     WHERE customer_id = $1
       AND period = $2
       AND is_active = TRUE`,
    [customerId, period]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function listSpendingLimits(customerId: string): Promise<Array<{
  period: SpendingLimitPeriod;
  amountCents: number;
  isActive: boolean;
}>> {
  await ensureSpendingLimitsSchema();
  const result = await pool.query<SpendingLimitRow>(
    `SELECT period, amount_cents, is_active
     FROM spending_limits
     WHERE customer_id = $1
     ORDER BY CASE period
       WHEN 'daily' THEN 1
       WHEN 'weekly' THEN 2
       WHEN 'monthly' THEN 3
       ELSE 99
     END`,
    [customerId]
  );

  return result.rows.map((row) => ({
    period: row.period,
    amountCents: row.amount_cents,
    isActive: row.is_active
  }));
}

async function familyMembershipByCustomer(customerId: string): Promise<{
  groupId: string;
  role: 'owner' | 'member';
} | null> {
  await ensureFamilySchema();
  const result = await pool.query<{
    family_group_id: string;
    role: 'owner' | 'member';
  }>(
    `SELECT family_group_id, role
     FROM family_members
     WHERE customer_id = $1
       AND is_active = TRUE
     LIMIT 1`,
    [customerId]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    groupId: row.family_group_id,
    role: row.role
  };
}

async function familyMemberIds(groupId: string): Promise<string[]> {
  await ensureFamilySchema();
  const result = await pool.query<{ customer_id: string }>(
    `SELECT customer_id
     FROM family_members
     WHERE family_group_id = $1
       AND is_active = TRUE`,
    [groupId]
  );
  return result.rows.map((row) => row.customer_id);
}

export async function upsertFamilySpendingLimit(params: {
  actorCustomerId: string;
  period: SpendingLimitPeriod;
  amountCents: number;
}): Promise<{
  period: SpendingLimitPeriod;
  amountCents: number;
  isActive: boolean;
  groupId: string;
}> {
  const membership = await familyMembershipByCustomer(params.actorCustomerId);
  if (!membership) {
    throw new Error('family_group_not_found');
  }
  if (membership.role !== 'owner') {
    throw new Error('family_owner_required');
  }

  await ensureFamilySchema();
  const result = await pool.query<FamilyLimitRow>(
    `INSERT INTO family_limits (family_group_id, period, amount_cents, is_active, updated_at)
     VALUES ($1, $2, $3, TRUE, NOW())
     ON CONFLICT (family_group_id, period)
     DO UPDATE SET amount_cents = EXCLUDED.amount_cents,
                   is_active = TRUE,
                   updated_at = NOW()
     RETURNING period, amount_cents, is_active`,
    [membership.groupId, params.period, params.amountCents]
  );
  const row = result.rows[0];
  return {
    period: row.period,
    amountCents: row.amount_cents,
    isActive: row.is_active,
    groupId: membership.groupId
  };
}

export async function clearFamilySpendingLimit(params: {
  actorCustomerId: string;
  period: SpendingLimitPeriod;
}): Promise<{ removed: boolean; groupId: string | null }> {
  const membership = await familyMembershipByCustomer(params.actorCustomerId);
  if (!membership) {
    throw new Error('family_group_not_found');
  }
  if (membership.role !== 'owner') {
    throw new Error('family_owner_required');
  }

  await ensureFamilySchema();
  const result = await pool.query(
    `UPDATE family_limits
     SET is_active = FALSE, updated_at = NOW()
     WHERE family_group_id = $1
       AND period = $2
       AND is_active = TRUE`,
    [membership.groupId, params.period]
  );
  return {
    removed: (result.rowCount ?? 0) > 0,
    groupId: membership.groupId
  };
}

export async function listFamilySpendingLimits(actorCustomerId: string): Promise<{
  role: 'owner' | 'member' | null;
  groupId: string | null;
  items: Array<{
    period: SpendingLimitPeriod;
    amountCents: number;
    isActive: boolean;
  }>;
}> {
  const membership = await familyMembershipByCustomer(actorCustomerId);
  if (!membership) {
    return { role: null, groupId: null, items: [] };
  }

  await ensureFamilySchema();
  const result = await pool.query<FamilyLimitRow>(
    `SELECT period, amount_cents, is_active
     FROM family_limits
     WHERE family_group_id = $1
     ORDER BY CASE period
       WHEN 'daily' THEN 1
       WHEN 'weekly' THEN 2
       WHEN 'monthly' THEN 3
       ELSE 99
     END`,
    [membership.groupId]
  );

  return {
    role: membership.role,
    groupId: membership.groupId,
    items: result.rows.map((row) => ({
      period: row.period,
      amountCents: row.amount_cents,
      isActive: row.is_active
    }))
  };
}

async function expenseSpentInPeriod(params: {
  customerId: string;
  period: SpendingLimitPeriod;
  referenceDate: Date;
  timezone: string;
}): Promise<number> {
  if (params.period === 'daily') {
    const result = await pool.query<{ total: string }>(
      `SELECT COALESCE(SUM(amount_cents), 0)::text AS total
       FROM transactions
       WHERE customer_id = $1
         AND kind = 'expense'
         AND (occurred_at AT TIME ZONE $2)::date = ($3::timestamptz AT TIME ZONE $2)::date`,
      [params.customerId, params.timezone, params.referenceDate.toISOString()]
    );
    return Number(result.rows[0]?.total ?? '0');
  }

  if (params.period === 'weekly') {
    const result = await pool.query<{ total: string }>(
      `SELECT COALESCE(SUM(amount_cents), 0)::text AS total
       FROM transactions
       WHERE customer_id = $1
         AND kind = 'expense'
         AND date_trunc('week', occurred_at AT TIME ZONE $2) = date_trunc('week', $3::timestamptz AT TIME ZONE $2)`,
      [params.customerId, params.timezone, params.referenceDate.toISOString()]
    );
    return Number(result.rows[0]?.total ?? '0');
  }

  const result = await pool.query<{ total: string }>(
    `SELECT COALESCE(SUM(amount_cents), 0)::text AS total
     FROM transactions
     WHERE customer_id = $1
       AND kind = 'expense'
       AND date_trunc('month', occurred_at AT TIME ZONE $2) = date_trunc('month', $3::timestamptz AT TIME ZONE $2)`,
    [params.customerId, params.timezone, params.referenceDate.toISOString()]
  );
  return Number(result.rows[0]?.total ?? '0');
}

async function familyExpenseSpentInPeriod(params: {
  groupId: string;
  period: SpendingLimitPeriod;
  referenceDate: Date;
  timezone: string;
}): Promise<number> {
  const memberIds = await familyMemberIds(params.groupId);
  if (memberIds.length === 0) return 0;

  if (params.period === 'daily') {
    const result = await pool.query<{ total: string }>(
      `SELECT COALESCE(SUM(amount_cents), 0)::text AS total
       FROM transactions
       WHERE customer_id = ANY($1::uuid[])
         AND kind = 'expense'
         AND (occurred_at AT TIME ZONE $2)::date = ($3::timestamptz AT TIME ZONE $2)::date`,
      [memberIds, params.timezone, params.referenceDate.toISOString()]
    );
    return Number(result.rows[0]?.total ?? '0');
  }

  if (params.period === 'weekly') {
    const result = await pool.query<{ total: string }>(
      `SELECT COALESCE(SUM(amount_cents), 0)::text AS total
       FROM transactions
       WHERE customer_id = ANY($1::uuid[])
         AND kind = 'expense'
         AND date_trunc('week', occurred_at AT TIME ZONE $2) = date_trunc('week', $3::timestamptz AT TIME ZONE $2)`,
      [memberIds, params.timezone, params.referenceDate.toISOString()]
    );
    return Number(result.rows[0]?.total ?? '0');
  }

  const result = await pool.query<{ total: string }>(
    `SELECT COALESCE(SUM(amount_cents), 0)::text AS total
     FROM transactions
     WHERE customer_id = ANY($1::uuid[])
       AND kind = 'expense'
       AND date_trunc('month', occurred_at AT TIME ZONE $2) = date_trunc('month', $3::timestamptz AT TIME ZONE $2)`,
    [memberIds, params.timezone, params.referenceDate.toISOString()]
  );
  return Number(result.rows[0]?.total ?? '0');
}

export async function spendingLimitStatuses(params: {
  customerId: string;
  referenceDate?: Date;
  timezone?: string;
}): Promise<Array<{
  period: SpendingLimitPeriod;
  limitCents: number;
  spentCents: number;
  remainingCents: number;
  status: 'ok' | 'near' | 'exceeded';
}>> {
  await ensureSpendingLimitsSchema();
  const referenceDate = params.referenceDate ?? new Date();
  const timezone = params.timezone ?? 'America/Sao_Paulo';

  const activeLimits = await pool.query<SpendingLimitRow>(
    `SELECT period, amount_cents, is_active
     FROM spending_limits
     WHERE customer_id = $1
       AND is_active = TRUE`,
    [params.customerId]
  );

  const statuses = await Promise.all(
    activeLimits.rows.map(async (row) => {
      const spentCents = await expenseSpentInPeriod({
        customerId: params.customerId,
        period: row.period,
        referenceDate,
        timezone
      });
      const limitCents = row.amount_cents;
      const remainingCents = limitCents - spentCents;

      let status: 'ok' | 'near' | 'exceeded' = 'ok';
      if (remainingCents <= 0) {
        status = 'exceeded';
      } else {
        const remainingRatio = remainingCents / limitCents;
        if (remainingCents <= 15000 || remainingRatio <= 0.15) {
          status = 'near';
        }
      }

      return {
        period: row.period,
        limitCents,
        spentCents,
        remainingCents,
        status
      };
    })
  );

  return statuses.sort((a, b) => {
    const order: Record<SpendingLimitPeriod, number> = { daily: 1, weekly: 2, monthly: 3 };
    return order[a.period] - order[b.period];
  });
}

export async function familySpendingLimitStatuses(params: {
  actorCustomerId: string;
  referenceDate?: Date;
  timezone?: string;
}): Promise<{
  role: 'owner' | 'member' | null;
  groupId: string | null;
  statuses: Array<{
    period: SpendingLimitPeriod;
    limitCents: number;
    spentCents: number;
    remainingCents: number;
    status: 'ok' | 'near' | 'exceeded';
  }>;
}> {
  const membership = await familyMembershipByCustomer(params.actorCustomerId);
  if (!membership) {
    return { role: null, groupId: null, statuses: [] };
  }

  await ensureFamilySchema();
  const referenceDate = params.referenceDate ?? new Date();
  const timezone = params.timezone ?? 'America/Sao_Paulo';
  const activeLimits = await pool.query<FamilyLimitRow>(
    `SELECT period, amount_cents, is_active
     FROM family_limits
     WHERE family_group_id = $1
       AND is_active = TRUE`,
    [membership.groupId]
  );

  const statuses = await Promise.all(
    activeLimits.rows.map(async (row) => {
      const spentCents = await familyExpenseSpentInPeriod({
        groupId: membership.groupId,
        period: row.period,
        referenceDate,
        timezone
      });
      const limitCents = row.amount_cents;
      const remainingCents = limitCents - spentCents;
      let status: 'ok' | 'near' | 'exceeded' = 'ok';
      if (remainingCents <= 0) {
        status = 'exceeded';
      } else {
        const remainingRatio = remainingCents / limitCents;
        if (remainingCents <= 30000 || remainingRatio <= 0.15) {
          status = 'near';
        }
      }
      return {
        period: row.period,
        limitCents,
        spentCents,
        remainingCents,
        status
      };
    })
  );

  return {
    role: membership.role,
    groupId: membership.groupId,
    statuses: statuses.sort((a, b) => {
      const order: Record<SpendingLimitPeriod, number> = { daily: 1, weekly: 2, monthly: 3 };
      return order[a.period] - order[b.period];
    })
  };
}

export type AccessResult = {
  allowed: boolean;
  reason: 'ok' | 'trial_active' | 'trial_expired' | 'setup_payment_required' | 'monthly_payment_overdue' | 'canceled' | 'inactive' | 'monthly_message_limit_reached';
  status: string;
  amountDueCents?: number;
  dueDate?: string | null;
  trialEndDate?: string | null;
  trialDaysLeft?: number;
  planCode?: PlanCode;
  planName?: string;
  monthlyMessageLimit?: number;
  messagesUsedThisMonth?: number;
};

export async function evaluateCustomerAccess(customerId: string, referenceDate = new Date()): Promise<AccessResult> {
  const subscription = await ensureSubscription(customerId);
  const plan = getPlanDefinition(subscription.plan_code);
  const messagesUsedThisMonth = await currentMonthInboundMessageCount(customerId, referenceDate);
  const customer = await pool.query<{ is_active: boolean; whatsapp_number: string | null }>(
    `SELECT is_active, whatsapp_number FROM customers WHERE id = $1 LIMIT 1`,
    [customerId]
  );

  const isActive = Boolean(customer.rows[0]?.is_active);
  const isOwner = isOwnerWhatsappNumber(customer.rows[0]?.whatsapp_number ?? null);
  const today = todayIsoDate(referenceDate);

  const buildLimitBlocked = (): AccessResult => ({
    allowed: false,
    reason: 'monthly_message_limit_reached',
    status: subscription.status,
    planCode: plan.code,
    planName: plan.name,
    monthlyMessageLimit: plan.monthlyMessageLimit,
    messagesUsedThisMonth
  });

  const attachPlanMeta = (base: AccessResult): AccessResult => ({
    ...base,
    planCode: plan.code,
    planName: plan.name,
    monthlyMessageLimit: plan.monthlyMessageLimit,
    messagesUsedThisMonth
  });

  if (isOwner) {
    if (!isActive) {
      await pool.query(
        `UPDATE customers
         SET is_active = TRUE, updated_at = NOW()
         WHERE id = $1`,
        [customerId]
      );
    }

    return {
      ...attachPlanMeta({
        allowed: true,
        reason: 'ok',
        status: 'active'
      }),
      planCode: 'elite',
      planName: 'Master (Dono)',
      monthlyMessageLimit: 0
    };
  }

  if (subscription.status === 'canceled') {
    return attachPlanMeta({ allowed: false, reason: 'canceled', status: subscription.status });
  }

  if (plan.monthlyMessageLimit > 0 && messagesUsedThisMonth > plan.monthlyMessageLimit) {
    return buildLimitBlocked();
  }

  if (plan.code === 'free') {
    if (!isActive) {
      await pool.query(
        `UPDATE customers
         SET is_active = TRUE, updated_at = NOW()
         WHERE id = $1`,
        [customerId]
      );
    }

    return attachPlanMeta({
      allowed: true,
      reason: 'ok',
      status: 'active'
    });
  }

  if (!subscription.has_paid_setup) {
    if (subscription.trial_enabled && subscription.trial_end_date) {
      if (today <= subscription.trial_end_date) {
        if (!isActive) {
          await pool.query(
            `UPDATE customers
             SET is_active = TRUE, updated_at = NOW()
             WHERE id = $1`,
            [customerId]
          );
        }

        return attachPlanMeta({
          allowed: true,
          reason: 'trial_active',
          status: 'trial',
          trialEndDate: subscription.trial_end_date,
          trialDaysLeft: trialDaysLeft(subscription.trial_end_date, today)
        });
      }

      await pool.query(
        `UPDATE subscriptions
         SET trial_enabled = FALSE, updated_at = NOW()
         WHERE id = $1`,
        [subscription.id]
      );
      await pool.query(
        `UPDATE customers
         SET is_active = FALSE, updated_at = NOW()
         WHERE id = $1`,
        [customerId]
      );

      return attachPlanMeta({
        allowed: false,
        reason: 'trial_expired',
        status: subscription.status,
        amountDueCents: effectiveMonthlyFeeCents(subscription),
        trialEndDate: subscription.trial_end_date
      });
    }

    return attachPlanMeta({
      allowed: false,
      reason: 'setup_payment_required',
      status: subscription.status,
      amountDueCents: effectiveMonthlyFeeCents(subscription)
    });
  }

  if (subscription.next_due_date) {
    const overdueLimit = addDaysIsoDate(subscription.next_due_date, subscription.grace_days);

    if (today > overdueLimit) {
      await pool.query(
        `UPDATE subscriptions
         SET status = 'past_due', updated_at = NOW()
         WHERE id = $1`,
        [subscription.id]
      );
      await pool.query(
        `UPDATE customers
         SET is_active = FALSE, updated_at = NOW()
         WHERE id = $1`,
        [customerId]
      );

      return attachPlanMeta({
        allowed: false,
        reason: 'monthly_payment_overdue',
        status: 'past_due',
        amountDueCents: effectiveMonthlyFeeCents(subscription),
        dueDate: subscription.next_due_date
      });
    }
  }

  if (!isActive) {
    return attachPlanMeta({ allowed: false, reason: 'inactive', status: subscription.status });
  }

  if (subscription.status !== 'active') {
    await pool.query(
      `UPDATE subscriptions
       SET status = 'active', updated_at = NOW()
       WHERE id = $1`,
      [subscription.id]
    );
  }

  return attachPlanMeta({
    allowed: true,
    reason: 'ok',
    status: 'active',
    dueDate: subscription.next_due_date
  });
}

export async function recordSubscriptionPayment(params: {
  customerId: string;
  paymentType: 'setup' | 'monthly';
  amountCents?: number;
  gateway?: string;
  externalReference?: string;
  metadata?: Record<string, unknown>;
}): Promise<{ amountCents: number; nextDueDate: string | null; status: string }> {
  await ensureSubscriptionSchema();
  const client = await pool.connect();
  const paymentGateway = params.gateway ?? 'manual';

  try {
    await client.query('BEGIN');

    const subRes = await client.query<SubscriptionRow>(
      `SELECT id, customer_id, status, setup_fee_cents, base_monthly_fee_cents, discounted_monthly_fee_cents,
              referral_count, referral_threshold, has_paid_setup, start_date::text, next_due_date::text,
              last_payment_date::text, grace_days, trial_enabled, trial_start_date::text, trial_end_date::text, plan_code
       FROM subscriptions
       WHERE customer_id = $1
       LIMIT 1
       FOR UPDATE`,
      [params.customerId]
    );

    let subscription = subRes.rows[0];

    if (!subscription) {
      const created = await client.query<SubscriptionRow>(
        `INSERT INTO subscriptions (customer_id)
         VALUES ($1)
         RETURNING id, customer_id, status, setup_fee_cents, base_monthly_fee_cents, discounted_monthly_fee_cents,
                   referral_count, referral_threshold, has_paid_setup, start_date::text, next_due_date::text,
                   last_payment_date::text, grace_days, trial_enabled, trial_start_date::text, trial_end_date::text, plan_code`,
        [params.customerId]
      );
      subscription = created.rows[0];
    }
    const plan = getPlanDefinition(subscription.plan_code);

    let existingPayment: {
      id: string;
      status: string;
      amount_cents: number;
      payment_type: 'setup' | 'monthly';
    } | null = null;

    if (params.externalReference) {
      const existingRes = await client.query<{
        id: string;
        status: string;
        amount_cents: number;
        payment_type: 'setup' | 'monthly';
      }>(
        `SELECT id, status, amount_cents, payment_type
         FROM payments
         WHERE gateway = $1
           AND external_reference = $2
         ORDER BY created_at DESC
         LIMIT 1
         FOR UPDATE`,
        [paymentGateway, params.externalReference]
      );
      existingPayment = existingRes.rows[0] ?? null;

      if (existingPayment?.status === 'paid') {
        await client.query('ROLLBACK');
        return {
          amountCents: existingPayment.amount_cents,
          nextDueDate: subscription.next_due_date,
          status: subscription.status
        };
      }
    }

    const paymentAmountCents = params.amountCents ??
      (params.paymentType === 'setup'
        ? plan.setupFeeCents
        : effectiveMonthlyFeeCents(subscription));

    let nextDueDate: string | null = subscription.next_due_date;

    if (params.paymentType === 'setup') {
      const firstDueDate = subscription.next_due_date ?? addMonthsIsoDate(new Date(), 1);
      nextDueDate = firstDueDate;

      await client.query(
        `UPDATE subscriptions
         SET has_paid_setup = TRUE,
             status = 'active',
             trial_enabled = FALSE,
             trial_start_date = NULL,
             trial_end_date = NULL,
             start_date = COALESCE(start_date, CURRENT_DATE),
             last_payment_date = CURRENT_DATE,
             next_due_date = $2::date,
             updated_at = NOW()
         WHERE id = $1`,
        [subscription.id, firstDueDate]
      );
    } else {
      const updated = await client.query<{ next_due_date: string }>(
        `UPDATE subscriptions
         SET has_paid_setup = TRUE,
             status = 'active',
             trial_enabled = FALSE,
             trial_start_date = NULL,
             trial_end_date = NULL,
             last_payment_date = CURRENT_DATE,
             next_due_date = CASE
               WHEN next_due_date IS NULL OR next_due_date < CURRENT_DATE THEN (CURRENT_DATE + INTERVAL '1 month')::date
               ELSE (next_due_date + INTERVAL '1 month')::date
             END,
             updated_at = NOW()
         WHERE id = $1
         RETURNING next_due_date::text`,
        [subscription.id]
      );

      nextDueDate = updated.rows[0]?.next_due_date ?? addMonthsIsoDate(new Date(), 1);
    }

    await client.query(
      `UPDATE customers
       SET is_active = TRUE, updated_at = NOW()
       WHERE id = $1`,
      [params.customerId]
    );

    if (existingPayment?.id) {
      await client.query(
        `UPDATE payments
         SET customer_id = $2,
             subscription_id = $3,
             payment_type = $4,
             gateway = $5,
             amount_cents = $6,
             status = 'paid',
             due_date = $7::date,
             paid_at = NOW(),
             metadata = COALESCE(metadata, '{}'::jsonb) || $8::jsonb
         WHERE id = $1`,
        [
          existingPayment.id,
          params.customerId,
          subscription.id,
          params.paymentType,
          paymentGateway,
          paymentAmountCents,
          nextDueDate,
          params.metadata ?? {}
        ]
      );
    } else {
      await client.query(
        `INSERT INTO payments (customer_id, subscription_id, payment_type, gateway, amount_cents, status, due_date, paid_at, external_reference, metadata)
         VALUES ($1, $2, $3, $4, $5, 'paid', $6::date, NOW(), $7, $8)`,
        [
          params.customerId,
          subscription.id,
          params.paymentType,
          paymentGateway,
          paymentAmountCents,
          nextDueDate,
          params.externalReference ?? null,
          params.metadata ?? null
        ]
      );
    }

    await client.query('COMMIT');

    return {
      amountCents: paymentAmountCents,
      nextDueDate,
      status: 'active'
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function listPayments(limit = 200): Promise<Array<{
  id: string;
  customerId: string;
  customerName: string | null;
  whatsappNumber: string;
  paymentType: string;
  gateway: string;
  amountCents: number;
  status: string;
  dueDate: string | null;
  paidAt: string | null;
  externalReference: string | null;
  createdAt: string;
}>> {
  const safeLimit = Math.min(Math.max(limit, 1), 500);
  const result = await pool.query<{
    id: string;
    customer_id: string;
    customer_name: string | null;
    whatsapp_number: string;
    payment_type: string;
    gateway: string;
    amount_cents: number;
    status: string;
    due_date: string | null;
    paid_at: string | null;
    external_reference: string | null;
    created_at: string;
  }>(
    `SELECT
      p.id,
      p.customer_id,
      c.name AS customer_name,
      c.whatsapp_number,
      p.payment_type,
      p.gateway,
      p.amount_cents,
      p.status,
      p.due_date::text,
      p.paid_at::text,
      p.external_reference,
      p.created_at::text
     FROM payments p
     INNER JOIN customers c ON c.id = p.customer_id
     ORDER BY p.created_at DESC
     LIMIT $1`,
    [safeLimit]
  );

  return result.rows.map((row) => ({
    id: row.id,
    customerId: row.customer_id,
    customerName: row.customer_name,
    whatsappNumber: row.whatsapp_number,
    paymentType: row.payment_type,
    gateway: row.gateway,
    amountCents: row.amount_cents,
    status: row.status,
    dueDate: row.due_date,
    paidAt: row.paid_at,
    externalReference: row.external_reference,
    createdAt: row.created_at
  }));
}

export async function changeReferralCount(customerId: string, delta: number): Promise<{
  referralCount: number;
  effectiveMonthlyFeeCents: number;
}> {
  await ensureSubscriptionSchema();
  const updated = await pool.query<SubscriptionRow>(
    `UPDATE subscriptions
     SET referral_count = GREATEST(referral_count + $2, 0),
         updated_at = NOW()
     WHERE customer_id = $1
     RETURNING id, customer_id, status, setup_fee_cents, base_monthly_fee_cents, discounted_monthly_fee_cents,
               referral_count, referral_threshold, has_paid_setup, start_date::text, next_due_date::text,
               last_payment_date::text, grace_days, trial_enabled, trial_start_date::text, trial_end_date::text, plan_code`,
    [customerId, delta]
  );

  const row = updated.rows[0] ?? await ensureSubscription(customerId);

  return {
    referralCount: row.referral_count,
    effectiveMonthlyFeeCents: effectiveMonthlyFeeCents(row)
  };
}

export async function activateCustomerTrial(customerId: string, days = 5): Promise<{
  trialEnabled: boolean;
  trialStartDate: string | null;
  trialEndDate: string | null;
  trialDays: number;
}> {
  await ensureSubscriptionSchema();
  await ensureSubscription(customerId);

  const safeDays = Math.min(Math.max(Math.floor(days), 1), 14);
  const updated = await pool.query<{
    trial_enabled: boolean;
    trial_start_date: string | null;
    trial_end_date: string | null;
  }>(
    `UPDATE subscriptions
     SET trial_enabled = TRUE,
         trial_start_date = CURRENT_DATE,
         trial_end_date = (CURRENT_DATE + (($2::int - 1) * INTERVAL '1 day'))::date,
         status = CASE WHEN status = 'canceled' THEN status ELSE 'pending_setup_payment' END,
         updated_at = NOW()
     WHERE customer_id = $1
     RETURNING trial_enabled, trial_start_date::text, trial_end_date::text`,
    [customerId, safeDays]
  );

  await pool.query(
    `UPDATE customers
     SET is_active = TRUE, updated_at = NOW()
     WHERE id = $1`,
    [customerId]
  );

  const row = updated.rows[0];
  return {
    trialEnabled: Boolean(row?.trial_enabled),
    trialStartDate: row?.trial_start_date ?? null,
    trialEndDate: row?.trial_end_date ?? null,
    trialDays: safeDays
  };
}

export async function getCustomerSubscription(customerId: string): Promise<{
  status: string;
  hasPaidSetup: boolean;
  setupFeeCents: number;
  baseMonthlyFeeCents: number;
  discountedMonthlyFeeCents: number;
  effectiveMonthlyFeeCents: number;
  referralCount: number;
  referralThreshold: number;
  nextDueDate: string | null;
  lastPaymentDate: string | null;
  graceDays: number;
  trialEnabled: boolean;
  trialStartDate: string | null;
  trialEndDate: string | null;
  trialActive: boolean;
  trialDaysLeft: number;
  planCode: PlanCode;
  planName: string;
  monthlyMessageLimit: number;
  messagesUsedThisMonth: number;
  features: string[];
}> {
  const row = await ensureSubscription(customerId);
  const today = todayIsoDate();
  const trialActive = trialIsActive(row, today);
  const plan = getPlanDefinition(row.plan_code);
  const messagesUsedThisMonth = await currentMonthInboundMessageCount(customerId);

  return {
    status: trialActive ? 'trial' : row.status,
    hasPaidSetup: row.has_paid_setup,
    setupFeeCents: plan.setupFeeCents,
    baseMonthlyFeeCents: plan.monthlyFeeCents,
    discountedMonthlyFeeCents: Math.round(plan.monthlyFeeCents * 0.6),
    effectiveMonthlyFeeCents: plan.monthlyFeeCents,
    referralCount: row.referral_count,
    referralThreshold: row.referral_threshold,
    nextDueDate: row.next_due_date,
    lastPaymentDate: row.last_payment_date,
    graceDays: row.grace_days,
    trialEnabled: row.trial_enabled,
    trialStartDate: row.trial_start_date,
    trialEndDate: row.trial_end_date,
    trialActive,
    trialDaysLeft: row.trial_end_date ? trialDaysLeft(row.trial_end_date, today) : 0,
    planCode: plan.code,
    planName: plan.name,
    monthlyMessageLimit: plan.monthlyMessageLimit,
    messagesUsedThisMonth,
    features: plan.features
  };
}

export async function setCustomerSubscriptionStatus(customerId: string, status: 'active' | 'past_due' | 'canceled'): Promise<void> {
  await ensureSubscriptionSchema();
  await pool.query(
    `UPDATE subscriptions
     SET status = $2,
         trial_enabled = FALSE,
         trial_start_date = NULL,
         trial_end_date = NULL,
         updated_at = NOW()
     WHERE customer_id = $1`,
    [customerId, status]
  );

  await pool.query(
    `UPDATE customers
     SET is_active = CASE WHEN $2 = 'active' THEN TRUE ELSE FALSE END,
         updated_at = NOW()
     WHERE id = $1`,
    [customerId, status]
  );
}

export async function refreshSubscriptionStatuses(referenceDate = new Date()): Promise<{ pastDueMarked: number }> {
  const today = todayIsoDate(referenceDate);
  const result = await pool.query<{ customer_id: string }>(
    `UPDATE subscriptions
     SET status = 'past_due', updated_at = NOW()
     WHERE has_paid_setup = TRUE
       AND status <> 'canceled'
       AND next_due_date IS NOT NULL
       AND $1::date > (next_due_date + (grace_days * INTERVAL '1 day'))::date
     RETURNING customer_id`,
    [today]
  );

  if (result.rowCount) {
    await pool.query(
      `UPDATE customers
       SET is_active = FALSE,
           updated_at = NOW()
       WHERE id = ANY($1::uuid[])`,
      [result.rows.map((row) => row.customer_id)]
    );
  }

  return { pastDueMarked: result.rowCount ?? 0 };
}

export async function adminMetrics(): Promise<{
  activeCustomers: number;
  customersOnline1h: number;
  customersOnline24h: number;
  inactive7d: number;
  newCustomersToday: number;
  pastDueCustomers: number;
  pendingSetupCustomers: number;
  trialCustomers: number;
  transactionsThisMonth: number;
  expensesThisMonthCents: number;
}> {
  await ensureSubscriptionSchema();
  const metrics = await pool.query<{
    active_customers: string;
    customers_online_1h: string;
    customers_online_24h: string;
    inactive_7d: string;
    new_customers_today: string;
    past_due_customers: string;
    pending_setup_customers: string;
    trial_customers: string;
    transactions_this_month: string;
    expenses_this_month: string;
  }>(
    `SELECT
      (SELECT COUNT(*)::text FROM customers WHERE is_active = TRUE) AS active_customers,
      (SELECT COUNT(*)::text FROM customers WHERE last_inbound_at >= NOW() - INTERVAL '1 hour') AS customers_online_1h,
      (SELECT COUNT(*)::text FROM customers WHERE last_inbound_at >= NOW() - INTERVAL '24 hours') AS customers_online_24h,
      (SELECT COUNT(*)::text FROM customers WHERE last_inbound_at IS NULL OR last_inbound_at < NOW() - INTERVAL '7 days') AS inactive_7d,
      (SELECT COUNT(*)::text FROM customers WHERE created_at::date = CURRENT_DATE) AS new_customers_today,
      (SELECT COUNT(*)::text FROM subscriptions WHERE status = 'past_due') AS past_due_customers,
      (SELECT COUNT(*)::text FROM subscriptions WHERE status = 'pending_setup_payment') AS pending_setup_customers,
      (
        SELECT COUNT(*)::text
        FROM subscriptions
        WHERE trial_enabled = TRUE
          AND trial_end_date IS NOT NULL
          AND CURRENT_DATE <= trial_end_date
      ) AS trial_customers,
      (
        SELECT COUNT(*)::text
        FROM transactions
        WHERE DATE_TRUNC('month', occurred_at) = DATE_TRUNC('month', NOW())
      ) AS transactions_this_month,
      (
        SELECT COALESCE(SUM(amount_cents), 0)::text
        FROM transactions
        WHERE kind = 'expense'
          AND DATE_TRUNC('month', occurred_at) = DATE_TRUNC('month', NOW())
      ) AS expenses_this_month`
  );

  const row = metrics.rows[0];

  return {
    activeCustomers: Number(row?.active_customers ?? '0'),
    customersOnline1h: Number(row?.customers_online_1h ?? '0'),
    customersOnline24h: Number(row?.customers_online_24h ?? '0'),
    inactive7d: Number(row?.inactive_7d ?? '0'),
    newCustomersToday: Number(row?.new_customers_today ?? '0'),
    pastDueCustomers: Number(row?.past_due_customers ?? '0'),
    pendingSetupCustomers: Number(row?.pending_setup_customers ?? '0'),
    trialCustomers: Number(row?.trial_customers ?? '0'),
    transactionsThisMonth: Number(row?.transactions_this_month ?? '0'),
    expensesThisMonthCents: Number(row?.expenses_this_month ?? '0')
  };
}

export async function listCustomers(): Promise<Array<{
  id: string;
  name: string | null;
  whatsappNumber: string;
  planName: string;
  planCode: PlanCode;
  monthlyMessageLimit: number;
  createdAt: string;
  lastInboundAt: string | null;
  isActive: boolean;
  subscriptionStatus: string;
  nextDueDate: string | null;
  referralCount: number;
  effectiveMonthlyFeeCents: number;
  trialEnabled: boolean;
  trialStartDate: string | null;
  trialEndDate: string | null;
  trialActive: boolean;
  trialDaysLeft: number;
  monthlyIncomeCents: number | null;
}>> {
  await ensureCustomerSchema();
  await ensureSubscriptionSchema();
  const result = await pool.query<{
    id: string;
    name: string | null;
    whatsapp_number: string;
    plan_name: string;
    plan_code: string;
    created_at: string;
    last_inbound_at: string | null;
    is_active: boolean;
    subscription_status: string;
    next_due_date: string | null;
    referral_count: number;
    referral_threshold: number;
    base_monthly_fee_cents: number;
    discounted_monthly_fee_cents: number;
    trial_enabled: boolean;
    trial_start_date: string | null;
    trial_end_date: string | null;
    monthly_income_cents: number | null;
  }>(
    `SELECT
      c.id,
      c.name,
      c.whatsapp_number,
      c.plan_name,
      COALESCE(s.plan_code, 'essential') AS plan_code,
      c.created_at,
      c.last_inbound_at,
      c.is_active,
      c.monthly_income_cents,
      COALESCE(s.status, 'pending_setup_payment') AS subscription_status,
      s.next_due_date::text,
      COALESCE(s.referral_count, 0) AS referral_count,
      COALESCE(s.referral_threshold, 6) AS referral_threshold,
      COALESCE(s.base_monthly_fee_cents, 2000) AS base_monthly_fee_cents,
      COALESCE(s.discounted_monthly_fee_cents, 1000) AS discounted_monthly_fee_cents,
      COALESCE(s.trial_enabled, FALSE) AS trial_enabled,
      s.trial_start_date::text,
      s.trial_end_date::text
     FROM customers c
     LEFT JOIN subscriptions s ON s.customer_id = c.id
     ORDER BY c.created_at DESC
     LIMIT 200`
  );

  const today = todayIsoDate();
  return result.rows.map((row) => {
    const plan = getPlanDefinition(row.plan_code);
    const trialActive = Boolean(
      row.trial_enabled &&
      row.trial_end_date &&
      today <= row.trial_end_date &&
      row.subscription_status !== 'canceled'
    );

    return {
      id: row.id,
      name: row.name,
      whatsappNumber: row.whatsapp_number,
      planName: plan.name,
      planCode: plan.code,
      monthlyMessageLimit: plan.monthlyMessageLimit,
      createdAt: row.created_at,
      lastInboundAt: row.last_inbound_at,
      isActive: row.is_active,
      subscriptionStatus: trialActive ? 'trial' : row.subscription_status,
      nextDueDate: row.next_due_date,
      referralCount: row.referral_count,
      effectiveMonthlyFeeCents: row.referral_count >= row.referral_threshold
        ? row.discounted_monthly_fee_cents
        : row.base_monthly_fee_cents,
      trialEnabled: row.trial_enabled,
      trialStartDate: row.trial_start_date,
      trialEndDate: row.trial_end_date,
      trialActive,
      trialDaysLeft: row.trial_end_date ? trialDaysLeft(row.trial_end_date, today) : 0,
      monthlyIncomeCents: row.monthly_income_cents
    };
  });
}

export async function listActiveCustomerContacts(limit = 1000): Promise<Array<{
  id: string;
  name: string | null;
  whatsappNumber: string;
  lastInboundAt: Date | null;
}>> {
  const safeLimit = Math.max(1, Math.min(Math.floor(limit), 5000));
  const result = await pool.query<{
    id: string;
    name: string | null;
    whatsapp_number: string;
    last_inbound_at: Date | null;
  }>(
    `SELECT id, name, whatsapp_number, last_inbound_at
     FROM customers
     WHERE is_active = TRUE
       AND whatsapp_number IS NOT NULL
       AND LENGTH(TRIM(whatsapp_number)) >= 8
     ORDER BY updated_at DESC
     LIMIT $1`,
    [safeLimit]
  );

  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    whatsappNumber: row.whatsapp_number,
    lastInboundAt: row.last_inbound_at ?? null
  }));
}

export async function deleteCustomer(customerId: string): Promise<{
  deleted: boolean;
  id?: string;
  name?: string | null;
  whatsappNumber?: string;
}> {
  const deleted = await pool.query<{
    id: string;
    name: string | null;
    whatsapp_number: string;
  }>(
    `DELETE FROM customers
     WHERE id = $1
     RETURNING id, name, whatsapp_number`,
    [customerId]
  );

  const row = deleted.rows[0];
  if (!row) {
    return { deleted: false };
  }

  return {
    deleted: true,
    id: row.id,
    name: row.name,
    whatsappNumber: row.whatsapp_number
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Sentinela de Impulso
// Detecta se o gasto atual se encaixa em um padrão comportamental histórico do
// usuário (mesma categoria, horário similar, mesmo tipo de dia da semana).
// ─────────────────────────────────────────────────────────────────────────────
export * from './ledger/transactions.js';
export * from './ledger/bank-connections.js';
export * from './ledger/profile-facts.js';
export * from './ledger/doubts.js';
export * from './ledger/jardes.js';
