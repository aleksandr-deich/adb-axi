import { realClock, type Clock } from "./poll.js";

/**
 * One deadline for a whole command (`--timeout` or the command's default). Every device
 * call takes what is left of it, so a command can never outlive its deadline by more than
 * one killed child.
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
