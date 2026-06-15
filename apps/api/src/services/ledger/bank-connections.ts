import { pool } from '../../db/pool.js';

// ─── OPEN FINANCE (Pluggy) ────────────────────────────────────────────────────

let openFinanceSchemaReady: Promise<void> | null = null;

async function ensureOpenFinanceSchema(): Promise<void> {
  if (!openFinanceSchemaReady) {
    openFinanceSchemaReady = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS bank_connections (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
          pluggy_item_id TEXT NOT NULL UNIQUE,
          institution_name TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_bank_connections_customer
        ON bank_connections (customer_id, status)
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS bank_transactions (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
          pluggy_tx_id TEXT UNIQUE,
          pluggy_account_id TEXT,
          amount_cents INTEGER NOT NULL,
          description TEXT NOT NULL,
          category TEXT NOT NULL DEFAULT 'outros',
          kind TEXT NOT NULL DEFAULT 'expense',
          occurred_at TIMESTAMPTZ NOT NULL,
          source TEXT NOT NULL DEFAULT 'open_finance',
          raw_pluggy_type TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_bank_transactions_customer_date
        ON bank_transactions (customer_id, occurred_at DESC)
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_bank_transactions_pluggy_id
        ON bank_transactions (pluggy_tx_id)
      `);
    })().catch((err) => {
      openFinanceSchemaReady = null;
      throw err;
    });
  }
  await openFinanceSchemaReady;
}

export async function upsertBankConnection(params: {
  customerId: string;
  pluggyItemId: string;
  institutionName?: string;
  status: 'pending' | 'connected' | 'error' | 'updating';
}): Promise<void> {
  await ensureOpenFinanceSchema();
  await pool.query(
    `INSERT INTO bank_connections (customer_id, pluggy_item_id, institution_name, status)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (pluggy_item_id) DO UPDATE
       SET status = EXCLUDED.status,
           institution_name = COALESCE(EXCLUDED.institution_name, bank_connections.institution_name),
           updated_at = NOW()`,
    [params.customerId, params.pluggyItemId, params.institutionName ?? null, params.status]
  );
}

export async function getBankConnectionByItemId(pluggyItemId: string): Promise<{
  id: string;
  customerId: string;
  institutionName: string | null;
  status: string;
} | null> {
  await ensureOpenFinanceSchema();
  const r = await pool.query(
    `SELECT id, customer_id, institution_name, status FROM bank_connections WHERE pluggy_item_id = $1`,
    [pluggyItemId]
  );
  if (!r.rows[0]) return null;
  return {
    id: r.rows[0].id,
    customerId: r.rows[0].customer_id,
    institutionName: r.rows[0].institution_name,
    status: r.rows[0].status,
  };
}

export async function getBankConnectionByCustomer(customerId: string): Promise<{
  pluggyItemId: string;
  institutionName: string | null;
  status: string;
} | null> {
  await ensureOpenFinanceSchema();
  const r = await pool.query(
    `SELECT pluggy_item_id, institution_name, status FROM bank_connections
     WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [customerId]
  );
  if (!r.rows[0]) return null;
  return {
    pluggyItemId: r.rows[0].pluggy_item_id,
    institutionName: r.rows[0].institution_name,
    status: r.rows[0].status,
  };
}

export async function deleteBankConnection(customerId: string): Promise<boolean> {
  await ensureOpenFinanceSchema();
  const r = await pool.query(
    `DELETE FROM bank_connections WHERE customer_id = $1 RETURNING pluggy_item_id`,
    [customerId]
  );
  return (r.rowCount ?? 0) > 0;
}

export async function saveBankTransactions(params: {
  customerId: string;
  transactions: Array<{
    pluggyTxId: string;
    pluggyAccountId: string;
    amountCents: number;
    description: string;
    category: string;
    kind: 'expense' | 'income';
    occurredAt: string;
    rawPluggyType: string;
  }>;
}): Promise<number> {
  await ensureOpenFinanceSchema();
  let inserted = 0;
  for (const tx of params.transactions) {
    const r = await pool.query(
      `INSERT INTO bank_transactions
         (customer_id, pluggy_tx_id, pluggy_account_id, amount_cents, description,
          category, kind, occurred_at, raw_pluggy_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (pluggy_tx_id) DO NOTHING`,
      [
        params.customerId,
        tx.pluggyTxId,
        tx.pluggyAccountId,
        tx.amountCents,
        tx.description,
        tx.category,
        tx.kind,
        tx.occurredAt,
        tx.rawPluggyType,
      ]
    );
    inserted += r.rowCount ?? 0;
  }
  return inserted;
}

export async function getBankTransactionsSummary(
  customerId: string,
  fromDate: string,
  toDate: string
): Promise<{ category: string; totalCents: number; count: number }[]> {
  await ensureOpenFinanceSchema();
  const r = await pool.query(
    `SELECT category, SUM(amount_cents) AS total_cents, COUNT(*) AS count
     FROM bank_transactions
     WHERE customer_id = $1
       AND kind = 'expense'
       AND occurred_at::date BETWEEN $2 AND $3
     GROUP BY category
     ORDER BY total_cents DESC`,
    [customerId, fromDate, toDate]
  );
  return r.rows.map((row) => ({
    category: row.category,
    totalCents: parseInt(row.total_cents, 10),
    count: parseInt(row.count, 10),
  }));
}
