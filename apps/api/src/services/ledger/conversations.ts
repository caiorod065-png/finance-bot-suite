import { pool } from '../../db/pool.js';

// ─── Conversation logging & message-check helpers ─────────────────────────────

export async function logConversation(customerId: string | null, direction: 'inbound' | 'outbound', message: string, metadata?: Record<string, unknown>): Promise<void> {
  await pool.query(
    `INSERT INTO conversation_logs (customer_id, direction, message, metadata)
     VALUES ($1, $2, $3, $4)`,
    [customerId, direction, message, metadata ?? null]
  );

  if (customerId && direction === 'inbound') {
    await pool.query(
      `UPDATE customers
       SET last_inbound_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [customerId]
    );
  }
}

export async function getLastOutboundMessage(customerId: string): Promise<string | null> {
  const result = await pool.query<{ message: string }>(
    `SELECT message
     FROM conversation_logs
     WHERE customer_id = $1
       AND direction = 'outbound'
     ORDER BY created_at DESC
     LIMIT 1`,
    [customerId]
  );

  return result.rows[0]?.message ?? null;
}

export async function recentConversationMessages(
  customerId: string,
  limit = 6
): Promise<Array<{ direction: 'inbound' | 'outbound'; message: string }>> {
  const safeLimit = Math.min(Math.max(Math.floor(limit), 1), 20);
  const result = await pool.query<{ direction: 'inbound' | 'outbound'; message: string }>(
    `SELECT direction, message
     FROM conversation_logs
     WHERE customer_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [customerId, safeLimit]
  );

  return result.rows;
}

export async function hasAutoMessageToday(params: {
  customerId: string;
  source: string;
  referenceDate?: Date;
  timezone?: string;
}): Promise<boolean> {
  const timezone = params.timezone ?? 'America/Sao_Paulo';
  const referenceDate = params.referenceDate ?? new Date();
  const found = await pool.query<{ id: string }>(
    `SELECT id
     FROM conversation_logs
     WHERE customer_id = $1
       AND direction = 'outbound'
       AND metadata ->> 'source' = $2
       AND COALESCE(metadata ->> 'sent', 'true') <> 'false'
       AND (created_at AT TIME ZONE $4)::date = (($3::timestamptz AT TIME ZONE $4)::date)
     LIMIT 1`,
    [params.customerId, params.source, referenceDate.toISOString(), timezone]
  );

  return Boolean(found.rows[0]?.id);
}

export async function hasInboundMessageToday(params: {
  customerId: string;
  referenceDate?: Date;
  timezone?: string;
}): Promise<boolean> {
  const timezone = params.timezone ?? 'America/Sao_Paulo';
  const referenceDate = params.referenceDate ?? new Date();
  const found = await pool.query<{ id: string }>(
    `SELECT id
     FROM conversation_logs
     WHERE customer_id = $1
       AND direction = 'inbound'
       AND (created_at AT TIME ZONE $3)::date = (($2::timestamptz AT TIME ZONE $3)::date)
     LIMIT 1`,
    [params.customerId, referenceDate.toISOString(), timezone]
  );

  return Boolean(found.rows[0]?.id);
}

export async function hasAutoMessageThisWeek(params: {
  customerId: string;
  source: string;
  referenceDate?: Date;
  timezone?: string;
}): Promise<boolean> {
  const timezone = params.timezone ?? 'America/Sao_Paulo';
  const referenceDate = params.referenceDate ?? new Date();
  const found = await pool.query<{ id: string }>(
    `SELECT id
     FROM conversation_logs
     WHERE customer_id = $1
       AND direction = 'outbound'
       AND metadata ->> 'source' = $2
       AND COALESCE(metadata ->> 'sent', 'true') <> 'false'
       AND date_trunc('week', created_at AT TIME ZONE $4) = date_trunc('week', $3::timestamptz AT TIME ZONE $4)
     LIMIT 1`,
    [params.customerId, params.source, referenceDate.toISOString(), timezone]
  );

  return Boolean(found.rows[0]?.id);
}

export async function hasAutoMessageThisMonth(params: {
  customerId: string;
  source: string;
  referenceDate?: Date;
  timezone?: string;
}): Promise<boolean> {
  const timezone = params.timezone ?? 'America/Sao_Paulo';
  const referenceDate = params.referenceDate ?? new Date();
  const found = await pool.query<{ id: string }>(
    `SELECT id
     FROM conversation_logs
     WHERE customer_id = $1
       AND direction = 'outbound'
       AND metadata ->> 'source' = $2
       AND COALESCE(metadata ->> 'sent', 'true') <> 'false'
       AND date_trunc('month', created_at AT TIME ZONE $4) = date_trunc('month', $3::timestamptz AT TIME ZONE $4)
     LIMIT 1`,
    [params.customerId, params.source, referenceDate.toISOString(), timezone]
  );

  return Boolean(found.rows[0]?.id);
}

// ── Batch helpers — carregam dados de TODOS os clientes em uma única query ──

/** Retorna `Set<"customerId:source">` de mensagens automáticas enviadas hoje. */
export async function batchAutoMessagesSentToday(params: {
  customerIds: string[];
  referenceDate?: Date;
  timezone?: string;
}): Promise<Set<string>> {
  if (params.customerIds.length === 0) return new Set();
  const timezone = params.timezone ?? 'America/Sao_Paulo';
  const referenceDate = params.referenceDate ?? new Date();
  const { rows } = await pool.query<{ customer_id: string; source: string }>(
    `SELECT DISTINCT customer_id, metadata ->> 'source' AS source
     FROM conversation_logs
     WHERE customer_id = ANY($1)
       AND direction = 'outbound'
       AND COALESCE(metadata ->> 'sent', 'true') <> 'false'
       AND (created_at AT TIME ZONE $3)::date = (($2::timestamptz AT TIME ZONE $3)::date)`,
    [params.customerIds, referenceDate.toISOString(), timezone]
  );
  return new Set(rows.filter((r) => r.source).map((r) => `${r.customer_id}:${r.source}`));
}

/** Retorna `Set<customerId>` de clientes que enviaram mensagem hoje. */
export async function batchInboundMessagesSentToday(params: {
  customerIds: string[];
  referenceDate?: Date;
  timezone?: string;
}): Promise<Set<string>> {
  if (params.customerIds.length === 0) return new Set();
  const timezone = params.timezone ?? 'America/Sao_Paulo';
  const referenceDate = params.referenceDate ?? new Date();
  const { rows } = await pool.query<{ customer_id: string }>(
    `SELECT DISTINCT customer_id
     FROM conversation_logs
     WHERE customer_id = ANY($1)
       AND direction = 'inbound'
       AND (created_at AT TIME ZONE $3)::date = (($2::timestamptz AT TIME ZONE $3)::date)`,
    [params.customerIds, referenceDate.toISOString(), timezone]
  );
  return new Set(rows.map((r) => r.customer_id));
}

/** Retorna `Set<"customerId:source">` de mensagens automáticas enviadas esta semana. */
export async function batchAutoMessagesSentThisWeek(params: {
  customerIds: string[];
  referenceDate?: Date;
  timezone?: string;
}): Promise<Set<string>> {
  if (params.customerIds.length === 0) return new Set();
  const timezone = params.timezone ?? 'America/Sao_Paulo';
  const referenceDate = params.referenceDate ?? new Date();
  const { rows } = await pool.query<{ customer_id: string; source: string }>(
    `SELECT DISTINCT customer_id, metadata ->> 'source' AS source
     FROM conversation_logs
     WHERE customer_id = ANY($1)
       AND direction = 'outbound'
       AND COALESCE(metadata ->> 'sent', 'true') <> 'false'
       AND date_trunc('week', created_at AT TIME ZONE $3) = date_trunc('week', $2::timestamptz AT TIME ZONE $3)`,
    [params.customerIds, referenceDate.toISOString(), timezone]
  );
  return new Set(rows.filter((r) => r.source).map((r) => `${r.customer_id}:${r.source}`));
}

/** Retorna `Set<"customerId:source">` de mensagens automáticas enviadas este mês. */
export async function batchAutoMessagesSentThisMonth(params: {
  customerIds: string[];
  referenceDate?: Date;
  timezone?: string;
}): Promise<Set<string>> {
  if (params.customerIds.length === 0) return new Set();
  const timezone = params.timezone ?? 'America/Sao_Paulo';
  const referenceDate = params.referenceDate ?? new Date();
  const { rows } = await pool.query<{ customer_id: string; source: string }>(
    `SELECT DISTINCT customer_id, metadata ->> 'source' AS source
     FROM conversation_logs
     WHERE customer_id = ANY($1)
       AND direction = 'outbound'
       AND COALESCE(metadata ->> 'sent', 'true') <> 'false'
       AND date_trunc('month', created_at AT TIME ZONE $3) = date_trunc('month', $2::timestamptz AT TIME ZONE $3)`,
    [params.customerIds, referenceDate.toISOString(), timezone]
  );
  return new Set(rows.filter((r) => r.source).map((r) => `${r.customer_id}:${r.source}`));
}

export async function findLatestUnansweredOutbound(params: {
  customerId: string;
  referenceDate?: Date;
  minSilenceMinutes: number;
  maxLookbackHours?: number;
}): Promise<{
  id: string;
  createdAt: string;
  source: string | null;
  intent: string | null;
  minutesSinceOutbound: number;
} | null> {
  const referenceDate = params.referenceDate ?? new Date();
  const minSilenceMinutes = Math.max(1, Math.floor(params.minSilenceMinutes));
  const maxLookbackHours = Math.max(1, Math.min(Math.floor(params.maxLookbackHours ?? 48), 24 * 7));

  const found = await pool.query<{
    id: string;
    created_at: string;
    source: string | null;
    intent: string | null;
    minutes_since_outbound: string;
  }>(
    `SELECT o.id,
            o.created_at,
            (o.metadata ->> 'source') AS source,
            (o.metadata ->> 'intent') AS intent,
            FLOOR(EXTRACT(EPOCH FROM ($2::timestamptz - o.created_at)) / 60)::text AS minutes_since_outbound
     FROM conversation_logs o
     WHERE o.customer_id = $1
       AND o.direction = 'outbound'
       AND COALESCE(o.metadata ->> 'sent', 'true') <> 'false'
       AND o.created_at >= ($2::timestamptz - ($4::text || ' hours')::interval)
       AND o.created_at <= ($2::timestamptz - ($3::text || ' minutes')::interval)
       AND COALESCE(o.metadata ->> 'source', '') <> 'auto-followup-checkin'
       AND COALESCE(o.metadata ->> 'source', '') NOT LIKE 'auto-%'
       AND NOT EXISTS (
         SELECT 1
         FROM conversation_logs i
         WHERE i.customer_id = o.customer_id
           AND i.direction = 'inbound'
           AND i.created_at > o.created_at
       )
     ORDER BY o.created_at DESC
     LIMIT 1`,
    [params.customerId, referenceDate.toISOString(), minSilenceMinutes, maxLookbackHours]
  );

  const row = found.rows[0];
  if (!row) return null;

  return {
    id: row.id,
    createdAt: row.created_at,
    source: row.source,
    intent: row.intent,
    minutesSinceOutbound: Number(row.minutes_since_outbound || '0')
  };
}

export async function hasAutoFollowupAfter(params: {
  customerId: string;
  outboundCreatedAt: string;
}): Promise<boolean> {
  const found = await pool.query<{ id: string }>(
    `SELECT id
     FROM conversation_logs
     WHERE customer_id = $1
       AND direction = 'outbound'
       AND metadata ->> 'source' = 'auto-followup-checkin'
       AND COALESCE(metadata ->> 'sent', 'true') <> 'false'
       AND created_at > $2::timestamptz
     LIMIT 1`,
    [params.customerId, params.outboundCreatedAt]
  );

  return Boolean(found.rows[0]?.id);
}
