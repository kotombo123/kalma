/** Per-channel circuit breaker: opens after 3 consecutive failures, auto-resets after 60 s. */

type CircuitState = 'closed' | 'open';

interface CircuitEntry {
  state: CircuitState;
  failures: number;
  openUntil: number;
}

const breakers = new Map<string, CircuitEntry>();

const FAILURE_THRESHOLD = 3;
const OPEN_DURATION_MS = 60_000;

export function isCircuitOpen(channel: string): boolean {
  const cb = breakers.get(channel);
  if (!cb || cb.state === 'closed') return false;
  if (Date.now() > cb.openUntil) {
    breakers.set(channel, { state: 'closed', failures: 0, openUntil: 0 });
    return false;
  }
  return true;
}

export function recordFailure(channel: string): void {
  const cb = breakers.get(channel) ?? { state: 'closed' as const, failures: 0, openUntil: 0 };
  const failures = cb.failures + 1;
  if (failures >= FAILURE_THRESHOLD) {
    breakers.set(channel, { state: 'open', failures, openUntil: Date.now() + OPEN_DURATION_MS });
  } else {
    breakers.set(channel, { ...cb, failures });
  }
}

export function recordSuccess(channel: string): void {
  breakers.set(channel, { state: 'closed', failures: 0, openUntil: 0 });
}

/** For tests only — reset all breakers to closed. */
export function resetBreakers(): void {
  breakers.clear();
}
