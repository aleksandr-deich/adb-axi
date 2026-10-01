/**
 * The fake-adb scenario format. A scenario is a JSON file named by FAKE_ADB_SCENARIO.
 * Each call of the fake executable is matched against `rules` in order; the first rule
 * whose `match` and `when` hold (and that is not used up) answers the call.
 */
export interface Scenario {
  /** What this scenario replays, for readers of the fixture. */
  description?: string;
  /** Evidence IDs this scenario covers, for example ["H5"]. */
  evidence?: string[];
  /** True when the output was written from sources rather than captured from a device. */
  synthetic?: boolean;
  /** Where synthetic output comes from, for example an AOSP file and line. */
  source?: string;
  /** Initial values of named state variables, advanced by rules' `set`. */
  state?: Record<string, string>;
  rules: Rule[];
}

/** One argv element: an exact string, a regex (full match), or "any remaining arguments". */
export type ArgMatcher = string | { re: string } | { rest: true };

export interface Rule {
  /** Only calls to this tool match; defaults to "adb". The second tool is "agent-device". */
  tool?: string;
  /** Matched against the argv, element by element; lengths must agree unless `{rest: true}` ends it. */
  match: ArgMatcher[];
  /** State variables that must all hold for the rule to match. */
  when?: Record<string, string>;
  /** State variables to set when the rule answers a call. */
  set?: Record<string, string>;
  respond: Response;
  /** Answer with `respond` this many times; afterwards `then` answers, or the rule is skipped. */
  times?: number;
  then?: Response;
}

export interface Response {
  stdout?: string;
  /** Path of a file whose bytes become stdout, relative to the scenario file. */
  stdoutFile?: string;
  stderr?: string;
  /** Exit code; defaults to 0. */
  exit?: number;
  /** Wait this long before answering. */
  delayMs?: number;
  /**
   * Never exit, like adb on a missing device. Prints `- waiting for device -` on stderr
   * unless `stderr` is given; `stdout` is written first, as output produced before the stall.
   */
  hang?: boolean;
}

/** One line of the JSONL call log. `start` is written when a call begins, `end` when it answers. */
export type LogEntry =
  | {
      event: "start";
      pid: number;
      tool: string;
      argv: string[];
      androidSerial: string | null;
      at: number;
    }
  | {
      event: "end";
      pid: number;
      at: number;
      rule: number | null;
      exit: number;
      unmatched?: boolean;
    };

/** Exit code and stderr prefix for a call no rule answers. */
export const UNMATCHED_EXIT = 97;
export const UNMATCHED_PREFIX = "FAKE_ADB_UNMATCHED";
/** Exit code for a missing or malformed scenario. */
export const BAD_SCENARIO_EXIT = 98;
