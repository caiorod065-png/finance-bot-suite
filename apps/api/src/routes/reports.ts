import type { FastifyInstance } from 'fastify';

// ─── In-memory token store (token → {buffer, expiresAt}) ─────────────────────

type ReportToken = {
  buffer: Buffer;
  expiresAt: number;
  fileName: string;
};

const tokenStore = new Map<string, ReportToken>();
const TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

// Periodic cleanup — run every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of tokenStore) {
    if (entry.expiresAt < now) tokenStore.delete(token);
  }
}, 10 * 60 * 1000).unref();

export function storeReportToken(token: string, buffer: Buffer, fileName: string): void {
  tokenStore.set(token, {
    buffer,
    expiresAt: Date.now() + TOKEN_TTL_MS,
    fileName
  });
}

// ─── Fastify route ────────────────────────────────────────────────────────────

export async function reportRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { token: string } }>(
    '/reports/:token',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } }
    },
    async (req, reply) => {
      const entry = tokenStore.get(req.params.token);

      if (!entry) {
        return reply.status(404).send({ error: 'Relatório não encontrado ou expirado.' });
      }

      if (entry.expiresAt < Date.now()) {
        tokenStore.delete(req.params.token);
        return reply.status(410).send({ error: 'Link expirado. Solicite um novo relatório no WhatsApp.' });
      }

      return reply
        .header('Content-Type', 'application/pdf')
        .header('Content-Disposition', `inline; filename="${entry.fileName}"`)
        .header('Cache-Control', 'private, max-age=3600')
        .send(entry.buffer);
    }
  );
}
