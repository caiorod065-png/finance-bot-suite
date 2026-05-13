import { embed } from "@/lib/openai";
import { getRecentAssistantReplies, logConversationMessage, logQualityIssue } from "@/lib/db";
import { evaluateAssistantMessage } from "@/lib/quality";
import type { ParsedWebhookEvent } from "@/lib/whatsapp-parser";

export async function ingestParsedWebhook(parsed: ParsedWebhookEvent): Promise<{ stored: number; issues: number }> {
  let stored = 0;
  let issues = 0;

  for (const event of parsed.events) {
    const logged = await logConversationMessage({
      provider: parsed.provider,
      conversationId: event.conversationId,
      customerPhone: event.customerPhone,
      direction: event.direction,
      role: event.role,
      body: event.body,
      createdAt: event.createdAt,
      meta: event.meta
    });
    stored += 1;

    if (event.role === "assistant" || event.direction === "outbound") {
      const previousAssistantReplies = await getRecentAssistantReplies(event.conversationId, 6);
      const userMessageContext = String(event.meta?.lastUserMessage ?? "");
      const signals = evaluateAssistantMessage({
        reply: event.body,
        userMessage: userMessageContext,
        previousAssistantReplies
      });

      if (signals.score < 0.95 || signals.complaintSignal || signals.repetitive || signals.robotic) {
        const embedding = await embed(`${event.body}\n${signals.reasons.join(" ")}`);
        await logQualityIssue({
          messageId: logged.id,
          conversationId: event.conversationId,
          qualityScore: signals.score,
          isRobotic: signals.robotic,
          isRepetitive: signals.repetitive,
          lacksEmpathy: signals.lacksEmpathy,
          hallucinationRisk: signals.hallucinationRisk,
          userComplaintSignal: signals.complaintSignal,
          reasons: signals.reasons,
          embedding
        });
        issues += 1;
      }
    }
  }

  return { stored, issues };
}
