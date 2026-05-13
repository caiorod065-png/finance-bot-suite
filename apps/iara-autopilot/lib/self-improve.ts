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
  return generateJson<CritiqueResponse>(
    `Prompt atual:\n${prompt}\n\nContexto de erros recorrentes:\n${ragContext}\n\nFaça uma crítica técnica e objetiva do prompt para a Iara.`,
    [
      "Você é um avaliador de qualidade de assistentes de WhatsApp.",
      "Retorne JSON com: failures (array), opportunities (array), directives (array).",
      "Foque em: tom humano, anti-repetição, empatia, segurança conversacional, entendimento de lembretes e perguntas ambíguas."
    ].join("\n")
  );
}

async function generateCandidatePrompt(input: {
  currentPrompt: string;
  critique: CritiqueResponse;
  ragContext: string;
}): Promise<CandidatePromptResponse> {
  return generateJson<CandidatePromptResponse>(
    `Prompt atual:\n${input.currentPrompt}\n\nCrítica:\n${JSON.stringify(input.critique, null, 2)}\n\nRAG:\n${input.ragContext}`,
    [
      "Você é um prompt engineer sênior para assistente financeira brasileira no WhatsApp.",
      "Gere uma nova versão de prompt mais natural, empática e segura.",
      "Mantenha foco financeiro e comercial da Iara.",
      "Inclua regras para: não repetir resposta, não executar ação em pergunta, confirmação em ambiguidade, lembretes precisos.",
      "Retorne JSON com: prompt (string) e changeSummary (array)."
    ].join("\n")
  );
}

async function runSimulation(input: {
  prompt: string;
  cases: SimulationCase[];
}): Promise<{ score: number; details: SimulationEvaluation[] }> {
  const details: SimulationEvaluation[] = [];

  for (const simulationCase of input.cases.slice(0, env.MAX_SIMULATION_CASES)) {
    const iaraReply = await generateText(
      `Contexto: ${simulationCase.context ?? "sem contexto"}\nUsuário: ${simulationCase.input}\n\nResponda como Iara.`,
      input.prompt
    );

    const evaluation = await generateJson<SimulationEvaluation>(
      `Caso:\n${JSON.stringify(simulationCase, null, 2)}\n\nResposta da Iara:\n${iaraReply}`,
      [
        "Você é avaliador de qualidade de resposta da Iara.",
        "Pontue de 0 a 1 os campos:",
        "- score",
        "- conversationalNaturalness",
        "- antiRepetition",
        "- empathy",
        "- transactionalSafety",
        "Retorne também notes curtas.",
        "Saída obrigatória em JSON."
      ].join("\n")
    );

    details.push(evaluation);
  }

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
