import type { FastifyInstance } from 'fastify';
import { getCircuitState } from '../services/openai-circuit-breaker.js';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async () => {
    const circuit = getCircuitState();
    return {
      ok: circuit.state !== 'open',
      service: 'finance-bot-api',
      timestamp: new Date().toISOString(),
      openai: {
        circuitState: circuit.state,
        failureCount: circuit.failureCount
      }
    };
  });
}
