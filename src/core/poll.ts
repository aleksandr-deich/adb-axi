/** Poll interval bounds for every wait (7.4): never busier than 250 ms, never lazier than 500 ms. */
export const MIN_INTERVAL_MS = 250;
export const MAX_INTERVAL_MS = 500;
export const DEFAULT_INTERVAL_MS = 400;

/** Time source for polling. Tests inject a fake one; production uses the real clock. */
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
  now: () => performance.now(),
  sleep: (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
};

export type Observation<TValue, TLast> =
  { done: true; value: TValue } | { done: false; last: TLast };

export interface PollOptions<TValue, TLast> {
  /** Total time allowed, in milliseconds. */
  timeoutMs: number;
  intervalMs?: number;
  clock?: Clock;
  /**
   * One observation. Receives the time left so a device call can take it as its deadline.
   * The final observation, taken at the deadline, receives 0.
   */
  check: (remainingMs: number) => Promise<Observation<TValue, TLast>>;
}

export type PollResult<TValue, TLast> =
  | { ok: true; value: TValue; waitedMs: number; attempts: number }
  | { ok: false; last: TLast | undefined; waitedMs: number; attempts: number };

/**
 * Observe until `check` reports done or the deadline passes. A final observation is
 * taken at the deadline, so a state reached during the last interval is not missed.
 * The caller turns a timeout into its own error (`WAIT_TIMEOUT`, `KILL_TIMEOUT`, ...)
 * with `last` as the evidence.
 */
export async function poll<TValue, TLast>(
  options: PollOptions<TValue, TLast>,
): Promise<PollResult<TValue, TLast>> {
  const interval = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  if (!Number.isFinite(interval) || interval < MIN_INTERVAL_MS || interval > MAX_INTERVAL_MS) {
    throw new RangeError(
      `Poll interval ${interval} ms is outside ${MIN_INTERVAL_MS}-${MAX_INTERVAL_MS} ms`,
    );
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0) {
    throw new RangeError(`Poll timeout ${options.timeoutMs} ms is not a valid duration`);
  }
  const clock = options.clock ?? realClock;
  const start = clock.now();
  const deadline = start + options.timeoutMs;
  let last: TLast | undefined;
  let attempts = 0;

  for (;;) {
    attempts++;
    const observation = await options.check(Math.max(0, deadline - clock.now()));
    const waitedMs = Math.round(clock.now() - start);
    if (observation.done) {
      return { ok: true, value: observation.value, waitedMs, attempts };
    }
    last = observation.last;
    const remaining = deadline - clock.now();
    if (remaining <= 0) {
      return { ok: false, last, waitedMs, attempts };
    }
    await clock.sleep(Math.min(interval, remaining));
  }
}
