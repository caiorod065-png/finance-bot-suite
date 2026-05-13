import { supabase } from "@/lib/supabase";
import { DEFAULT_IARA_PROMPT } from "@/lib/prompt-base";
import { nowIso } from "@/lib/utils";
import type { ConversationMessage, PromptVersion, QualityIssue, SimulationCase } from "@/types/domain";

const TABLE_MESSAGES = "conversation_messages";
const TABLE_ISSUES = "conversation_quality_issues";
const TABLE_PROMPTS = "prompt_versions";
const TABLE_RUNS = "improvement_runs";
const TABLE_CASES = "simulation_cases";

export async function logConversationMessage(message: Omit<ConversationMessage, "id">): Promise<{ id: string }> {
  const payload = {
    provider: message.provider,
    conversation_id: message.conversationId,
    customer_phone: message.customerPhone ?? null,
    direction: message.direction,
    role: message.role,
    body: message.body,
    meta: message.meta ?? {},
    created_at: message.createdAt
  };

  const { data, error } = await supabase.from(TABLE_MESSAGES).insert(payload).select("id").single();
  if (error) throw error;
  return { id: data.id as string };
}

export async function logQualityIssue(issue: QualityIssue): Promise<void> {
  const payload = {
    message_id: issue.messageId,
    conversation_id: issue.conversationId,
    quality_score: issue.qualityScore,
    is_robotic: issue.isRobotic,
    is_repetitive: issue.isRepetitive,
    lacks_empathy: issue.lacksEmpathy,
    hallucination_risk: issue.hallucinationRisk,
    user_complaint_signal: issue.userComplaintSignal,
    reasons: issue.reasons,
    embedding: issue.embedding ?? [],
    created_at: issue.createdAt ?? nowIso()
  };

  const { error } = await supabase.from(TABLE_ISSUES).insert(payload);
  if (error) throw error;
}

export async function getRecentAssistantReplies(conversationId: string, limit = 10): Promise<string[]> {
  const { data, error } = await supabase
    .from(TABLE_MESSAGES)
    .select("body")
    .eq("conversation_id", conversationId)
    .eq("role", "assistant")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw error;
  return (data ?? []).map((row) => String(row.body));
}

export async function getActivePrompt(): Promise<PromptVersion> {
  const { data, error } = await supabase
    .from(TABLE_PROMPTS)
    .select("id,version,prompt_text,status,quality_score,source,created_at")
    .eq("status", "active")
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;

  if (!data) {
    const inserted = await insertPromptVersion({
      promptText: DEFAULT_IARA_PROMPT,
      source: "bootstrap",
      status: "active",
      qualityScore: null
    });

    return inserted;
  }

  return mapPrompt(data);
}

export async function getPromptById(id: string): Promise<PromptVersion | null> {
  const { data, error } = await supabase
    .from(TABLE_PROMPTS)
    .select("id,version,prompt_text,status,quality_score,source,created_at")
    .eq("id", id)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;
  return mapPrompt(data);
}

export async function insertPromptVersion(input: {
  promptText: string;
  source: string;
  status: PromptVersion["status"];
  qualityScore?: number | null;
}): Promise<PromptVersion> {
  const { data: maxData, error: maxErr } = await supabase
    .from(TABLE_PROMPTS)
    .select("version")
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (maxErr) throw maxErr;
  const nextVersion = Number(maxData?.version ?? 0) + 1;

  const { data, error } = await supabase
    .from(TABLE_PROMPTS)
    .insert({
      version: nextVersion,
      prompt_text: input.promptText,
      source: input.source,
      status: input.status,
      quality_score: input.qualityScore ?? null,
      created_at: nowIso()
    })
    .select("id,version,prompt_text,status,quality_score,source,created_at")
    .single();

  if (error) throw error;
  return mapPrompt(data);
}

export async function activatePrompt(promptId: string): Promise<void> {
  const { error: archiveErr } = await supabase
    .from(TABLE_PROMPTS)
    .update({ status: "archived" })
    .eq("status", "active");

  if (archiveErr) throw archiveErr;

  const { error } = await supabase
    .from(TABLE_PROMPTS)
    .update({ status: "active" })
    .eq("id", promptId);

  if (error) throw error;
}

export async function saveImprovementRun(input: {
  triggerReason: string;
  status: string;
  baselinePromptId?: string;
  candidatePromptId?: string;
  baselineScore?: number;
  candidateScore?: number;
  deployId?: string;
  summary?: string;
  details?: Record<string, unknown>;
}): Promise<string> {
  const { data, error } = await supabase
    .from(TABLE_RUNS)
    .insert({
      trigger_reason: input.triggerReason,
      status: input.status,
      baseline_prompt_id: input.baselinePromptId ?? null,
      candidate_prompt_id: input.candidatePromptId ?? null,
      baseline_score: input.baselineScore ?? null,
      candidate_score: input.candidateScore ?? null,
      deploy_id: input.deployId ?? null,
      summary: input.summary ?? null,
      details: input.details ?? {},
      created_at: nowIso()
    })
    .select("id")
    .single();

  if (error) throw error;
  return String(data.id);
}

export async function getPoorQualityIssues(windowMinutes: number, limit = 200): Promise<Array<Record<string, unknown>>> {
  const since = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from(TABLE_ISSUES)
    .select("id,message_id,conversation_id,quality_score,reasons,embedding,created_at")
    .lte("quality_score", 0.72)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw error;
  return data ?? [];
}

export async function getMessagesByIds(ids: string[]): Promise<Array<Record<string, unknown>>> {
  if (!ids.length) return [];
  const { data, error } = await supabase
    .from(TABLE_MESSAGES)
    .select("id,conversation_id,role,body,created_at,meta")
    .in("id", ids);

  if (error) throw error;
  return data ?? [];
}

export async function getSimulationCases(limit = 40): Promise<SimulationCase[]> {
  const { data, error } = await supabase
    .from(TABLE_CASES)
    .select("id,input,context,expected,tags")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw error;
  return (data ?? []).map((item) => ({
    id: String(item.id),
    input: String(item.input),
    context: item.context ? String(item.context) : undefined,
    expected: String(item.expected),
    tags: Array.isArray(item.tags) ? (item.tags as string[]) : []
  }));
}

export async function insertSimulationCaseIfMissing(input: SimulationCase): Promise<void> {
  const { data, error } = await supabase
    .from(TABLE_CASES)
    .select("id")
    .eq("input", input.input)
    .maybeSingle();

  if (error) throw error;
  if (data) return;

  const { error: insertErr } = await supabase.from(TABLE_CASES).insert({
    input: input.input,
    context: input.context ?? null,
    expected: input.expected,
    tags: input.tags ?? [],
    created_at: nowIso()
  });

  if (insertErr) throw insertErr;
}

function mapPrompt(row: Record<string, unknown>): PromptVersion {
  return {
    id: String(row.id),
    version: Number(row.version),
    promptText: String(row.prompt_text),
    status: String(row.status) as PromptVersion["status"],
    qualityScore: row.quality_score == null ? null : Number(row.quality_score),
    source: row.source == null ? null : String(row.source),
    createdAt: String(row.created_at)
  };
}
