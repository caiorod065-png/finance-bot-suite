import OpenAI from 'openai';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { isOwnerWhatsappNumber, logConversation } from './ledger.js';
import { sendWhatsAppText } from './whatsapp-outbound.js';

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

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

// ─────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────

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

// ─────────────────────────────────────────────
// Knowledge base
// ─────────────────────────────────────────────

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
      rule: r.rule, isActive: r.is_active, appliedAt: r.applied_at
    }));
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────
// Template overrides
// ─────────────────────────────────────────────

export async function getTemplateOverride(key: string): Promise<string | null> {
  try {
    const result = await pool.query<{ override_text: string }>(
      `SELECT override_text FROM jardes_template_overrides
       WHERE template_key = $1 AND is_active = TRUE
       LIMIT 1`,
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
      key: r.template_key,
      text: r.override_text,
      description: r.description,
      updatedAt: r.updated_at
    }));
  } catch {
    return [];
  }
}

async function deactivateTemplateOverride(key: string): Promise<boolean> {
  const result = await pool.query<{ id: string }>(
    `UPDATE jardes_template_overrides SET is_active = FALSE, updated_at = NOW()
     WHERE template_key = $1 AND is_active = TRUE
     RETURNING id`,
    [key]
  );
  return (result.rowCount ?? 0) > 0;
}

async function setOutboundTemplate(key: string, text: string): Promise<void> {
  await pool.query(
    `INSERT INTO jardes_outbound_templates (template_key, message_text, is_active, updated_at)
     VALUES ($1, $2, TRUE, NOW())
     ON CONFLICT (template_key) DO UPDATE
       SET message_text = EXCLUDED.message_text,
           is_active = TRUE,
           updated_at = NOW()`,
    [key, text]
  );
}

async function getOutboundTemplate(key: string): Promise<string | null> {
  const result = await pool.query<{ message_text: string }>(
    `SELECT message_text
     FROM jardes_outbound_templates
     WHERE template_key = $1 AND is_active = TRUE
     LIMIT 1`,
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
  return result.rows.map((r) => ({ key: r.template_key, text: r.message_text }));
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

// ─────────────────────────────────────────────
// Pending approvals
// ─────────────────────────────────────────────

export async function getAwaitingApproval(): Promise<PendingApproval | null> {
  try {
    const result = await pool.query<{
      id: string; type: string; message_to_owner: string;
      proposal_data: PendingApproval['proposalData']; status: string; created_at: Date;
    }>(
      `SELECT id, type, message_to_owner, proposal_data, status, created_at
       FROM jardes_pending_approvals
       WHERE status = 'awaiting'
       ORDER BY created_at DESC
       LIMIT 1`
    );
    if (!result.rows[0]) return null;
    const r = result.rows[0];
    return {
      id: r.id,
      type: r.type as PendingApproval['type'],
      messageToOwner: r.message_to_owner,
      proposalData: r.proposal_data,
      status: r.status as PendingApproval['status'],
      createdAt: r.created_at
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
  await pool.query(
    `UPDATE jardes_pending_approvals SET status = 'expired' WHERE status = 'awaiting'`
  );
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

// ─────────────────────────────────────────────
// Owner WhatsApp communication
// ─────────────────────────────────────────────

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
      await logConversation(ownerCustomerId, 'outbound', formatted, { source: 'jardes-message', automated, whatsappSent: result.sent, whatsappError: result.error });
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

// Jardes mode is active if the last non-automated outbound came from Jardes
// AND that message was sent within the last 60 minutes (auto-resets after inactivity).
export async function isJardesModeActive(ownerCustomerId: string): Promise<boolean> {
  try {
    const result = await pool.query<{ source: string | null; created_at: Date }>(
      `SELECT metadata->>'source' AS source, created_at
       FROM conversation_logs
       WHERE customer_id = $1 AND direction = 'outbound'
         AND (metadata->>'automated') IS DISTINCT FROM 'true'
       ORDER BY created_at DESC
       LIMIT 1`,
      [ownerCustomerId]
    );
    if (result.rows[0]?.source !== 'jardes-message') return false;
    const ageMinutes = (Date.now() - new Date(result.rows[0].created_at).getTime()) / 60000;
    return ageMinutes <= 60;
  } catch {
    return false;
  }
}

async function getOwnerCustomerId(): Promise<string | null> {
  const ownerNumbers = config.ownerWhatsappNumbers;
  if (ownerNumbers.length === 0) return null;
  const result = await pool.query<{ id: string }>(
    `SELECT id FROM customers WHERE whatsapp_number = $1 LIMIT 1`,
    [ownerNumbers[0]]
  );
  return result.rows[0]?.id ?? null;
}

// ─────────────────────────────────────────────
// Conversation retrieval for analysis
// ─────────────────────────────────────────────

async function getConversationsForAnalysis(sinceHours: number): Promise<Array<{
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

  // Group by customer, exclude owner
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
    messages: rows.map(r => ({ direction: r.direction, message: r.message.slice(0, 300) }))
  }));
}

// ─────────────────────────────────────────────
// Core analysis
// ─────────────────────────────────────────────

export async function runJardesAnalysis(params: {
  sinceHours?: number;
  forceRun?: boolean;
  automated?: boolean;
} = {}): Promise<{ proposalsSent: number; issuesFound: number; conversationsReviewed: number }> {
  await ensureJardesSchema();

  const sinceHours = params.sinceHours ?? 6;
  const automated = params.automated ?? false;

  // Don't run if there's already a pending approval waiting for the owner
  if (!params.forceRun) {
    const pending = await getAwaitingApproval();
    if (pending) {
      return { proposalsSent: 0, issuesFound: 0, conversationsReviewed: 0 };
    }
  }

  const openai = config.openAiApiKey
    ? new OpenAI({ apiKey: config.openAiApiKey, organization: config.openAiOrganizationId || undefined })
    : null;
  if (!openai) return { proposalsSent: 0, issuesFound: 0, conversationsReviewed: 0 };

  const runRes = await pool.query<{ id: string }>(
    `INSERT INTO jardes_analysis_runs (started_at) VALUES (NOW()) RETURNING id`
  );
  const runId = runRes.rows[0]?.id ?? 'unknown';

  try {
    const [conversations, knowledgeEntries] = await Promise.all([
      getConversationsForAnalysis(sinceHours),
      getActiveKnowledgeEntries()
    ]);
    const ownerCustomerId = await getOwnerCustomerId();
    const businessSnap = await fetchBusinessSnapshot();

    const buildStatusFooter = (activeRules: number): string => [
      '',
      `*Status do negócio:*`,
      businessSnap,
      `Regras ativas na Iara: ${activeRules}`
    ].join('\n');

    if (conversations.length === 0) {
      await pool.query(
        `UPDATE jardes_analysis_runs SET finished_at = NOW(), status = 'completed' WHERE id = $1`, [runId]
      );
      const report = [
        `📊 *Relatório Jardes — Últimas ${sinceHours}h*`,
        '',
        'Sem conversas de clientes para analisar neste período.',
        buildStatusFooter(knowledgeEntries.length)
      ].join('\n');
      await sendJardesMessage(report, ownerCustomerId ?? undefined, automated);
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
6. Texto fixo inadequado (mensagem da Iara que parece robótica/fria e é gerada por template fixo, não GPT)
   Templates overridáveis: confirm-transaction-ask (pergunta de confirmação de transação), confirm-transaction-hint (instrução pós-confirmação), spending-limit-ok (confirmação de limite definido), register-transaction-ok (confirmação de lançamento registrado)
   Exemplos: "Só para confirmar: você quer que eu registre..." ou "Fechou! ✅ Limite X definido em Y."

Ignore conversas normais e bem-sucedidas.

Para cada problema encontrado, proponha uma regra específica, concisa e aplicável que a Iara deve seguir.
Para problemas do tipo 6 (texto fixo), proponha um novo texto para o template (suporte a variáveis: {amount}, {category}, {period}, {emoji}).

Conversas analisadas (últimas ${sinceHours}h):
${conversationText}

Retorne APENAS JSON válido neste formato:
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

Se não encontrar problemas relevantes, retorne { "issues": [], "template_overrides": [] }.
Máximo 5 issues + 3 template_overrides. Priorize os mais impactantes para o cliente.`;

    const response = await openai.chat.completions.create({
      model: config.openAiAgentModel,
      messages: [{ role: 'user', content: analysisPrompt }],
      max_tokens: 2000,
      temperature: 0.2,
      response_format: { type: 'json_object' }
    });

    const content = response.choices[0]?.message?.content ?? '{"issues":[],"template_overrides":[]}';
    let parsed: { issues: PendingApproval['proposalData']['issues']; template_overrides?: PendingApproval['proposalData']['template_overrides'] };
    try {
      parsed = JSON.parse(content);
    } catch {
      parsed = { issues: [], template_overrides: [] };
    }
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
      const report = [
        `📊 *Relatório Jardes — Últimas ${sinceHours}h*`,
        '',
        `Conversas analisadas: ${conversations.length} cliente(s)`,
        'Problemas encontrados: nenhum ✅',
        'Iara respondendo bem.',
        buildStatusFooter(knowledgeEntries.length)
      ].join('\n');
      await sendJardesMessage(report, ownerCustomerId ?? undefined, automated);
      return { proposalsSent: 0, issuesFound: 0, conversationsReviewed: conversations.length };
    }

    const issueLines = issues.map((issue, i) =>
      `${i + 1}. *${issue.topic}*\n   Problema: ${issue.problem}\n   Melhoria: ${issue.improvement_rule}`
    ).join('\n\n');

    const templateOverrideLines = templateOverrides.length > 0
      ? [
          '',
          '🔧 *Templates a atualizar:*',
          ...templateOverrides.map(t => `• ${t.template_key}: "${t.new_text.slice(0, 80)}${t.new_text.length > 80 ? '...' : ''}"\n  Motivo: ${t.reason}`)
        ].join('\n')
      : '';

    const approvalMessage = [
      `📊 *Relatório Jardes — Últimas ${sinceHours}h*`,
      '',
      ...(issues.length > 0
        ? [`Felipe, analisei ${conversations.length} conversa(s) e encontrei ${issues.length} ponto(s) a melhorar na Iara:`, '', issueLines]
        : [`Felipe, analisei ${conversations.length} conversa(s). Sem issues de comportamento.`]),
      templateOverrideLines,
      '',
      'Posso aplicar essas melhorias?',
      buildStatusFooter(knowledgeEntries.length)
    ].join('\n');

    await createPendingApproval({
      type: 'improvement',
      messageToOwner: approvalMessage,
      proposalData: { issues, template_overrides: templateOverrides, runId, sinceHours }
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

// ─────────────────────────────────────────────
// Business data snapshot for Jardes context
// ─────────────────────────────────────────────

async function fetchBusinessSnapshot(): Promise<string> {
  try {
    const [activeRes, pastDueRes, trialRes, pendingRes, planRes] = await Promise.all([
      pool.query<{ total: string }>(`SELECT COUNT(*)::text AS total FROM customers WHERE is_active = TRUE`),
      pool.query<{ total: string }>(
        `SELECT COUNT(*)::text AS total FROM subscriptions s JOIN customers c ON c.id = s.customer_id WHERE s.status = 'past_due' AND c.is_active = FALSE`
      ),
      pool.query<{ total: string }>(
        `SELECT COUNT(*)::text AS total FROM subscriptions WHERE trial_enabled = TRUE AND trial_end_date >= CURRENT_DATE`
      ),
      pool.query<{ total: string }>(
        `SELECT COUNT(*)::text AS total FROM subscriptions WHERE has_paid_setup = FALSE AND status != 'canceled'`
      ),
      pool.query<{ plan_code: string; total: string }>(
        `SELECT s.plan_code, COUNT(*)::text AS total FROM subscriptions s JOIN customers c ON c.id = s.customer_id WHERE c.is_active = TRUE GROUP BY s.plan_code`
      )
    ]);

    const byPlan = planRes.rows.map(r => `${r.plan_code}: ${r.total}`).join(', ');
    return [
      `Clientes ativos: ${activeRes.rows[0]?.total ?? 0}`,
      `Inadimplentes: ${pastDueRes.rows[0]?.total ?? 0}`,
      `Em teste: ${trialRes.rows[0]?.total ?? 0}`,
      `Pendente ativação: ${pendingRes.rows[0]?.total ?? 0}`,
      `Por plano: ${byPlan || 'sem dados'}`
    ].join('\n');
  } catch {
    return 'Dados do sistema indisponíveis agora.';
  }
}

// ─────────────────────────────────────────────
// Process owner response to pending approval
// Returns the reply string (delivered via replyText by the webhook)
// ─────────────────────────────────────────────

export async function processOwnerJardesResponse(params: {
  ownerMessage: string;
  pendingApproval: PendingApproval;
  ownerCustomerId: string;
}): Promise<string> {
  const { ownerMessage, pendingApproval, ownerCustomerId } = params;
  const normalized = ownerMessage.trim();

  const isSimpleApproval = /^(sim|s|ok|pode|vai|yes|confirma|confirmado|aplica|aplicar|tá bom|ta bom|beleza|ótimo|otimo|certo|perfeito)(\s.*)?$/i.test(normalized);

  const openai = config.openAiApiKey
    ? new OpenAI({ apiKey: config.openAiApiKey, organization: config.openAiOrganizationId || undefined })
    : null;

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
    const reply = `*[JARDES]* Entendido! ${totalApplied} melhoria(s) aplicada(s)${templateNote}. A Iara já vai usar isso nas próximas conversas.\nPara ver o que mudei: "Jards, o que você mudou?" 🤝`;
    await logConversation(ownerCustomerId, 'outbound', reply, { source: 'jardes-message' });
    return reply;
  }

  // Owner is correcting — re-interpret with GPT
  if (!openai) {
    await markApprovalResponded({ id: pendingApproval.id, status: 'rejected', ownerResponse: ownerMessage });
    const reply = '*[JARDES]* Entendido, anotei sua correção. Quando quiser, é só pedir nova análise.';
    await logConversation(ownerCustomerId, 'outbound', reply, { source: 'jardes-message' });
    return reply;
  }

  const correctionPrompt = `Você é Jardes. Você propôs estas melhorias para a Iara:

${pendingApproval.messageToOwner}

O Felipe respondeu com esta correção:
"${ownerMessage}"

Gere as regras finais ajustadas. Retorne APENAS JSON válido:
{
  "adjusted_rules": [
    { "topic": "identificador_snake_case", "description": "o que foi corrigido", "rule": "regra final para a Iara" }
  ],
  "confirmation_message": "mensagem curta confirmando (máx 2 linhas)"
}`;

  try {
    const response = await openai.chat.completions.create({
      model: config.openAiAgentModel,
      messages: [{ role: 'user', content: correctionPrompt }],
      max_tokens: 800, temperature: 0.2,
      response_format: { type: 'json_object' }
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
    const reply = `*[JARDES]* ${adjusted.confirmation_message ?? 'Entendido, ajustei conforme sua instrução e apliquei. 🤝'}`;
    await logConversation(ownerCustomerId, 'outbound', reply, { source: 'jardes-message' });
    return reply;
  } catch {
    await markApprovalResponded({ id: pendingApproval.id, status: 'applied', ownerResponse: ownerMessage });
    const reply = '*[JARDES]* Entendido e anotado. Ajustei conforme sua instrução.';
    await logConversation(ownerCustomerId, 'outbound', reply, { source: 'jardes-message' });
    return reply;
  }
}

// ─────────────────────────────────────────────
// Customer conversation lookup (for Jardes direct queries)
// ─────────────────────────────────────────────

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
     ORDER BY cl.created_at DESC
     LIMIT $2`,
    [`%${digits}%`, limitMsgs]
  );

  if (result.rows.length === 0) return null;
  return {
    customerName: result.rows[0].customer_name,
    whatsappNumber: result.rows[0].whatsapp_number,
    messages: result.rows.map(r => ({ direction: r.direction, message: r.message })).reverse()
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
  const sql = `
    SELECT c.name AS customer_name, c.whatsapp_number, cl.direction, cl.message
    FROM conversation_logs cl
    JOIN customers c ON c.id = cl.customer_id
    WHERE ${whereClause}
      AND cl.created_at > NOW() - INTERVAL '30 days'
    ORDER BY c.id, cl.created_at DESC
    LIMIT $${args.length + 1}`;

  if (searchName) args.push(`%${searchName}%`);
  args.push(limitMsgs);

  const result = await pool.query<{
    customer_name: string | null; whatsapp_number: string;
    direction: string; message: string;
  }>(sql, args);

  // Group by number
  const byNumber = new Map<string, typeof result.rows>();
  for (const row of result.rows) {
    const existing = byNumber.get(row.whatsapp_number) ?? [];
    existing.push(row);
    byNumber.set(row.whatsapp_number, existing);
  }

  return Array.from(byNumber.entries()).map(([, rows]) => ({
    customerName: rows[0].customer_name,
    whatsappNumber: rows[0].whatsapp_number,
    messages: rows.map(r => ({ direction: r.direction, message: r.message })).reverse()
  }));
}

function formatConversationForAnalysis(messages: Array<{ direction: string; message: string }>, maxMsgLen = 400): string {
  return messages.map(m =>
    `${m.direction === 'inbound' ? 'Cliente' : 'Iara'}: ${m.message.slice(0, maxMsgLen)}`
  ).join('\n');
}

function extractManualMessageToSend(command: string): string | null {
  const explicitField =
    command.match(/(?:mensagem|texto)\s*[:\-]\s*["“]?([\s\S]+?)["”]?\s*$/i) ??
    command.match(/(?:escreve|escrever)\s*[:\-]\s*["“]?([\s\S]+?)["”]?\s*$/i);
  if (explicitField?.[1]) return explicitField[1].trim();

  const quoted =
    command.match(/["“]([^"”]{3,})["”]/) ??
    command.match(/(?:diga|fala|fale)\s+(.{3,})$/i);
  if (quoted?.[1]) return quoted[1].trim();

  return null;
}

function extractOutboundTemplateKey(command: string): string | null {
  const byKeyword =
    command.match(/template\s*[:\-]\s*([a-z0-9][a-z0-9\-_]+)/i) ??
    command.match(/mensagem\s*[:\-]\s*([a-z0-9][a-z0-9\-_]+)/i);
  if (byKeyword?.[1]) return byKeyword[1].trim().toLowerCase();
  return null;
}

// ─────────────────────────────────────────────
// Fetches last N turns of owner <> Jardes conversation for GPT context
// ─────────────────────────────────────────────

async function fetchOwnerConversationHistory(
  ownerCustomerId: string,
  limit = 8
): Promise<Array<{ role: 'user' | 'assistant'; content: string }>> {
  const result = await pool.query<{ direction: 'inbound' | 'outbound'; message: string }>(
    `SELECT direction, message
     FROM conversation_logs
     WHERE customer_id = $1
       AND created_at >= NOW() - INTERVAL '30 minutes'
     ORDER BY created_at DESC
     LIMIT $2`,
    [ownerCustomerId, limit]
  );
  return result.rows.reverse().map(row => ({
    role: row.direction === 'inbound' ? ('user' as const) : ('assistant' as const),
    content: row.message
  }));
}

// ─────────────────────────────────────────────
// Broadcast helper — sends a freeform message to all active customers inside the 24h window
// ─────────────────────────────────────────────

async function broadcastGreeting(message: string): Promise<{ sent: number; skipped: number; failed: number }> {
  const result = await pool.query<{ id: string; name: string | null; whatsapp_number: string }>(
    `SELECT id, name, whatsapp_number
     FROM customers
     WHERE is_active = true
     ORDER BY last_inbound_at DESC NULLS LAST`
  );

  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const customer of result.rows) {
    const firstName = customer.name?.split(' ')[0] ?? null;
    const personalised = firstName ? message.replace('{nome}', firstName) : message.replace(', {nome}', '').replace('{nome}', '');

    const outcome = await sendWhatsAppText({ to: customer.whatsapp_number, message: personalised });
    if (outcome.sent) {
      sent++;
    } else if (outcome.error === 'customer_outside_window_no_template') {
      skipped++;
    } else {
      failed++;
    }

    // Small delay to avoid hammering the provider
    await new Promise(r => setTimeout(r, 300));
  }

  return { sent, skipped, failed };
}

// ─────────────────────────────────────────────
// Direct command from owner ("Jards, ...")
// Returns the reply string (delivered via replyText by the webhook)
// ─────────────────────────────────────────────

export async function handleJardesDirectCommand(params: {
  rawMessage: string;
  ownerCustomerId: string;
}): Promise<string> {
  const { rawMessage, ownerCustomerId } = params;
  const cleanCommand = rawMessage.replace(/^jard[aes]s?\s*[,:]?\s*/i, '').trim();
  const normalized = cleanCommand.toLowerCase();

  let reply: string;

  try {
    // ── Broadcast para todos os clientes ─────────────────────
    const isBroadcastGreeting =
      // "boa tarde/bom dia/boa noite" + destino "clientes/todos/base"
      (/\b(boa\s+tarde|bom\s+dia|boa\s+noite)\b/i.test(normalized) &&
       /\b(clientes?|todos|base|todo\s+mundo|geral)\b/i.test(normalized)) ||
      // "mande/envia/dispara boa tarde agora/já/sim"
      (/\b(mande?|envia?r?|dispara?r?)\b/i.test(normalized) &&
       /\b(boa\s+tarde|bom\s+dia|boa\s+noite)\b/i.test(normalized) &&
       /\b(agora|já|logo|sim|confirmo)\b/i.test(normalized)) ||
      // "broadcast" explícito
      /\bbroadcast\b/i.test(normalized);

    if (isBroadcastGreeting) {
      const now = new Date();
      const hour = Number(now.toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: 'America/Sao_Paulo' }));
      const greeting = hour < 12 ? 'Bom dia' : hour < 18 ? 'Boa tarde' : 'Boa noite';
      const defaultMsg = `${greeting}, {nome}! 👋 Passando pra saber se posso te ajudar com algo hoje. Sua Iara está aqui!`;

      reply = `*[JARDES]* Disparando ${greeting.toLowerCase()} para todos os clientes ativos na janela 24h... ⏳`;
      await logConversation(ownerCustomerId, 'outbound', reply, { source: 'jardes-message' });

      const result = await broadcastGreeting(defaultMsg);
      reply = `*[JARDES]* Broadcast concluído.\n• Enviadas: ${result.sent}\n• Fora da janela: ${result.skipped}\n• Falhas: ${result.failed}`;
      await logConversation(ownerCustomerId, 'outbound', reply, { source: 'jardes-message' });
      return reply;
    }



    // ── Análise agora ─────────────────────────────────────────
    if (/^(faz|fazer|rodar|roda|executa|executar|inicia|iniciar|dispara?|force?)?\s*(a\s+)?(análise|analise|analisa)/i.test(cleanCommand) || normalized === 'análise' || normalized === 'analise') {
      const initial = '*[JARDES]* Iniciando análise completa agora. Te aviso quando terminar. ⏳';
      await logConversation(ownerCustomerId, 'outbound', initial, { source: 'jardes-message' });

      const result = await runJardesAnalysis({ sinceHours: 6, forceRun: true });
      if (result.conversationsReviewed === 0) {
        reply = '*[JARDES]* Análise concluída: sem conversas recentes para revisar.';
      } else if (result.issuesFound === 0) {
        reply = `*[JARDES]* Análise concluída: ${result.conversationsReviewed} conversa(s) revisada(s). Nenhum problema crítico encontrado. A Iara está respondendo bem. 👍`;
      } else {
        reply = `*[JARDES]* Análise concluída: ${result.conversationsReviewed} conversa(s) revisada(s), ${result.issuesFound} ponto(s) identificado(s). As propostas foram enviadas acima.`;
      }
      await logConversation(ownerCustomerId, 'outbound', reply, { source: 'jardes-message' });
      return reply;
    }

    // ── O que você mudou? ─────────────────────────────────────
    if (/o que (você |vc )?(mudou|fez|aplic|melho)/i.test(normalized) || normalized === 'status') {
      const entries = await getActiveKnowledgeEntries();
      if (entries.length === 0) {
        reply = '*[JARDES]* Ainda não apliquei nenhuma melhoria. Base de conhecimento vazia.';
      } else {
        const lines = entries.slice(0, 10).map((e, i) => `${i + 1}. *${e.topic}*: ${e.description}`);
        reply = `*[JARDES]* Melhorias ativas na Iara:\n\n${lines.join('\n')}\n\nTotal: ${entries.length} regra(s).`;
      }
      await logConversation(ownerCustomerId, 'outbound', reply, { source: 'jardes-message' });
      return reply;
    }

    // ── Listar templates ──────────────────────────────────────
    if (/\b(template|templates|modelo|modelos)\b/i.test(normalized) &&
        /\b(mostra|lista|ver|quais|status)\b/i.test(normalized)) {
      const overrides = await listTemplateOverrides();
      const defaultTemplates = [
        { key: 'confirm-transaction-ask', default: 'Só para confirmar: você quer que eu registre {amount}{category}?' },
        { key: 'confirm-transaction-hint', default: 'Se sim, me manda: "anota esse gasto".\nSe era só dúvida, me fala: "era pergunta".' },
        { key: 'spending-limit-ok', default: 'Fechou! ✅ Limite {period} definido em {amount}.\nQuando você estiver perto do limite (ou passar), eu te aviso na hora.' },
        { key: 'register-transaction-ok', default: 'Anotado! ✅ {action} de {amount} em {category}. Data do gasto: {dateLabel}. Horário: {timeLabel}.' }
      ];
      const overrideMap = new Map(overrides.map(o => [o.key, o.text]));
      const lines = defaultTemplates.map(t => {
        const active = overrideMap.get(t.key);
        return `• *${t.key}*\n  ${active ? `Override ativo: "${active.slice(0, 60)}${active.length > 60 ? '...' : ''}"` : `Padrão: "${t.default.slice(0, 60)}${t.default.length > 60 ? '...' : ''}"`}`;
      });
      reply = `*[JARDES]* Templates da Iara:\n\n${lines.join('\n\n')}\n\nPara mudar: "Jardes, muda o template confirm-transaction-ask: novo texto"`;
      await logConversation(ownerCustomerId, 'outbound', reply, { source: 'jardes-message' });
      return reply;
    }

    // ── Definir template ──────────────────────────────────────
    if (/\b(muda|altera|altere|define|atualiza|set)\b.{0,30}\btemplate\b/i.test(normalized)) {
      // Parse: "muda o template <key>: <novo texto>"
      const tplMatch = cleanCommand.match(/template\s+([a-z][a-z0-9\-_]+)\s*[:\-]\s*(.+)/is);
      if (!tplMatch) {
        reply = '*[JARDES]* Formato inválido. Use: "Jardes, muda o template <chave>: novo texto"\nChaves: confirm-transaction-ask, confirm-transaction-hint, spending-limit-ok, register-transaction-ok';
      } else {
        const [, tKey, tText] = tplMatch;
        await setTemplateOverride(tKey.trim(), tText.trim());
        reply = `*[JARDES]* Template *${tKey.trim()}* atualizado. A Iara já vai usar o novo texto nas próximas mensagens.`;
      }
      await logConversation(ownerCustomerId, 'outbound', reply, { source: 'jardes-message' });
      return reply;
    }

    // ── Resetar template ──────────────────────────────────────
    if (/\b(reseta|reset|remove|apaga|volta ao padrão|padrão)\b.{0,30}\btemplate\b/i.test(normalized)) {
      const tplMatch = cleanCommand.match(/template\s+([a-z][a-z0-9\-_]+)/i);
      if (!tplMatch) {
        reply = '*[JARDES]* Diz qual template resetar. Ex: "Jardes, reseta o template confirm-transaction-ask"';
      } else {
        const tKey = tplMatch[1].trim();
        const removed = await deactivateTemplateOverride(tKey);
        reply = removed
          ? `*[JARDES]* Template *${tKey}* resetado. A Iara voltará a usar o texto padrão.`
          : `*[JARDES]* Não encontrei override ativo para o template *${tKey}*.`;
      }
      await logConversation(ownerCustomerId, 'outbound', reply, { source: 'jardes-message' });
      return reply;
    }

    // ── Templates de envio manual da Iara ─────────────────────
    if (/\b(lista|listar|mostra|mostrar|ver)\b.{0,30}\btemplates?\b.{0,20}\b(envio|mensagem)\b/i.test(normalized)) {
      const templates = await listOutboundTemplates();
      if (templates.length === 0) {
        reply = '*[JARDES]* Não há templates de envio cadastrados.';
      } else {
        const lines = templates.map((t) => `• *${t.key}*: "${t.text.slice(0, 90)}${t.text.length > 90 ? '...' : ''}"`);
        reply = `*[JARDES]* Templates de envio ativos:\n\n${lines.join('\n')}`;
      }
      await logConversation(ownerCustomerId, 'outbound', reply, { source: 'jardes-message' });
      return reply;
    }

    if (/\b(cria|criar|salva|salvar|define|definir)\b.{0,30}\btemplate\b.{0,20}\b(envio|mensagem)?\b/i.test(normalized)) {
      const tplMatch = cleanCommand.match(/template\s+([a-z0-9][a-z0-9\-_]+)\s*[:\-]\s*(.+)/is);
      if (!tplMatch) {
        reply = '*[JARDES]* Formato inválido. Use: "Jardes, cria template followup-1: <mensagem>".';
      } else {
        const [, key, text] = tplMatch;
        await setOutboundTemplate(key.trim().toLowerCase(), text.trim());
        reply = `*[JARDES]* Template de envio *${key.trim().toLowerCase()}* salvo.`;
      }
      await logConversation(ownerCustomerId, 'outbound', reply, { source: 'jardes-message' });
      return reply;
    }

    const openai = config.openAiApiKey
      ? new OpenAI({ apiKey: config.openAiApiKey, organization: config.openAiOrganizationId || undefined })
      : null;

    if (!openai) {
      reply = '*[JARDES]* OpenAI não configurada. Não consigo processar esse comando agora.';
      await logConversation(ownerCustomerId, 'outbound', reply, { source: 'jardes-message' });
      return reply;
    }

    // ── Lookup por número de telefone ──────────────────────────
    const phoneMatch = cleanCommand.match(/\b(\d{2}[\s\-]?\d{4,5}[\s\-]?\d{4})\b/) ??
                       cleanCommand.match(/\b(\d{10,13})\b/);

    // ── Comando explícito: enviar mensagem da Iara para um número ──
    const manualSendIntent =
      /\biara\b/i.test(normalized) &&
      /\b(manda|mandar|envia|enviar|dispara|disparar|chama|chamar)\b/i.test(normalized) &&
      /\b(mensagem|msg|n[úu]mero|contato|whatsapp)\b/i.test(normalized);

    if (manualSendIntent && phoneMatch) {
      const rawPhone = phoneMatch[1];
      const digits = rawPhone.replace(/\D/g, '');
      const to = `+${digits}`;

      if (digits.length < 10 || digits.length > 13) {
        reply = `*[JARDES]* Número inválido: ${rawPhone}. Me passa no formato com DDD, por exemplo: +55 11 95609-0319.`;
        await logConversation(ownerCustomerId, 'outbound', reply, { source: 'jardes-message' });
        return reply;
      }

      const selectedMessage = extractManualMessageToSend(cleanCommand);
      const selectedTemplateKey = extractOutboundTemplateKey(cleanCommand);
      const templateMessage = selectedTemplateKey ? await getOutboundTemplate(selectedTemplateKey) : null;
      const outboundMessage = selectedMessage ?? templateMessage;

      if (!outboundMessage) {
        reply = `*[JARDES]* Para eu mandar pela Iara, me passe a mensagem exata.\nFormato: "Jardes, manda para ${to} | mensagem: <seu texto>"`;
        await logConversation(ownerCustomerId, 'outbound', reply, { source: 'jardes-message' });
        return reply;
      }

      const sendResult = await sendWhatsAppText({ to, message: outboundMessage });
      if (!sendResult.sent) {
        reply = `*[JARDES]* Não consegui enviar para ${to}. Motivo: ${sendResult.error ?? 'falha desconhecida'}.`;
        await logConversation(ownerCustomerId, 'outbound', reply, { source: 'jardes-message' });
        return reply;
      }

      reply = `*[JARDES]* Mensagem enviada para ${to} via ${sendResult.provider ?? 'canal padrão'}.\nTexto: "${outboundMessage}"`;
      await logConversation(ownerCustomerId, 'outbound', reply, { source: 'jardes-message' });
      return reply;
    }

    if (phoneMatch) {
      const convData = await lookupConversationsByPhone(phoneMatch[1]);
      if (!convData) {
        reply = `*[JARDES]* Não encontrei conversas para o número ${phoneMatch[1]} no banco.`;
      } else {
        const convText = formatConversationForAnalysis(convData.messages);
        const analysisResp = await openai.chat.completions.create({
          model: config.openAiAgentModel,
          messages: [
            { role: 'system', content: `Você é Jardes — analista da Iara Bot. O Felipe quer que você analise a conversa do cliente abaixo e responda o que ele pediu. Seja direto, executivo, em português.` },
            { role: 'user', content: `${cleanCommand}\n\nConversa de ${convData.customerName ?? 'anônimo'} (${convData.whatsappNumber}):\n${convText}` }
          ],
          max_tokens: 800, temperature: 0.4
        });
        const text = analysisResp.choices[0]?.message?.content?.trim() ?? 'Não consegui analisar.';
        reply = `*[JARDES]* ${text}`;
      }
      await logConversation(ownerCustomerId, 'outbound', reply, { source: 'jardes-message' });
      return reply;
    }

    // ── Lookup por anônimo ou nome de cliente ──────────────────
    const needsConvLookup = /\b(conversa|mensagem|resposta|anon|an[oô]nim|cliente|contato|ver|veja|mostrar|olha|olhe)\b/i.test(normalized) &&
      !/^(faz|fazer|analisa|analise)/i.test(normalized);
    if (needsConvLookup) {
      const convList = await lookupConversationsByQuery(cleanCommand);
      if (convList.length === 0) {
        reply = `*[JARDES]* Não encontrei conversas correspondentes para "${cleanCommand.slice(0, 60)}".`;
      } else {
        const allText = convList.map(c => {
          const label = c.customerName ?? c.whatsappNumber;
          const msgs = formatConversationForAnalysis(c.messages);
          return `--- ${label} ---\n${msgs}`;
        }).join('\n\n');
        const analysisResp = await openai.chat.completions.create({
          model: config.openAiAgentModel,
          messages: [
            { role: 'system', content: `Você é Jardes — analista da Iara Bot. O Felipe quer que você analise a(s) conversa(s) abaixo e responda o que ele pediu. Seja direto, identifique problemas, sugira correção se houver. Português executivo.` },
            { role: 'user', content: `${cleanCommand}\n\n${allText}` }
          ],
          max_tokens: 1000, temperature: 0.4
        });
        const text = analysisResp.choices[0]?.message?.content?.trim() ?? 'Não consegui analisar.';
        reply = `*[JARDES]* ${text}`;
      }
      await logConversation(ownerCustomerId, 'outbound', reply, { source: 'jardes-message' });
      return reply;
    }

    // ── Fallback geral com dados + histórico de conversa ──────
    const [businessCtx, knowledgeEntries, history] = await Promise.all([
      fetchBusinessSnapshot(),
      getActiveKnowledgeEntries(),
      fetchOwnerConversationHistory(ownerCustomerId, 8)
    ]);

    const knowledgeCtx = knowledgeEntries.length > 0
      ? `\nRegras ativas na Iara (${knowledgeEntries.length}): ${knowledgeEntries.slice(0, 5).map(e => e.topic).join(', ')}`
      : '';

    const systemPrompt = `Você é Jardes — braço direito executivo do Felipe, fundador do Iara Bot.

PERSONALIDADE:
- Direto, confiante, humano. Nunca enrola, nunca pede confirmação desnecessária.
- Quando o Felipe pedir algo que você consegue fazer, FAÇA — não pergunte se ele quer que você faça.
- Quando não souber algo, diz claramente e sugere o próximo passo.
- Use raciocínio curto e objetivo. Máximo 3 parágrafos.
- Responda sempre em português brasileiro.

REGRA CRÍTICA — O QUE VOCÊ PODE E NÃO PODE FAZER:
- Você PODE: responder perguntas, analisar conversas, mostrar dados do sistema, aplicar melhorias quando o Felipe aprovar, disparar broadcasts.
- Você NÃO PODE: "enviar em instantes", "preparar relatórios", "executar ajustes", ou qualquer ação que não esteja implementada agora. Se o Felipe pedir algo fora do seu escopo, explique claramente o que você não consegue fazer e sugira uma alternativa real.
- NUNCA diga "Te envio em instantes", "Já estou preparando", "Vou te mandar agora" a menos que você vá REALMENTE executar e entregar a resposta nessa mesma mensagem.

DADOS REAIS DO SISTEMA AGORA:
${businessCtx}${knowledgeCtx}

Hoje: ${new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' })}, ${new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' })} (Brasília)`;

    const historyMessages = history.filter(h => h.content !== cleanCommand && h.content !== rawMessage);

    const response = await openai.chat.completions.create({
      model: config.openAiAgentModel,
      messages: [
        { role: 'system', content: systemPrompt },
        ...historyMessages,
        { role: 'user', content: cleanCommand || rawMessage }
      ],
      max_tokens: 800,
      temperature: 0.65
    });

    const text = response.choices[0]?.message?.content?.trim() ?? 'Não consegui processar agora.';
    reply = `*[JARDES]* ${text}`;
  } catch (error) {
    reply = `*[JARDES]* Erro ao processar: ${error instanceof Error ? error.message : 'erro desconhecido'}`;
  }

  await logConversation(ownerCustomerId, 'outbound', reply, { source: 'jardes-message' });
  return reply;
}
