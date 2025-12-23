export interface BackoffOptions {
  initialMs: number;
  maxMs: number;
  factor: number;
  jitterRatio: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = {
  initialMs: 1_000,
  maxMs: 30_000,
  factor: 1.5,
  jitterRatio: 0.2,
};

export function backoffDelayMs(
  attempt: number,
  opts: Partial<BackoffOptions> = {}
): number {
  const o: BackoffOptions = { ...DEFAULT_BACKOFF, ...opts };
  const base = Math.min(o.initialMs * Math.pow(o.factor, attempt), o.maxMs);
  const jitter = base * o.jitterRatio;
  const randomized = base + (Math.random() * 2 - 1) * jitter;
  return Math.max(0, Math.floor(randomized));
}
