import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getAdminSessionFromRequest } from '../services/admin-auth.js';
import { chatWithJardes, type JardesMessage } from '../services/jardes.js';

const chatSchema = z.object({
  messages: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string().min(1).max(4000)
  })).min(1).max(50),
  includeMetrics: z.boolean().optional().default(false)
});

function auth(headers: Record<string, unknown>): boolean {
  return Boolean(getAdminSessionFromRequest(headers));
}

export async function jardesRoutes(app: FastifyInstance): Promise<void> {
  app.post('/admin/jardes/chat', async (request, reply) => {
    if (!auth(request.headers as Record<string, unknown>)) {
      return reply.status(401).send({ error: 'unauthorized' });
    }

    const body = chatSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: 'invalid_body', details: body.error.flatten() });
    }

    try {
      const result = await chatWithJardes({
        messages: body.data.messages as JardesMessage[],
        includeMetrics: body.data.includeMetrics
      });
      return { ok: true, reply: result.reply, tokensUsed: result.tokensUsed };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown_error';
      return reply.status(500).send({ error: 'jardes_error', details: message });
    }
  });
}
