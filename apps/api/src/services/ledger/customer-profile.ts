import { pool } from '../../db/pool.js';

// ─── Customer profile field updates ──────────────────────────────────────────

let _customerSchemaReady: Promise<void> | null = null;

async function ensureCustomerSchema(): Promise<void> {
  if (!_customerSchemaReady) {
    _customerSchemaReady = (async () => {
      await pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS tax_id TEXT`);
      await pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS monthly_income_cents INTEGER`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_customers_tax_id ON customers (tax_id)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_customers_monthly_income ON customers (monthly_income_cents)`);
    })().catch((error) => {
      _customerSchemaReady = null;
      throw error;
    });
  }
  await _customerSchemaReady;
}

export async function setCustomerPreferredName(customerId: string, name: string): Promise<void> {
  await pool.query(
    `UPDATE customers
     SET name = $2, updated_at = NOW()
     WHERE id = $1`,
    [customerId, name]
  );
}

export async function setCustomerTaxId(customerId: string, taxId: string): Promise<void> {
  await ensureCustomerSchema();
  const digits = taxId.replace(/\D/g, '');
  if (digits.length !== 11 && digits.length !== 14) {
    return;
  }

  await pool.query(
    `UPDATE customers
     SET tax_id = $2, updated_at = NOW()
     WHERE id = $1`,
    [customerId, digits]
  );
}

export async function setCustomerMonthlyIncome(customerId: string, amountCents: number | null): Promise<void> {
  await ensureCustomerSchema();

  if (amountCents !== null && amountCents <= 0) {
    return;
  }

  await pool.query(
    `UPDATE customers
     SET monthly_income_cents = $2, updated_at = NOW()
     WHERE id = $1`,
    [customerId, amountCents]
  );
}

export async function getCustomerMonthlyIncome(customerId: string): Promise<number | null> {
  await ensureCustomerSchema();
  const result = await pool.query<{ monthly_income_cents: number | null }>(
    `SELECT monthly_income_cents
     FROM customers
     WHERE id = $1
     LIMIT 1`,
    [customerId]
  );
  return result.rows[0]?.monthly_income_cents ?? null;
}
