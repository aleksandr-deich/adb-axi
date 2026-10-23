import { realClock, type Clock } from "./clock.js";
import { Deadline } from "./deadline.js";
import { AdbAxiError } from "./errors.js";

export { realClock, type Clock } from "./clock.js";

/** Poll interval bounds for every wait (7.4): never busier than 250 ms, never lazier than 500 ms. */
export const MIN_INTERVAL_MS = 250;
export const MAX_INTERVAL_MS = 500;
export const DEFAULT_INTERVAL_MS = 400;

export interface ObserveOptions<T> {
  deadline: Deadline;
  read: (deadline: Deadline) => Promise<T>;
  done: (value: T) => boolean;
  intervalMs?: number;
  clock?: Clock;
  readCapMs?: number;
  windowMs?: number;
  requireObservation?: boolean;
}

export function observe<T, TDone extends T>(
  options: Omit<ObserveOptions<T>, "done"> & { done: (value: T) => value is TDone },
): Promise<PollResult<TDone, T>>;
export function observe<T>(options: ObserveOptions<T>): Promise<PollResult<T, T>>;
/**
 * A timed-out read keeps the last completed observation; `requireObservation` instead
 * propagates TIMEOUT until a read completes. Other errors always propagate.
 * A deadline-edge read needs its own budget or AdbClient refuses it without reading.
 * See the final-interval regression in test/unit/poll.test.ts.
 */
export async function observe<T>(options: ObserveOptions<T>): Promise<PollResult<T, T>> {
  const clock = options.clock ?? realClock;
  let last: T | undefined;
  return poll({
    timeoutMs: Math.min(options.windowMs ?? Infinity, options.deadline.remainingMs()),
    ...(options.intervalMs === undefined ? {} : { intervalMs: options.intervalMs }),
    clock,
    check: async () => {
      const remaining = options.deadline.remainingMs();
      const deadline =
        remaining < MAX_INTERVAL_MS
          ? new Deadline(MAX_INTERVAL_MS, clock)
          : options.readCapMs === undefined || remaining <= options.readCapMs
            ? options.deadline
            : new Deadline(options.readCapMs, clock);
      let value: T;
      try {
        value = await options.read(deadline);
      } catch (error) {
        if (
          !(error instanceof AdbAxiError && error.code === "TIMEOUT") ||
          (options.requireObservation === true && last === undefined)
        )
          throw error;
        return { done: false, last };
      }
      last = value;
      return options.done(value) ? { done: true, value } : { done: false, last: value };
    },
  });
}

export type Observation<TValue, TLast> =
  { done: true; value: TValue } | { done: false; last: TLast };

export interface PollOptions<TValue, TLast> {
  /** Total time allowed, in milliseconds. */
  timeoutMs: number;
  intervalMs?: number;
  clock?: Clock;
  /**
   * One observation with the time left in the polling window (0 at its edge).
   * For device state reads, prefer `observe`, which supplies a usable read deadline.
   */
  check: (remainingMs: number) => Promise<Observation<TValue, TLast>>;
}

export type PollResult<TValue, TLast> =
  | { ok: true; value: TValue; waitedMs: number; attempts: number }
  | { ok: false; last: TLast | undefined; waitedMs: number; attempts: number };

/**
 * Schedule `check` until done or the polling window ends. Checks start one interval
 * apart; one slower than the interval is followed by the next at once. Sleeping stops
 * at the deadline for a final check; an in-flight check can finish later.
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
    const observedAt = clock.now();
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
    await clock.sleep(Math.min(Math.max(0, interval - (clock.now() - observedAt)), remaining));
  }
}
