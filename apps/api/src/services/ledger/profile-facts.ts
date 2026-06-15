import { pool } from '../../db/pool.js';

// ─── Customer profile facts — semantic memory learned during conversations ────

let _profileSchemaReady: Promise<void> | null = null;

async function ensureProfileSchema(): Promise<void> {
  if (!_profileSchemaReady) {
    _profileSchemaReady = pool.query(`
      CREATE TABLE IF NOT EXISTS customer_profile_facts (
        id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        customer_id UUID        NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
        key         TEXT        NOT NULL,
        value       TEXT        NOT NULL,
        source      TEXT        NOT NULL DEFAULT 'auto-detected',
        is_active   BOOLEAN     NOT NULL DEFAULT TRUE,
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(customer_id, key)
      );
      CREATE INDEX IF NOT EXISTS idx_customer_profile_facts_active
        ON customer_profile_facts(customer_id) WHERE is_active = TRUE;
    `).then(() => undefined).catch((err) => {
      _profileSchemaReady = null;
      throw err;
    });
  }
  await _profileSchemaReady;
}

export async function getCustomerProfileFacts(customerId: string): Promise<Array<{
  key: string;
  value: string;
  source: string;
  updatedAt: Date;
}>> {
  try {
    await ensureProfileSchema();
    const result = await pool.query<{
      key: string; value: string; source: string; updated_at: Date;
    }>(
      `SELECT key, value, source, updated_at
       FROM customer_profile_facts
       WHERE customer_id = $1 AND is_active = TRUE
       ORDER BY updated_at DESC`,
      [customerId]
    );
    return result.rows.map(r => ({ key: r.key, value: r.value, source: r.source, updatedAt: r.updated_at }));
  } catch {
    return [];
  }
}

export async function upsertCustomerProfileFact(params: {
  customerId: string;
  key: string;
  value: string;
  source?: string;
}): Promise<void> {
  await ensureProfileSchema();
  await pool.query(
    `INSERT INTO customer_profile_facts (customer_id, key, value, source, updated_at, is_active)
     VALUES ($1, $2, $3, $4, NOW(), TRUE)
     ON CONFLICT (customer_id, key) DO UPDATE
       SET value      = EXCLUDED.value,
           source     = EXCLUDED.source,
           updated_at = NOW(),
           is_active  = TRUE`,
    [params.customerId, params.key, params.value, params.source ?? 'auto-detected']
  );
}

export async function deleteCustomerProfileFact(customerId: string, key: string): Promise<boolean> {
  await ensureProfileSchema();
  const r = await pool.query(
    `UPDATE customer_profile_facts SET is_active = FALSE, updated_at = NOW()
     WHERE customer_id = $1 AND key = $2 AND is_active = TRUE`,
    [customerId, key]
  );
  return (r.rowCount ?? 0) > 0;
}
