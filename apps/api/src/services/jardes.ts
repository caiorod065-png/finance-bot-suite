import OpenAI from 'openai';
import { readFileSync } from 'node:fs';
import { config } from '../config.js';
import { adminMetrics, listCustomers } from './ledger.js';
import { getActiveKnowledgeEntries, getConversationsForAnalysis } from './jardes-analysis.js';

async function fetchTwilioLiveData(): Promise<{ balanceUsd: number | null; monthlySpendUsd: number | null; autoRechargeNote: string; }> {
  const sid = process.env.TWILIO_ACCOUNT_SID, token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) return { balanceUsd: null, monthlySpendUsd: null, autoRechargeNote: 'credenciais não configuradas' };
  const headers = { Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}` };
  try {
    const [balanceRes, usageRes] = await Promise.all([
      fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Balance.json`, { headers }),
      fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Usage/Records/ThisMonth.json`, { headers }),
    ]);
    const balanceData = await balanceRes.json() as { balance?: string };
    const usageData = await usageRes.json() as { usage_records?: Array<{ price?: string; price_unit?: string }> };
    const monthlySpendUsd = (usageData.usage_records ?? []).reduce((sum, record) => sum + (record.price_unit === 'usd' ? Number(record.price || 0) : 0), 0);
    return { balanceUsd: balanceData.balance ? Number(balanceData.balance) : null, monthlySpendUsd: Number(monthlySpendUsd.toFixed(4)), autoRechargeNote: 'configuração gerenciada pelo console Twilio (não exposta via API REST)' };
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

let cachedApiVersion: string | null = null;

function readApiVersion(): string {
  if (cachedApiVersion !== null) return cachedApiVersion;

  try {
    const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: string };
    cachedApiVersion = packageJson.version ?? 'unknown';
  } catch {
    cachedApiVersion = 'unknown';
  }

  return cachedApiVersion;
}

function normalizeDigits(value: string | null | undefined): string {
  return (value ?? '').replace(/\D/g, '');
}

function parsePositiveInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function formatUptime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0 || parts.length > 0) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);
  return parts.join(' ');
}

function safeCurrency(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function buildSystemPrompt(includeMetrics?: boolean): string {
  const today = new Date().toLocaleDateString('pt-BR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const now = new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
  return [
    'Você é Jardes — assistente executivo do Felipe, fundador e CEO do Iara Bot.',
    'Seu papel: braço direito do Felipe. Gestor geral do projeto, conselheiro estratégico, analista de dados, resolvedor de problemas. Age com autonomia de execução, alinhado aos objetivos do Felipe.',
    'PERSONALIDADE:\n- Executivo experiente, não chatbot. Tom: direto, confiante, caloroso quando necessário.\n- Raciocínio estruturado quando a pergunta exige análise. Admita incerteza quando houver.\n- Nunca use linguagem de manual ("como posso ajudá-lo?", "claro, posso fazer isso!").\n- Conversa rápida = resposta curta. Decisão estratégica = análise profunda.\n- Responda sempre em português brasileiro.',
    'PROJETO IARA BOT:\nSaaS de assistente financeiro pessoal via WhatsApp. IA (GPT-4.1-mini), Node.js/Fastify + PostgreSQL + n8n.\nClientes interagem 100% via WhatsApp.',
    'PLANOS (preços reais do sistema):\n| Plano     | Preço       | Msgs/mês | Membros |\n|-----------|-------------|----------|---------|\n| Gratuito  | R$ 0        | 20       | 1       |\n| Essencial | R$ 49,90    | 180      | 1       |\n| Premium   | R$ 99,90    | 550      | 1       |\n| Família   | R$ 179,90   | 1.200    | 3 base  |\n| Elite     | R$ 349,90   | 2.500    | 15      |',
    'Regras comerciais: sem taxa de ativação. Família: +R$34,90/membro extra até 15 total.\nBloqueio automático após inadimplência + 3 dias de tolerância.\nCusto IA/msg (gpt-4.1-mini): ~R$0,0022 — margem é alta em todos os planos pagos.',
    'STACK: Node.js 20+/Fastify/TypeScript, PostgreSQL 16, OpenAI, Meta Cloud API (WhatsApp), Twilio (fallback), Asaas (cobranças Pix).',
    'CAPACIDADES NESTE CONTEXTO (painel admin):\n- Analisar dados de negócio com métricas reais do sistema\n- Responder dúvidas técnicas, comerciais ou estratégicas\n- Sugerir melhorias de produto, pricing, conversão e retenção\n- Ajudar a priorizar backlog\n- Redigir textos, scripts, mensagens\n- Consultar ferramentas internas de métricas, custos, clientes, conversas e conhecimento quando precisar de dados reais',
    includeMetrics ? 'Contexto adicional: o painel abriu em modo de análise administrativa; prefira dados reais antes de inferir.' : '',
    `Hoje: ${today}, ${now} (Brasília)`,
  ].filter(Boolean).join('\n');
}

function createFunctionTool(name: string, description: string, parameters: Record<string, unknown>) {
  return { type: 'function', function: { name, description, parameters } };
}

function buildTools() {
  const empty = { type: 'object', properties: {}, additionalProperties: false };
  return [
    createFunctionTool('get_business_metrics', 'Busca métricas reais do negócio e um resumo da base de clientes por plano.', empty),
    createFunctionTool('get_cost_breakdown', 'Busca o breakdown de custos da operação, incluindo Twilio ao vivo e custos fixos da configuração.', empty),
    createFunctionTool('lookup_customer_by_phone', 'Procura um cliente pelo número de telefone e retorna o melhor match com dados da assinatura.', {
      type: 'object',
      properties: { phone: { type: 'string', description: 'Número de telefone completo ou parcial, com ou sem máscara.' } },
      required: ['phone'],
      additionalProperties: false,
    }),
    createFunctionTool('get_recent_conversations', 'Busca conversas recentes para análise de contexto e comportamento dos clientes.', {
      type: 'object',
      properties: { sinceHours: { type: 'number', minimum: 1, maximum: 168, description: 'Janela temporal em horas.' } },
      additionalProperties: false,
    }),
    createFunctionTool('get_system_status', 'Retorna o status geral do sistema, versão da API, uptime e distribuição dos planos ativos.', empty),
    createFunctionTool('list_customers_by_plan', 'Lista clientes agrupados por plano com contagens e amostras úteis para análise.', {
      type: 'object',
      properties: { limitPerPlan: { type: 'number', minimum: 1, maximum: 25, description: 'Quantidade máxima de clientes a retornar por plano.' } },
      additionalProperties: false,
    }),
    createFunctionTool('get_active_knowledge_entries', 'Retorna as regras ativas e conhecimento operacional registrados pelo Jardes.', empty),
  ];
}

function stringifyToolResult(value: unknown): string {
  return JSON.stringify(value);
}

function customerMatchScore(queryDigits: string, phone: string): number {
  const digits = normalizeDigits(phone);
  if (!queryDigits || !digits) return -1;
  if (digits === queryDigits) return 1000 + digits.length;
  if (digits.endsWith(queryDigits) || queryDigits.endsWith(digits)) return 800 + Math.min(digits.length, queryDigits.length);
  if (digits.includes(queryDigits) || queryDigits.includes(digits)) return 600 + Math.min(digits.length, queryDigits.length);
  return -1;
}

function summarizeCustomersByPlan(customers: Awaited<ReturnType<typeof listCustomers>>, sampleLimit = 8) {
  const buckets = new Map<string, {
    planCode: string;
    planName: string;
    total: number;
    active: number;
    inactive: number;
    trialActive: number;
    pastDue: number;
    pendingSetup: number;
    sample: Array<{
      id: string;
      name: string | null;
      whatsappNumber: string;
      subscriptionStatus: string;
      isActive: boolean;
      trialActive: boolean;
      trialDaysLeft: number;
      nextDueDate: string | null;
    }>;
  }>();

  for (const customer of customers) {
    const key = customer.planCode;
    const bucket = buckets.get(key) ?? {
      planCode: customer.planCode,
      planName: customer.planName,
      total: 0,
      active: 0,
      inactive: 0,
      trialActive: 0,
      pastDue: 0,
      pendingSetup: 0,
      sample: [],
    };

    bucket.total += 1;
    if (customer.isActive) bucket.active += 1;
    else bucket.inactive += 1;
    if (customer.trialActive) bucket.trialActive += 1;
    if (customer.subscriptionStatus === 'past_due') bucket.pastDue += 1;
    if (customer.subscriptionStatus === 'pending_setup_payment') bucket.pendingSetup += 1;
    if (bucket.sample.length < sampleLimit) {
      bucket.sample.push({
        id: customer.id,
        name: customer.name,
        whatsappNumber: customer.whatsappNumber,
        subscriptionStatus: customer.subscriptionStatus,
        isActive: customer.isActive,
        trialActive: customer.trialActive,
        trialDaysLeft: customer.trialDaysLeft,
        nextDueDate: customer.nextDueDate,
      });
    }

    buckets.set(key, bucket);
  }

  return Array.from(buckets.values()).sort((a, b) => b.total - a.total || a.planName.localeCompare(b.planName, 'pt-BR'));
}

function toCustomerLookupEntry(customer: Awaited<ReturnType<typeof listCustomers>>[number]) {
  return {
    id: customer.id,
    name: customer.name,
    whatsappNumber: customer.whatsappNumber,
    planCode: customer.planCode,
    planName: customer.planName,
    subscriptionStatus: customer.subscriptionStatus,
    isActive: customer.isActive,
    trialActive: customer.trialActive,
    trialDaysLeft: customer.trialDaysLeft,
    monthlyMessageLimit: customer.monthlyMessageLimit,
    nextDueDate: customer.nextDueDate,
    lastInboundAt: customer.lastInboundAt,
    referralCount: customer.referralCount,
    effectiveMonthlyFeeCents: customer.effectiveMonthlyFeeCents,
    monthlyIncomeCents: customer.monthlyIncomeCents,
  };
}

async function executeToolCall(name: string, argumentsJson: string | undefined): Promise<string> {
  let parsed: Record<string, unknown> = {};
  if (argumentsJson && argumentsJson.trim()) {
    try {
      parsed = JSON.parse(argumentsJson) as Record<string, unknown>;
    } catch {
      return stringifyToolResult({ error: 'invalid_arguments', tool: name, details: 'Não foi possível interpretar os argumentos da ferramenta.' });
    }
  }

  try {
    switch (name) {
      case 'get_business_metrics': {
        const [metrics, customers] = await Promise.all([adminMetrics(), listCustomers()]);
        const planBreakdown = summarizeCustomersByPlan(customers, 5).map((bucket) => ({
          planCode: bucket.planCode,
          planName: bucket.planName,
          total: bucket.total,
          active: bucket.active,
          inactive: bucket.inactive,
          trialActive: bucket.trialActive,
          pastDue: bucket.pastDue,
          pendingSetup: bucket.pendingSetup,
        }));

        return stringifyToolResult({
          snapshotAt: new Date().toISOString(),
          metrics,
          customers: {
            total: customers.length,
            active: customers.filter((customer) => customer.isActive).length,
            inactive: customers.filter((customer) => !customer.isActive).length,
          },
          planBreakdown,
        });
      }

      case 'get_cost_breakdown': {
        const rate = Number.isFinite(config.costUsdBrlRate) && config.costUsdBrlRate > 0 ? config.costUsdBrlRate : 5.5;
        const twilio = await fetchTwilioLiveData();
        const twilioMonthlyUsd = twilio.monthlySpendUsd ?? safeCurrency(config.costTwilioMonthlyUsd);
        const openAiMonthlyUsd = safeCurrency(config.costOpenAiMonthlyUsd);
        const supabaseMonthlyUsd = safeCurrency(config.costSupabaseMonthlyUsd);
        const infraMonthlyUsd = safeCurrency(config.costInfraMonthlyUsd);
        const otherMonthlyUsd = safeCurrency(config.costOtherMonthlyUsd);
        const totalMonthlyUsd = twilioMonthlyUsd + openAiMonthlyUsd + supabaseMonthlyUsd + infraMonthlyUsd + otherMonthlyUsd;

        const lineItems = [
          { key: 'twilio', label: 'Twilio', monthlyUsd: twilioMonthlyUsd, monthlyBrl: twilioMonthlyUsd * rate, source: twilio.monthlySpendUsd !== null ? 'live' : 'manual' },
          { key: 'openai', label: 'OpenAI', monthlyUsd: openAiMonthlyUsd, monthlyBrl: openAiMonthlyUsd * rate, source: 'config' },
          { key: 'supabase', label: 'Supabase', monthlyUsd: supabaseMonthlyUsd, monthlyBrl: supabaseMonthlyUsd * rate, source: 'config' },
          { key: 'infra', label: 'Infra', monthlyUsd: infraMonthlyUsd, monthlyBrl: infraMonthlyUsd * rate, source: 'config' },
          { key: 'other', label: 'Outros', monthlyUsd: otherMonthlyUsd, monthlyBrl: otherMonthlyUsd * rate, source: 'config' },
        ];

        return stringifyToolResult({
          snapshotAt: new Date().toISOString(),
          currency: { usdBrlRate: rate },
          twilio: {
            balanceUsd: twilio.balanceUsd,
            monthlySpendUsd: twilio.monthlySpendUsd,
            autoRechargeNote: twilio.autoRechargeNote,
          },
          lineItems,
          totals: {
            monthlyUsd: totalMonthlyUsd,
            monthlyBrl: totalMonthlyUsd * rate,
          },
        });
      }

      case 'lookup_customer_by_phone': {
        const phone = typeof parsed.phone === 'string' ? parsed.phone : '';
        const digits = normalizeDigits(phone);
        if (digits.length < 8) {
          return stringifyToolResult({ error: 'invalid_phone', phone, details: 'Informe um telefone com ao menos 8 dígitos.' });
        }

        const customers = await listCustomers();
        const matches = customers
          .map((customer) => ({
            score: customerMatchScore(digits, customer.whatsappNumber),
            customer,
          }))
          .filter((item) => item.score >= 0)
          .sort((a, b) => b.score - a.score || Number(b.customer.isActive) - Number(a.customer.isActive))
          .slice(0, 5)
          .map((item) => ({
            score: item.score,
            ...toCustomerLookupEntry(item.customer),
          }));

        return stringifyToolResult({
          query: phone,
          normalizedDigits: digits,
          matchCount: matches.length,
          matches,
        });
      }

      case 'get_recent_conversations': {
        const sinceHours = parsePositiveInt(parsed.sinceHours, 24, 1, 168);
        const conversations = await getConversationsForAnalysis(sinceHours);
        return stringifyToolResult({
          snapshotAt: new Date().toISOString(),
          sinceHours,
          conversationCount: conversations.length,
          conversations: conversations.slice(0, 10).map((conversation) => ({
            customerId: conversation.customerId,
            customerName: conversation.customerName,
            messageCount: conversation.messages.length,
            messages: conversation.messages.map((message) => ({
              direction: message.direction,
              message: message.message.slice(0, 300),
            })),
          })),
        });
      }

      case 'get_system_status': {
        const customers = await listCustomers();
        const activePlans = summarizeCustomersByPlan(customers, 3)
          .filter((bucket) => bucket.active > 0)
          .map((bucket) => ({
            planCode: bucket.planCode,
            planName: bucket.planName,
            activeCustomers: bucket.active,
            sample: bucket.sample.map((customer) => ({
              name: customer.name,
              whatsappNumber: customer.whatsappNumber,
              subscriptionStatus: customer.subscriptionStatus,
            })),
          }));

        const metrics = await adminMetrics();
        return stringifyToolResult({
          snapshotAt: new Date().toISOString(),
          version: readApiVersion(),
          nodeVersion: process.version,
          uptime: {
            seconds: Math.floor(process.uptime()),
            human: formatUptime(process.uptime()),
          },
          metrics: {
            activeCustomers: metrics.activeCustomers,
            customersOnline1h: metrics.customersOnline1h,
            customersOnline24h: metrics.customersOnline24h,
            inactive7d: metrics.inactive7d,
            trialCustomers: metrics.trialCustomers,
            pastDueCustomers: metrics.pastDueCustomers,
          },
          activePlans,
        });
      }

      case 'list_customers_by_plan': {
        const limitPerPlan = parsePositiveInt(parsed.limitPerPlan, 8, 1, 25);
        const customers = await listCustomers();
        return stringifyToolResult({
          snapshotAt: new Date().toISOString(),
          totalCustomers: customers.length,
          plans: summarizeCustomersByPlan(customers, limitPerPlan),
        });
      }

      case 'get_active_knowledge_entries': {
        const entries = await getActiveKnowledgeEntries();
        return stringifyToolResult({
          snapshotAt: new Date().toISOString(),
          count: entries.length,
          entries,
        });
      }

      default:
        return stringifyToolResult({ error: 'unknown_tool', tool: name });
    }
  } catch (error) {
    return stringifyToolResult({
      error: 'tool_execution_failed',
      tool: name,
      details: error instanceof Error ? error.message : String(error),
    });
  }
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

  const systemPrompt = buildSystemPrompt(params.includeMetrics);
  const conversation: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    ...params.messages.map((message) => ({
      role: message.role,
      content: message.content,
    })),
  ];

  let tokensUsed = 0;
  let finalReply = '';

  for (let iteration = 0; iteration < 5; iteration += 1) {
    const response = await client.chat.completions.create({
      model: config.openAiAgentModel,
      messages: conversation,
      tools: buildTools() as any,
      tool_choice: 'auto',
      max_tokens: 2000,
      temperature: 0.4,
    });

    const usage = response.usage;
    tokensUsed += usage?.total_tokens ?? ((usage?.prompt_tokens ?? 0) + (usage?.completion_tokens ?? 0));

    const assistantMessage = response.choices[0]?.message;
    if (!assistantMessage) break;

    conversation.push({
      role: 'assistant',
      content: assistantMessage.content ?? null,
      tool_calls: assistantMessage.tool_calls,
    } as any);

    if (response.choices[0]?.finish_reason !== 'tool_calls' || !assistantMessage.tool_calls?.length) {
      finalReply = assistantMessage.content?.trim() ?? '';
      break;
    }

    for (const toolCall of assistantMessage.tool_calls) {
      if (toolCall.type !== 'function') {
        conversation.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: stringifyToolResult({
            error: 'unsupported_tool_call_type',
            toolCallType: toolCall.type,
          }),
        } as any);
        continue;
      }

      const toolResult = await executeToolCall(toolCall.function.name, toolCall.function.arguments);
      conversation.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: toolResult,
      } as any);
    }
  }

  if (!finalReply) {
    finalReply = 'Não consegui concluir a resposta com segurança neste momento. Tente novamente com um escopo mais específico.';
  }

  return { reply: finalReply, tokensUsed };
}
