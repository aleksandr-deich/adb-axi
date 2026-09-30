import { describe, expect, it } from "vitest";
import { poll, type Clock, type Observation } from "../../src/core/poll.js";

/** A clock that advances only when the code under test sleeps (or a check takes time). */
function fakeClock(): Clock & { sleeps: number[]; advance(ms: number): void } {
  let now = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => now,
    advance: (ms) => {
      now += ms;
    },
    sleep: (ms) => {
      sleeps.push(ms);
      now += ms;
      return Promise.resolve();
    },
  };
}

describe("poll", () => {
  it("returns as soon as the state is reached, with waited_ms", async () => {
    const clock = fakeClock();
    let n = 0;
    const result = await poll({
      timeoutMs: 15_000,
      intervalMs: 400,
      clock,
      check: () =>
        Promise.resolve(
          ++n === 4 ? { done: true, value: "foreground" } : { done: false, last: `state-${n}` },
        ),
    });
    expect(result).toEqual({ ok: true, value: "foreground", waitedMs: 1200, attempts: 4 });
    expect(clock.sleeps).toEqual([400, 400, 400]);
  });

  it("times out with the last observation and a final check at the deadline", async () => {
    const clock = fakeClock();
    const seenAt: number[] = [];
    const result = await poll<never, { boot_completed: number }>({
      timeoutMs: 1000,
      intervalMs: 400,
      clock,
      check: () => {
        seenAt.push(clock.now());
        return Promise.resolve({ done: false, last: { boot_completed: 0 } });
      },
    });
    expect(result).toEqual({ ok: false, last: { boot_completed: 0 }, waitedMs: 1000, attempts: 4 });
    expect(seenAt).toEqual([0, 400, 800, 1000]);
  });

  it("hands each check the time left, so device calls share one deadline", async () => {
    const clock = fakeClock();
    const remaining: number[] = [];
    await poll({
      timeoutMs: 1000,
      intervalMs: 250,
      clock,
      check: (left): Promise<Observation<never, null>> => {
        remaining.push(left);
        clock.advance(100);
        return Promise.resolve({ done: false, last: null });
      },
    });
    expect(remaining).toEqual([1000, 650, 300, 0]);
  });

  it("keeps its interval inside 250-500 ms", async () => {
    const check = (): Promise<Observation<number, null>> =>
      Promise.resolve({ done: true, value: 1 });
    await expect(poll({ timeoutMs: 1, intervalMs: 249, check })).rejects.toThrow(RangeError);
    await expect(poll({ timeoutMs: 1, intervalMs: 501, check })).rejects.toThrow(RangeError);
    await expect(poll({ timeoutMs: 1, intervalMs: 250, check })).resolves.toMatchObject({
      ok: true,
    });
    await expect(poll({ timeoutMs: 1, intervalMs: 500, check })).resolves.toMatchObject({
      ok: true,
    });
  });

  it("polls with the real clock by default", async () => {
    let n = 0;
    const started = performance.now();
    const result = await poll({
      timeoutMs: 5000,
      intervalMs: 250,
      check: () => Promise.resolve(++n === 3 ? { done: true, value: n } : { done: false, last: n }),
    });
    expect(result.ok).toBe(true);
    expect(performance.now() - started).toBeGreaterThanOrEqual(490);
  });
});
