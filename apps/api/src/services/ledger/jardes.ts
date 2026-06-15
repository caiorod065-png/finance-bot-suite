import { pool } from '../../db/pool.js';

// ─── Jardes Intercept Rules — regras globais de interceptação síncrona ────────

export type JardesInterceptRule = {
  id: string;
  ruleType: 'block' | 'require' | 'rewrite';
  topic: string;
  pattern: string | null;
  instruction: string;
  replacement: string | null;
  isActive: boolean;
  createdAt: Date;
};

let _interceptRulesSchemaReady: Promise<void> | null = null;

async function ensureInterceptRulesSchema(): Promise<void> {
  if (!_interceptRulesSchemaReady) {
    _interceptRulesSchemaReady = pool.query(`
      CREATE TABLE IF NOT EXISTS jardes_intercept_rules (
        id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        rule_type    TEXT        NOT NULL,
        topic        TEXT        NOT NULL,
        pattern      TEXT,
        instruction  TEXT        NOT NULL,
        replacement  TEXT,
        is_active    BOOLEAN     NOT NULL DEFAULT TRUE,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_jardes_intercept_rules_topic
        ON jardes_intercept_rules(topic) WHERE is_active = TRUE;
    `).then(() => undefined).catch((err) => { _interceptRulesSchemaReady = null; throw err; });
  }
  await _interceptRulesSchemaReady;
}

export async function upsertJardesRule(params: {
  ruleType: 'block' | 'require' | 'rewrite';
  topic: string;
  pattern: string | null;
  instruction: string;
  replacement: string | null;
}): Promise<void> {
  await ensureInterceptRulesSchema();
  await pool.query(
    `INSERT INTO jardes_intercept_rules (rule_type, topic, pattern, instruction, replacement, is_active)
     VALUES ($1, $2, $3, $4, $5, TRUE)
     ON CONFLICT (topic) WHERE is_active = TRUE
     DO UPDATE SET
       rule_type   = EXCLUDED.rule_type,
       pattern     = EXCLUDED.pattern,
       instruction = EXCLUDED.instruction,
       replacement = EXCLUDED.replacement,
       is_active   = TRUE`,
    [params.ruleType, params.topic, params.pattern, params.instruction, params.replacement]
  );
}

export async function getActiveJardesRules(): Promise<JardesInterceptRule[]> {
  try {
    await ensureInterceptRulesSchema();
    const r = await pool.query<{
      id: string; rule_type: string; topic: string; pattern: string | null;
      instruction: string; replacement: string | null; is_active: boolean; created_at: Date;
    }>(
      `SELECT id, rule_type, topic, pattern, instruction, replacement, is_active, created_at
       FROM jardes_intercept_rules
       WHERE is_active = TRUE
       ORDER BY created_at ASC`
    );
    return r.rows.map(row => ({
      id: row.id,
      ruleType: row.rule_type as JardesInterceptRule['ruleType'],
      topic: row.topic,
      pattern: row.pattern,
      instruction: row.instruction,
      replacement: row.replacement,
      isActive: row.is_active,
      createdAt: row.created_at
    }));
  } catch {
    return [];
  }
}

export async function deactivateJardesRule(topic: string): Promise<boolean> {
  await ensureInterceptRulesSchema();
  const result = await pool.query<{ id: string }>(
    `UPDATE jardes_intercept_rules SET is_active = FALSE
     WHERE topic = $1 AND is_active = TRUE
     RETURNING id`,
    [topic]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function listJardesRules(): Promise<Array<{
  ruleType: string; topic: string; instruction: string; isActive: boolean;
}>> {
  await ensureInterceptRulesSchema();
  const r = await pool.query<{ rule_type: string; topic: string; instruction: string; is_active: boolean }>(
    `SELECT rule_type, topic, instruction, is_active FROM jardes_intercept_rules ORDER BY created_at DESC`
  );
  return r.rows.map(row => ({
    ruleType: row.rule_type, topic: row.topic, instruction: row.instruction, isActive: row.is_active
  }));
}

// ─── Jardes Monitors — monitoramento em tempo real de conversas ───────────────

let _monitorsSchemaReady: Promise<void> | null = null;

async function ensureMonitorsSchema(): Promise<void> {
  if (!_monitorsSchemaReady) {
    _monitorsSchemaReady = pool.query(`
      CREATE TABLE IF NOT EXISTS jardes_monitors (
        id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        customer_phone   TEXT        NOT NULL,
        owner_customer_id UUID       NOT NULL,
        auto_correct     BOOLEAN     NOT NULL DEFAULT FALSE,
        active           BOOLEAN     NOT NULL DEFAULT TRUE,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at       TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '2 hours'
      );
      CREATE INDEX IF NOT EXISTS idx_jardes_monitors_active
        ON jardes_monitors(customer_phone) WHERE active = TRUE;
    `).then(() => undefined).catch((err) => { _monitorsSchemaReady = null; throw err; });
  }
  await _monitorsSchemaReady;
}

export async function startJardesMonitor(params: {
  customerPhone: string;
  ownerCustomerId: string;
  autoCorrect?: boolean;
}): Promise<void> {
  await ensureMonitorsSchema();
  // Deactivate any existing monitors for this phone before creating a fresh one
  await pool.query(
    `UPDATE jardes_monitors SET active = FALSE WHERE customer_phone = $1 AND active = TRUE`,
    [params.customerPhone]
  );
  await pool.query(
    `INSERT INTO jardes_monitors (customer_phone, owner_customer_id, auto_correct, active, expires_at)
     VALUES ($1, $2, $3, TRUE, NOW() + INTERVAL '2 hours')`,
    [params.customerPhone, params.ownerCustomerId, params.autoCorrect ?? false]
  );
}

export async function stopJardesMonitor(customerPhone: string): Promise<void> {
  await ensureMonitorsSchema();
  await pool.query(
    `UPDATE jardes_monitors SET active = FALSE WHERE customer_phone = $1 AND active = TRUE`,
    [customerPhone]
  );
}

export async function getActiveJardesMonitor(customerPhone: string): Promise<{
  ownerCustomerId: string;
  autoCorrect: boolean;
} | null> {
  try {
    await ensureMonitorsSchema();
    const r = await pool.query<{ owner_customer_id: string; auto_correct: boolean }>(
      `SELECT owner_customer_id, auto_correct FROM jardes_monitors
       WHERE customer_phone = $1 AND active = TRUE AND expires_at > NOW()
       ORDER BY created_at DESC LIMIT 1`,
      [customerPhone]
    );
    if (!r.rows[0]) return null;
    return { ownerCustomerId: r.rows[0].owner_customer_id, autoCorrect: r.rows[0].auto_correct };
  } catch { return null; }
}
