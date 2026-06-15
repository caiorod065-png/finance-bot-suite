import OpenAI from 'openai';
import { config } from '../config.js';
import { adminMetrics, listCustomers } from './ledger.js';

// ─── Twilio API helpers ───────────────────────────────────────────────────────

async function fetchTwilioLiveData(): Promise<{
  balanceUsd: number | null;
  monthlySpendUsd: number | null;
  autoRechargeNote: string;
}> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) return { balanceUsd: null, monthlySpendUsd: null, autoRechargeNote: 'credenciais não configuradas' };

  const auth = Buffer.from(`${sid}:${token}`).toString('base64');
  const headers = { Authorization: `Basic ${auth}` };

  try {
    const [balRes, usageRes] = await Promise.all([
      fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Balance.json`, { headers }),
      fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Usage/Records/ThisMonth.json`, { headers }),
    ]);

    const balData = await balRes.json() as { balance?: string };
    const usageData = await usageRes.json() as { usage_records?: Array<{ price?: string; price_unit?: string }> };

    const balanceUsd = balData.balance ? Number(balData.balance) : null;
    const monthlySpendUsd = (usageData.usage_records ?? []).reduce((sum, r) => {
      return sum + (r.price_unit === 'usd' ? Number(r.price || 0) : 0);
    }, 0);

    return {
      balanceUsd,
      monthlySpendUsd: Number(monthlySpendUsd.toFixed(4)),
      autoRechargeNote: 'configuração gerenciada pelo console Twilio (não exposta via API REST)',
    };
  } catch {
    return { balanceUsd: null, monthlySpendUsd: null, autoRechargeNote: 'erro ao consultar API Twilio' };
  }
}

const client = config.openAiApiKey
  ? new OpenAI({ apiKey: config.openAiApiKey, organization: config.openAiOrganizationId || undefined })
  : null;

export type JardesMessage = {
  role: 'user' | 'assistant';
  content: string;
};

// System prompt is built per-call so date/time are always current.
function buildSystemPrompt(): string {
  const today = new Date().toLocaleDateString('pt-BR', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
  const now = new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });

  return `Você é Jardes — assistente executivo do Felipe, fundador e CEO do Iara Bot.

Seu papel: braço direito do Felipe. Gestor geral do projeto, conselheiro estratégico, analista de dados, resolvedor de problemas. Age com autonomia de execução, alinhado aos objetivos do Felipe.

PERSONALIDADE:
- Executivo experiente, não chatbot. Tom: direto, confiante, caloroso quando necessário.
- Raciocínio estruturado quando a pergunta exige análise. Admita incerteza quando houver.
- Nunca use linguagem de manual ("como posso ajudá-lo?", "claro, posso fazer isso!").
- Conversa rápida = resposta curta. Decisão estratégica = análise profunda.
- Responda sempre em português brasileiro.

PROJETO IARA BOT:
SaaS de assistente financeiro pessoal via WhatsApp. IA (GPT-4.1-mini), Node.js/Fastify + PostgreSQL + n8n.
Clientes interagem 100% via WhatsApp.

PLANOS (preços reais do sistema):
| Plano     | Preço       | Msgs/mês | Membros |
|-----------|-------------|----------|---------|
| Gratuito  | R$ 0        | 20       | 1       |
| Essencial | R$ 49,90    | 180      | 1       |
| Premium   | R$ 99,90    | 550      | 1       |
| Família   | R$ 179,90   | 1.200    | 3 base  |
| Elite     | R$ 349,90   | 2.500    | 15      |

Regras comerciais: sem taxa de ativação. Família: +R$34,90/membro extra até 15 total.
Bloqueio automático após inadimplência + 3 dias de tolerância.
Custo IA/msg (gpt-4.1-mini): ~R$0,0022 — margem é alta em todos os planos pagos.

STACK: Node.js 20+/Fastify/TypeScript, PostgreSQL 16, OpenAI, Meta Cloud API (WhatsApp), Twilio (fallback), Asaas (cobranças Pix).

CAPACIDADES NESTE CONTEXTO (painel admin):
- Analisar dados de negócio com métricas reais do sistema
- Responder dúvidas técnicas, comerciais ou estratégicas
- Sugerir melhorias de produto, pricing, conversão e retenção
- Ajudar a priorizar backlog
- Redigir textos, scripts, mensagens

Hoje: ${today}, ${now} (Brasília)`;
}

async function fetchCostContext(): Promise<string> {
  const rate = config.costUsdBrlRate || 5.5;
  const fmt = (usd: number) => `US$ ${usd.toFixed(2)} (R$ ${(usd * rate).toFixed(2)})`;

  const twilio = await fetchTwilioLiveData();

  const twilioSpendUsd = twilio.monthlySpendUsd ?? config.costTwilioMonthlyUsd;
  const openAiUsd = config.costOpenAiMonthlyUsd;
  const supabaseUsd = config.costSupabaseMonthlyUsd;
  const infraUsd = config.costInfraMonthlyUsd;
  const otherUsd = config.costOtherMonthlyUsd;
  const totalUsd = twilioSpendUsd + openAiUsd + supabaseUsd + infraUsd + otherUsd;

  const lines = [
    `CUSTOS DE PLATAFORMA (mês corrente):`,
    `- Twilio (API WhatsApp):  ${fmt(twilioSpendUsd)}${twilio.monthlySpendUsd !== null ? ' [live]' : ' [config manual]'}`,
    `- Twilio saldo atual:     US$ ${twilio.balanceUsd?.toFixed(2) ?? 'n/d'}`,
    `- OpenAI (API IA):        ${fmt(openAiUsd)} [config manual — atualize COST_OPENAI_MONTHLY_USD no .env]`,
    `- Supabase (banco):       ${fmt(supabaseUsd)}`,
    `- Infra/servidores:       ${fmt(infraUsd)}`,
    `- Outros:                 ${fmt(otherUsd)}`,
    `- TOTAL PLATAFORMA:       ${fmt(totalUsd)}`,
    `- Taxa câmbio usada:      1 USD = R$ ${rate}`,
    `Nota auto-recharge Twilio: ${twilio.autoRechargeNote}.`,
  ];
  return lines.join('\n');
}

async function fetchBusinessContext(): Promise<string> {
  try {
    const metrics = await adminMetrics();
    const customers = await listCustomers();
    const byPlan = customers.reduce<Record<string, number>>((acc, c) => {
      const p = c.planCode ?? 'unknown';
      acc[p] = (acc[p] ?? 0) + 1;
      return acc;
    }, {});
    return [
      `DADOS REAIS DO SISTEMA (agora):`,
      `- Clientes ativos: ${metrics.activeCustomers}`,
      `- Online última hora: ${metrics.customersOnline1h}`,
      `- Online últimas 24h: ${metrics.customersOnline24h}`,
      `- Inativos 7 dias: ${metrics.inactive7d}`,
      `- Novos hoje: ${metrics.newCustomersToday}`,
      `- Inadimplentes: ${metrics.pastDueCustomers}`,
      `- Aguardando ativação: ${metrics.pendingSetupCustomers}`,
      `- Em período de teste: ${metrics.trialCustomers ?? 0}`,
      `- Gastos do mês (clientes): R$ ${((metrics.expensesThisMonthCents ?? 0) / 100).toFixed(2)}`,
      `- Distribuição por plano: ${JSON.stringify(byPlan)}`,
    ].join('\n');
  } catch {
    return 'Dados do sistema indisponíveis no momento.';
  }
}

function isCostQuestion(messages: JardesMessage[]): boolean {
  const last = messages.at(-1)?.content?.toLowerCase() ?? '';
  return /\b(custo|cust|gast|api|twilio|openai|open.?ai|supabase|infra|plataforma|mensal|despesa|quanto.*(pago|custa|gasto)|gasto.*quanto)\b/.test(last);
}

export async function chatWithJardes(params: {
  messages: JardesMessage[];
  includeMetrics?: boolean;
}): Promise<{ reply: string; tokensUsed: number }> {
  if (!client) {
    return {
      reply: 'Felipe, a API da OpenAI não está configurada neste ambiente. Configure OPENAI_API_KEY no .env para que eu possa operar.',
      tokensUsed: 0,
    };
  }

  let systemPrompt = buildSystemPrompt();

  const shouldIncludeCosts = isCostQuestion(params.messages);
  const [businessCtx, costCtx] = await Promise.all([
    params.includeMetrics ? fetchBusinessContext() : Promise.resolve(null),
    shouldIncludeCosts ? fetchCostContext() : Promise.resolve(null),
  ]);

  if (businessCtx) systemPrompt = `${systemPrompt}\n\n${businessCtx}`;
  if (costCtx) systemPrompt = `${systemPrompt}\n\n${costCtx}`;

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    ...params.messages.map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    })),
  ];

  const response = await client.chat.completions.create({
    model: config.openAiAgentModel,
    messages,
    max_tokens: 1500,
    temperature: 0.7,
  });

  const reply = response.choices[0]?.message?.content?.trim() ?? 'Não consegui gerar uma resposta agora. Tente novamente.';
  const tokensUsed = response.usage?.total_tokens ?? 0;

  return { reply, tokensUsed };
}
