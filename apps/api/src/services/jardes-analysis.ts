// ─────────────────────────────────────────────────────────────────────────────
// Jardes – Assistente executivo / sistema de análise e controle da Iara Bot
// ─────────────────────────────────────────────────────────────────────────────

import OpenAI from 'openai';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import {
  isOwnerWhatsappNumber,
  logConversation,
  getPendingIaraDoubts,
  markIaraDoubtsSent,
  startJardesMonitor,
  stopJardesMonitor,
  getActiveJardesMonitor,
  getActiveJardesRules,
  upsertJardesRule,
  deactivateJardesRule,
  listJardesRules,
} from './ledger.js';
import { sendWhatsAppText } from './whatsapp-outbound.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type KnowledgeEntry = {
  id: string;
  topic: string;
  description: string;
  rule: string;
  isActive: boolean;
  appliedAt: Date;
};

export type PendingApproval = {
  id: string;
  type: 'improvement' | 'question';
  messageToOwner: string;
  proposalData: {
    issues?: Array<{ topic: string; problem: string; improvement_rule: string }>;
    template_overrides?: Array<{ template_key: string; new_text: string; reason: string }>;
    runId?: string;
    sinceHours?: number;
    [key: string]: unknown;
  };
  status: 'awaiting' | 'approved' | 'rejected' | 'applied' | 'expired';
  createdAt: Date;
};

// ─── OpenAI ───────────────────────────────────────────────────────────────────

function mkOpenAI(): OpenAI | null {
  if (!config.openAiApiKey) return null;
  return new OpenAI({
    apiKey: config.openAiApiKey,
    organization: config.openAiOrganizationId || undefined,
  });
}

// ─── Schema ────────────────────────────────────────────────────────────────────

export async function ensureJardesSchema(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS jardes_knowledge_base (
      id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      topic       TEXT        NOT NULL,
      description TEXT        NOT NULL,
      rule        TEXT        NOT NULL,
      is_active   BOOLEAN     NOT NULL DEFAULT TRUE,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS jardes_pending_approvals (
      id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      type              TEXT        NOT NULL DEFAULT 'improvement',
      message_to_owner  TEXT        NOT NULL,
      proposal_data     JSONB       NOT NULL DEFAULT '{}',
      status            TEXT        NOT NULL DEFAULT 'awaiting',
      owner_response    TEXT,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      responded_at      TIMESTAMPTZ,
      applied_at        TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS jardes_analysis_runs (
      id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      started_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at            TIMESTAMPTZ,
      conversations_reviewed INTEGER     NOT NULL DEFAULT 0,
      issues_found           INTEGER     NOT NULL DEFAULT 0,
      proposals_created      INTEGER     NOT NULL DEFAULT 0,
      status                 TEXT        NOT NULL DEFAULT 'running'
    );

    CREATE TABLE IF NOT EXISTS jardes_template_overrides (
      id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      template_key TEXT       NOT NULL UNIQUE,
      override_text TEXT      NOT NULL,
      description TEXT,
      is_active   BOOLEAN     NOT NULL DEFAULT TRUE,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS jardes_outbound_templates (
      id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      template_key  TEXT        NOT NULL UNIQUE,
      message_text  TEXT        NOT NULL,
      is_active     BOOLEAN     NOT NULL DEFAULT TRUE,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

// ─── Knowledge base ────────────────────────────────────────────────────────────

export async function getActiveKnowledgeEntries(): Promise<KnowledgeEntry[]> {
  try {
    const result = await pool.query<{
      id: string; topic: string; description: string;
      rule: string; is_active: boolean; applied_at: Date;
    }>(
      `SELECT id, topic, description, rule, is_active, applied_at
       FROM jardes_knowledge_base
       WHERE is_active = TRUE
       ORDER BY applied_at DESC
       LIMIT 30`
    );
    return result.rows.map(r => ({
      id: r.id, topic: r.topic, description: r.description,
      rule: r.rule, isActive: r.is_active, appliedAt: r.applied_at,
    }));
  } catch {
    return [];
  }
}

async function applyKnowledgeEntry(entry: {
  topic: string; description: string; rule: string;
}): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO jardes_knowledge_base (topic, description, rule) VALUES ($1, $2, $3) RETURNING id`,
    [entry.topic, entry.description, entry.rule]
  );
  return result.rows[0].id;
}

// ─── Template overrides ────────────────────────────────────────────────────────

export async function getTemplateOverride(key: string): Promise<string | null> {
  try {
    const result = await pool.query<{ override_text: string }>(
      `SELECT override_text FROM jardes_template_overrides
       WHERE template_key = $1 AND is_active = TRUE LIMIT 1`,
      [key]
    );
    return result.rows[0]?.override_text ?? null;
  } catch {
    return null;
  }
}

export async function setTemplateOverride(key: string, text: string, description?: string): Promise<void> {
  await pool.query(
    `INSERT INTO jardes_template_overrides (template_key, override_text, description, is_active, updated_at)
     VALUES ($1, $2, $3, TRUE, NOW())
     ON CONFLICT (template_key) DO UPDATE
       SET override_text = EXCLUDED.override_text,
           description   = COALESCE(EXCLUDED.description, jardes_template_overrides.description),
           is_active     = TRUE,
           updated_at    = NOW()`,
    [key, text, description ?? null]
  );
}

export async function listTemplateOverrides(): Promise<Array<{ key: string; text: string; description: string | null; updatedAt: Date }>> {
  try {
    const result = await pool.query<{ template_key: string; override_text: string; description: string | null; updated_at: Date }>(
      `SELECT template_key, override_text, description, updated_at
       FROM jardes_template_overrides
       WHERE is_active = TRUE
       ORDER BY updated_at DESC`
    );
    return result.rows.map(r => ({
      key: r.template_key, text: r.override_text,
      description: r.description, updatedAt: r.updated_at,
    }));
  } catch {
    return [];
  }
}

async function deactivateTemplateOverride(key: string): Promise<boolean> {
  const result = await pool.query<{ id: string }>(
    `UPDATE jardes_template_overrides SET is_active = FALSE, updated_at = NOW()
     WHERE template_key = $1 AND is_active = TRUE RETURNING id`,
    [key]
  );
  return (result.rowCount ?? 0) > 0;
}

// ─── Outbound templates ────────────────────────────────────────────────────────

async function setOutboundTemplate(key: string, text: string): Promise<void> {
  await pool.query(
    `INSERT INTO jardes_outbound_templates (template_key, message_text, is_active, updated_at)
     VALUES ($1, $2, TRUE, NOW())
     ON CONFLICT (template_key) DO UPDATE
       SET message_text = EXCLUDED.message_text, is_active = TRUE, updated_at = NOW()`,
    [key, text]
  );
}

async function getOutboundTemplate(key: string): Promise<string | null> {
  const result = await pool.query<{ message_text: string }>(
    `SELECT message_text FROM jardes_outbound_templates
     WHERE template_key = $1 AND is_active = TRUE LIMIT 1`,
    [key]
  );
  return result.rows[0]?.message_text ?? null;
}

async function listOutboundTemplates(): Promise<Array<{ key: string; text: string }>> {
  const result = await pool.query<{ template_key: string; message_text: string }>(
    `SELECT template_key, message_text
     FROM jardes_outbound_templates
     WHERE is_active = TRUE
     ORDER BY updated_at DESC`
  );
  return result.rows.map(r => ({ key: r.template_key, text: r.message_text }));
}

// ─── Pending approvals ────────────────────────────────────────────────────────

export async function getAwaitingApproval(): Promise<PendingApproval | null> {
  try {
    const result = await pool.query<{
      id: string; type: string; message_to_owner: string;
      proposal_data: PendingApproval['proposalData']; status: string; created_at: Date;
    }>(
      `SELECT id, type, message_to_owner, proposal_data, status, created_at
       FROM jardes_pending_approvals
       WHERE status = 'awaiting'
       ORDER BY created_at DESC LIMIT 1`
    );
    if (!result.rows[0]) return null;
    const r = result.rows[0];
    return {
      id: r.id,
      type: r.type as PendingApproval['type'],
      messageToOwner: r.message_to_owner,
      proposalData: r.proposal_data,
      status: r.status as PendingApproval['status'],
      createdAt: r.created_at,
    };
  } catch {
    return null;
  }
}

async function createPendingApproval(params: {
  type: PendingApproval['type'];
  messageToOwner: string;
  proposalData: PendingApproval['proposalData'];
}): Promise<string> {
  await pool.query(`UPDATE jardes_pending_approvals SET status = 'expired' WHERE status = 'awaiting'`);
  const result = await pool.query<{ id: string }>(
    `INSERT INTO jardes_pending_approvals (type, message_to_owner, proposal_data)
     VALUES ($1, $2, $3) RETURNING id`,
    [params.type, params.messageToOwner, JSON.stringify(params.proposalData)]
  );
  return result.rows[0].id;
}

async function markApprovalResponded(params: {
  id: string; status: 'approved' | 'rejected' | 'applied'; ownerResponse: string;
}): Promise<void> {
  await pool.query(
    `UPDATE jardes_pending_approvals
     SET status = $1, owner_response = $2, responded_at = NOW(), applied_at = NOW()
     WHERE id = $3`,
    [params.status, params.ownerResponse, params.id]
  );
}

// ─── Communication ─────────────────────────────────────────────────────────────

async function sendJardesMessage(message: string, ownerCustomerId?: string, automated = false): Promise<void> {
  const ownerNumbers = config.ownerWhatsappNumbers;
  if (ownerNumbers.length === 0) return;

  const formatted = `*[JARDES]* ${message}`;

  for (const number of ownerNumbers) {
    const result = await sendWhatsAppText({ to: number, message: formatted });
    if (!result.sent) {
      console.error(`[Jardes] Falha ao enviar WhatsApp para ${number}: ${result.error ?? 'sem detalhes'}`);
    }
    if (ownerCustomerId) {
      await logConversation(ownerCustomerId, 'outbound', formatted, {
        source: 'jardes-message', automated, whatsappSent: result.sent, whatsappError: result.error,
      });
    }
  }
}

export async function getLastJardesOutboundAgeMinutes(ownerCustomerId: string): Promise<number | null> {
  try {
    const result = await pool.query<{ created_at: Date }>(
      `SELECT created_at FROM conversation_logs
       WHERE customer_id = $1 AND direction = 'outbound'
         AND metadata->>'source' = 'jardes-message'
         AND (metadata->>'automated') IS DISTINCT FROM 'true'
       ORDER BY created_at DESC LIMIT 1`,
      [ownerCustomerId]
    );
    if (!result.rows[0]) return null;
    return (Date.now() - new Date(result.rows[0].created_at).getTime()) / 60000;
  } catch {
    return null;
  }
}

// Jardes mode is active while the last non-automated outbound was from Jardes
// and within the last 90 minutes (auto-resets after inactivity).
export async function isJardesModeActive(ownerCustomerId: string): Promise<boolean> {
  try {
    const result = await pool.query<{ source: string | null; created_at: Date }>(
      `SELECT metadata->>'source' AS source, created_at
       FROM conversation_logs
       WHERE customer_id = $1 AND direction = 'outbound'
         AND (metadata->>'automated') IS DISTINCT FROM 'true'
       ORDER BY created_at DESC LIMIT 1`,
      [ownerCustomerId]
    );
    if (result.rows[0]?.source !== 'jardes-message') return false;
    const ageMinutes = (Date.now() - new Date(result.rows[0].created_at).getTime()) / 60000;
    return ageMinutes <= 90;
  } catch {
    return false;
  }
}

// ─── Context builders ──────────────────────────────────────────────────────────

async function getOwnerCustomerId(): Promise<string | null> {
  const ownerNumbers = config.ownerWhatsappNumbers;
  if (ownerNumbers.length === 0) return null;
  const result = await pool.query<{ id: string }>(
    `SELECT id FROM customers WHERE whatsapp_number = $1 LIMIT 1`,
    [ownerNumbers[0]]
  );
  return result.rows[0]?.id ?? null;
}

export async function fetchBusinessSnapshot(): Promise<string> {
  try {
    const [activeRes, pastDueRes, trialRes, pendingRes, planRes] = await Promise.all([
      pool.query<{ total: string }>(`SELECT COUNT(*)::text AS total FROM customers WHERE is_active = TRUE`),
      pool.query<{ total: string }>(
        `SELECT COUNT(*)::text AS total FROM subscriptions s
         JOIN customers c ON c.id = s.customer_id
         WHERE s.status = 'past_due' AND c.is_active = FALSE`
      ),
      pool.query<{ total: string }>(
        `SELECT COUNT(*)::text AS total FROM subscriptions
         WHERE trial_enabled = TRUE AND trial_end_date >= CURRENT_DATE`
      ),
      pool.query<{ total: string }>(
        `SELECT COUNT(*)::text AS total FROM subscriptions
         WHERE has_paid_setup = FALSE AND status != 'canceled'`
      ),
      pool.query<{ plan_code: string; total: string }>(
        `SELECT s.plan_code, COUNT(*)::text AS total
         FROM subscriptions s JOIN customers c ON c.id = s.customer_id
         WHERE c.is_active = TRUE GROUP BY s.plan_code`
      ),
    ]);

    const byPlan = planRes.rows.map(r => `${r.plan_code}: ${r.total}`).join(', ');
    return [
      `Clientes ativos: ${activeRes.rows[0]?.total ?? 0}`,
      `Inadimplentes: ${pastDueRes.rows[0]?.total ?? 0}`,
      `Em teste: ${trialRes.rows[0]?.total ?? 0}`,
      `Pendente ativação: ${pendingRes.rows[0]?.total ?? 0}`,
      `Por plano: ${byPlan || 'sem dados'}`,
    ].join('\n');
  } catch {
    return 'Dados do sistema indisponíveis agora.';
  }
}

// Fetches conversation history, business context, and situational awareness
// for use in the GPT fallback. All queries run in parallel.
async function buildOwnerContext(ownerCustomerId: string): Promise<{
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  businessCtx: string;
  knowledgeCtx: string;
  pendingSummary: string;
  monitorSummary: string;
}> {
  const [history, businessCtx, knowledgeEntries, pendingApproval, activeMonitors] = await Promise.all([
    fetchOwnerConversationHistory(ownerCustomerId, 14),
    fetchBusinessSnapshot(),
    getActiveKnowledgeEntries(),
    getAwaitingApproval(),
    getOwnerActiveMonitors(ownerCustomerId),
  ]);

  const knowledgeCtx = knowledgeEntries.length > 0
    ? `Regras ativas na Iara (${knowledgeEntries.length}): ${knowledgeEntries.slice(0, 6).map(e => e.topic).join(', ')}`
    : 'Nenhuma regra de melhoria ativa ainda.';

  const pendingSummary = pendingApproval
    ? `⏳ PROPOSTA PENDENTE: ${pendingApproval.proposalData.issues?.length ?? 0} melhoria(s) aguardando aprovação. Responda "sim" para aplicar, "não" para rejeitar, ou "item N: [ajuste]" para corrigir.`
    : '';

  const monitorSummary = activeMonitors.length > 0
    ? `👁️ Monitores ativos: ${activeMonitors.map(m => m.customerPhone).join(', ')}`
    : '';

  return { history, businessCtx, knowledgeCtx, pendingSummary, monitorSummary };
}

// ─── Conversation history ─────────────────────────────────────────────────────

async function fetchOwnerConversationHistory(
  ownerCustomerId: string,
  limit = 14
): Promise<Array<{ role: 'user' | 'assistant'; content: string }>> {
  try {
    const result = await pool.query<{ direction: 'inbound' | 'outbound'; message: string }>(
      `SELECT direction, message
       FROM conversation_logs
       WHERE customer_id = $1
         AND created_at >= NOW() - INTERVAL '4 hours'
         AND (metadata->>'automated') IS DISTINCT FROM 'true'
       ORDER BY created_at DESC
       LIMIT $2`,
      [ownerCustomerId, limit]
    );
    return result.rows.reverse().map(row => ({
      role: row.direction === 'inbound' ? ('user' as const) : ('assistant' as const),
      content: row.message,
    }));
  } catch {
    return [];
  }
}

// ─── Monitor helpers ──────────────────────────────────────────────────────────

async function getOwnerActiveMonitors(ownerCustomerId: string): Promise<Array<{
  customerPhone: string;
  autoCorrect: boolean;
  createdAt: Date;
}>> {
  try {
    const r = await pool.query<{ customer_phone: string; auto_correct: boolean; created_at: Date }>(
      `SELECT customer_phone, auto_correct, created_at
       FROM jardes_monitors
       WHERE owner_customer_id = $1 AND active = TRUE AND expires_at > NOW()
       ORDER BY created_at DESC`,
      [ownerCustomerId]
    );
    return r.rows.map(row => ({
      customerPhone: row.customer_phone,
      autoCorrect: row.auto_correct,
      createdAt: row.created_at,
    }));
  } catch {
    return [];
  }
}

// Returns recent monitor notification messages logged to conversation_logs
// (automated=true messages from jardes-message source = monitor pings)
async function getRecentMonitorLogs(ownerCustomerId: string, limitMinutes = 120): Promise<string[]> {
  try {
    const r = await pool.query<{ message: string }>(
      `SELECT message
       FROM conversation_logs
       WHERE customer_id = $1
         AND direction = 'outbound'
         AND metadata->>'source' = 'jardes-message'
         AND (metadata->>'automated') = 'true'
         AND created_at > NOW() - ($2 || ' minutes')::INTERVAL
       ORDER BY created_at DESC
       LIMIT 30`,
      [ownerCustomerId, String(limitMinutes)]
    );
    return r.rows.map(r => r.message);
  } catch {
    return [];
  }
}

// ─── Conversation lookup ──────────────────────────────────────────────────────

export async function getConversationsForAnalysis(sinceHours: number): Promise<Array<{
  customerId: string;
  customerName: string | null;
  messages: Array<{ direction: 'inbound' | 'outbound'; message: string }>;
}>> {
  const result = await pool.query<{
    customer_id: string; customer_name: string | null;
    direction: 'inbound' | 'outbound'; message: string; whatsapp_number: string | null;
  }>(
    `SELECT cl.customer_id, c.name AS customer_name, cl.direction, cl.message, c.whatsapp_number
     FROM conversation_logs cl
     JOIN customers c ON c.id = cl.customer_id
     WHERE cl.created_at > NOW() - ($1 || ' hours')::INTERVAL
       AND cl.customer_id IS NOT NULL
       AND c.is_active = TRUE
       AND (cl.metadata->>'source' IS NULL OR cl.metadata->>'source' NOT LIKE 'auto-%')
       AND (cl.metadata->>'source' IS NULL OR cl.metadata->>'source' != 'jardes-message')
     ORDER BY cl.customer_id, cl.created_at ASC
     LIMIT 600`,
    [String(sinceHours)]
  );

  const byCustomer = new Map<string, typeof result.rows>();
  for (const row of result.rows) {
    if (isOwnerWhatsappNumber(row.whatsapp_number)) continue;
    const existing = byCustomer.get(row.customer_id) ?? [];
    existing.push(row);
    byCustomer.set(row.customer_id, existing);
  }

  return Array.from(byCustomer.entries()).map(([customerId, rows]) => ({
    customerId,
    customerName: rows[0]?.customer_name ?? null,
    messages: rows.map(r => ({ direction: r.direction, message: r.message.slice(0, 300) })),
  }));
}

async function lookupConversationsByPhone(phoneRaw: string, limitMsgs = 40): Promise<{
  customerName: string | null;
  whatsappNumber: string;
  messages: Array<{ direction: string; message: string }>;
} | null> {
  const digits = phoneRaw.replace(/\D/g, '');
  if (digits.length < 8) return null;

  const result = await pool.query<{
    customer_name: string | null; whatsapp_number: string;
    direction: string; message: string;
  }>(
    `SELECT c.name AS customer_name, c.whatsapp_number, cl.direction, cl.message
     FROM conversation_logs cl
     JOIN customers c ON c.id = cl.customer_id
     WHERE regexp_replace(c.whatsapp_number, '[^0-9]', '', 'g') LIKE $1
     ORDER BY cl.created_at DESC LIMIT $2`,
    [`%${digits}%`, limitMsgs]
  );

  if (result.rows.length === 0) return null;
  return {
    customerName: result.rows[0].customer_name,
    whatsappNumber: result.rows[0].whatsapp_number,
    messages: result.rows.map(r => ({ direction: r.direction, message: r.message })).reverse(),
  };
}

async function lookupConversationsByQuery(query: string, limitMsgs = 40): Promise<Array<{
  customerName: string | null;
  whatsappNumber: string;
  messages: Array<{ direction: string; message: string }>;
}>> {
  const isAnonQuery = /an[oô]nim|sem nome|sem cadastro/i.test(query);
  const nameExtract = query.match(/\b(?:do|da|de|com|cliente|contato)\s+([A-ZÀ-Ú][a-záéíóúâêôãõç]+(?:\s+[A-ZÀ-Ú][a-záéíóúâêôãõç]+)*)/i);
  const searchName = nameExtract ? nameExtract[1].trim() : null;

  const whereClause = isAnonQuery
    ? `(c.name IS NULL OR c.name = '' OR c.name ILIKE 'anônimo%' OR c.name ILIKE 'unknown%')`
    : searchName
      ? `c.name ILIKE $1`
      : null;

  if (!whereClause) return [];

  const args: unknown[] = [];
  if (searchName) args.push(`%${searchName}%`);
  args.push(limitMsgs);

  const sql = `
    SELECT c.name AS customer_name, c.whatsapp_number, cl.direction, cl.message
    FROM conversation_logs cl
    JOIN customers c ON c.id = cl.customer_id
    WHERE ${whereClause}
      AND cl.created_at > NOW() - INTERVAL '30 days'
    ORDER BY c.id, cl.created_at DESC
    LIMIT $${args.length}`;

  const result = await pool.query<{
    customer_name: string | null; whatsapp_number: string;
    direction: string; message: string;
  }>(sql, args);

  const byNumber = new Map<string, typeof result.rows>();
  for (const row of result.rows) {
    const existing = byNumber.get(row.whatsapp_number) ?? [];
    existing.push(row);
    byNumber.set(row.whatsapp_number, existing);
  }

  return Array.from(byNumber.entries()).map(([, rows]) => ({
    customerName: rows[0].customer_name,
    whatsappNumber: rows[0].whatsapp_number,
    messages: rows.map(r => ({ direction: r.direction, message: r.message })).reverse(),
  }));
}

async function lookupLastConversation(): Promise<{
  customerName: string | null;
  whatsappNumber: string;
  messages: Array<{ direction: string; message: string }>;
} | null> {
  try {
    const ownerNumbers = config.ownerWhatsappNumbers;
    const excludeClause = ownerNumbers.length > 0
      ? `AND c.whatsapp_number NOT IN (${ownerNumbers.map((_, i) => `$${i + 1}`).join(', ')})`
      : '';

    const latestResult = await pool.query<{
      customer_id: string; customer_name: string | null; whatsapp_number: string;
    }>(
      `SELECT c.id AS customer_id, c.name AS customer_name, c.whatsapp_number
       FROM conversation_logs cl
       JOIN customers c ON c.id = cl.customer_id
       WHERE cl.direction = 'inbound'
         AND c.is_active = TRUE
         ${excludeClause}
       ORDER BY cl.created_at DESC
       LIMIT 1`,
      ownerNumbers
    );

    if (!latestResult.rows[0]) return null;
    const { customer_id, customer_name, whatsapp_number } = latestResult.rows[0];

    const msgs = await pool.query<{ direction: string; message: string }>(
      `SELECT direction, message
       FROM conversation_logs
       WHERE customer_id = $1
         AND created_at > NOW() - INTERVAL '7 days'
         AND (metadata->>'source' IS NULL OR metadata->>'source' NOT LIKE 'auto-%')
       ORDER BY created_at DESC
       LIMIT 30`,
      [customer_id]
    );

    return {
      customerName: customer_name,
      whatsappNumber: whatsapp_number,
      messages: msgs.rows.map(r => ({ direction: r.direction, message: r.message })).reverse(),
    };
  } catch {
    return null;
  }
}

function formatConversationForAnalysis(
  messages: Array<{ direction: string; message: string }>,
  maxMsgLen = 400
): string {
  return messages
    .map(m => `${m.direction === 'inbound' ? 'Cliente' : 'Iara'}: ${m.message.slice(0, maxMsgLen)}`)
    .join('\n');
}

// ─── Misc helpers ─────────────────────────────────────────────────────────────

function extractManualMessageToSend(command: string): string | null {
  const explicitField =
    command.match(/(?:mensagem|texto)\s*[:\-]\s*[""]?([\s\S]+?)[""]?\s*$/i) ??
    command.match(/(?:escreve|escrever)\s*[:\-]\s*[""]?([\s\S]+?)[""]?\s*$/i);
  if (explicitField?.[1]) return explicitField[1].trim();

  const quoted =
    command.match(/[""]([^""]{3,})[""]/) ??
    command.match(/(?:diga|fala|fale)\s+(.{3,})$/i);
  if (quoted?.[1]) return quoted[1].trim();

  return null;
}

function extractOutboundTemplateKey(command: string): string | null {
  const byKeyword =
    command.match(/template\s*[:\-]\s*([a-z0-9][a-z0-9\-_]+)/i) ??
    command.match(/mensagem\s*[:\-]\s*([a-z0-9][a-z0-9\-_]+)/i);
  return byKeyword?.[1]?.trim().toLowerCase() ?? null;
}

function nowBrasilia(): string {
  return new Date().toLocaleTimeString('pt-BR', {
    timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit',
  });
}

function todayBrasilia(): string {
  return new Date().toLocaleDateString('pt-BR', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
}

// ─── Analysis engine ──────────────────────────────────────────────────────────

export async function runJardesAnalysis(params: {
  sinceHours?: number;
  forceRun?: boolean;
  automated?: boolean;
} = {}): Promise<{ proposalsSent: number; issuesFound: number; conversationsReviewed: number }> {
  await ensureJardesSchema();

  const sinceHours = params.sinceHours ?? 6;
  const automated = params.automated ?? false;

  if (!params.forceRun) {
    const pending = await getAwaitingApproval();
    if (pending) return { proposalsSent: 0, issuesFound: 0, conversationsReviewed: 0 };
  }

  const openai = mkOpenAI();
  if (!openai) return { proposalsSent: 0, issuesFound: 0, conversationsReviewed: 0 };

  const runRes = await pool.query<{ id: string }>(
    `INSERT INTO jardes_analysis_runs (started_at) VALUES (NOW()) RETURNING id`
  );
  const runId = runRes.rows[0]?.id ?? 'unknown';

  try {
    const [conversations, knowledgeEntries] = await Promise.all([
      getConversationsForAnalysis(sinceHours),
      getActiveKnowledgeEntries(),
    ]);
    const ownerCustomerId = await getOwnerCustomerId();
    const businessSnap = await fetchBusinessSnapshot();

    const statusFooter = [
      '', `*Status do negócio:*`, businessSnap,
      `Regras ativas na Iara: ${knowledgeEntries.length}`,
    ].join('\n');

    if (conversations.length === 0) {
      await pool.query(
        `UPDATE jardes_analysis_runs SET finished_at = NOW(), status = 'completed' WHERE id = $1`, [runId]
      );
      await sendJardesMessage(
        `📊 *Relatório Jardes — Últimas ${sinceHours}h*\n\nSem conversas de clientes para analisar.${statusFooter}`,
        ownerCustomerId ?? undefined, automated
      );
      return { proposalsSent: 0, issuesFound: 0, conversationsReviewed: 0 };
    }

    const conversationText = conversations.map(c => {
      const lines = c.messages
        .map(m => `  ${m.direction === 'inbound' ? 'Cliente' : 'Iara'}: ${m.message}`)
        .join('\n');
      return `--- ${c.customerName ?? 'Cliente anônimo'} ---\n${lines}`;
    }).join('\n\n');

    const analysisPrompt = `Você é Jardes, analista de qualidade da Iara Bot — assistente financeira no WhatsApp.
Analise as conversas abaixo e identifique problemas concretos na qualidade das respostas da Iara.

Procure apenas por:
1. Respostas de fallback ("não entendi", "pode reformular", "como posso te ajudar?", "não consegui interpretar")
2. Perguntas repetidas pelo mesmo cliente (Iara não soube responder na primeira vez)
3. Falta de exemplo prático quando o cliente estava confuso
4. Tom robótico ou frio em situação que pedia empatia
5. Erro de classificação (Iara executou ação que o cliente não pediu)
6. Texto fixo inadequado (mensagem gerada por template fixo, não GPT, que parece robótica)
   Templates overridáveis: confirm-transaction-ask, confirm-transaction-hint, spending-limit-ok, register-transaction-ok

Ignore conversas normais e bem-sucedidas.
Para cada problema encontrado, proponha uma regra específica e aplicável.
Para problemas do tipo 6, proponha novo texto para o template (variáveis: {amount}, {category}, {period}, {emoji}).

Conversas (últimas ${sinceHours}h):
${conversationText}

Retorne APENAS JSON válido:
{
  "issues": [
    {
      "topic": "identificador_snake_case",
      "problem": "descrição curta do problema",
      "example": "trecho literal que ilustra o problema",
      "improvement_rule": "regra concisa para a Iara evitar esse erro"
    }
  ],
  "template_overrides": [
    {
      "template_key": "chave_do_template",
      "new_text": "novo texto com suporte a {variáveis}",
      "reason": "por que essa mudança melhora a experiência"
    }
  ]
}

Se não encontrar problemas relevantes: { "issues": [], "template_overrides": [] }.
Máximo 5 issues + 3 template_overrides.`;

    const response = await openai.chat.completions.create({
      model: config.openAiAgentModel,
      messages: [{ role: 'user', content: analysisPrompt }],
      max_tokens: 2000, temperature: 0.2,
      response_format: { type: 'json_object' },
    });

    const content = response.choices[0]?.message?.content ?? '{"issues":[],"template_overrides":[]}';
    let parsed: { issues: PendingApproval['proposalData']['issues']; template_overrides?: PendingApproval['proposalData']['template_overrides'] };
    try { parsed = JSON.parse(content); }
    catch { parsed = { issues: [], template_overrides: [] }; }

    const issues = parsed.issues ?? [];
    const templateOverrides = parsed.template_overrides ?? [];

    await pool.query(
      `UPDATE jardes_analysis_runs SET conversations_reviewed = $1, issues_found = $2 WHERE id = $3`,
      [conversations.length, issues.length + templateOverrides.length, runId]
    );

    if (issues.length === 0 && templateOverrides.length === 0) {
      await pool.query(
        `UPDATE jardes_analysis_runs SET finished_at = NOW(), status = 'completed' WHERE id = $1`, [runId]
      );
      await sendJardesMessage(
        `📊 *Relatório Jardes — Últimas ${sinceHours}h*\n\nConversas analisadas: ${conversations.length} cliente(s)\nProblemas encontrados: nenhum ✅\nIara respondendo bem.${statusFooter}`,
        ownerCustomerId ?? undefined, automated
      );
      return { proposalsSent: 0, issuesFound: 0, conversationsReviewed: conversations.length };
    }

    const issueLines = issues.map((issue, i) =>
      [
        `${i + 1}. *${issue.topic}*`,
        `   Problema: ${issue.problem}`,
        `   Proposta: ${issue.improvement_rule}`,
      ].join('\n')
    ).join('\n\n');

    const templateOverrideLines = templateOverrides.length > 0
      ? [
          '', '🔧 *Templates a atualizar:*',
          ...templateOverrides.map(t =>
            `• ${t.template_key}: "${t.new_text.slice(0, 80)}${t.new_text.length > 80 ? '...' : ''}"\n  Motivo: ${t.reason}`
          ),
        ].join('\n')
      : '';

    const approvalMessage = [
      `📊 *Relatório Jardes — Últimas ${sinceHours}h*`, '',
      ...(issues.length > 0
        ? [`Felipe, analisei ${conversations.length} conversa(s) e encontrei ${issues.length} ponto(s) a melhorar na Iara:`, '', issueLines]
        : [`Felipe, analisei ${conversations.length} conversa(s). Sem issues de comportamento.`]),
      templateOverrideLines, '',
      'Para aplicar tudo: *sim*\nPara rejeitar: *não*\nPara ajustar por item: *item N: [sua instrução]*',
      statusFooter,
    ].join('\n');

    await createPendingApproval({
      type: 'improvement',
      messageToOwner: approvalMessage,
      proposalData: { issues, template_overrides: templateOverrides, runId, sinceHours },
    });

    await sendJardesMessage(approvalMessage, ownerCustomerId ?? undefined, automated);

    await pool.query(
      `UPDATE jardes_analysis_runs SET finished_at = NOW(), status = 'completed', proposals_created = 1 WHERE id = $1`, [runId]
    );

    return { proposalsSent: 1, issuesFound: issues.length + templateOverrides.length, conversationsReviewed: conversations.length };
  } catch (error) {
    await pool.query(
      `UPDATE jardes_analysis_runs SET finished_at = NOW(), status = 'failed' WHERE id = $1`, [runId]
    );
    throw error;
  }
}

// ─── Approval flow ────────────────────────────────────────────────────────────

export async function processOwnerJardesResponse(params: {
  ownerMessage: string;
  pendingApproval: PendingApproval;
  ownerCustomerId: string;
}): Promise<string> {
  const { ownerMessage, pendingApproval, ownerCustomerId } = params;
  const normalized = ownerMessage.trim();

  // Only intercept if the message actually looks like a response to the pending proposal.
  // Questions and operational commands go to handleJardesDirectCommand instead.
  const isApprovalResponse =
    /^(sim|s|ok|pode|vai|yes|confirma|confirmado|aplica|aplicar|tá\s*bom|ta\s*bom|beleza|ótimo|otimo|certo|perfeito|n[ãa]o|rejeita|cancela|ignora|não\s+aplica)\b/i.test(normalized) ||
    /^(item\s+\d|\d+\s*[:\-])/i.test(normalized) ||
    /\b(concordo|discordo|sobre\s+(essa\s+)?proposta|sobre\s+o\s+item|quanto\s+ao\s+item|corrige\s+o\s+item|ajusta\s+o\s+item)\b/i.test(normalized);

  if (!isApprovalResponse) {
    return handleJardesDirectCommand({ rawMessage: ownerMessage, ownerCustomerId });
  }

  const isSimpleApproval =
    /^(sim|s|ok|pode|vai|yes|confirma|confirmado|aplica|aplicar|tá bom|ta bom|beleza|ótimo|otimo|certo|perfeito)(\s.*)?$/i.test(normalized);

  const openai = mkOpenAI();

  if (isSimpleApproval) {
    const issues = pendingApproval.proposalData.issues ?? [];
    for (const issue of issues) {
      await applyKnowledgeEntry({ topic: issue.topic, description: issue.problem, rule: issue.improvement_rule });
    }
    const templateOverrides = pendingApproval.proposalData.template_overrides ?? [];
    for (const override of templateOverrides) {
      await setTemplateOverride(override.template_key, override.new_text, override.reason);
    }
    await markApprovalResponded({ id: pendingApproval.id, status: 'applied', ownerResponse: ownerMessage });
    const totalApplied = issues.length + templateOverrides.length;
    const templateNote = templateOverrides.length > 0 ? ` (inclui ${templateOverrides.length} template(s) atualizado(s))` : '';
    const reply = `*[JARDES]* Aplicado. ${totalApplied} melhoria(s) ativa(s) agora${templateNote}. A Iara já usa nas próximas conversas. 🤝\nPara revisar: "Jardes, o que você mudou?"`;
    await logConversation(ownerCustomerId, 'outbound', reply, { source: 'jardes-message' });
    return reply;
  }

  if (!openai) {
    await markApprovalResponded({ id: pendingApproval.id, status: 'rejected', ownerResponse: ownerMessage });
    const reply = '*[JARDES]* Anotado. OpenAI indisponível para ajustar automaticamente — quando quiser, peça nova análise.';
    await logConversation(ownerCustomerId, 'outbound', reply, { source: 'jardes-message' });
    return reply;
  }

  // Owner is making a correction — extract only the proposal content (no metrics footer)
  const issueLines = (pendingApproval.proposalData.issues ?? [])
    .map((issue, i) => `${i + 1}. [${issue.topic}] ${issue.problem} → Proposta: ${issue.improvement_rule}`)
    .join('\n');

  const templateLines = (pendingApproval.proposalData.template_overrides ?? [])
    .map(t => `• ${t.template_key}: "${t.new_text}" (motivo: ${t.reason})`)
    .join('\n');

  const proposalSummary = [
    issueLines,
    templateLines ? `Templates:\n${templateLines}` : '',
  ].filter(Boolean).join('\n\n') || 'Sem melhorias específicas registradas.';

  const correctionPrompt = `Você é Jardes. Você propôs estas melhorias para a Iara:

${proposalSummary}

O Felipe respondeu:
"${ownerMessage}"

Interprete como ajustes às propostas. Gere as regras finais consolidadas.
Retorne APENAS JSON válido:
{
  "adjusted_rules": [
    { "topic": "identificador_snake_case", "description": "o que foi ajustado", "rule": "regra final para a Iara" }
  ],
  "confirmation_message": "confirmação direta do que foi aplicado (máx 2 linhas)"
}`;

  try {
    const response = await openai.chat.completions.create({
      model: config.openAiAgentModel,
      messages: [{ role: 'user', content: correctionPrompt }],
      max_tokens: 800, temperature: 0.2,
      response_format: { type: 'json_object' },
    });
    const content = response.choices[0]?.message?.content ?? '{}';
    const adjusted = JSON.parse(content) as {
      adjusted_rules?: Array<{ topic: string; description: string; rule: string }>;
      confirmation_message?: string;
    };
    for (const rule of (adjusted.adjusted_rules ?? [])) {
      await applyKnowledgeEntry(rule);
    }
    await markApprovalResponded({ id: pendingApproval.id, status: 'applied', ownerResponse: ownerMessage });
    const reply = `*[JARDES]* ${adjusted.confirmation_message ?? 'Entendido, ajustes aplicados. 🤝'}`;
    await logConversation(ownerCustomerId, 'outbound', reply, { source: 'jardes-message' });
    return reply;
  } catch {
    await markApprovalResponded({ id: pendingApproval.id, status: 'applied', ownerResponse: ownerMessage });
    const reply = '*[JARDES]* Entendido e anotado. Ajustado conforme sua instrução.';
    await logConversation(ownerCustomerId, 'outbound', reply, { source: 'jardes-message' });
    return reply;
  }
}

// ─── Command sub-handlers ─────────────────────────────────────────────────────
// Each returns a string reply or null (= not my command, try next handler).
// All replies already include the *[JARDES]* prefix.

async function tryBroadcastCommand(normalized: string, rawCommand: string, ownerCustomerId: string): Promise<string | null> {
  const isBroadcast =
    (/\b(boa\s+tarde|bom\s+dia|boa\s+noite)\b/i.test(normalized) && /\b(clientes?|todos|base|todo\s+mundo|geral)\b/i.test(normalized)) ||
    (/\b(mande?|envia?r?|dispara?r?)\b/i.test(normalized) && /\b(boa\s+tarde|bom\s+dia|boa\s+noite)\b/i.test(normalized) && /\b(agora|já|logo|sim|confirmo)\b/i.test(normalized)) ||
    /\bbroadcast\b/i.test(normalized);

  if (!isBroadcast) return null;

  const hour = Number(new Date().toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: 'America/Sao_Paulo' }));
  const greeting = hour < 12 ? 'Bom dia' : hour < 18 ? 'Boa tarde' : 'Boa noite';
  const defaultMsg = `${greeting}, {nome}! 👋 Passando pra saber se posso te ajudar com algo hoje. Sua Iara está aqui!`;

  const preview = `*[JARDES]* Disparando ${greeting.toLowerCase()} para todos os clientes ativos na janela 24h... ⏳`;
  await logConversation(ownerCustomerId, 'outbound', preview, { source: 'jardes-message' });

  const result = await broadcastGreeting(defaultMsg);
  return `*[JARDES]* Broadcast concluído.\n• Enviadas: ${result.sent}\n• Fora da janela: ${result.skipped}\n• Falhas: ${result.failed}`;
}

async function cmdAnalysis(ownerCustomerId: string): Promise<string> {
  const result = await runJardesAnalysis({ sinceHours: 6, forceRun: true });
  if (result.conversationsReviewed === 0) {
    return '*[JARDES]* Análise concluída: sem conversas de clientes para revisar.';
  }
  if (result.issuesFound === 0) {
    return `*[JARDES]* ${result.conversationsReviewed} conversa(s) revisada(s). Iara respondendo bem, nenhum ponto crítico. 👍`;
  }
  return `*[JARDES]* ${result.conversationsReviewed} conversa(s) revisada(s), ${result.issuesFound} ponto(s) identificado(s). Proposta enviada acima — aguardo sua decisão.`;
}

async function cmdStatus(ownerCustomerId: string): Promise<string> {
  const [entries, pending, monitors] = await Promise.all([
    getActiveKnowledgeEntries(),
    getAwaitingApproval(),
    getOwnerActiveMonitors(ownerCustomerId),
  ]);

  const parts: string[] = ['*[JARDES]* Status atual:'];

  if (entries.length === 0) {
    parts.push('• Base de conhecimento: vazia (sem melhorias aplicadas)');
  } else {
    const lines = entries.slice(0, 8).map((e, i) => `  ${i + 1}. *${e.topic}*: ${e.description}`);
    parts.push(`• Melhorias ativas (${entries.length} total):\n${lines.join('\n')}`);
  }

  if (pending) {
    const issuesCount = pending.proposalData.issues?.length ?? 0;
    const templatesCount = pending.proposalData.template_overrides?.length ?? 0;
    parts.push(`• ⏳ Proposta pendente: ${issuesCount} melhoria(s) + ${templatesCount} template(s) aguardando aprovação`);
  } else {
    parts.push('• Sem propostas pendentes');
  }

  if (monitors.length > 0) {
    parts.push(`• 👁️ Monitores ativos: ${monitors.map(m => m.customerPhone).join(', ')}`);
  }

  return parts.join('\n');
}

async function cmdPending(ownerCustomerId: string): Promise<string> {
  const [pending, monitors] = await Promise.all([
    getAwaitingApproval(),
    getOwnerActiveMonitors(ownerCustomerId),
  ]);

  if (!pending && monitors.length === 0) {
    return '*[JARDES]* Nada pendente. Tudo em dia.';
  }

  const parts: string[] = ['*[JARDES]* O que está pendente:'];

  if (pending) {
    const issues = pending.proposalData.issues ?? [];
    const templates = pending.proposalData.template_overrides ?? [];
    const age = Math.round((Date.now() - new Date(pending.createdAt).getTime()) / 60000);
    parts.push(
      `\n📋 *Proposta de melhoria* (há ${age} min)`,
      `${issues.length} regra(s) + ${templates.length} template(s) para a Iara.`,
      issues.slice(0, 3).map((i, n) => `  ${n + 1}. ${i.topic}: ${i.problem}`).join('\n'),
      issues.length > 3 ? `  ... e mais ${issues.length - 3} item(s)` : '',
      '\nResponda *sim* (aplica tudo), *não* (rejeita), ou *item N: [ajuste]* para corrigir.'
    );
  }

  if (monitors.length > 0) {
    parts.push(
      `\n👁️ *Monitores ativos* (${monitors.length}):`,
      monitors.map(m => `  • ${m.customerPhone}${m.autoCorrect ? ' [autocorreção ON]' : ''}`).join('\n')
    );
  }

  return parts.filter(Boolean).join('\n');
}

async function cmdMonitorStatus(ownerCustomerId: string, openai: OpenAI | null): Promise<string> {
  const [monitors, recentLogs] = await Promise.all([
    getOwnerActiveMonitors(ownerCustomerId),
    getRecentMonitorLogs(ownerCustomerId, 120),
  ]);

  if (monitors.length === 0) {
    return '*[JARDES]* Nenhum monitor ativo. Para iniciar: "Jardes, monitora a conversa com +55 XX XXXXX-XXXX".';
  }

  const monitorList = monitors.map(m =>
    `${m.customerPhone}${m.autoCorrect ? ' (autocorreção ON)' : ''}`
  ).join(', ');

  if (recentLogs.length === 0) {
    return `*[JARDES]* Monitor ativo para: ${monitorList}.\nNenhuma troca de mensagens detectada ainda nesta sessão.`;
  }

  if (!openai) {
    return `*[JARDES]* Monitor ativo: ${monitorList}.\n\nÚltimas notificações:\n${recentLogs.slice(0, 5).join('\n')}`;
  }

  const logsText = recentLogs.slice(0, 20).join('\n');
  const summaryResp = await openai.chat.completions.create({
    model: config.openAiAgentModel,
    messages: [
      {
        role: 'system',
        content: 'Você é Jardes. Resuma em pt-BR, de forma executiva, as notificações de monitoramento abaixo. Destaque: quantas trocas aconteceram, se a Iara respondeu bem, qualquer problema detectado. Máximo 4 linhas.',
      },
      { role: 'user', content: `Monitor de: ${monitorList}\n\n${logsText}` },
    ],
    max_tokens: 300, temperature: 0.3,
  });

  const summary = summaryResp.choices[0]?.message?.content?.trim() ?? 'Não consegui sumarizar.';
  return `*[JARDES]* ${summary}`;
}

async function tryTemplateCommand(
  normalized: string, cleanCommand: string, ownerCustomerId: string
): Promise<string | null> {
  // List templates
  if (/\b(template|templates|modelo|modelos)\b/i.test(normalized) && /\b(mostra|lista|ver|quais|status)\b/i.test(normalized)) {
    const overrides = await listTemplateOverrides();
    const defaults = [
      { key: 'confirm-transaction-ask', default: 'Só para confirmar: você quer que eu registre {amount}{category}?' },
      { key: 'confirm-transaction-hint', default: 'Se sim, me manda: "anota esse gasto".\nSe era só dúvida, me fala: "era pergunta".' },
      { key: 'spending-limit-ok', default: 'Fechou! ✅ Limite {period} definido em {amount}.\nVou te avisar quando estiver perto.' },
      { key: 'register-transaction-ok', default: 'Anotado! ✅ {action} de {amount} em {category}. Data: {dateLabel}. Horário: {timeLabel}.' },
    ];
    const overrideMap = new Map(overrides.map(o => [o.key, o.text]));
    const lines = defaults.map(t => {
      const active = overrideMap.get(t.key);
      return `• *${t.key}*\n  ${active ? `Override ativo: "${active.slice(0, 60)}${active.length > 60 ? '...' : ''}"` : `Padrão: "${t.default.slice(0, 60)}${t.default.length > 60 ? '...' : ''}"`}`;
    });
    return `*[JARDES]* Templates da Iara:\n\n${lines.join('\n\n')}\n\nPara mudar: "Jardes, muda o template <chave>: novo texto"`;
  }

  // Set template
  if (/\b(muda|altera|altere|define|atualiza|set)\b.{0,30}\btemplate\b/i.test(normalized)) {
    const m = cleanCommand.match(/template\s+([a-z][a-z0-9\-_]+)\s*[:\-]\s*(.+)/is);
    if (!m) return '*[JARDES]* Formato: "Jardes, muda o template <chave>: novo texto"\nChaves: confirm-transaction-ask, confirm-transaction-hint, spending-limit-ok, register-transaction-ok';
    const [, tKey, tText] = m;
    await setTemplateOverride(tKey.trim(), tText.trim());
    return `*[JARDES]* Template *${tKey.trim()}* atualizado. Iara já usa o novo texto.`;
  }

  // Reset template
  if (/\b(reseta|reset|remove|apaga|volta ao padrão|padrão)\b.{0,30}\btemplate\b/i.test(normalized)) {
    const m = cleanCommand.match(/template\s+([a-z][a-z0-9\-_]+)/i);
    if (!m) return '*[JARDES]* Qual template resetar? Ex: "Jardes, reseta o template confirm-transaction-ask"';
    const tKey = m[1].trim();
    const removed = await deactivateTemplateOverride(tKey);
    return removed
      ? `*[JARDES]* Template *${tKey}* resetado. Iara voltou ao texto padrão.`
      : `*[JARDES]* Não encontrei override ativo para o template *${tKey}*.`;
  }

  // List outbound (manual send) templates
  if (/\b(lista|listar|mostra|mostrar|ver)\b.{0,30}\btemplates?\b.{0,20}\b(envio|mensagem)\b/i.test(normalized)) {
    const templates = await listOutboundTemplates();
    if (templates.length === 0) return '*[JARDES]* Nenhum template de envio cadastrado.';
    const lines = templates.map(t => `• *${t.key}*: "${t.text.slice(0, 90)}${t.text.length > 90 ? '...' : ''}"`);
    return `*[JARDES]* Templates de envio:\n\n${lines.join('\n')}`;
  }

  // Create outbound template
  if (/\b(cria|criar|salva|salvar|define|definir)\b.{0,30}\btemplate\b.{0,20}\b(envio|mensagem)?\b/i.test(normalized)) {
    const m = cleanCommand.match(/template\s+([a-z0-9][a-z0-9\-_]+)\s*[:\-]\s*(.+)/is);
    if (!m) return '*[JARDES]* Formato: "Jardes, cria template <chave>: <mensagem>"';
    const [, key, text] = m;
    await setOutboundTemplate(key.trim().toLowerCase(), text.trim());
    return `*[JARDES]* Template de envio *${key.trim().toLowerCase()}* salvo.`;
  }

  return null;
}

async function tryMonitorControlCommand(
  normalized: string, cleanCommand: string, ownerCustomerId: string
): Promise<string | null> {
  const isStop =
    /\b(para|pare|stop|cancela|cancele|encerra|encerre)\b/i.test(normalized) &&
    /\b(monitor|monitoramento|monitorar|acompanhar|acompanhamento)\b/i.test(normalized);

  const isStart =
    /\b(monitora|monitore|acompanha|acompanhe|observa|observe|vigila|vigie|fique de olho)\b/i.test(normalized) &&
    /\b(conversa|iara|cliente|número|numero)\b/i.test(normalized);

  const isAutoCorrect =
    /\b(não deixa|nao deixa|não permita|nao permita|corrige|corrija|autocorrige|auto.corrij)\b/i.test(normalized) &&
    /\b(besteira|erro|errado|falar errado|resposta errada)\b/i.test(normalized);

  if (!isStop && !isStart && !isAutoCorrect) return null;

  const phoneExtract =
    cleanCommand.match(/(\+?55[\s\-]?\d{2}[\s\-]?\d{4,5}[\s\-]?\d{4})/) ??
    cleanCommand.match(/\b(\d{2}[\s\-]?\d{4,5}[\s\-]?\d{4})\b/) ??
    cleanCommand.match(/\b(\d{10,13})\b/);

  if (isStop) {
    if (!phoneExtract) return '*[JARDES]* Me passa o número para encerrar o monitoramento.';
    const digits = phoneExtract[0].replace(/\D/g, '');
    const phone = digits.startsWith('55') ? `+${digits}` : `+55${digits}`;
    await stopJardesMonitor(phone);
    return `*[JARDES]* Monitoramento de ${phone} encerrado.`;
  }

  if (!phoneExtract) {
    return `*[JARDES]* Me passa o número que eu monitoro. Ex: "Jardes, monitora a conversa com +55 21 98676-4614"`;
  }

  const rawDigits = phoneExtract[0].replace(/\D/g, '');
  const monPhone = rawDigits.startsWith('55') ? `+${rawDigits}` : `+55${rawDigits}`;
  const autoCorrect = isAutoCorrect ||
    /\b(não deixa|nao deixa|nao permita|não permita|corrige|corrija|autocorrige)\b/i.test(normalized) ||
    /\b(besteira|erro|falar errado)\b/i.test(normalized);

  await startJardesMonitor({ customerPhone: monPhone, ownerCustomerId, autoCorrect });

  return autoCorrect
    ? `*[JARDES]* Monitorando ${monPhone} com autocorreção ativada. Se a Iara errar, eu corrijo e aviso você. ⚡`
    : `*[JARDES]* Monitorando a conversa de ${monPhone}. Vou te reportar aqui o que a Iara estiver respondendo. 👁️`;
}

async function tryRuleCommand(
  normalized: string, cleanCommand: string, ownerCustomerId: string
): Promise<string | null> {
  // Single-word "regras" → status (avoid clashing with conversation lookups)
  const isRuleStatus =
    /\bregras?\s*(ativas?|cadastradas?|lista|ativas)?\b/i.test(normalized) &&
    !/conversa|cliente|número/i.test(normalized);

  if (isRuleStatus) {
    const rules = await getActiveJardesRules();
    if (rules.length === 0) return '*[JARDES]* Nenhuma regra de interceptação ativa.';
    const lines = rules.map((r, i) =>
      `${i + 1}. [${r.ruleType.toUpperCase()}] *${r.topic}*\n   ${r.instruction.slice(0, 80)}${r.instruction.length > 80 ? '...' : ''}`
    );
    return `*[JARDES]* Regras de interceptação ativas (${rules.length}):\n\n${lines.join('\n\n')}`;
  }

  // List all rules (explicit list)
  if (/\b(regras?|bloqueios?|restrições?)\b/i.test(normalized) && /\b(ativas?|lista|listar|quais|mostra|ver|status)\b/i.test(normalized)) {
    const rules = await listJardesRules();
    if (rules.length === 0) return '*[JARDES]* Nenhuma regra cadastrada. Use "Jardes, bloqueia [tópico]" para criar.';
    const lines = rules.map(r =>
      `${r.isActive ? '🟢' : '🔴'} *${r.topic}* (${r.ruleType}): ${r.instruction.slice(0, 80)}${r.instruction.length > 80 ? '...' : ''}`
    );
    return `*[JARDES]* Regras cadastradas:\n\n${lines.join('\n')}`;
  }

  // Block topic
  if (/\b(bloqueia|bloquear|bloqueie|block|bane|ban|proibe|proibir|proíbe)\b/i.test(normalized)) {
    const m = cleanCommand.match(/(?:bloqueia|bloquear|bloqueie|block|bane|ban|proibe|proibir|proíbe)\s+(.+)/i);
    if (!m) return '*[JARDES]* Me diz o que bloquear. Ex: "Jardes, bloqueia open finance"';
    const topicRaw = m[1].trim();
    const topicKey = topicRaw.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
    const autoPattern = topicRaw.split(/\s+/).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.?');
    await upsertJardesRule({
      ruleType: 'block', topic: topicKey, pattern: autoPattern,
      instruction: `Não mencione ${topicRaw}. Diga que é um recurso em desenvolvimento que será lançado em breve.`,
      replacement: null,
    });
    return `*[JARDES]* Regra de bloqueio criada para *${topicKey}*. Iara não menciona mais esse tópico.`;
  }

  // Allow/Remove rule
  if (/\b(libera|liberar|libere|permite|permitir|permita|remove\s+regra|remove\s+bloqueio)\b/i.test(normalized)) {
    const m = cleanCommand.match(/(?:libera|liberar|libere|permite|permitir|permita|remove\s+regra|remove\s+bloqueio)\s+(.+)/i);
    if (!m) return '*[JARDES]* Me diz qual regra liberar. Ex: "Jardes, libera open_finance"';
    const topicKey = m[1].trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
    const removed = await deactivateJardesRule(topicKey);
    return removed
      ? `*[JARDES]* Regra *${topicKey}* desativada. Iara pode mencionar esse tópico normalmente.`
      : `*[JARDES]* Não encontrei regra ativa para *${topicKey}*.`;
  }

  return null;
}

async function tryManualSendCommand(
  normalized: string, cleanCommand: string, ownerCustomerId: string
): Promise<string | null> {
  const manualSendIntent =
    /\biara\b/i.test(normalized) &&
    /\b(manda|mandar|envia|enviar|dispara|disparar|chama|chamar)\b/i.test(normalized) &&
    /\b(mensagem|msg|n[úu]mero|contato|whatsapp)\b/i.test(normalized);

  const phoneMatch =
    cleanCommand.match(/\b(\d{2}[\s\-]?\d{4,5}[\s\-]?\d{4})\b/) ??
    cleanCommand.match(/\b(\d{10,13})\b/);

  if (!manualSendIntent || !phoneMatch) return null;

  const digits = phoneMatch[1].replace(/\D/g, '');
  const to = `+${digits}`;

  if (digits.length < 10 || digits.length > 13) {
    return `*[JARDES]* Número inválido: ${phoneMatch[1]}. Use o formato com DDD: +55 11 95609-0319.`;
  }

  const selectedMessage = extractManualMessageToSend(cleanCommand);
  const selectedTemplateKey = extractOutboundTemplateKey(cleanCommand);
  const templateMessage = selectedTemplateKey ? await getOutboundTemplate(selectedTemplateKey) : null;
  const outboundMessage = selectedMessage ?? templateMessage;

  if (!outboundMessage) {
    return `*[JARDES]* Me passe a mensagem exata.\nFormato: "Jardes, manda para ${to} | mensagem: <seu texto>"`;
  }

  const sendResult = await sendWhatsAppText({ to, message: outboundMessage });
  if (!sendResult.sent) {
    return `*[JARDES]* Não consegui enviar para ${to}. Motivo: ${sendResult.error ?? 'falha desconhecida'}.`;
  }
  return `*[JARDES]* Mensagem enviada para ${to} via ${sendResult.provider ?? 'canal padrão'}.\nTexto: "${outboundMessage}"`;
}

async function tryConversationLookupCommand(
  cleanCommand: string,
  normalized: string,
  ownerCustomerId: string,
  openai: OpenAI
): Promise<string | null> {
  // Phone number lookup
  const phoneMatch =
    cleanCommand.match(/\b(\d{2}[\s\-]?\d{4,5}[\s\-]?\d{4})\b/) ??
    cleanCommand.match(/\b(\d{10,13})\b/);

  if (phoneMatch) {
    const convData = await lookupConversationsByPhone(phoneMatch[1]);
    if (!convData) return `*[JARDES]* Não encontrei conversas para o número ${phoneMatch[1]}.`;
    const convText = formatConversationForAnalysis(convData.messages);
    const resp = await openai.chat.completions.create({
      model: config.openAiAgentModel,
      messages: [
        { role: 'system', content: `Você é Jardes — analista da Iara Bot. Analise a conversa abaixo e responda o que o Felipe pediu. Seja direto e executivo, em português.` },
        { role: 'user', content: `${cleanCommand}\n\nConversa de ${convData.customerName ?? 'anônimo'} (${convData.whatsappNumber}):\n${convText}` },
      ],
      max_tokens: 800, temperature: 0.4,
    });
    return `*[JARDES]* ${resp.choices[0]?.message?.content?.trim() ?? 'Não consegui analisar.'}`;
  }

  // "última conversa" / "conversa mais recente"
  const isLastConvQuery = /\b(última\s+conversa|conversa\s+mais\s+recente|último\s+cliente|cliente\s+mais\s+recente|último\s+contato)\b/i.test(normalized);
  if (isLastConvQuery) {
    const lastConv = await lookupLastConversation();
    if (!lastConv) return `*[JARDES]* Não encontrei conversas recentes de clientes.`;
    const convText = formatConversationForAnalysis(lastConv.messages);
    const resp = await openai.chat.completions.create({
      model: config.openAiAgentModel,
      messages: [
        { role: 'system', content: `Você é Jardes. Analise a conversa mais recente de cliente. Destaque: o cliente conseguiu o que queria? A Iara respondeu bem? Algum problema identificado? Português executivo.` },
        { role: 'user', content: `Última conversa: ${lastConv.customerName ?? 'anônimo'} (${lastConv.whatsappNumber})\n\n${convText}` },
      ],
      max_tokens: 600, temperature: 0.4,
    });
    return `*[JARDES]* ${resp.choices[0]?.message?.content?.trim() ?? 'Não consegui analisar.'}`;
  }

  // Name / anon lookup
  const needsConvLookup =
    /\b(conversa|mensagem|resposta|anon|an[oô]nim|cliente|contato|ver|veja|mostrar|olha|olhe)\b/i.test(normalized) &&
    !/^(faz|fazer|analisa|analise)/i.test(normalized);

  if (needsConvLookup) {
    const convList = await lookupConversationsByQuery(cleanCommand);
    if (convList.length === 0) return `*[JARDES]* Não encontrei conversas para "${cleanCommand.slice(0, 60)}".`;
    const allText = convList.map(c => {
      const label = c.customerName ?? c.whatsappNumber;
      return `--- ${label} ---\n${formatConversationForAnalysis(c.messages)}`;
    }).join('\n\n');
    const resp = await openai.chat.completions.create({
      model: config.openAiAgentModel,
      messages: [
        { role: 'system', content: `Você é Jardes. Analise a(s) conversa(s) abaixo e responda o que o Felipe pediu. Identifique problemas e sugira correção se houver. Português executivo.` },
        { role: 'user', content: `${cleanCommand}\n\n${allText}` },
      ],
      max_tokens: 1000, temperature: 0.4,
    });
    return `*[JARDES]* ${resp.choices[0]?.message?.content?.trim() ?? 'Não consegui analisar.'}`;
  }

  return null;
}

async function cmdFallback(
  cleanCommand: string,
  rawMessage: string,
  ownerCustomerId: string,
  openai: OpenAI
): Promise<string> {
  const ctx = await buildOwnerContext(ownerCustomerId);

  const contextSection = [
    'DADOS DO SISTEMA (agora):',
    ctx.businessCtx,
    ctx.knowledgeCtx,
    ctx.pendingSummary,
    ctx.monitorSummary,
  ].filter(Boolean).join('\n');

  const systemPrompt = `Você é Jardes — braço direito executivo do Felipe, fundador do Iara Bot.

PERSONALIDADE: Direto, confiante, humano. Sem enrolação, sem confirmações desnecessárias.
Quando o Felipe perguntar, responda. Quando pedir análise, analise. Máximo 3 parágrafos.

CAPACIDADES (só prometa o que entregará nesta mensagem):
• Responder perguntas sobre o negócio, dados do sistema, stack, planos
• Analisar conversas de clientes: "Jardes, veja a conversa de X"
• Disparar análise de qualidade: "Jardes, faz a análise"
• Monitorar conversas em tempo real: "Jardes, monitora X"
• Gerenciar regras de bloqueio/reescrita da Iara
• Fazer broadcast de saudações
• Mostrar/atualizar templates de resposta

NÃO PROMETA ações que não consegue executar nesta resposta.

${contextSection}

Hoje: ${todayBrasilia()}, ${nowBrasilia()} (Brasília)`;

  // Filter out the current message from history to avoid duplication
  const historyMessages = ctx.history.filter(h =>
    !(h.role === 'user' && (h.content === cleanCommand || h.content === rawMessage))
  );

  const response = await openai.chat.completions.create({
    model: config.openAiAgentModel,
    messages: [
      { role: 'system', content: systemPrompt },
      ...historyMessages,
      { role: 'user', content: cleanCommand || rawMessage },
    ],
    max_tokens: 1000, temperature: 0.65,
  });

  const text = response.choices[0]?.message?.content?.trim() ?? 'Não consegui processar agora.';
  return `*[JARDES]* ${text}`;
}

// ─── Main command router ──────────────────────────────────────────────────────

export async function handleJardesDirectCommand(params: {
  rawMessage: string;
  ownerCustomerId: string;
}): Promise<string> {
  const { rawMessage, ownerCustomerId } = params;
  const cleanCommand = rawMessage.replace(/^jard[aes]s?\s*[,:]?\s*/i, '').trim();
  const normalized = cleanCommand.toLowerCase();

  let reply: string;

  try {
    // 1 · Broadcast
    const broadcast = await tryBroadcastCommand(normalized, cleanCommand, ownerCustomerId);
    if (broadcast !== null) {
      reply = broadcast;
      await logConversation(ownerCustomerId, 'outbound', reply, { source: 'jardes-message' });
      return reply;
    }

    // 2 · Trigger analysis
    if (
      /^(faz|fazer|rodar|roda|executa|executar|inicia|iniciar|dispara?r?|force?)?\s*(a\s+)?(análise|analise|analisa)/i.test(cleanCommand) ||
      normalized === 'análise' || normalized === 'analise'
    ) {
      reply = await cmdAnalysis(ownerCustomerId);
      await logConversation(ownerCustomerId, 'outbound', reply, { source: 'jardes-message' });
      return reply;
    }

    // 3 · Status / o que mudou
    if (/\b(o\s+que\s+(você|vc)\s+(mudou|fez|aplic|melhorou)|status\s*$)\b/i.test(normalized)) {
      reply = await cmdStatus(ownerCustomerId);
      await logConversation(ownerCustomerId, 'outbound', reply, { source: 'jardes-message' });
      return reply;
    }

    // 4 · Pending check
    if (/\b(pendente|pending|tem\s+(algo|alguma\s+coisa)\s+pendente|o\s+que\s+est[aá]\s+pendente|proposta\s+pendente)\b/i.test(normalized)) {
      reply = await cmdPending(ownerCustomerId);
      await logConversation(ownerCustomerId, 'outbound', reply, { source: 'jardes-message' });
      return reply;
    }

    // 5 · Monitor status ("como está indo?", "me atualiza", "novidades?")
    const isStatusQuery =
      /\b(como\s+est[aá]\s+(indo|sendo|acontecendo)|me\s+atualiza|o\s+que\s+(est[aá]\s+(acontecendo|rolando)|rolou|aconteceu)|novidades|me\s+atualiza\s*$|atualiza\s+me)\b/i.test(normalized);

    if (isStatusQuery) {
      const openai = mkOpenAI();
      reply = await cmdMonitorStatus(ownerCustomerId, openai);
      await logConversation(ownerCustomerId, 'outbound', reply, { source: 'jardes-message' });
      return reply;
    }

    // 6 · Template management
    const tmplResult = await tryTemplateCommand(normalized, cleanCommand, ownerCustomerId);
    if (tmplResult !== null) {
      reply = tmplResult;
      await logConversation(ownerCustomerId, 'outbound', reply, { source: 'jardes-message' });
      return reply;
    }

    // 7 · Monitor control (start / stop)
    const monitorResult = await tryMonitorControlCommand(normalized, cleanCommand, ownerCustomerId);
    if (monitorResult !== null) {
      reply = monitorResult;
      await logConversation(ownerCustomerId, 'outbound', reply, { source: 'jardes-message' });
      return reply;
    }

    // 8 · Rule management (block / allow / list)
    const ruleResult = await tryRuleCommand(normalized, cleanCommand, ownerCustomerId);
    if (ruleResult !== null) {
      reply = ruleResult;
      await logConversation(ownerCustomerId, 'outbound', reply, { source: 'jardes-message' });
      return reply;
    }

    // OpenAI required for remaining commands
    const openai = mkOpenAI();
    if (!openai) {
      reply = '*[JARDES]* OpenAI não configurada. Não consigo processar esse comando.';
      await logConversation(ownerCustomerId, 'outbound', reply, { source: 'jardes-message' });
      return reply;
    }

    // 9 · Manual send via Iara
    const sendResult = await tryManualSendCommand(normalized, cleanCommand, ownerCustomerId);
    if (sendResult !== null) {
      reply = sendResult;
      await logConversation(ownerCustomerId, 'outbound', reply, { source: 'jardes-message' });
      return reply;
    }

    // 10 · Conversation lookup (phone / name / last)
    const lookupResult = await tryConversationLookupCommand(cleanCommand, normalized, ownerCustomerId, openai);
    if (lookupResult !== null) {
      reply = lookupResult;
      await logConversation(ownerCustomerId, 'outbound', reply, { source: 'jardes-message' });
      return reply;
    }

    // 11 · GPT fallback (with full context)
    reply = await cmdFallback(cleanCommand, rawMessage, ownerCustomerId, openai);
  } catch (error) {
    reply = `*[JARDES]* Erro ao processar: ${error instanceof Error ? error.message : 'erro desconhecido'}`;
  }

  await logConversation(ownerCustomerId, 'outbound', reply, { source: 'jardes-message' });
  return reply;
}

// ─── Interceptor ─────────────────────────────────────────────────────────────

export async function runJardesInterceptor(params: {
  customerPhone: string;
  customerMessage: string;
  candidateResponse: string;
  isOwnerMode: boolean;
}): Promise<{ finalResponse: string; wasModified: boolean; reason?: string }> {
  if (params.isOwnerMode) return { finalResponse: params.candidateResponse, wasModified: false };

  try {
    const [rules, monitor] = await Promise.all([
      getActiveJardesRules(),
      getActiveJardesMonitor(params.customerPhone),
    ]);

    const openai = mkOpenAI();

    // 1 · Block / rewrite rules (always active, all customers)
    for (const rule of rules) {
      if (rule.ruleType !== 'block' && rule.ruleType !== 'rewrite') continue;

      let violated = false;
      if (rule.pattern) {
        try { violated = new RegExp(rule.pattern, 'i').test(params.candidateResponse); }
        catch { violated = false; }
      } else {
        violated = true;
      }
      if (!violated) continue;

      if (rule.replacement) {
        void notifyOwnerOfCorrection(params.customerPhone, params.candidateResponse, rule.replacement, rule.topic, monitor?.ownerCustomerId);
        return { finalResponse: rule.replacement, wasModified: true, reason: rule.topic };
      }

      if (!openai) {
        const fallback = `Esse recurso ainda está em desenvolvimento e será lançado em breve! Posso te ajudar com algo mais?`;
        void notifyOwnerOfCorrection(params.customerPhone, params.candidateResponse, fallback, rule.topic, monitor?.ownerCustomerId);
        return { finalResponse: fallback, wasModified: true, reason: rule.topic };
      }

      const rewriteResult = await Promise.race([
        openai.chat.completions.create({
          model: config.openAiAgentModel,
          messages: [
            { role: 'system', content: 'Você reescreve respostas de chatbot seguindo instruções. Retorne APENAS a resposta reescrita, sem comentários, em pt-BR.' },
            { role: 'user', content: `Instrução: ${rule.instruction}\n\nResposta original:\n"${params.candidateResponse}"\n\nMensagem do cliente: "${params.customerMessage}"\n\nReescreva mantendo tom amigável e natural.` },
          ],
          max_tokens: 500, temperature: 0.3,
        }),
        new Promise<null>(resolve => setTimeout(() => resolve(null), 700)),
      ]);

      const rewritten = rewriteResult
        ? (rewriteResult.choices[0]?.message?.content?.trim() ?? params.candidateResponse)
        : `Esse recurso ainda está em desenvolvimento e será lançado em breve! Posso te ajudar com algo mais?`;

      void notifyOwnerOfCorrection(params.customerPhone, params.candidateResponse, rewritten, rule.topic, monitor?.ownerCustomerId);
      return { finalResponse: rewritten, wasModified: true, reason: rule.topic };
    }

    // 2 · Quality check (only when monitor is active for this number)
    if (monitor && openai) {
      const qualityResult = await Promise.race([
        openai.chat.completions.create({
          model: config.openAiAgentModel,
          messages: [
            {
              role: 'system',
              content: `Você é Jardes, supervisor de qualidade da Iara Bot. Analise se a resposta da Iara está correta.
Responda SOMENTE JSON: { "ok": true } ou { "ok": false, "correction": "resposta corrigida completa em pt-BR" }
Erro = informação factualmente errada, valor de plano inventado, funcionalidade inexistente afirmada.
Variações de estilo, respostas curtas ou incompletas mas corretas = { "ok": true }.`,
            },
            { role: 'user', content: `Cliente: "${params.customerMessage}"\nIara: "${params.candidateResponse}"` },
          ],
          max_tokens: 400, temperature: 0.1,
        }),
        new Promise<null>(resolve => setTimeout(() => resolve(null), 600)),
      ]);

      if (qualityResult) {
        try {
          const raw = qualityResult.choices[0]?.message?.content?.trim() ?? '';
          const jsonStr = raw.match(/\{[\s\S]*\}/)?.[0] ?? raw;
          const parsed = JSON.parse(jsonStr) as { ok: boolean; correction?: string };
          if (!parsed.ok && parsed.correction) {
            void notifyOwnerOfCorrection(params.customerPhone, params.candidateResponse, parsed.correction, 'quality_check', monitor.ownerCustomerId);
            return { finalResponse: parsed.correction, wasModified: true, reason: 'quality_check' };
          }
        } catch { /* pass without modifying */ }
      }

      // Notify owner when monitor is ok (logged as automated so it doesn't affect Jardes mode)
      void sendJardesMessage(
        `👁️ Monitor ${params.customerPhone}:\nCliente: "${params.customerMessage.slice(0, 100)}"\nIara: "${params.candidateResponse.slice(0, 150)}" ✅`,
        monitor.ownerCustomerId,
        true
      );
    }

    return { finalResponse: params.candidateResponse, wasModified: false };
  } catch {
    return { finalResponse: params.candidateResponse, wasModified: false };
  }
}

async function notifyOwnerOfCorrection(
  customerPhone: string,
  original: string,
  corrected: string,
  reason: string,
  ownerCustomerId?: string
): Promise<void> {
  try {
    const notification = [
      `Corrigi uma resposta para ${customerPhone} (regra: ${reason}):`,
      `❌ Original: "${original.slice(0, 150)}${original.length > 150 ? '...' : ''}"`,
      `✅ Corrigida: "${corrected.slice(0, 150)}${corrected.length > 150 ? '...' : ''}"`,
    ].join('\n');

    const ownerCid = ownerCustomerId ?? (await getOwnerCustomerId() ?? undefined);
    await sendJardesMessage(notification, ownerCid, true);
  } catch {
    // não bloqueia o fluxo principal
  }
}

// ─── Broadcast ────────────────────────────────────────────────────────────────

async function broadcastGreeting(message: string): Promise<{ sent: number; skipped: number; failed: number }> {
  const result = await pool.query<{ id: string; name: string | null; whatsapp_number: string }>(
    `SELECT id, name, whatsapp_number FROM customers WHERE is_active = true ORDER BY last_inbound_at DESC NULLS LAST`
  );

  let sent = 0, skipped = 0, failed = 0;

  for (const customer of result.rows) {
    const firstName = customer.name?.split(' ')[0] ?? null;
    const personalised = firstName
      ? message.replace('{nome}', firstName)
      : message.replace(', {nome}', '').replace('{nome}', '');

    const outcome = await sendWhatsAppText({ to: customer.whatsapp_number, message: personalised });
    if (outcome.sent) { sent++; }
    else if (outcome.error === 'customer_outside_window_no_template') { skipped++; }
    else { failed++; }

    await new Promise(r => setTimeout(r, 300));
  }

  return { sent, skipped, failed };
}

// ─── Daily doubt digest ───────────────────────────────────────────────────────

export async function sendDailyDoubtDigest(): Promise<{ sent: boolean; doubtCount: number }> {
  const doubts = await getPendingIaraDoubts();
  if (doubts.length === 0) return { sent: false, doubtCount: 0 };

  const ownerNumbers = config.ownerWhatsappNumbers;
  if (!ownerNumbers || ownerNumbers.length === 0) return { sent: false, doubtCount: 0 };

  const lines: string[] = [
    `Felipe, aqui estão minhas dúvidas de hoje (${doubts.length} situação${doubts.length > 1 ? 'ões' : ''} que não soube resolver bem):`,
  ];

  doubts.forEach((doubt, i) => {
    lines.push('');
    lines.push(`*${i + 1}.* Quando o cliente perguntou:`);
    lines.push(`"${doubt.originalMessage}"`);

    if (doubt.iaraResponse) {
      lines.push(`Eu respondi:`);
      lines.push(`"${doubt.iaraResponse.slice(0, 200)}${doubt.iaraResponse.length > 200 ? '...' : ''}"`);
      lines.push(`Essa foi a resposta certa? Se não, o que devo responder?`);
    } else {
      lines.push(`Não soube responder. O que devo dizer nessa situação?`);
    }
  });

  lines.push('');
  lines.push('Pode responder mensagem por mensagem e eu vou aprender com suas correções. 🙏');

  const message = lines.join('\n');

  for (const number of ownerNumbers) {
    try { await sendWhatsAppText({ to: number, message }); }
    catch { /* ignora falha em número individual */ }
  }

  await markIaraDoubtsSent(doubts.map(d => d.id));
  return { sent: true, doubtCount: doubts.length };
}
