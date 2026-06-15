import { config } from '../config.js';
import { isCustomerInsideConversationWindowByWhatsapp } from './ledger.js';

function digitsOnly(value: string): string {
  return value.replace(/\D/g, '');
}

function normalizeE164(value: string): string {
  const cleaned = value.trim();
  if (cleaned.startsWith('+')) return cleaned;
  const digits = digitsOnly(cleaned);
  return digits ? `+${digits}` : cleaned;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function outsideWindowLikely(errorText: string | undefined): boolean {
  const normalized = String(errorText ?? '').toLowerCase();
  if (!normalized) return false;
  return (
    normalized.includes('63015') ||
    normalized.includes('outside the allowed window') ||
    normalized.includes('outside the customer care window') ||
    normalized.includes('twilio delivery failed')
  );
}

function normalizeTwilioFrom(raw: string): string {
  return raw.startsWith('whatsapp:') ? raw : `whatsapp:${normalizeE164(raw)}`;
}

function normalizeTwilioTo(raw: string): string {
  return `whatsapp:${normalizeE164(raw)}`;
}

function twilioAuthHeader(accountSid: string, authToken: string): string {
  return Buffer.from(`${accountSid}:${authToken}`).toString('base64');
}

function resolveOutboundStrategy(params: {
  hasTemplateSid: boolean;
  hasMetaTemplate: boolean;
  outsideConversationWindow: boolean | null;
  templateOutside24hEnabled: boolean;
}): 'meta_template_first' | 'twilio_template_first' | 'freeform_first' {
  if (!params.templateOutside24hEnabled) return 'freeform_first';
  if (params.outsideConversationWindow !== true) return 'freeform_first';
  if (params.hasMetaTemplate) return 'meta_template_first';
  if (params.hasTemplateSid) return 'twilio_template_first';
  return 'freeform_first';
}

async function fetchTwilioMessageStatus(params: {
  accountSid: string;
  authToken: string;
  sid: string;
}): Promise<{ status?: string; errorCode?: number | null }> {
  const basic = Buffer.from(`${params.accountSid}:${params.authToken}`).toString('base64');
  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${params.accountSid}/Messages/${params.sid}.json`,
    {
      method: 'GET',
      headers: {
        Authorization: `Basic ${basic}`
      }
    }
  );

  if (!response.ok) return {};
  const body = await response.json().catch(() => ({} as any));
  return {
    status: body?.status,
    errorCode: body?.error_code ?? null
  };
}

async function sendViaMetaTemplate(to: string, templateBody: string): Promise<boolean> {
  if (!config.whatsappToken || !config.whatsappPhoneNumberId) return false;
  if (!config.metaWhatsappTemplateName) return false;

  const response = await fetch(`https://graph.facebook.com/v22.0/${config.whatsappPhoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.whatsappToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: digitsOnly(to),
      type: 'template',
      template: {
        name: config.metaWhatsappTemplateName,
        language: { code: 'pt_BR' },
        components: [
          {
            type: 'body',
            parameters: [{ type: 'text', text: templateBody.slice(0, 950) }]
          }
        ]
      }
    })
  });

  const bodyText = await response.text().catch(() => '');
  let parsed: any = null;
  try { parsed = bodyText ? JSON.parse(bodyText) : null; } catch { parsed = null; }

  if (!response.ok || parsed?.error) {
    const msg = parsed?.error?.message ?? bodyText ?? `Meta template API ${response.status}`;
    throw new Error(`Meta template error: ${msg}`);
  }

  return true;
}

async function sendViaMetaCloud(to: string, message: string): Promise<boolean> {
  if (!config.whatsappToken || !config.whatsappPhoneNumberId) {
    return false;
  }

  const response = await fetch(`https://graph.facebook.com/v22.0/${config.whatsappPhoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.whatsappToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: digitsOnly(to),
      type: 'text',
      text: { body: message }
    })
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Meta API ${response.status}: ${body}`);
  }

  return true;
}

async function sendViaTwilio(to: string, message: string): Promise<boolean> {
  if (!config.twilioAccountSid || !config.twilioAuthToken || !config.twilioWhatsappFrom) {
    return false;
  }

  const basic = twilioAuthHeader(config.twilioAccountSid, config.twilioAuthToken);
  const form = new URLSearchParams({
    From: normalizeTwilioFrom(config.twilioWhatsappFrom),
    To: normalizeTwilioTo(to),
    Body: message
  });

  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${config.twilioAccountSid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: form.toString()
  });

  const bodyText = await response.text().catch(() => '');
  let parsed: any = null;
  try {
    parsed = bodyText ? JSON.parse(bodyText) : null;
  } catch {
    parsed = null;
  }

  if (!response.ok) {
    const errorMessage =
      parsed?.message ||
      parsed?.error_message ||
      bodyText ||
      `Twilio API ${response.status}`;
    throw new Error(`Twilio API ${response.status}: ${errorMessage}`);
  }

  // Twilio pode responder HTTP 2xx e ainda retornar falha de canal (ex.: WhatsApp fora da janela).
  const status = String(parsed?.status ?? '').toLowerCase();
  const errorCode = parsed?.error_code;
  if (status === 'failed' || status === 'undelivered' || errorCode) {
    const details = [status || 'unknown_status', errorCode ? `error_code=${errorCode}` : '']
      .filter(Boolean)
      .join(' ');
    throw new Error(`Twilio delivery failed: ${details}`.trim());
  }

  // Em WhatsApp, algumas falhas aparecem poucos instantes após criar a mensagem.
  // Faz uma checagem curta para evitar falso positivo de envio.
  const sid = typeof parsed?.sid === 'string' ? parsed.sid : '';
  if (sid && ['queued', 'accepted', 'sending', 'sent'].includes(status)) {
    await sleep(1200);
    const followUp = await fetchTwilioMessageStatus({
      accountSid: config.twilioAccountSid,
      authToken: config.twilioAuthToken,
      sid
    });
    const finalStatus = String(followUp.status ?? '').toLowerCase();
    if (finalStatus === 'failed' || finalStatus === 'undelivered' || followUp.errorCode) {
      const details = [finalStatus || 'unknown_status', followUp.errorCode ? `error_code=${followUp.errorCode}` : '']
        .filter(Boolean)
        .join(' ');
      throw new Error(`Twilio delivery failed: ${details}`.trim());
    }
  }

  return true;
}

async function sendViaTwilioTemplate(to: string, message: string): Promise<boolean> {
  if (!config.twilioAccountSid || !config.twilioAuthToken || !config.twilioWhatsappFrom) {
    return false;
  }
  if (!config.twilioWhatsappTemplateSid) {
    return false;
  }

  const basic = twilioAuthHeader(config.twilioAccountSid, config.twilioAuthToken);
  const base = {
    From: normalizeTwilioFrom(config.twilioWhatsappFrom),
    To: normalizeTwilioTo(to),
    ContentSid: config.twilioWhatsappTemplateSid
  };

  const attempts: URLSearchParams[] = [
    new URLSearchParams({
      ...base,
      // Template fallback genérico: variável 1 carrega a mensagem dinâmica.
      ContentVariables: JSON.stringify({ '1': message.slice(0, 950) })
    }),
    new URLSearchParams(base)
  ];

  let lastError = '';
  for (const form of attempts) {
    const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${config.twilioAccountSid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: form.toString()
    });

    const bodyText = await response.text().catch(() => '');
    let parsed: any = null;
    try {
      parsed = bodyText ? JSON.parse(bodyText) : null;
    } catch {
      parsed = null;
    }

    if (!response.ok) {
      const errorMessage =
        parsed?.message ||
        parsed?.error_message ||
        bodyText ||
        `Twilio API ${response.status}`;
      lastError = `Twilio template ${response.status}: ${errorMessage}`;
      continue;
    }

    const status = String(parsed?.status ?? '').toLowerCase();
    const errorCode = parsed?.error_code;
    if (status === 'failed' || status === 'undelivered' || errorCode) {
      lastError = `Twilio template delivery failed: ${status || 'unknown_status'}${errorCode ? ` error_code=${errorCode}` : ''}`.trim();
      continue;
    }

    const sid = typeof parsed?.sid === 'string' ? parsed.sid : '';
    if (sid && ['queued', 'accepted', 'sending', 'sent'].includes(status)) {
      await sleep(1200);
      const followUp = await fetchTwilioMessageStatus({
        accountSid: config.twilioAccountSid,
        authToken: config.twilioAuthToken,
        sid
      });
      const finalStatus = String(followUp.status ?? '').toLowerCase();
      if (finalStatus === 'failed' || finalStatus === 'undelivered' || followUp.errorCode) {
        lastError = `Twilio template delivery failed: ${finalStatus || 'unknown_status'}${followUp.errorCode ? ` error_code=${followUp.errorCode}` : ''}`.trim();
        continue;
      }
    }

    return true;
  }

  throw new Error(lastError || 'Falha ao enviar template Twilio');
}

async function isOutsideConversationWindow(to: string): Promise<boolean | null> {
  try {
    const inWindow = await isCustomerInsideConversationWindowByWhatsapp(to, 24);
    if (inWindow === null) return null;
    return !inWindow;
  } catch {
    return null;
  }
}

export async function sendWhatsAppText(params: {
  to: string;
  message: string;
}): Promise<{ sent: boolean; provider?: 'meta' | 'meta-template' | 'twilio' | 'twilio-template'; error?: string }> {
  let lastError: string | undefined;
  const hasTemplateSid = Boolean(config.twilioWhatsappTemplateSid);
  const hasMetaTemplate = Boolean(config.whatsappToken && config.metaWhatsappTemplateName);
  const outsideWindow = await isOutsideConversationWindow(params.to);

  if (outsideWindow === true && !hasMetaTemplate && !hasTemplateSid) {
    return { sent: false, error: 'customer_outside_window_no_template' };
  }

  const strategy = resolveOutboundStrategy({
    hasTemplateSid,
    hasMetaTemplate,
    outsideConversationWindow: outsideWindow,
    templateOutside24hEnabled: config.twilioTemplateOutside24hEnabled
  });

  // — Fora da janela: Meta template é o canal primário —
  if (strategy === 'meta_template_first') {
    try {
      await sendViaMetaTemplate(params.to, params.message);
      return { sent: true, provider: 'meta-template' };
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'Falha ao enviar meta-template';
    }
    // fallback para Twilio template se Meta falhar
    if (hasTemplateSid) {
      try {
        await sendViaTwilioTemplate(params.to, params.message);
        return { sent: true, provider: 'twilio-template' };
      } catch (error) {
        lastError = error instanceof Error ? error.message : lastError;
      }
    }
    return { sent: false, error: lastError ?? 'Falha em todos os canais de template' };
  }

  // — Fora da janela: Twilio template (sem Meta configurado) —
  if (strategy === 'twilio_template_first') {
    try {
      await sendViaTwilioTemplate(params.to, params.message);
      return { sent: true, provider: 'twilio-template' };
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'Falha ao enviar twilio-template';
    }
    return { sent: false, error: lastError ?? 'Falha ao enviar template Twilio' };
  }

  // — Dentro da janela (freeform_first): Twilio → Meta —
  try {
    await sendViaTwilio(params.to, params.message);
    return { sent: true, provider: 'twilio' };
  } catch (error) {
    lastError = error instanceof Error ? error.message : 'Falha ao enviar via Twilio';
    // Se Twilio indicar janela fechada, tenta template imediatamente
    if (outsideWindowLikely(lastError)) {
      if (hasMetaTemplate) {
        try {
          await sendViaMetaTemplate(params.to, params.message);
          return { sent: true, provider: 'meta-template' };
        } catch (templateError) {
          lastError = templateError instanceof Error ? templateError.message : lastError;
        }
      }
      if (hasTemplateSid) {
        try {
          await sendViaTwilioTemplate(params.to, params.message);
          return { sent: true, provider: 'twilio-template' };
        } catch (templateError) {
          lastError = templateError instanceof Error ? templateError.message : lastError;
        }
      }
    }
  }

  try {
    await sendViaMetaCloud(params.to, params.message);
    return { sent: true, provider: 'meta' };
  } catch (error) {
    lastError = error instanceof Error ? error.message : 'Falha ao enviar via Meta';
  }

  return {
    sent: false,
    error: lastError ?? 'Nenhum canal de envio (Meta/Twilio) está configurado.'
  };
}

export async function sendPaymentThanksMessage(params: {
  to: string;
  customerName?: string | null;
  paymentType: 'setup' | 'monthly';
  planName?: string | null;
  planFeatures?: string[];
  familyInviteCodes?: string[];
}): Promise<{ sent: boolean; provider?: 'meta' | 'meta-template' | 'twilio' | 'twilio-template' }> {
  const firstName = params.customerName?.trim().split(/\s+/)[0] ?? 'cliente';
  const planLabel = params.planName ? `plano ${params.planName}` : 'seu plano';

  let text: string;
  // Trata primeira ativação (paymentType setup OU first monthly sem setup fee)
  const isActivation = params.paymentType === 'setup' ||
    (params.paymentType === 'monthly' && params.planFeatures !== undefined);
  if (isActivation) {
    const lines = [
      `Perfeito, ${firstName}! ✅ Pagamento confirmado — seu acesso ao ${planLabel} foi liberado agora.`
    ];

    if (params.planFeatures && params.planFeatures.length > 0) {
      lines.push(`No seu plano você tem: ${params.planFeatures.join(', ')}.`);
    }

    if (params.familyInviteCodes && params.familyInviteCodes.length > 0) {
      lines.push('');
      lines.push('👨‍👩‍👧‍👦 *Seu Plano Família inclui 3 membros.* Envie esses códigos de convite para os outros:');
      params.familyInviteCodes.forEach((code, i) => {
        lines.push(`  Membro ${i + 2}: *${code}*`);
      });
      lines.push('');
      lines.push('Como usar: a pessoa só precisa me chamar no WhatsApp e enviar o código. Eu reconheço e já adiciono ela ao seu grupo.');
    }

    lines.push('Obrigada por assinar comigo — vamos construir muitos meses de evolução financeira juntos. 🚀');
    text = lines.join('\n');
  } else {
    text = `Pagamento confirmado, ${firstName}! ✅ Mensalidade do ${planLabel} em dia. Seguimos firmes no controle financeiro este mês.`;
  }

  const sent = await sendWhatsAppText({
    to: params.to,
    message: text
  });
  return { sent: sent.sent, provider: sent.provider };
}

const WELCOME_MESSAGES: Record<string, (firstName: string) => string> = {
  free: (firstName) =>
    `Seja bem-vindo(a), ${firstName}! 🎉\n` +
    `Seu acesso ao plano Gratuito está ativo.\n` +
    `Me chama quando quiser anotar um gasto, ver um resumo ou só entender melhor como eu funciono. Estou aqui o tempo todo — respondo em menos de 10 segundos.\n` +
    `Pode me tratar como sua assistente pessoal. Sem frescura, sem complicação.\n` +
    `Sempre que quiser evoluir seu controle financeiro, me avisa. Tenho planos feitos pra isso. 😉`,

  essential: (firstName) =>
    `Que bom ter você aqui, ${firstName}! 🙌\n` +
    `Seu plano Essencial está ativo — e esse é um dos melhores primeiros passos que você podia dar pelo seu dinheiro.\n` +
    `Me conta os gastos do jeito que você fala no dia a dia, que eu organizo tudo pra você. Sem planilha, sem app complicado, sem dor de cabeça.\n` +
    `Pode me chamar como se fosse uma secretária dedicada só a você: qualquer hora, te respondo em menos de 10 segundos. Total atenção.\n` +
    `Vamos juntos — esse mês é o primeiro de muitos. 💚`,

  premium: (firstName) =>
    `Bem-vindo(a) ao Premium, ${firstName}! ✨\n` +
    `Você escolheu o plano com melhor custo-benefício — e eu vou fazer valer cada centavo.\n` +
    `Com até 500 mensagens por mês, dá pra ir fundo: limites, metas, insights de comportamento, previsão de saldo, alertas automáticos. Cuido de tudo isso por você.\n` +
    `Me trata como sua assistente financeira pessoal — pode perguntar qualquer coisa, a qualquer hora. Respondo em menos de 10 segundos, com atenção total.\n` +
    `Esse mês começa agora. Me conta o primeiro gasto quando quiser. 💰`,

  family: (firstName) =>
    `Família reunida, dinheiro organizado, ${firstName}! 👨‍👩‍👧\n` +
    `Seu plano Família está ativo — agora vocês podem cuidar das finanças juntos, cada um do seu celular.\n` +
    `Me trata como a assistente financeira da família: anoto gastos, aviso sobre limites, mostro o resumo do mês inteiro — de todos. Qualquer hora, respondo em menos de 10 segundos.\n` +
    `Esse é o começo de uma gestão financeira diferente pra vocês. Conte comigo. 💚`,

  elite: (firstName) =>
    `Bem-vindo(a) ao topo, ${firstName}. 🏆\n` +
    `Seu plano Elite está ativo — e a partir de agora você tem acesso completo a tudo que eu faço: até 5.000 mensagens por mês, até 15 membros, importação Open Banking, relatórios visuais mensais e muito mais.\n` +
    `Me trata como sua diretora financeira pessoal: estou aqui pra antecipar riscos, identificar padrões, sugerir ajustes e manter seu dinheiro sempre sob controle.\n` +
    `Qualquer hora, te respondo em menos de 10 segundos. Atenção total — sem exceção.\n` +
    `Fala comigo quando quiser. Esse mês começa agora. 🚀`
};

export async function sendWelcomeActivationMessage(params: {
  to: string;
  customerName?: string | null;
  planCode: string;
  familyInviteCodes?: string[];
}): Promise<{ sent: boolean; provider?: 'meta' | 'meta-template' | 'twilio' | 'twilio-template' }> {
  const firstName = params.customerName?.trim().split(/\s+/)[0] ?? 'cliente';
  const buildMessage = WELCOME_MESSAGES[params.planCode] ?? WELCOME_MESSAGES['essential'];
  const lines = [buildMessage(firstName)];

  if (params.familyInviteCodes && params.familyInviteCodes.length > 0) {
    lines.push('');
    lines.push('👨‍👩‍👧‍👦 *Convites para os outros membros:*');
    params.familyInviteCodes.forEach((code, i) => {
      lines.push(`  Membro ${i + 2}: *${code}*`);
    });
    lines.push('');
    lines.push('Como usar: a pessoa só precisa me chamar no WhatsApp e enviar o código. Eu reconheço e já adiciono ela ao grupo.');
  }

  const sent = await sendWhatsAppText({ to: params.to, message: lines.join('\n') });
  return { sent: sent.sent, provider: sent.provider };
}

export const __whatsappOutboundTestables = {
  outsideWindowLikely,
  resolveOutboundStrategy,
};
