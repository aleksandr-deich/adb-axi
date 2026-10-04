import { expect } from "vitest";

/**
 * The data of a `--json` result that TOON carries too. A mutation's JSON also has a
 * boolean `noop`, which TOON states as `(no-op)` in its `ok` line: it is checked against
 * that line here, then left out so the rest compares field for field.
 */
export function sharedWithToon<T>(data: T): T {
  if (typeof data !== "object" || data === null || !("noop" in data)) return data;
  const { noop, ...rest } = data as Record<string, unknown>;
  expect(noop).toBe(String(rest.ok).endsWith(" (no-op)"));
  return rest as T;
}
