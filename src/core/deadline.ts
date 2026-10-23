import { realClock, type Clock } from "./clock.js";

/**
 * A monotonic time budget for a command or a bounded read. See `observe` in poll.ts
 * for deadline-edge read handling and README.md for user-facing timeout semantics.
 */
export class Deadline {
  readonly totalMs: number;
  private readonly end: number;
  private readonly clock: Clock;

  constructor(totalMs: number, clock: Clock = realClock) {
    this.totalMs = totalMs;
    this.clock = clock;
    this.end = clock.now() + totalMs;
  }

  remainingMs(): number {
    return Math.max(0, Math.floor(this.end - this.clock.now()));
  }
}
