import type { AdbClient } from "../../adb/run.js";
import { readLaunchCrashes, type LaunchCrash } from "../../android/launch-crash.js";
import type { ReadOptions } from "../../android/read.js";
import { AdbAxiError } from "../../core/errors.js";
import { poll, realClock } from "../../core/poll.js";

export class LaunchWatch {
  private constructor(
    private readonly adb: AdbClient,
    private readonly serial: string,
    private readonly userId: number,
    private readonly options: ReadOptions,
    private readonly baseline: Set<string>,
  ) {}

  static async open(
    adb: AdbClient,
    serial: string,
    userId: number,
    options: ReadOptions,
  ): Promise<LaunchWatch> {
    const baseline = new Set(
      (await readLaunchCrashes(adb, serial, options)).map((crash) => crash.key),
    );
    return new LaunchWatch(adb, serial, userId, options, baseline);
  }

  async check(options = this.options): Promise<LaunchCrash[]> {
    return (await readLaunchCrashes(this.adb, this.serial, options)).filter(
      (crash) => crash.userId === this.userId && !this.baseline.has(crash.key),
    );
  }

  async during<T>(
    start: (signal: AbortSignal) => Promise<T>,
    died: (crash: LaunchCrash, signal: AbortSignal) => Promise<AdbAxiError | null>,
  ): Promise<T> {
    const controller = new AbortController();
    const signal = controller.signal;
    const starting = start(signal);
    const monitoring = (async (): Promise<T> => {
      try {
        await poll({
          timeoutMs: this.options.deadline.remainingMs(),
          clock: { now: () => realClock.now(), sleep: (ms) => realClock.sleep(ms, signal) },
          check: async () => {
            signal.throwIfAborted();
            for (const crash of await this.check({ ...this.options, signal })) {
              signal.throwIfAborted();
              const error = await died(crash, signal);
              if (error !== null) throw error;
            }
            return { done: false, last: null };
          },
        });
        return await starting;
      } catch (error) {
        if (error instanceof AdbAxiError && error.code === "TIMEOUT") return starting;
        throw error;
      }
    })();
    try {
      return await Promise.race([starting, monitoring]);
    } finally {
      controller.abort();
      await Promise.allSettled([starting, monitoring]);
    }
  }
}
