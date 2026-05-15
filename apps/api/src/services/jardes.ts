import OpenAI from 'openai';
import { config } from '../config.js';
import { adminMetrics, listCustomers } from './ledger.js';

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

PLANOS:
| Plano     | Preço      | Msgs/mês | Membros |
|-----------|------------|----------|---------|
| Gratuito  | R$ 0       | 20       | 1       |
| Essencial | R$ 39,90   | 160      | 1       |
| Premium   | R$ 79,90   | 500      | 1       |
| Família   | R$ 149,90  | 1.400    | 3 base  |
| Elite     | R$ 299,90  | 5.000    | 15      |

Regras comerciais: sem taxa de ativação. Família: +R$29,90/membro extra até 15 total.
Bloqueio automático após inadimplência + 3 dias de tolerância.

STACK: Node.js 20+/Fastify/TypeScript, PostgreSQL 16, OpenAI, Meta Cloud API (WhatsApp), Twilio (fallback), Asaas (cobranças Pix).

CAPACIDADES NESTE CONTEXTO (painel admin):
- Analisar dados de negócio com métricas reais do sistema
- Responder dúvidas técnicas, comerciais ou estratégicas
- Sugerir melhorias de produto, pricing, conversão e retenção
- Ajudar a priorizar backlog
- Redigir textos, scripts, mensagens

Hoje: ${today}, ${now} (Brasília)`;
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

  if (params.includeMetrics) {
    const context = await fetchBusinessContext();
    systemPrompt = `${systemPrompt}\n\n${context}`;
  }

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
