import { pool } from '../../db/pool.js';

// ─── Iara Doubts — dúvidas registradas durante conversas para envio diário ────

let _doubtsSchemaReady: Promise<void> | null = null;

async function ensureDoubtsSchema(): Promise<void> {
  if (!_doubtsSchemaReady) {
    _doubtsSchemaReady = pool.query(`
      CREATE TABLE IF NOT EXISTS iara_doubts (
        id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        customer_id      UUID        REFERENCES customers(id) ON DELETE SET NULL,
        customer_phone   TEXT,
        original_message TEXT        NOT NULL,
        iara_response    TEXT,
        doubt_type       TEXT        NOT NULL DEFAULT 'fallback',
        sent_to_owner    BOOLEAN     NOT NULL DEFAULT FALSE,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_iara_doubts_pending
        ON iara_doubts(created_at) WHERE sent_to_owner = FALSE;
    `).then(() => undefined).catch((err) => {
      _doubtsSchemaReady = null;
      throw err;
    });
  }
  await _doubtsSchemaReady;
}

export async function logIaraDoubt(params: {
  customerId?: string;
  customerPhone?: string;
  originalMessage: string;
  iaraResponse?: string;
  doubtType: 'fallback' | 'uncertain' | 'unknown_intent';
}): Promise<void> {
  try {
    await ensureDoubtsSchema();
    await pool.query(
      `INSERT INTO iara_doubts (customer_id, customer_phone, original_message, iara_response, doubt_type)
       VALUES ($1, $2, $3, $4, $5)`,
      [params.customerId ?? null, params.customerPhone ?? null, params.originalMessage, params.iaraResponse ?? null, params.doubtType]
    );
  } catch {
    // non-critical — never break the conversation flow
  }
}

export async function getPendingIaraDoubts(): Promise<Array<{
  id: string;
  customerPhone: string | null;
  originalMessage: string;
  iaraResponse: string | null;
  doubtType: string;
  createdAt: Date;
}>> {
  await ensureDoubtsSchema();
  const result = await pool.query<{
    id: string;
    customer_phone: string | null;
    original_message: string;
    iara_response: string | null;
    doubt_type: string;
    created_at: Date;
  }>(
    `SELECT id, customer_phone, original_message, iara_response, doubt_type, created_at
     FROM iara_doubts
     WHERE sent_to_owner = FALSE
       AND created_at >= NOW() - INTERVAL '24 hours'
     ORDER BY created_at ASC`
  );
  return result.rows.map(r => ({
    id: r.id,
    customerPhone: r.customer_phone,
    originalMessage: r.original_message,
    iaraResponse: r.iara_response,
    doubtType: r.doubt_type,
    createdAt: r.created_at
  }));
}

export async function markIaraDoubtsSent(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await pool.query(
    `UPDATE iara_doubts SET sent_to_owner = TRUE WHERE id = ANY($1)`,
    [ids]
  );
}
