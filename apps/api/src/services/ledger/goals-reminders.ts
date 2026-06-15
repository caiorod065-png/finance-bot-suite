import { pool } from '../../db/pool.js';
import { config } from '../../config.js';
import {
  toIsoDate,
  todayIsoDate,
  daysDiffInclusive,
  isoDateInTimezone,
  nextMonthlyDueDate,
} from './utils.js';

// ─── Financial Goals ──────────────────────────────────────────────────────────

type FinancialGoalRow = {
  id: string;
  customer_id: string;
  title: string;
  target_cents: number;
  start_date: string | Date;
  deadline_date: string | Date;
  is_active: boolean;
  achieved_at: string | null;
  created_at: string;
  updated_at: string;
};

type BillReminderRow = {
  id: string;
  customer_id: string;
  title: string;
  amount_cents: number | null;
  due_date: string | Date;
  due_time: string | null;
  recurrence: 'none' | 'monthly';
  remind_days_before: number;
  remind_minutes_before: number | null;
  is_active: boolean;
  last_notified_for_due_date: string | Date | null;
  created_at: string;
  updated_at: string;
};

let goalsSchemaReady: Promise<void> | null = null;
let billRemindersSchemaReady: Promise<void> | null = null;

async function ensureGoalsSchema(): Promise<void> {
  if (!goalsSchemaReady) {
    goalsSchemaReady = (async () => {
      await pool.query(
        `CREATE TABLE IF NOT EXISTS financial_goals (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          target_cents INTEGER NOT NULL CHECK (target_cents > 0),
          start_date DATE NOT NULL DEFAULT CURRENT_DATE,
          deadline_date DATE NOT NULL,
          is_active BOOLEAN NOT NULL DEFAULT TRUE,
          achieved_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`
      );
      await pool.query(
        `CREATE INDEX IF NOT EXISTS idx_financial_goals_customer_active
         ON financial_goals (customer_id, is_active, deadline_date)`
      );
    })().catch((error) => {
      goalsSchemaReady = null;
      throw error;
    });
  }
  await goalsSchemaReady;
}

async function ensureBillRemindersSchema(): Promise<void> {
  if (!billRemindersSchemaReady) {
    billRemindersSchemaReady = (async () => {
      await pool.query(
        `CREATE TABLE IF NOT EXISTS bill_reminders (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          amount_cents INTEGER,
          due_date DATE NOT NULL,
          due_time TEXT,
          recurrence TEXT NOT NULL DEFAULT 'none' CHECK (recurrence IN ('none', 'monthly')),
          remind_days_before INTEGER NOT NULL DEFAULT 2 CHECK (remind_days_before BETWEEN 0 AND 30),
          remind_minutes_before INTEGER CHECK (remind_minutes_before BETWEEN 0 AND 240),
          is_active BOOLEAN NOT NULL DEFAULT TRUE,
          last_notified_for_due_date DATE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`
      );
      await pool.query(`ALTER TABLE bill_reminders ADD COLUMN IF NOT EXISTS due_time TEXT`);
      await pool.query(`ALTER TABLE bill_reminders ADD COLUMN IF NOT EXISTS remind_minutes_before INTEGER`);
      await pool.query(
        `CREATE INDEX IF NOT EXISTS idx_bill_reminders_customer_active
         ON bill_reminders (customer_id, is_active, due_date)`
      );
    })().catch((error) => {
      billRemindersSchemaReady = null;
      throw error;
    });
  }
  await billRemindersSchemaReady;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function createFinancialGoal(params: {
  customerId: string;
  title: string;
  targetCents: number;
  deadlineDate: string;
  startDate?: string;
}): Promise<{
  id: string;
  title: string;
  targetCents: number;
  startDate: string;
  deadlineDate: string;
  isActive: boolean;
}> {
  await ensureGoalsSchema();
  const created = await pool.query<FinancialGoalRow>(
    `INSERT INTO financial_goals (customer_id, title, target_cents, start_date, deadline_date, is_active, updated_at)
     VALUES ($1, $2, $3, COALESCE($4::date, CURRENT_DATE), $5::date, TRUE, NOW())
     RETURNING *`,
    [params.customerId, params.title, params.targetCents, params.startDate ?? null, params.deadlineDate]
  );

  const row = created.rows[0];
  return {
    id: row.id,
    title: row.title,
    targetCents: row.target_cents,
    startDate: toIsoDate(row.start_date),
    deadlineDate: toIsoDate(row.deadline_date),
    isActive: row.is_active
  };
}

export async function listActiveFinancialGoals(customerId: string): Promise<Array<{
  id: string;
  title: string;
  targetCents: number;
  startDate: string;
  deadlineDate: string;
  isActive: boolean;
}>> {
  await ensureGoalsSchema();
  const result = await pool.query<FinancialGoalRow>(
    `SELECT *
     FROM financial_goals
     WHERE customer_id = $1
       AND is_active = TRUE
     ORDER BY deadline_date ASC, created_at ASC`,
    [customerId]
  );

  return result.rows.map((row) => ({
    id: row.id,
    title: row.title,
    targetCents: row.target_cents,
    startDate: toIsoDate(row.start_date),
    deadlineDate: toIsoDate(row.deadline_date),
    isActive: row.is_active
  }));
}

export async function financialGoalsProgress(customerId: string, referenceDate = new Date(), timezone = 'America/Sao_Paulo'): Promise<Array<{
  id: string;
  title: string;
  targetCents: number;
  startDate: string;
  deadlineDate: string;
  progressCents: number;
  remainingCents: number;
  progressRatio: number;
  daysLeft: number;
  requiredPerDayCents: number;
  requiredPerWeekCents: number;
  requiredPerMonthCents: number;
}>> {
  await ensureGoalsSchema();
  const today = todayIsoDate(referenceDate);
  const goals = await pool.query<FinancialGoalRow>(
    `SELECT *
     FROM financial_goals
     WHERE customer_id = $1
       AND is_active = TRUE
     ORDER BY deadline_date ASC, created_at ASC`,
    [customerId]
  );

  if (goals.rowCount === 0) return [];

  const withProgress = await Promise.all(goals.rows.map(async (goal) => {
    const tx = await pool.query<{ net_cents: string }>(
      `SELECT COALESCE(SUM(
          CASE
            WHEN kind = 'income' THEN amount_cents
            ELSE -amount_cents
          END
        ), 0)::text AS net_cents
       FROM transactions
       WHERE customer_id = $1
         AND (occurred_at AT TIME ZONE $2)::date BETWEEN $3::date AND $4::date`,
      [customerId, timezone, toIsoDate(goal.start_date), today]
    );
    const netCents = Number(tx.rows[0]?.net_cents ?? '0');
    const progressCents = netCents > 0 ? netCents : 0;
    const remainingCents = Math.max(goal.target_cents - progressCents, 0);
    const progressRatio = Math.max(Math.min(progressCents / goal.target_cents, 1), 0);
    const daysLeft = daysDiffInclusive(today, toIsoDate(goal.deadline_date));

    const requiredPerDayCents = daysLeft > 0 ? Math.ceil(remainingCents / daysLeft) : remainingCents;
    const requiredPerWeekCents = requiredPerDayCents * 7;
    const requiredPerMonthCents = requiredPerDayCents * 30;

    return {
      id: goal.id,
      title: goal.title,
      targetCents: goal.target_cents,
      startDate: toIsoDate(goal.start_date),
      deadlineDate: toIsoDate(goal.deadline_date),
      progressCents,
      remainingCents,
      progressRatio,
      daysLeft,
      requiredPerDayCents,
      requiredPerWeekCents,
      requiredPerMonthCents
    };
  }));

  return withProgress;
}

export async function createBillReminder(params: {
  customerId: string;
  title: string;
  dueDate: string;
  dueTime?: string | null;
  remindDaysBefore?: number;
  remindMinutesBefore?: number | null;
  recurrence?: 'none' | 'monthly';
  amountCents?: number | null;
}): Promise<{
  id: string;
  title: string;
  dueDate: string;
  dueTime: string | null;
  remindDaysBefore: number;
  remindMinutesBefore: number | null;
  recurrence: 'none' | 'monthly';
  amountCents: number | null;
  isActive: boolean;
}> {
  await ensureBillRemindersSchema();
  const created = await pool.query<BillReminderRow>(
    `INSERT INTO bill_reminders (customer_id, title, amount_cents, due_date, due_time, recurrence, remind_days_before, remind_minutes_before, is_active, updated_at)
     VALUES ($1, $2, $3, $4::date, $5, COALESCE($6, 'none'), COALESCE($7, 2), $8, TRUE, NOW())
     RETURNING *`,
    [
      params.customerId,
      params.title,
      params.amountCents ?? null,
      params.dueDate,
      params.dueTime ?? null,
      params.recurrence ?? 'none',
      params.remindDaysBefore ?? 2,
      params.remindMinutesBefore ?? null
    ]
  );
  const row = created.rows[0];
  return {
    id: row.id,
    title: row.title,
    dueDate: toIsoDate(row.due_date),
    dueTime: row.due_time,
    remindDaysBefore: row.remind_days_before,
    remindMinutesBefore: row.remind_minutes_before,
    recurrence: row.recurrence,
    amountCents: row.amount_cents,
    isActive: row.is_active
  };
}

export async function listBillReminders(
  customerId: string,
  referenceDate = new Date(),
  timezone = config.defaultTimezone
): Promise<Array<{
  id: string;
  title: string;
  dueDate: string;
  effectiveDueDate: string;
  dueTime: string | null;
  lastNotifiedForDueDate: string | null;
  daysUntilDue: number;
  minutesUntilDue: number | null;
  recurrence: 'none' | 'monthly';
  remindDaysBefore: number;
  remindMinutesBefore: number | null;
  amountCents: number | null;
  isActive: boolean;
}>> {
  await ensureBillRemindersSchema();
  const today = isoDateInTimezone(referenceDate, timezone);
  const result = await pool.query<BillReminderRow>(
    `SELECT *
     FROM bill_reminders
     WHERE customer_id = $1
       AND is_active = TRUE
     ORDER BY due_date ASC, created_at ASC`,
    [customerId]
  );

  return result.rows.map((row) => {
    const storedDueDate = toIsoDate(row.due_date);
    const effectiveDueDate = row.recurrence === 'monthly'
      ? nextMonthlyDueDate(storedDueDate, today)
      : storedDueDate;
    const daysUntilDue = Math.floor(
      (new Date(`${effectiveDueDate}T12:00:00.000Z`).getTime() - new Date(`${today}T12:00:00.000Z`).getTime()) /
      (1000 * 60 * 60 * 24)
    );
    return {
      id: row.id,
      title: row.title,
      dueDate: storedDueDate,
      effectiveDueDate,
      lastNotifiedForDueDate: row.last_notified_for_due_date ? toIsoDate(row.last_notified_for_due_date) : null,
      daysUntilDue,
      minutesUntilDue: null,
      recurrence: row.recurrence,
      remindDaysBefore: row.remind_days_before,
      remindMinutesBefore: row.remind_minutes_before,
      amountCents: row.amount_cents,
      isActive: row.is_active,
      dueTime: row.due_time
    };
  });
}

export async function markBillReminderInactive(customerId: string, reminderId: string): Promise<boolean> {
  await ensureBillRemindersSchema();
  const updated = await pool.query(
    `UPDATE bill_reminders
     SET is_active = FALSE, updated_at = NOW()
     WHERE customer_id = $1
       AND id = $2
       AND is_active = TRUE`,
    [customerId, reminderId]
  );
  return (updated.rowCount ?? 0) > 0;
}

export async function markBillReminderNotifiedForDueDate(params: {
  customerId: string;
  reminderId: string;
  dueDate: string;
}): Promise<boolean> {
  await ensureBillRemindersSchema();
  const updated = await pool.query(
    `UPDATE bill_reminders
     SET last_notified_for_due_date = $3::date, updated_at = NOW()
     WHERE customer_id = $1
       AND id = $2
       AND is_active = TRUE`,
    [params.customerId, params.reminderId, params.dueDate]
  );

  return (updated.rowCount ?? 0) > 0;
}

export async function updateLatestBillReminderLead(params: {
  customerId: string;
  remindDaysBefore: number;
  remindMinutesBefore: number | null;
}): Promise<{
  id: string;
  title: string;
  dueDate: string;
  dueTime: string | null;
  remindDaysBefore: number;
  remindMinutesBefore: number | null;
} | null> {
  await ensureBillRemindersSchema();
  const updated = await pool.query<BillReminderRow>(
    `UPDATE bill_reminders
     SET remind_days_before = $2,
         remind_minutes_before = $3,
         updated_at = NOW()
     WHERE id = (
       SELECT id
       FROM bill_reminders
       WHERE customer_id = $1
         AND is_active = TRUE
       ORDER BY due_date DESC, created_at DESC
       LIMIT 1
     )
     RETURNING *`,
    [params.customerId, params.remindDaysBefore, params.remindMinutesBefore]
  );
  const row = updated.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    dueDate: toIsoDate(row.due_date),
    dueTime: row.due_time,
    remindDaysBefore: row.remind_days_before,
    remindMinutesBefore: row.remind_minutes_before
  };
}

export async function updateBillReminderLeadById(params: {
  customerId: string;
  reminderId: string;
  remindDaysBefore: number;
  remindMinutesBefore: number | null;
}): Promise<{
  id: string;
  title: string;
  dueDate: string;
  dueTime: string | null;
  remindDaysBefore: number;
  remindMinutesBefore: number | null;
} | null> {
  await ensureBillRemindersSchema();
  const updated = await pool.query<BillReminderRow>(
    `UPDATE bill_reminders
     SET remind_days_before = $3,
         remind_minutes_before = $4,
         updated_at = NOW()
     WHERE customer_id = $1
       AND id = $2
       AND is_active = TRUE
     RETURNING *`,
    [params.customerId, params.reminderId, params.remindDaysBefore, params.remindMinutesBefore]
  );
  const row = updated.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    dueDate: toIsoDate(row.due_date),
    dueTime: row.due_time,
    remindDaysBefore: row.remind_days_before,
    remindMinutesBefore: row.remind_minutes_before
  };
}

export async function getLastReminderContextReminderId(customerId: string): Promise<string | null> {
  const result = await pool.query<{ reminder_id: string | null }>(
    `SELECT metadata ->> 'reminderId' AS reminder_id
     FROM conversation_logs
     WHERE customer_id = $1
       AND direction = 'outbound'
       AND metadata IS NOT NULL
       AND metadata ->> 'intent' IN (
         'create-reminder',
         'create-reminder-from-context',
         'update-reminder-lead',
         'update-reminder-lead-created-from-context',
         'update-reminder-lead-by-context-match'
       )
       AND metadata ->> 'reminderId' IS NOT NULL
     ORDER BY created_at DESC
     LIMIT 1`,
    [customerId]
  );
  return result.rows[0]?.reminder_id ?? null;
}
