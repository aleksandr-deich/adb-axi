import { setTimeout } from "node:timers/promises";

export interface Clock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const realClock: Clock = {
  now: () => performance.now(),
  sleep: (ms, signal) => setTimeout(ms, undefined, { signal }),
};
