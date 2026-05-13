import { jaccard, normalizeText, tokenize } from "@/lib/utils";

const ROBOTIC_PATTERNS = [
  /como posso te ajudar/i,
  /estou aqui para ajudar/i,
  /se precisar estou a disposicao/i,
  /aguardo seu retorno/i,
  /fico feliz em ajudar/i
];

const COMPLAINT_PATTERNS = [
  /nao entendi/i,
  /ta errado/i,
  /voce repetiu/i,
  /isso nao foi o que pedi/i,
  /de novo/i,
  /nao era isso/i,
  /voce anotou errado/i,
  /robotic/i,
  /roboti/i
];

const EMPATHY_MARKERS = [
  "entendi",
  "boa",
  "fechou",
  "show",
  "beleza",
  "te ajudo",
  "vamos"
];

export interface QualitySignals {
  score: number;
  repetitive: boolean;
  robotic: boolean;
  lacksEmpathy: boolean;
  hallucinationRisk: boolean;
  complaintSignal: boolean;
  reasons: string[];
}

export function evaluateAssistantMessage(input: {
  reply: string;
  userMessage?: string;
  previousAssistantReplies?: string[];
}): QualitySignals {
  const reply = input.reply || "";
  const norm = normalizeText(reply);
  const reasons: string[] = [];

  let score = 1;

  const robotic = ROBOTIC_PATTERNS.some((r) => r.test(reply));
  if (robotic) {
    score -= 0.2;
    reasons.push("tom_robotico");
  }

  let repetitive = false;
  for (const prev of input.previousAssistantReplies ?? []) {
    const sim = jaccard(tokenize(prev), tokenize(reply));
    if (sim > 0.82) {
      repetitive = true;
      break;
    }
  }

  if (repetitive) {
    score -= 0.25;
    reasons.push("repeticao_alta");
  }

  const hasEmpathy = EMPATHY_MARKERS.some((m) => norm.includes(m));
  const lacksEmpathy = !hasEmpathy;
  if (lacksEmpathy) {
    score -= 0.1;
    reasons.push("baixa_empatia");
  }

  const hallucinationRisk = /anotado|corrigido|apagado/.test(norm) &&
    !!input.userMessage &&
    /\?$/.test(input.userMessage.trim()) &&
    !/(gastei|anota|registra|corrige|apaga|cria|define)/i.test(input.userMessage);

  if (hallucinationRisk) {
    score -= 0.2;
    reasons.push("acao_sem_confirmacao");
  }

  const complaintSignal = !!input.userMessage && COMPLAINT_PATTERNS.some((r) => r.test(input.userMessage as string));
  if (complaintSignal) {
    score -= 0.25;
    reasons.push("sinal_reclamacao_usuario");
  }

  return {
    score: Math.max(0, Number(score.toFixed(3))),
    repetitive,
    robotic,
    lacksEmpathy,
    hallucinationRisk,
    complaintSignal,
    reasons
  };
}
