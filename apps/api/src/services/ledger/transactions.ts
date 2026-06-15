import { pool } from '../../db/pool.js';

// ─── Transaction read / write operations ─────────────────────────────────────

export async function getTransactionList(customerId: string, params: {
  since: Date;
  until: Date;
}): Promise<Array<{
  occurredAt: Date;
  kind: 'expense' | 'income';
  amountCents: number;
  category: string;
  description: string;
}>> {
  const result = await pool.query<{
    occurred_at: Date;
    kind: 'expense' | 'income';
    amount_cents: string;
    category: string;
    description: string;
  }>(
    `SELECT occurred_at, kind, amount_cents, category, description
     FROM transactions
     WHERE customer_id = $1
       AND occurred_at >= $2
       AND occurred_at < $3
     ORDER BY occurred_at ASC
     LIMIT 100`,
    [customerId, params.since.toISOString(), params.until.toISOString()]
  );
  return result.rows.map(r => ({
    occurredAt: new Date(r.occurred_at),
    kind: r.kind,
    amountCents: Number(r.amount_cents),
    category: r.category,
    description: r.description
  }));
}

export async function getSpendingByCategory(customerId: string, months = 3): Promise<Array<{
  category: string;
  avgMonthlyCents: number;
  totalCents: number;
}>> {
  const result = await pool.query<{
    category: string;
    total_cents: string;
    month_count: string;
  }>(
    `SELECT category,
            SUM(amount_cents) AS total_cents,
            COUNT(DISTINCT DATE_TRUNC('month', occurred_at)) AS month_count
     FROM transactions
     WHERE customer_id = $1
       AND kind = 'expense'
       AND occurred_at >= NOW() - ($2 || ' months')::INTERVAL
     GROUP BY category
     ORDER BY SUM(amount_cents) DESC`,
    [customerId, months]
  );

  return result.rows.map((row) => {
    const total = Number(row.total_cents);
    const count = Number(row.month_count) || 1;
    return {
      category: row.category,
      avgMonthlyCents: Math.round(total / count),
      totalCents: total
    };
  });
}

export async function saveTransaction(params: {
  customerId: string;
  kind: 'expense' | 'income';
  amountCents: number;
  category: string;
  description: string;
  occurredAtIso: string;
  sourceMessage: string;
}): Promise<void> {
  await pool.query(
    `INSERT INTO transactions (customer_id, kind, amount_cents, category, description, occurred_at, source_message)
     VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7)`,
    [
      params.customerId,
      params.kind,
      params.amountCents,
      params.category,
      params.description,
      params.occurredAtIso,
      params.sourceMessage
    ]
  );
}

export async function deleteLastTransaction(customerId: string, kind: 'expense' | 'income'): Promise<{
  id: string;
  amountCents: number;
  category: string;
  occurredAt: string;
} | null> {
  const deleted = await pool.query<{
    id: string;
    amount_cents: number;
    category: string;
    occurred_at: string;
  }>(
    `DELETE FROM transactions
     WHERE id = (
       SELECT id
       FROM transactions
       WHERE customer_id = $1
         AND kind = $2
       ORDER BY occurred_at DESC
       LIMIT 1
     )
     RETURNING id, amount_cents, category, occurred_at`,
    [customerId, kind]
  );

  if (!deleted.rowCount || !deleted.rows[0]) {
    return null;
  }

  return {
    id: deleted.rows[0].id,
    amountCents: deleted.rows[0].amount_cents,
    category: deleted.rows[0].category,
    occurredAt: deleted.rows[0].occurred_at
  };
}

export async function correctLastTransactionAmount(params: {
  customerId: string;
  kind: 'expense' | 'income';
  newAmountCents: number;
  category?: string;
}): Promise<{
  id: string;
  previousAmountCents: number;
  amountCents: number;
  category: string;
  occurredAt: string;
} | null> {
  const updated = await pool.query<{
    id: string;
    amount_cents: number;
    previous_amount_cents: number;
    category: string;
    occurred_at: string;
  }>(
    `WITH last_tx AS (
      SELECT id, amount_cents
      FROM transactions
      WHERE customer_id = $1
        AND kind = $2
        AND ($4::text IS NULL OR category = $4::text)
      ORDER BY occurred_at DESC
      LIMIT 1
    )
    UPDATE transactions t
    SET amount_cents = $3
    FROM last_tx
    WHERE t.id = last_tx.id
    RETURNING t.id, t.amount_cents, last_tx.amount_cents AS previous_amount_cents, t.category, t.occurred_at`,
    [params.customerId, params.kind, params.newAmountCents, params.category ?? null]
  );

  if (!updated.rowCount || !updated.rows[0]) {
    return null;
  }

  return {
    id: updated.rows[0].id,
    previousAmountCents: Number(updated.rows[0].previous_amount_cents),
    amountCents: updated.rows[0].amount_cents,
    category: updated.rows[0].category,
    occurredAt: updated.rows[0].occurred_at
  };
}

export async function updateLastTransactionContext(params: {
  customerId: string;
  kind: 'expense' | 'income';
  amountCents?: number;
  category?: string;
  description?: string;
}): Promise<{
  id: string;
  previousAmountCents: number;
  amountCents: number;
  previousCategory: string;
  category: string;
  description: string | null;
  occurredAt: string;
} | null> {
  const updated = await pool.query<{
    id: string;
    amount_cents: number;
    previous_amount_cents: number;
    category: string;
    previous_category: string;
    description: string | null;
    occurred_at: string;
  }>(
    `WITH last_tx AS (
      SELECT id, amount_cents, category
      FROM transactions
      WHERE customer_id = $1
        AND kind = $2
        AND ($3::int IS NULL OR amount_cents = $3::int)
      ORDER BY occurred_at DESC
      LIMIT 1
    )
    UPDATE transactions t
    SET amount_cents = COALESCE($3::int, t.amount_cents),
        category = COALESCE($4::text, t.category),
        description = COALESCE($5::text, t.description)
    FROM last_tx
    WHERE t.id = last_tx.id
    RETURNING
      t.id,
      t.amount_cents,
      last_tx.amount_cents AS previous_amount_cents,
      t.category,
      last_tx.category AS previous_category,
      t.description,
      t.occurred_at`,
    [
      params.customerId,
      params.kind,
      params.amountCents ?? null,
      params.category ?? null,
      params.description ?? null
    ]
  );

  if (!updated.rowCount || !updated.rows[0]) {
    return null;
  }

  return {
    id: updated.rows[0].id,
    previousAmountCents: Number(updated.rows[0].previous_amount_cents),
    amountCents: updated.rows[0].amount_cents,
    previousCategory: updated.rows[0].previous_category,
    category: updated.rows[0].category,
    description: updated.rows[0].description,
    occurredAt: updated.rows[0].occurred_at
  };
}

export async function customerTransactions(customerId: string): Promise<Array<{
  id: string;
  kind: 'expense' | 'income';
  amountCents: number;
  category: string;
  description: string | null;
  occurredAt: string;
}>> {
  const result = await pool.query<{
    id: string;
    kind: 'expense' | 'income';
    amount_cents: number;
    category: string;
    description: string | null;
    occurred_at: string;
  }>(
    `SELECT id, kind, amount_cents, category, description, occurred_at
     FROM transactions
     WHERE customer_id = $1
     ORDER BY occurred_at DESC
     LIMIT 100`,
    [customerId]
  );

  return result.rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    amountCents: row.amount_cents,
    category: row.category,
    description: row.description,
    occurredAt: row.occurred_at
  }));
}

export async function detectImpulsivePattern(params: {
  customerId: string;
  category: string;
  amountCents: number;
  occurredAtIso: string;
  timezone?: string;
}): Promise<{
  isPattern: boolean;
  occurrences: number;
  avgAmountCents: number;
  patternLabel: string;
} | null> {
  try {
    const { customerId, category, amountCents, occurredAtIso } = params;
    const tz = params.timezone ?? 'America/Sao_Paulo';

    const occurredAt = new Date(occurredAtIso);
    const hourOfDay = Number(
      new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false })
        .format(occurredAt)
    );
    const dayOfWeek = occurredAt.toLocaleDateString('en-US', { timeZone: tz, weekday: 'long' });
    const isWeekend = dayOfWeek === 'Saturday' || dayOfWeek === 'Sunday';
    const hourMin = hourOfDay - 2;
    const hourMax = hourOfDay + 2;

    const result = await pool.query<{
      count: string;
      avg_amount: string;
      hour_occurrences: string;
    }>(
      `SELECT
         COUNT(*) AS count,
         AVG(amount_cents) AS avg_amount,
         SUM(
           CASE WHEN EXTRACT(HOUR FROM occurred_at AT TIME ZONE $5) BETWEEN $3 AND $4 THEN 1 ELSE 0 END
         ) AS hour_occurrences
       FROM transactions
       WHERE customer_id = $1
         AND category = $2
         AND kind = 'expense'
         AND occurred_at >= NOW() - INTERVAL '60 days'
         AND id NOT IN (
           SELECT id FROM transactions
           WHERE customer_id = $1 AND occurred_at >= NOW() - INTERVAL '1 hour'
           ORDER BY occurred_at DESC LIMIT 1
         )`,
      [customerId, category, hourMin, hourMax, tz]
    );

    const row = result.rows[0];
    const totalOccurrences = parseInt(row?.count ?? '0', 10);
    const hourOccurrences = parseInt(row?.hour_occurrences ?? '0', 10);
    const avgAmountCents = Math.round(parseFloat(row?.avg_amount ?? '0'));

    if (totalOccurrences < 3 || hourOccurrences < 2) return null;

    const dayLabel = isWeekend ? 'fim de semana' : 'dia de semana';
    const hourLabel = hourOfDay < 12 ? 'manhã' : hourOfDay < 18 ? 'tarde' : 'noite';
    const trendLabel = amountCents > avgAmountCents * 1.3
      ? ` (${Math.round(((amountCents / avgAmountCents) - 1) * 100)}% acima da sua média nessa categoria)`
      : '';

    return {
      isPattern: true,
      occurrences: totalOccurrences,
      avgAmountCents,
      patternLabel: `${category} à ${hourLabel} de ${dayLabel}${trendLabel} — padrão detectado ${totalOccurrences}x nos últimos 2 meses`
    };
  } catch {
    return null;
  }
}
