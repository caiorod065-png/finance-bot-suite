import OpenAI from 'openai';
import { z } from 'zod';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { recordOpenAiUsageFromResponse } from './openai-usage.js';

const client = config.openAiApiKey ? new OpenAI({ apiKey: config.openAiApiKey }) : null;

const agentDefinitionSchema = z.object({
  name: z.string().min(2).max(80),
  role: z.string().min(2).max(180),
  goal: z.string().min(2).max(280),
  active: z.boolean().default(true)
});

const llmMessageSchema = z.object({
  agentName: z.string().min(2).max(80),
  content: z.string().min(4).max(2000)
});

const llmDecisionSchema = z.object({
  title: z.string().min(2).max(160),
  reason: z.string().min(2).max(400),
  owner: z.string().min(2).max(80),
  priority: z.enum(['alta', 'media', 'baixa'])
});

const llmChangeSchema = z.object({
  title: z.string().min(2).max(160),
  what: z.string().min(2).max(400),
  why: z.string().min(2).max(400),
  status: z.enum(['proposta', 'aplicada', 'bloqueada'])
});

const llmMeetingSchema = z.object({
  summary: z.string().min(8).max(1800),
  decisions: z.array(llmDecisionSchema).max(10),
  changes: z.array(llmChangeSchema).max(12),
  messages: z.array(llmMessageSchema).min(4).max(24)
});

export type AgentDefinition = z.infer<typeof agentDefinitionSchema>;

type AgentConfigRow = {
  coordinator_agent: string;
  agents_json: unknown;
  updated_at: string;
};

type RoomRow = {
  id: string;
  title: string | null;
  coordinator_agent: string;
  status: 'running' | 'completed' | 'failed';
  created_by: string | null;
  summary: string | null;
  decisions_json: unknown;
  changes_json: unknown;
  created_at: string;
  updated_at: string;
};

type RoomMessageRow = {
  id: string;
  role: 'admin' | 'agent' | 'system';
  agent_name: string | null;
  content: string;
  metadata: unknown;
  created_at: string;
};

type RoomListRow = {
  id: string;
  title: string | null;
  coordinator_agent: string;
  status: 'running' | 'completed' | 'failed';
  created_by: string | null;
  summary: string | null;
  created_at: string;
  updated_at: string;
  message_count: number;
  last_message: string | null;
};

export type AgentCoordinatorConfig = {
  coordinatorAgent: string;
  agents: AgentDefinition[];
  updatedAt: string;
};

export type AgentMeetingMessage = {
  id: string;
  role: 'admin' | 'agent' | 'system';
  agentName: string | null;
  content: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
};

export type AgentMeetingDecision = z.infer<typeof llmDecisionSchema>;
export type AgentMeetingChange = z.infer<typeof llmChangeSchema>;

export type AgentMeetingRoom = {
  id: string;
  title: string | null;
  coordinatorAgent: string;
  status: 'running' | 'completed' | 'failed';
  createdBy: string | null;
  summary: string | null;
  decisions: AgentMeetingDecision[];
  changes: AgentMeetingChange[];
  createdAt: string;
  updatedAt: string;
  messages: AgentMeetingMessage[];
};

export type AgentMeetingRoomListItem = {
  id: string;
  title: string | null;
  coordinatorAgent: string;
  status: 'running' | 'completed' | 'failed';
  createdBy: string | null;
  summary: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  lastMessage: string | null;
};

let roomSchemaReady: Promise<void> | null = null;

const DEFAULT_COORDINATOR = 'iara-coordenador-geral';
const FAMILY_SQUAD_COORDINATOR = 'iara-family-coordenador';

const DEFAULT_AGENTS: AgentDefinition[] = [
  {
    name: 'iara-coordenador-geral',
    role: 'Coordenador geral dos agentes',
    goal: 'Orquestrar os agentes, fechar decisão e priorizar execução com clareza.',
    active: true
  },
  {
    name: 'iara-conversa',
    role: 'Especialista em conversa humana',
    goal: 'Deixar respostas naturais, empáticas e não robóticas no WhatsApp.',
    active: true
  },
  {
    name: 'iara-produto',
    role: 'Arquiteto de produto financeiro',
    goal: 'Garantir que toda conversa puxe para ação financeira (anotar, meta, limite).',
    active: true
  },
  {
    name: 'iara-qualidade',
    role: 'Guardião de qualidade e risco',
    goal: 'Evitar regressões, detectar ambiguidades e validar segurança conversacional.',
    active: true
  }
];

const FAMILY_SQUAD_AGENTS: AgentDefinition[] = [
  {
    name: FAMILY_SQUAD_COORDINATOR,
    role: 'Coordenador do plano família',
    goal: 'Orquestrar melhorias contínuas no plano família com foco em adesão, retenção e operação.',
    active: true
  },
  {
    name: 'iara-family-produto',
    role: 'Especialista de produto do plano família',
    goal: 'Aprimorar regras de grupo (dono/membro), limites compartilhados e fluxos de entrada/saída.',
    active: true
  },
  {
    name: 'iara-family-cx',
    role: 'Especialista de experiência conversacional familiar',
    goal: 'Garantir comunicação clara, humana e educativa para famílias no WhatsApp.',
    active: true
  },
  {
    name: 'iara-family-ops',
    role: 'Especialista de operação e métricas do plano família',
    goal: 'Monitorar saúde operacional, qualidade dos lembretes e aderência de uso por grupo.',
    active: true
  },
  {
    name: 'iara-family-qa',
    role: 'Guardião de qualidade do plano família',
    goal: 'Detectar regressões de regras familiares, conflitos de permissão e ambiguidade de intent.',
    active: true
  }
];

export type AgentSquadPreset = {
  key: 'family_plan';
  label: string;
  description: string;
  coordinatorAgent: string;
  agents: AgentDefinition[];
  defaultInstruction: string;
};

export function getFamilyPlanSquadPreset(): AgentSquadPreset {
  return {
    key: 'family_plan',
    label: 'Equipe dedicada do plano família',
    description: 'Squad especializado para evoluir aquisição, uso, governança e retenção do plano família.',
    coordinatorAgent: FAMILY_SQUAD_COORDINATOR,
    agents: FAMILY_SQUAD_AGENTS.map((agent) => ({ ...agent })),
    defaultInstruction:
      'Rodar auditoria completa do plano família: onboarding, criação/entrada em grupo, limites, resumo familiar, tom da Iara, riscos e retenção. Entregar plano objetivo com prioridades da semana.'
  };
}

export type FamilyPlanSquadStatus = {
  active: boolean;
  coordinatorAgent: string;
  requiredCoordinator: string;
  activeAgentNames: string[];
  missingAgents: string[];
  configUpdatedAt: string;
};

function safeParseAgentArray(value: unknown): AgentDefinition[] {
  if (!Array.isArray(value)) return DEFAULT_AGENTS;
  const parsed = value
    .map((item) => agentDefinitionSchema.safeParse(item))
    .filter((item) => item.success)
    .map((item) => item.data);
  return parsed.length > 0 ? parsed : DEFAULT_AGENTS;
}

function normalizeCoordinator(agents: AgentDefinition[], candidate?: string | null): string {
  const names = new Set(agents.filter((a) => a.active).map((a) => a.name));
  if (candidate && names.has(candidate)) return candidate;
  if (names.has(DEFAULT_COORDINATOR)) return DEFAULT_COORDINATOR;
  return agents[0]?.name ?? DEFAULT_COORDINATOR;
}

function coerceJsonObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function parseAiJsonOutput(raw: string): unknown | null {
  if (!raw) return null;

  const candidates = [raw.trim()];
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) candidates.push(fenced[1].trim());

  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // keep trying
    }

    const firstBrace = candidate.indexOf('{');
    const lastBrace = candidate.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      try {
        return JSON.parse(candidate.slice(firstBrace, lastBrace + 1));
      } catch {
        // ignore
      }
    }
  }

  return null;
}

async function ensureRoomSchema(): Promise<void> {
  if (!roomSchemaReady) {
    roomSchemaReady = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS agent_orchestration_config (
          id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
          coordinator_agent TEXT NOT NULL,
          agents_json JSONB NOT NULL DEFAULT '[]'::jsonb,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS agent_meeting_rooms (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          title TEXT,
          coordinator_agent TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
          created_by TEXT,
          summary TEXT,
          decisions_json JSONB NOT NULL DEFAULT '[]'::jsonb,
          changes_json JSONB NOT NULL DEFAULT '[]'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS agent_meeting_messages (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          room_id UUID NOT NULL REFERENCES agent_meeting_rooms(id) ON DELETE CASCADE,
          role TEXT NOT NULL CHECK (role IN ('admin', 'agent', 'system')),
          agent_name TEXT,
          content TEXT NOT NULL,
          metadata JSONB,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_agent_meeting_rooms_updated
        ON agent_meeting_rooms (updated_at DESC)
      `);

      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_agent_meeting_messages_room_created
        ON agent_meeting_messages (room_id, created_at ASC)
      `);

      const hasConfig = await pool.query<{ id: number }>(
        `SELECT id FROM agent_orchestration_config WHERE id = 1 LIMIT 1`
      );

      if (!hasConfig.rowCount) {
        await pool.query(
          `INSERT INTO agent_orchestration_config (id, coordinator_agent, agents_json)
           VALUES (1, $1, $2::jsonb)`,
          [DEFAULT_COORDINATOR, JSON.stringify(DEFAULT_AGENTS)]
        );
      }
    })().catch((error) => {
      roomSchemaReady = null;
      throw error;
    });
  }

  await roomSchemaReady;
}

function toMeetingMessage(row: RoomMessageRow): AgentMeetingMessage {
  return {
    id: row.id,
    role: row.role,
    agentName: row.agent_name,
    content: row.content,
    metadata: coerceJsonObject(row.metadata),
    createdAt: row.created_at
  };
}

function parseDecisions(value: unknown): AgentMeetingDecision[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => llmDecisionSchema.safeParse(item))
    .filter((item) => item.success)
    .map((item) => item.data);
}

function parseChanges(value: unknown): AgentMeetingChange[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => llmChangeSchema.safeParse(item))
    .filter((item) => item.success)
    .map((item) => item.data);
}

function toMeetingRoom(row: RoomRow, messages: RoomMessageRow[]): AgentMeetingRoom {
  return {
    id: row.id,
    title: row.title,
    coordinatorAgent: row.coordinator_agent,
    status: row.status,
    createdBy: row.created_by,
    summary: row.summary,
    decisions: parseDecisions(row.decisions_json),
    changes: parseChanges(row.changes_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    messages: messages.map(toMeetingMessage)
  };
}

export async function getAgentCoordinatorConfig(): Promise<AgentCoordinatorConfig> {
  await ensureRoomSchema();

  const result = await pool.query<AgentConfigRow>(
    `SELECT coordinator_agent, agents_json, updated_at
     FROM agent_orchestration_config
     WHERE id = 1
     LIMIT 1`
  );

  const row = result.rows[0];
  const agents = safeParseAgentArray(row?.agents_json);
  const coordinatorAgent = normalizeCoordinator(agents, row?.coordinator_agent ?? DEFAULT_COORDINATOR);

  return {
    coordinatorAgent,
    agents,
    updatedAt: row?.updated_at ?? new Date().toISOString()
  };
}

export async function getFamilyPlanSquadStatus(): Promise<FamilyPlanSquadStatus> {
  const current = await getAgentCoordinatorConfig();
  const preset = getFamilyPlanSquadPreset();
  const required = new Set(preset.agents.map((agent) => agent.name));
  const activeAgentNames = current.agents
    .filter((agent) => agent.active !== false)
    .map((agent) => agent.name);
  const missingAgents = Array.from(required).filter((name) => !activeAgentNames.includes(name));
  const active = current.coordinatorAgent === preset.coordinatorAgent && missingAgents.length === 0;

  return {
    active,
    coordinatorAgent: current.coordinatorAgent,
    requiredCoordinator: preset.coordinatorAgent,
    activeAgentNames,
    missingAgents,
    configUpdatedAt: current.updatedAt
  };
}

export async function updateAgentCoordinatorConfig(params: {
  coordinatorAgent?: string;
  agents?: AgentDefinition[];
}): Promise<AgentCoordinatorConfig> {
  await ensureRoomSchema();

  const current = await getAgentCoordinatorConfig();
  const agents = params.agents && params.agents.length > 0
    ? params.agents
    : current.agents;

  const coordinatorAgent = normalizeCoordinator(agents, params.coordinatorAgent ?? current.coordinatorAgent);

  await pool.query(
    `UPDATE agent_orchestration_config
     SET coordinator_agent = $1,
         agents_json = $2::jsonb,
         updated_at = NOW()
     WHERE id = 1`,
    [coordinatorAgent, JSON.stringify(agents)]
  );

  return getAgentCoordinatorConfig();
}

export async function activateFamilyPlanSquad(params?: {
  createdBy?: string | null;
  kickoffInstruction?: string;
  openKickoffRoom?: boolean;
}): Promise<{
  config: AgentCoordinatorConfig;
  status: FamilyPlanSquadStatus;
  room: AgentMeetingRoom | null;
}> {
  const preset = getFamilyPlanSquadPreset();
  const configData = await updateAgentCoordinatorConfig({
    coordinatorAgent: preset.coordinatorAgent,
    agents: preset.agents
  });

  let room: AgentMeetingRoom | null = null;
  const openKickoffRoom = params?.openKickoffRoom ?? true;
  if (openKickoffRoom) {
    room = await createAgentMeetingRoom({
      title: 'War Room: Plano Família',
      instruction: params?.kickoffInstruction?.trim() || preset.defaultInstruction,
      coordinatorAgent: preset.coordinatorAgent,
      createdBy: params?.createdBy ?? 'admin'
    });
  }

  const status = await getFamilyPlanSquadStatus();
  return {
    config: configData,
    status,
    room
  };
}

export async function createFamilyPlanSquadRoom(params: {
  instruction?: string;
  title?: string;
  coordinatorAgent?: string;
  createdBy?: string | null;
  ensureActive?: boolean;
}): Promise<{
  room: AgentMeetingRoom;
  autoActivated: boolean;
  status: FamilyPlanSquadStatus;
}> {
  const preset = getFamilyPlanSquadPreset();
  let autoActivated = false;

  if (params.ensureActive !== false) {
    const statusBefore = await getFamilyPlanSquadStatus();
    if (!statusBefore.active) {
      await activateFamilyPlanSquad({
        createdBy: params.createdBy,
        openKickoffRoom: false
      });
      autoActivated = true;
    }
  }

  const room = await createAgentMeetingRoom({
    title: params.title?.trim() || 'Diagnóstico dedicado: Plano Família',
    instruction: params.instruction?.trim() || preset.defaultInstruction,
    coordinatorAgent: params.coordinatorAgent || preset.coordinatorAgent,
    createdBy: params.createdBy ?? 'admin'
  });

  const status = await getFamilyPlanSquadStatus();
  return {
    room,
    autoActivated,
    status
  };
}

async function fetchRoom(roomId: string): Promise<RoomRow | null> {
  const room = await pool.query<RoomRow>(
    `SELECT id, title, coordinator_agent, status, created_by, summary,
            decisions_json, changes_json, created_at, updated_at
       FROM agent_meeting_rooms
      WHERE id = $1
      LIMIT 1`,
    [roomId]
  );

  return room.rows[0] ?? null;
}

async function fetchRoomMessages(roomId: string, limit = 200): Promise<RoomMessageRow[]> {
  const rows = await pool.query<RoomMessageRow>(
    `SELECT id, role, agent_name, content, metadata, created_at
       FROM agent_meeting_messages
      WHERE room_id = $1
      ORDER BY created_at ASC
      LIMIT $2`,
    [roomId, Math.max(1, Math.min(limit, 1000))]
  );
  return rows.rows;
}

async function appendMessage(params: {
  roomId: string;
  role: 'admin' | 'agent' | 'system';
  content: string;
  agentName?: string | null;
  metadata?: Record<string, unknown> | null;
}): Promise<void> {
  await pool.query(
    `INSERT INTO agent_meeting_messages (room_id, role, agent_name, content, metadata)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [
      params.roomId,
      params.role,
      params.agentName ?? null,
      params.content,
      params.metadata ? JSON.stringify(params.metadata) : null
    ]
  );
}

async function generateMeetingWithAi(params: {
  instruction: string;
  roomTitle: string | null;
  coordinatorAgent: string;
  agents: AgentDefinition[];
  historyLines: string[];
}): Promise<z.infer<typeof llmMeetingSchema> | null> {
  if (!client) return null;

  const activeAgents = params.agents.filter((agent) => agent.active);
  const history = params.historyLines.length > 0
    ? params.historyLines.join('\n')
    : 'Sem histórico anterior.';

  const prompt = [
    'Você vai simular uma sala de reunião entre agentes de IA da assistente financeira Iara.',
    'Idioma obrigatório: português do Brasil.',
    'Tom: humano, prático e colaborativo.',
    'Objetivo: discutir a instrução do admin, decidir melhorias e propor mudanças claras.',
    'IMPORTANTE: não revelar raciocínio oculto interno; só registrar falas objetivas dos agentes (como ata de reunião).',
    'Cada fala deve parecer uma conversa real de equipe, sem linguagem robótica.',
    'Regras:',
    '- Sempre inclua o coordenador geral guiando a discussão e fechando decisão.',
    '- Traga propostas acionáveis para produto, conversa da Iara e qualidade/testes.',
    '- Se houver dúvida, proponha experimento controlado com validação.',
    '- Gere 6 a 14 falas alternando agentes.',
    '',
    `Título da sala: ${params.roomTitle || 'Sala sem título'}`,
    `Instrução do admin: ${params.instruction}`,
    `Coordenador geral: ${params.coordinatorAgent}`,
    'Agentes disponíveis:',
    ...activeAgents.map((agent) => `- ${agent.name} | papel: ${agent.role} | meta: ${agent.goal}`),
    '',
    'Histórico recente da sala:',
    history,
    '',
    'Responda APENAS JSON válido com as chaves: summary, decisions, changes, messages.'
  ].join('\n');

  const response = await client.responses.create({
    model: config.openAiAgentModel,
    input: prompt,
    temperature: Math.max(0.2, Math.min(config.openAiAgentTemperature, 1)),
    max_output_tokens: 1800
  });

  void recordOpenAiUsageFromResponse(response, config.openAiAgentModel);

  const output = response.output_text?.trim() ?? '';
  const json = parseAiJsonOutput(output);
  if (!json) return null;

  const parsed = llmMeetingSchema.safeParse(json);
  if (!parsed.success) return null;

  const validAgentNames = new Set(activeAgents.map((agent) => agent.name));
  const messages = parsed.data.messages.map((message) => {
    if (validAgentNames.has(message.agentName)) return message;
    return {
      ...message,
      agentName: params.coordinatorAgent
    };
  });

  return {
    ...parsed.data,
    messages
  };
}

function generateFallbackMeeting(params: {
  instruction: string;
  coordinatorAgent: string;
}): z.infer<typeof llmMeetingSchema> {
  return {
    summary: 'Reunião registrada em modo local. Definimos próximos passos para melhorar a Iara com foco em conversa humana, retenção e clareza de ação.',
    decisions: [
      {
        title: 'Priorizar conversa humana no WhatsApp',
        reason: 'Reduz percepção de robô e aumenta retenção.',
        owner: 'iara-conversa',
        priority: 'alta'
      },
      {
        title: 'Criar bateria de testes por intenção',
        reason: 'Evita regressão em lembretes, metas e limites.',
        owner: 'iara-qualidade',
        priority: 'alta'
      }
    ],
    changes: [
      {
        title: 'Refino de prompt para contexto financeiro',
        what: 'Respostas mais naturais com recondução para metas, gastos e limites.',
        why: 'Aumenta assertividade e valor percebido no dia a dia.',
        status: 'proposta'
      }
    ],
    messages: [
      {
        agentName: params.coordinatorAgent,
        content: `Time, instrução recebida: "${params.instruction}". Vamos fechar plano prático e priorizado.`
      },
      {
        agentName: 'iara-conversa',
        content: 'Vou reforçar linguagem humana e evitar respostas repetitivas, sempre puxando para ação financeira útil.'
      },
      {
        agentName: 'iara-produto',
        content: 'Fecho com gatilhos por contexto: anotar gasto, ajustar limite, definir meta e revisar previsão.'
      },
      {
        agentName: 'iara-qualidade',
        content: 'Vou validar com cenários ambíguos e garantir que perguntas não virem ação sem confirmação.'
      },
      {
        agentName: params.coordinatorAgent,
        content: 'Decisão final: aplicar refinamento de conversa + testes de regressão e monitorar impacto em retenção.'
      }
    ]
  };
}

async function runMeetingRound(params: {
  roomId: string;
  instruction: string;
  coordinatorAgent: string;
  roomTitle: string | null;
}): Promise<void> {
  const configData = await getAgentCoordinatorConfig();
  const coordinatorAgent = normalizeCoordinator(configData.agents, params.coordinatorAgent || configData.coordinatorAgent);

  const recent = await pool.query<Pick<RoomMessageRow, 'role' | 'agent_name' | 'content'>>(
    `SELECT role, agent_name, content
       FROM agent_meeting_messages
      WHERE room_id = $1
      ORDER BY created_at DESC
      LIMIT 18`,
    [params.roomId]
  );

  const historyLines = recent.rows
    .slice()
    .reverse()
    .map((line) => {
      const who = line.role === 'admin' ? 'Admin' : (line.agent_name || 'Sistema');
      return `${who}: ${line.content}`;
    });

  const aiMeeting = await generateMeetingWithAi({
    instruction: params.instruction,
    roomTitle: params.roomTitle,
    coordinatorAgent,
    agents: configData.agents,
    historyLines
  });

  const meeting = aiMeeting ?? generateFallbackMeeting({
    instruction: params.instruction,
    coordinatorAgent
  });

  for (let index = 0; index < meeting.messages.length; index += 1) {
    const message = meeting.messages[index];
    await appendMessage({
      roomId: params.roomId,
      role: 'agent',
      agentName: message.agentName,
      content: message.content,
      metadata: {
        orderIndex: index + 1,
        coordinator: message.agentName === coordinatorAgent
      }
    });
  }

  await pool.query(
    `UPDATE agent_meeting_rooms
     SET coordinator_agent = $2,
         status = 'completed',
         summary = $3,
         decisions_json = $4::jsonb,
         changes_json = $5::jsonb,
         updated_at = NOW()
     WHERE id = $1`,
    [
      params.roomId,
      coordinatorAgent,
      meeting.summary,
      JSON.stringify(meeting.decisions),
      JSON.stringify(meeting.changes)
    ]
  );
}

export async function listAgentMeetingRooms(limit = 30): Promise<AgentMeetingRoomListItem[]> {
  await ensureRoomSchema();

  const safeLimit = Math.max(1, Math.min(limit, 200));
  const rows = await pool.query<RoomListRow>(
    `SELECT
       r.id,
       r.title,
       r.coordinator_agent,
       r.status,
       r.created_by,
       r.summary,
       r.created_at,
       r.updated_at,
       (SELECT COUNT(*)::int FROM agent_meeting_messages m WHERE m.room_id = r.id) AS message_count,
       (SELECT m.content FROM agent_meeting_messages m WHERE m.room_id = r.id ORDER BY m.created_at DESC LIMIT 1) AS last_message
     FROM agent_meeting_rooms r
     ORDER BY r.updated_at DESC
     LIMIT $1`,
    [safeLimit]
  );

  return rows.rows.map((row) => ({
    id: row.id,
    title: row.title,
    coordinatorAgent: row.coordinator_agent,
    status: row.status,
    createdBy: row.created_by,
    summary: row.summary,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    messageCount: Number(row.message_count || 0),
    lastMessage: row.last_message
  }));
}

export async function getAgentMeetingRoom(roomId: string): Promise<AgentMeetingRoom | null> {
  await ensureRoomSchema();

  const [room, messages] = await Promise.all([
    fetchRoom(roomId),
    fetchRoomMessages(roomId, 500)
  ]);

  if (!room) return null;
  return toMeetingRoom(room, messages);
}

export async function createAgentMeetingRoom(params: {
  title?: string;
  instruction: string;
  coordinatorAgent?: string;
  createdBy?: string | null;
}): Promise<AgentMeetingRoom> {
  await ensureRoomSchema();

  const title = params.title?.trim() || null;
  const created = await pool.query<{ id: string }>(
    `INSERT INTO agent_meeting_rooms (title, coordinator_agent, status, created_by)
     VALUES ($1, $2, 'running', $3)
     RETURNING id`,
    [title, params.coordinatorAgent ?? DEFAULT_COORDINATOR, params.createdBy ?? null]
  );

  const roomId = created.rows[0]?.id;
  if (!roomId) {
    throw new Error('failed_to_create_room');
  }

  await appendMessage({
    roomId,
    role: 'admin',
    agentName: null,
    content: params.instruction,
    metadata: { instruction: true }
  });

  try {
    await runMeetingRound({
      roomId,
      instruction: params.instruction,
      coordinatorAgent: params.coordinatorAgent ?? DEFAULT_COORDINATOR,
      roomTitle: title
    });
  } catch (error) {
    await pool.query(
      `UPDATE agent_meeting_rooms
       SET status = 'failed', updated_at = NOW()
       WHERE id = $1`,
      [roomId]
    );
    await appendMessage({
      roomId,
      role: 'system',
      content: 'Falha ao rodar reunião automática. Você pode enviar nova instrução para tentar novamente.',
      metadata: {
        error: error instanceof Error ? error.message : 'unknown_error'
      }
    });
  }

  const room = await getAgentMeetingRoom(roomId);
  if (!room) {
    throw new Error('room_not_found_after_create');
  }

  return room;
}

export async function appendAgentMeetingInstruction(params: {
  roomId: string;
  instruction: string;
  coordinatorAgent?: string;
}): Promise<AgentMeetingRoom> {
  await ensureRoomSchema();

  const room = await fetchRoom(params.roomId);
  if (!room) {
    throw new Error('room_not_found');
  }

  await appendMessage({
    roomId: params.roomId,
    role: 'admin',
    content: params.instruction,
    metadata: { instruction: true }
  });

  await pool.query(
    `UPDATE agent_meeting_rooms
     SET status = 'running',
         updated_at = NOW(),
         coordinator_agent = COALESCE($2, coordinator_agent)
     WHERE id = $1`,
    [params.roomId, params.coordinatorAgent ?? null]
  );

  try {
    await runMeetingRound({
      roomId: params.roomId,
      instruction: params.instruction,
      coordinatorAgent: params.coordinatorAgent ?? room.coordinator_agent,
      roomTitle: room.title
    });
  } catch (error) {
    await pool.query(
      `UPDATE agent_meeting_rooms
       SET status = 'failed', updated_at = NOW()
       WHERE id = $1`,
      [params.roomId]
    );

    await appendMessage({
      roomId: params.roomId,
      role: 'system',
      content: 'Falha ao processar a instrução. Tente novamente com uma instrução mais específica.',
      metadata: {
        error: error instanceof Error ? error.message : 'unknown_error'
      }
    });
  }

  const updated = await getAgentMeetingRoom(params.roomId);
  if (!updated) {
    throw new Error('room_not_found_after_update');
  }

  return updated;
}
