import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../src/config.js';
import { generateScopedSupportReply } from '../src/services/parser.js';

type SampleResult = {
  id: number;
  prompt: string;
  ok: boolean;
  flags: string[];
  reply: string | null;
};

function buildPrompts(): string[] {
  const openers = [
    'quero sim',
    'beleza',
    'show',
    'entendi',
    'iara',
    'ok',
    'vamos',
    'top',
    'certo',
    'manda'
  ];

  const asks = [
    'como posso te mandar meus gastos',
    'como mando meus gastos no dia a dia',
    'como faço para registrar um gasto',
    'como anoto receita',
    'como funciona essa assistente',
    'me explica como usar sem erro',
    'quais comandos principais você entende',
    'como eu começo com você agora',
    'como te passo minhas informações financeiras',
    'o que você faz exatamente'
  ];

  const prompts: string[] = [];
  for (const opener of openers) {
    for (const ask of asks) {
      prompts.push(`${opener}, ${ask}?`);
    }
  }
  return prompts;
}

function analyzeReply(reply: string | null): { ok: boolean; flags: string[] } {
  const flags: string[] = [];
  if (!reply) {
    flags.push('empty_reply');
    return { ok: false, flags };
  }

  const normalized = reply.toLowerCase();

  if (/ate agora, no mes|até agora, no mês|você tem r\$ .* em despesas/.test(normalized)) {
    flags.push('off_target_monthly_summary');
  }
  if (/como posso te ajudar|fico feliz em ajudar/.test(normalized)) {
    flags.push('robotic_phrase');
  }
  if ((reply.match(/\n•/g) ?? []).length >= 7) {
    flags.push('menu_like_reply');
  }
  if (
    !/[?]/.test(reply) &&
    !/\b(me manda|me conte|me conta|manda|envia|me diz|diga)\b/i.test(reply)
  ) {
    flags.push('no_next_step_question');
  }
  if (reply.length < 40) {
    flags.push('too_short');
  }

  return { ok: flags.length === 0, flags };
}

async function run(): Promise<void> {
  if (!config.openAiApiKey) {
    console.error('OPENAI_API_KEY ausente no ambiente. Bateria live cancelada.');
    process.exit(1);
  }

  const prompts = buildPrompts();
  const results: SampleResult[] = [];

  const concurrency = 4;
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < prompts.length) {
      const idx = cursor++;
      const prompt = prompts[idx];
      const reply = await generateScopedSupportReply({
        text: prompt,
        customerName: 'Felipe',
        now: new Date(),
        previousAssistantReply: null,
        recentUserMessages: ['oi iara', 'quero começar hoje'],
        planName: 'Essencial',
        planCode: 'essential',
        monthlyMessageLimit: 500,
        messagesUsedThisMonth: 15,
        availablePlansSummary: 'free, essential, premium, family, elite',
        allowedFeaturesSummary: 'anotação, resumo, limites, metas',
        blockedFeaturesSummary: 'open banking, modo família avançado',
        monthlyIncomeCents: 450000
      });

      const { ok, flags } = analyzeReply(reply);
      results.push({
        id: idx + 1,
        prompt,
        ok,
        flags,
        reply
      });
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  results.sort((a, b) => a.id - b.id);

  const total = results.length;
  const passed = results.filter((item) => item.ok).length;
  const failed = total - passed;
  const flagCount = new Map<string, number>();
  for (const item of results) {
    for (const flag of item.flags) {
      flagCount.set(flag, (flagCount.get(flag) ?? 0) + 1);
    }
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    model: config.openAiModel,
    total,
    passed,
    failed,
    passRate: Number(((passed / total) * 100).toFixed(2)),
    flags: Object.fromEntries([...flagCount.entries()].sort((a, b) => b[1] - a[1]))
  };

  const report = { summary, results };
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const outDir = path.join(root, 'docs', 'reports');
  const outFile = path.join(outDir, 'openai-conversation-battery.json');
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(outFile, JSON.stringify(report, null, 2), 'utf-8');

  console.log(JSON.stringify(summary, null, 2));
  console.log(`Relatório salvo em: ${outFile}`);
}

run().catch((error) => {
  console.error('Falha ao executar bateria OpenAI:', error);
  process.exit(1);
});
