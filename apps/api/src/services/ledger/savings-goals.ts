import { pool } from '../../db/pool.js';

// ─── Customer financial capacity & savings goals ──────────────────────────────

export async function getCustomerFinancialCapacity(customerId: string): Promise<{
  avgMonthlyIncomeCents: number;
  avgMonthlyExpenseCents: number;
  avgMonthlySurplusCents: number;
}> {
  const result = await pool.query<{ kind: string; month: string; total: string }>(
    `SELECT kind, DATE_TRUNC('month', occurred_at) AS month, SUM(amount_cents) AS total
     FROM transactions
     WHERE customer_id = $1
       AND occurred_at >= NOW() - INTERVAL '3 months'
     GROUP BY kind, DATE_TRUNC('month', occurred_at)`,
    [customerId]
  );

  const byMonth: Record<string, { income: number; expense: number }> = {};
  for (const row of result.rows) {
    const m = row.month;
    if (!byMonth[m]) byMonth[m] = { income: 0, expense: 0 };
    if (row.kind === 'income') byMonth[m].income += Number(row.total);
    else byMonth[m].expense += Number(row.total);
  }

  const months = Object.values(byMonth);
  if (months.length === 0) return { avgMonthlyIncomeCents: 0, avgMonthlyExpenseCents: 0, avgMonthlySurplusCents: 0 };

  const avgIncome = Math.round(months.reduce((s, m) => s + m.income, 0) / months.length);
  const avgExpense = Math.round(months.reduce((s, m) => s + m.expense, 0) / months.length);
  return {
    avgMonthlyIncomeCents: avgIncome,
    avgMonthlyExpenseCents: avgExpense,
    avgMonthlySurplusCents: Math.max(0, avgIncome - avgExpense)
  };
}

export async function createSavingsGoal(params: {
  customerId: string;
  description: string;
  targetCents: number;
  deadlineDate: Date;
  monthlyTargetCents: number;
}): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO savings_goals (customer_id, description, target_cents, deadline_date, monthly_target_cents)
     VALUES ($1, $2, $3, $4::date, $5)
     RETURNING id`,
    [params.customerId, params.description, params.targetCents, params.deadlineDate.toISOString(), params.monthlyTargetCents]
  );
  return result.rows[0].id;
}

export async function getActiveSavingsGoals(customerId: string): Promise<Array<{
  id: string;
  description: string;
  targetCents: number;
  deadlineDate: Date;
  monthlyTargetCents: number;
  createdAt: Date;
}>> {
  const result = await pool.query<{
    id: string;
    description: string;
    target_cents: string;
    deadline_date: string;
    monthly_target_cents: string;
    created_at: Date;
  }>(
    `SELECT id, description, target_cents, deadline_date, monthly_target_cents, created_at
     FROM savings_goals
     WHERE customer_id = $1 AND status = 'active'
     ORDER BY created_at ASC`,
    [customerId]
  );
  return result.rows.map(r => ({
    id: r.id,
    description: r.description,
    targetCents: Number(r.target_cents),
    deadlineDate: new Date(r.deadline_date),
    monthlyTargetCents: Number(r.monthly_target_cents),
    createdAt: new Date(r.created_at)
  }));
}

export async function cancelActiveSavingsGoals(customerId: string): Promise<number> {
  const result = await pool.query(
    `UPDATE savings_goals SET status = 'cancelled', updated_at = NOW()
     WHERE customer_id = $1 AND status = 'active'`,
    [customerId]
  );
  return result.rowCount ?? 0;
}

export async function getSavingsGoalMonthlyProgress(params: {
  customerId: string;
  goalCreatedAt: Date;
}): Promise<{ currentMonthSurplusCents: number; avgMonthlySurplusCents: number }> {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const [currentResult, avgResult] = await Promise.all([
    pool.query<{ kind: string; total: string }>(
      `SELECT kind, SUM(amount_cents) AS total
       FROM transactions
       WHERE customer_id = $1 AND occurred_at >= $2
       GROUP BY kind`,
      [params.customerId, startOfMonth.toISOString()]
    ),
    pool.query<{ kind: string; month: string; total: string }>(
      `SELECT kind, DATE_TRUNC('month', occurred_at) AS month, SUM(amount_cents) AS total
       FROM transactions
       WHERE customer_id = $1 AND occurred_at >= $2 AND occurred_at < $3
       GROUP BY kind, DATE_TRUNC('month', occurred_at)`,
      [params.customerId, params.goalCreatedAt.toISOString(), startOfMonth.toISOString()]
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
