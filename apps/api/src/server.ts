import Fastify from 'fastify';
import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import rateLimit from '@fastify/rate-limit';
import { config } from './config.js';
import { healthRoutes } from './routes/health.js';
import { webhookRoutes } from './routes/webhooks.js';
import { adminRoutes } from './routes/admin.js';
import { billingRoutes } from './routes/billing.js';
import { jardesRoutes } from './routes/jardes.js';
import { openFinanceRoutes } from './routes/openfinance.js';
import { reportRoutes } from './routes/reports.js';
import { startProactiveScheduler, stopProactiveScheduler } from './services/proactive-scheduler.js';
import { ensureJardesSchema } from './services/jardes-analysis.js';

const app = Fastify({ logger: true });

await app.register(cors, {
  origin: config.allowedOrigins.length > 0
    ? config.allowedOrigins
    : ['http://localhost:3000', 'http://localhost:8080', 'http://localhost:3001'],
  credentials: true,
});
await app.register(formbody);
await app.register(rateLimit, {
  global: true,
  max: 120,
  timeWindow: '1 minute',
  skipOnError: false,
  addHeaders: {
    'x-ratelimit-limit': true,
    'x-ratelimit-remaining': true,
    'x-ratelimit-reset': true,
  },
});

await app.register(healthRoutes);
await app.register(webhookRoutes);
await app.register(adminRoutes);
await app.register(billingRoutes);
await app.register(jardesRoutes);
await app.register(openFinanceRoutes);
await app.register(reportRoutes);

const start = async (): Promise<void> => {
  try {
    await app.listen({ port: config.port, host: '0.0.0.0' });
    app.log.info(`Finance Bot API running on ${config.port}`);
    await ensureJardesSchema();
    startProactiveScheduler(app.log);
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
};

app.addHook('onClose', async () => {
  stopProactiveScheduler();
});

await start();
