type CircuitState = 'closed' | 'open' | 'half-open';

const FAILURE_THRESHOLD = 5;
const OPEN_DURATION_MS = 30_000;
const WINDOW_MS = 60_000;

let state: CircuitState = 'closed';
let failureCount = 0;
let firstFailureAt = 0;
let openedAt = 0;

export function isCircuitOpen(): boolean {
  if (state === 'closed') return false;

  if (state === 'open') {
    if (Date.now() - openedAt >= OPEN_DURATION_MS) {
      state = 'half-open';
      return false;
    }
    return true;
  }

  return false; // half-open: let one request through
}

export function recordSuccess(): void {
  state = 'closed';
  failureCount = 0;
  firstFailureAt = 0;
}

export function recordFailure(): void {
  const now = Date.now();

  if (state === 'half-open') {
    state = 'open';
    openedAt = now;
    return;
  }

  if (failureCount === 0) firstFailureAt = now;

  // Reset window if failures are stale
  if (now - firstFailureAt > WINDOW_MS) {
    failureCount = 1;
    firstFailureAt = now;
    return;
  }

  failureCount += 1;

  if (failureCount >= FAILURE_THRESHOLD) {
    state = 'open';
    openedAt = now;
  }
}

export async function withBreaker<T>(fn: () => Promise<T>, fallback: () => T): Promise<T> {
  if (isCircuitOpen()) return fallback();

  try {
    const result = await fn();
    recordSuccess();
    return result;
  } catch (error) {
    recordFailure();
    throw error;
  }
}

export function getCircuitState(): { state: CircuitState; failureCount: number } {
  return { state, failureCount };
}
