import path from "node:path";
import { env } from "@/lib/env";
import {
  activatePrompt,
  getActivePrompt,
  getMessagesByIds,
  getPoorQualityIssues,
  getSimulationCases,
  insertPromptVersion,
  insertSimulationCaseIfMissing,
  saveImprovementRun
} from "@/lib/db";
import { embed, generateJson, generateText } from "@/lib/openai";
import { retrieveSimilarErrorPatterns } from "@/lib/rag";
import { runExternalValidators } from "@/lib/validators";
import { deployToVercel } from "@/lib/vercel-deploy";
import type { ImprovementRunResult, SimulationCase } from "@/types/domain";

interface CritiqueResponse {
  failures: string[];
  opportunities: string[];
  directives: string[];
}

interface CandidatePromptResponse {
  prompt: string;
  changeSummary: string[];
}

interface SimulationEvaluation {
  score: number;
  conversationalNaturalness: number;
  antiRepetition: number;
  empathy: number;
  transactionalSafety: number;
  notes: string;
}

function defaultSimulationCases(): SimulationCase[] {
  return [
    {
      input: "bom dia iara, como ta seu dia?",
      expected: "resposta humana, acolhedora, com convite leve para controle financeiro",
      tags: ["smalltalk", "human-tone"]
    },
    {
      input: "mas eu so tenho esse gasto de 80 reais ate agora?",
      expected: "consulta e explicacao sem registrar novo gasto",
      tags: ["conversational-safety", "question"]
    },
    {
      input: "gastei 80 no mercado",
      expected: "confirmar registro com insight objetivo",
      tags: ["transactional"]
    },
    {
      input: "80 em mercado?",
      expected: "pedir confirmacao antes de registrar",
      tags: ["ambiguous", "safety"]
    },
    {
      input: "iara me lembra hoje as 18h de ir pra faculdade",
      expected: "criar lembrete correto e confirmar horario/antecedencia",
      tags: ["reminder", "nlu"]
    },
    {
      input: "como funcionam os planos?",
      expected: "explicar planos em tom humano e sugerir melhor opcao",
      tags: ["sales", "plan"]
    }
  ];
}

async function ensureSeedSimulationCases(): Promise<void> {
  await Promise.all(defaultSimulationCases().map((c) => insertSimulationCaseIfMissing(c)));
}

async function critiquePrompt(prompt: string, ragContext: string): Promise<CritiqueResponse> {
  const systemInstructions = [
    "Você é um avaliador sênior de qualidade de assistentes de WhatsApp financeiros no Brasil.",
    "Sua única função é criticar prompts de IA com precisão técnica.",
    "Retorne EXCLUSIVAMENTE JSON com três campos:",
    "  failures: string[]   — falhas concretas observadas no prompt (tom robótico, repetição, execução sem confirmação, etc.)",
    "  opportunities: string[] — melhorias específicas ainda não contempladas",
    "  directives: string[] — instruções reescritas e acionáveis para corrigir cada falha",
    "Não adicione texto fora do JSON. Não use markdown.",
    "Priorize: segurança conversacional (não executar ação em pergunta), anti-repetição de frases, empatia sem exagero, precisão em lembretes e datas."
  ].join("\n");

  const userInput = [
    `## Prompt atual\n${prompt}`,
    `## Erros recorrentes detectados em produção\n${ragContext}`,
    "## Tarefa\nCritique o prompt acima considerando os erros de produção. Seja específico e cirúrgico."
  ].join("\n\n");

  return generateJson<CritiqueResponse>(userInput, systemInstructions);
}

async function generateCandidatePrompt(input: {
  currentPrompt: string;
  critique: CritiqueResponse;
  ragContext: string;
}): Promise<CandidatePromptResponse> {
  const systemInstructions = [
    "Você é um prompt engineer sênior especializado em assistentes financeiras conversacionais para WhatsApp no Brasil.",
    "Sua tarefa é reescrever um prompt de IA incorporando uma crítica técnica e padrões de erro reais.",
    "Regras obrigatórias que o novo prompt DEVE conter explicitamente:",
    "  1. Nunca executar ação de registro em mensagens que sejam perguntas (ex: '80 em mercado?' é pergunta, não lançamento).",
    "  2. Pedir confirmação antes de qualquer ação ambígua.",
    "  3. Nunca repetir a mesma frase ou estrutura de resposta em sequência.",
    "  4. Lembretes: confirmar horário, data e contexto completo antes de salvar.",
    "  5. Tom: brasileiro, direto, acolhedor — nunca robótico ou formal em excesso.",
    "Retorne EXCLUSIVAMENTE JSON com:",
    "  prompt: string   — novo prompt completo e autocontido",
    "  changeSummary: string[] — lista das mudanças aplicadas em relação ao original",
    "Não inclua texto fora do JSON. Não use markdown."
  ].join("\n");

  const userInput = [
    `## Prompt atual\n${input.currentPrompt}`,
    `## Crítica técnica\n${JSON.stringify(input.critique, null, 2)}`,
    `## Erros de produção (RAG)\n${input.ragContext}`,
    "## Tarefa\nGere o novo prompt incorporando todas as diretrizes da crítica e os padrões de erro reais."
  ].join("\n\n");

  return generateJson<CandidatePromptResponse>(userInput, systemInstructions);
}

const EVALUATOR_INSTRUCTIONS = [
  "Você é avaliador de qualidade de resposta da Iara, assistente financeira no WhatsApp.",
  "Pontue de 0.0 a 1.0 cada dimensão:",
  "  score — qualidade geral",
  "  conversationalNaturalness — soou humana e brasileira?",
  "  antiRepetition — evitou frases repetidas ou estrutura idêntica?",
  "  empathy — foi acolhedora sem ser exagerada?",
  "  transactionalSafety — não executou ação em pergunta, pediu confirmação em ambiguidade?",
  "Retorne EXCLUSIVAMENTE JSON com esses cinco campos numéricos e 'notes' (string curta).",
  "Não use markdown. Não adicione texto fora do JSON."
].join("\n");

async function evaluateCase(simulationCase: SimulationCase, prompt: string): Promise<SimulationEvaluation> {
  const iaraReply = await generateText(
    `Contexto: ${simulationCase.context ?? "sem contexto"}\nUsuário: ${simulationCase.input}\n\nResponda como Iara.`,
    prompt
  );

  return generateJson<SimulationEvaluation>(
    `## Caso de teste\n${JSON.stringify(simulationCase, null, 2)}\n\n## Resposta da Iara\n${iaraReply}`,
    EVALUATOR_INSTRUCTIONS
  );
}

async function runSimulation(input: {
  prompt: string;
  cases: SimulationCase[];
}): Promise<{ score: number; details: SimulationEvaluation[] }> {
  const details = await Promise.all(
    input.cases.slice(0, env.MAX_SIMULATION_CASES).map((c) => evaluateCase(c, input.prompt))
  );

  const score = details.length
    ? details.reduce((acc, cur) => acc + (cur.score ?? 0), 0) / details.length
    : 0;

  return {
    score: Number(score.toFixed(4)),
    details
  };
}

async function buildRagContext(windowMinutes: number): Promise<{ ragText: string; issueCount: number; issueSignals: string[] }> {
  const issues = await getPoorQualityIssues(windowMinutes);
  if (!issues.length) {
    return {
      ragText: "Sem problemas críticos recentes.",
      issueCount: 0,
      issueSignals: []
    };
  }

  const messageIds = issues.map((x) => String(x.message_id));
  const msgs = await getMessagesByIds(messageIds);
  const msgMap = new Map(msgs.map((m) => [String(m.id), m]));

  const pool = issues.map((issue) => {
    const msg = msgMap.get(String(issue.message_id));
    const text = `reasons=${JSON.stringify(issue.reasons)} | body=${String(msg?.body ?? "")}`;
    const embedding = Array.isArray(issue.embedding)
      ? (issue.embedding as unknown[]).map((v) => Number(v)).filter((x) => Number.isFinite(x))
      : [];

    return {
      id: String(issue.id),
      text,
      embedding
    };
  });

  const query = "erros frequentes de tom robotico, repeticao, entendimento de lembretes e ambiguidade";
  const ragItems = await retrieveSimilarErrorPatterns({ query, pool });

  return {
    ragText: ragItems.map((r, i) => `${i + 1}. ${r.text}`).join("\n"),
    issueCount: issues.length,
    issueSignals: issues.flatMap((i) => (Array.isArray(i.reasons) ? (i.reasons as string[]) : [])).slice(0, 40)
  };
}

export async function runSelfImprovement(triggerReason: string): Promise<ImprovementRunResult> {
  await ensureSeedSimulationCases();

  const active = await getActivePrompt();
  const rag = await buildRagContext(env.ANALYSIS_WINDOW_MINUTES);

  if (rag.issueCount === 0) {
    const runId = await saveImprovementRun({
      triggerReason,
      status: "skipped",
      baselinePromptId: active.id,
      summary: "Sem falhas recentes para otimizar",
      details: { windowMinutes: env.ANALYSIS_WINDOW_MINUTES }
    });

    return {
      runId,
      status: "skipped",
      reason: "Sem falhas recentes"
    };
  }

  const critique = await critiquePrompt(active.promptText, rag.ragText);

  const candidate = await generateCandidatePrompt({
    currentPrompt: active.promptText,
    critique,
    ragContext: rag.ragText
  });

  const candidateEmbedding = await embed(candidate.prompt);

  const simulationCases = await getSimulationCases(env.MAX_SIMULATION_CASES);
  const baselineEval = await runSimulation({
    prompt: active.promptText,
    cases: simulationCases
  });

  const candidateEval = await runSimulation({
    prompt: candidate.prompt,
    cases: simulationCases
  });

  const validatorResults = await runExternalValidators({
    candidatePrompt: candidate.prompt,
    baselinePrompt: active.promptText,
    qualitySignals: rag.issueSignals,
    runId: `r-${Date.now()}`
  });

  const validatorAvg = validatorResults.length
    ? validatorResults.reduce((sum, cur) => sum + cur.score, 0) / validatorResults.length
    : 1;

  const effectiveCandidateScore = Number(((candidateEval.score * 0.85) + (validatorAvg * 0.15)).toFixed(4));
  const gain = Number((effectiveCandidateScore - baselineEval.score).toFixed(4));

  const candidatePrompt = await insertPromptVersion({
    promptText: candidate.prompt,
    source: "self-improvement-loop",
    status: "candidate",
    qualityScore: effectiveCandidateScore
  });

  const shouldPromote =
    effectiveCandidateScore >= env.QUALITY_THRESHOLD &&
    gain >= env.CANDIDATE_MIN_IMPROVEMENT &&
    validatorResults.every((v) => v.pass || v.score >= 0.6);

  if (!shouldPromote) {
    const runId = await saveImprovementRun({
      triggerReason,
      status: "not-better",
      baselinePromptId: active.id,
      candidatePromptId: candidatePrompt.id,
      baselineScore: baselineEval.score,
      candidateScore: effectiveCandidateScore,
      summary: "Candidato não superou threshold mínimo",
      details: {
        gain,
        validatorResults,
        critique,
        candidateSummary: candidate.changeSummary
      }
    });

    return {
      runId,
      status: "not-better",
      reason: "Candidato abaixo do limiar",
      baselineScore: baselineEval.score,
      candidateScore: effectiveCandidateScore,
      candidatePromptId: candidatePrompt.id
    };
  }

  await activatePrompt(candidatePrompt.id);

  const autoDeployEnabled = env.AUTOPILOT_AUTO_DEPLOY === "true";

  if (!autoDeployEnabled) {
    const runId = await saveImprovementRun({
      triggerReason,
      status: "improved",
      baselinePromptId: active.id,
      candidatePromptId: candidatePrompt.id,
      baselineScore: baselineEval.score,
      candidateScore: effectiveCandidateScore,
      deployId: null,
      summary: "Prompt melhorado — deploy pendente de aprovação manual (AUTOPILOT_AUTO_DEPLOY=false)",
      details: { gain, critique, candidateSummary: candidate.changeSummary, validatorResults, baselineEval, candidateEval, candidateEmbeddingPreview: candidateEmbedding.slice(0, 8) }
    });
    return {
      runId,
      status: "improved",
      reason: "Prompt promovido — deploy aguarda aprovação manual",
      baselineScore: baselineEval.score,
      candidateScore: effectiveCandidateScore,
      candidatePromptId: candidatePrompt.id,
      deployed: false
    };
  }

  const projectRoot = path.resolve(process.cwd());
  const deployment = await deployToVercel(projectRoot);

  const runId = await saveImprovementRun({
    triggerReason,
    status: "improved",
    baselinePromptId: active.id,
    candidatePromptId: candidatePrompt.id,
    baselineScore: baselineEval.score,
    candidateScore: effectiveCandidateScore,
    deployId: deployment.deploymentId,
    summary: "Prompt melhorado e publicado",
    details: {
      gain,
      critique,
      candidateSummary: candidate.changeSummary,
      zipPath: deployment.zipPath,
      deploymentUrl: deployment.deploymentUrl,
      validatorResults,
      baselineEval,
      candidateEval,
      candidateEmbeddingPreview: candidateEmbedding.slice(0, 8)
    }
  });

  return {
    runId,
    status: "improved",
    reason: "Prompt promovido e deploy acionado",
    baselineScore: baselineEval.score,
    candidateScore: effectiveCandidateScore,
    candidatePromptId: candidatePrompt.id,
    deployed: true
  };
}
