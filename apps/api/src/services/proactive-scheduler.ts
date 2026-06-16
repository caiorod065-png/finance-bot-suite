import cron from 'node-cron';
import { config } from '../config.js';
import { runProactiveAlerts, type ProactiveRunResult } from './proactive-alerts.js';
import { ensureJardesSchema, runJardesAnalysis, sendDailyDoubtDigest } from './jardes-analysis.js';

type LoggerLike = {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
};

type ProactiveSchedulerState = {
  enabled: boolean;
  intervalMinutes: number;
  startupDelaySeconds: number;
  customerLimit: number;
  running: boolean;
  runCount: number;
  lastRunAt: string | null;
  lastRunSummary: ProactiveRunResult | null;
  lastError: string | null;
};

const state: ProactiveSchedulerState = {
  enabled: config.proactiveAutomationEnabled,
  intervalMinutes: Math.max(1, config.proactiveAutomationIntervalMinutes || 15),
  startupDelaySeconds: Math.max(0, config.proactiveAutomationStartupDelaySeconds || 20),
  customerLimit: Math.max(1, config.proactiveAutomationCustomerLimit || 1000),
  running: false,
  runCount: 0,
  lastRunAt: null,
  lastRunSummary: null,
  lastError: null
};

let intervalHandle: NodeJS.Timeout | null = null;
let startupHandle: NodeJS.Timeout | null = null;
let jardesIntervalHandle: NodeJS.Timeout | null = null;
let jardesStartupHandle: NodeJS.Timeout | null = null;
let doubtDigestCronTask: cron.ScheduledTask | null = null;

async function runOneCycle(logger: LoggerLike): Promise<void> {
  if (!state.enabled) return;
  if (state.running) {
    logger.warn(
      {
        running: true,
        runCount: state.runCount
      },
      'Proactive scheduler skipped cycle because previous run is still in progress'
    );
    return;
  }

  state.running = true;
  state.lastError = null;
  const startedAt = new Date();
  state.lastRunAt = startedAt.toISOString();

  try {
    const result = await runProactiveAlerts({
      referenceDate: startedAt,
      timezone: config.defaultTimezone,
      customerLimit: state.customerLimit
    });
    state.runCount += 1;
    state.lastRunSummary = result;
    const realFailures = result.failures.filter(f => f.reason !== 'customer_outside_window_no_template');
    logger.info(
      {
        runAt: result.runAt,
        customersScanned: result.customersScanned,
        customersEligible: result.customersEligible,
        bomDiasSent: result.bomDiasSent,
        inactivityAlertsSent: result.inactivityAlertsSent,
        followUpCheckinsSent: result.followUpCheckinsSent,
        riskAlertsSent: result.riskAlertsSent,
        progressAlertsSent: result.progressAlertsSent,
        reminderAlertsSent: result.reminderAlertsSent,
        weeklySummariesSent: result.weeklySummariesSent,
        scoreEvolutionsSent: result.scoreEvolutionsSent,
        monthlyVisualReportsSent: result.monthlyVisualReportsSent,
        limitAlertsSent: result.limitAlertsSent,
        renewalRemindersSent: result.renewalRemindersSent,
        goalAlertsSent: result.goalAlertsSent,
        familyRiskAlertsSent: result.familyRiskAlertsSent,
        failures: result.failures.length,
        realFailures: realFailures.length,
        failureReasons: realFailures.slice(0, 5).map(f => ({ id: f.customerId.slice(0, 8), reason: f.reason.slice(0, 80) }))
      },
      'Proactive scheduler cycle completed'
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown_error';
    state.lastError = message;
    logger.error(
      {
        error: message
      },
      'Proactive scheduler cycle failed'
    );
  } finally {
    state.running = false;
  }
}

async function runJardesCycle(logger: LoggerLike): Promise<void> {
  try {
    await ensureJardesSchema();
    const result = await runJardesAnalysis({ sinceHours: 6, automated: true });
    logger.info(
      { conversationsReviewed: result.conversationsReviewed, issuesFound: result.issuesFound, proposalsSent: result.proposalsSent },
      'Jardes analysis cycle completed'
    );
  } catch (error) {
    logger.error({ error: error instanceof Error ? error.message : 'unknown' }, 'Jardes analysis cycle failed');
  }
}

export function startProactiveScheduler(logger: LoggerLike): void {
  state.enabled = config.proactiveAutomationEnabled;
  state.intervalMinutes = Math.max(1, config.proactiveAutomationIntervalMinutes || 15);
  state.startupDelaySeconds = Math.max(0, config.proactiveAutomationStartupDelaySeconds || 20);
  state.customerLimit = Math.max(1, config.proactiveAutomationCustomerLimit || 1000);

  if (!state.enabled) {
    logger.info(
      {
        enabled: false
      },
      'Proactive scheduler disabled by PROACTIVE_AUTOMATION_ENABLED'
    );
    return;
  }

  const intervalMs = state.intervalMinutes * 60 * 1000;
  const startupDelayMs = state.startupDelaySeconds * 1000;

  if (startupHandle) clearTimeout(startupHandle);
  if (intervalHandle) clearInterval(intervalHandle);

  startupHandle = setTimeout(() => {
    void runOneCycle(logger);
  }, startupDelayMs);

  intervalHandle = setInterval(() => {
    void runOneCycle(logger);
  }, intervalMs);

  logger.info(
    {
      intervalMinutes: state.intervalMinutes,
      startupDelaySeconds: state.startupDelaySeconds,
      customerLimit: state.customerLimit
    },
    'Proactive scheduler started'
  );

  // Jardes analysis: first run 3 minutes after startup, then every 6 hours
  const jardesFirstDelayMs = 3 * 60 * 1000;
  const jardesIntervalMs = 6 * 60 * 60 * 1000;

  if (jardesStartupHandle) clearTimeout(jardesStartupHandle);
  if (jardesIntervalHandle) clearInterval(jardesIntervalHandle);

  jardesStartupHandle = setTimeout(() => {
    void runJardesCycle(logger);
  }, jardesFirstDelayMs);

  jardesIntervalHandle = setInterval(() => {
    void runJardesCycle(logger);
  }, jardesIntervalMs);

  logger.info({ intervalHours: 6, firstDelayMinutes: 3 }, 'Jardes analysis scheduler started');

  // Daily doubt digest: cron às 22:00 horário de São Paulo (survives API restarts)
  scheduleDoubtDigest(logger);
}

function scheduleDoubtDigest(logger: LoggerLike): void {
  if (doubtDigestCronTask) doubtDigestCronTask.stop();

  doubtDigestCronTask = cron.schedule('0 22 * * *', async () => {
    try {
      const result = await sendDailyDoubtDigest();
      if (result.sent) {
        logger.info({ doubtCount: result.doubtCount }, 'Daily doubt digest sent');
      } else {
        logger.info({}, 'Daily doubt digest: no doubts to send today');
      }
    } catch (error) {
      logger.error({ error: error instanceof Error ? error.message : 'unknown' }, 'Daily doubt digest failed');
    }
  }, { timezone: config.defaultTimezone });

  logger.info({ timezone: config.defaultTimezone }, 'Daily doubt digest scheduled via cron at 22:00');
}

export function stopProactiveScheduler(): void {
  if (startupHandle) { clearTimeout(startupHandle); startupHandle = null; }
  if (intervalHandle) { clearInterval(intervalHandle); intervalHandle = null; }
  if (jardesStartupHandle) { clearTimeout(jardesStartupHandle); jardesStartupHandle = null; }
  if (jardesIntervalHandle) { clearInterval(jardesIntervalHandle); jardesIntervalHandle = null; }
  if (doubtDigestCronTask) { doubtDigestCronTask.stop(); doubtDigestCronTask = null; }
}

export function getProactiveSchedulerState(): ProactiveSchedulerState {
  return {
    ...state
  };
}
