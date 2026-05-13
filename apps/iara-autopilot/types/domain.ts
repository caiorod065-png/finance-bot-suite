export type MessageDirection = "inbound" | "outbound";
export type MessageRole = "user" | "assistant" | "system";

export interface ConversationMessage {
  id: string;
  provider: string;
  conversationId: string;
  customerPhone?: string | null;
  direction: MessageDirection;
  role: MessageRole;
  body: string;
  createdAt: string;
  meta?: Record<string, unknown>;
}

export interface QualityIssue {
  id?: string;
  messageId: string;
  conversationId: string;
  qualityScore: number;
  isRobotic: boolean;
  isRepetitive: boolean;
  lacksEmpathy: boolean;
  hallucinationRisk: boolean;
  userComplaintSignal: boolean;
  reasons: string[];
  embedding?: number[];
  createdAt?: string;
}

export interface PromptVersion {
  id: string;
  version: number;
  promptText: string;
  status: "active" | "candidate" | "archived" | "rejected" | "deployed";
  qualityScore?: number | null;
  source?: string | null;
  createdAt: string;
}

export interface SimulationCase {
  id?: string;
  input: string;
  context?: string;
  expected: string;
  tags?: string[];
}

export interface ImprovementRunResult {
  runId: string;
  status: "skipped" | "improved" | "not-better" | "failed";
  reason: string;
  baselineScore?: number;
  candidateScore?: number;
  deployed?: boolean;
  candidatePromptId?: string;
}
