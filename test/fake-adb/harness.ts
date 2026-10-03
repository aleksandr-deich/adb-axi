import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { UNMATCHED_EXIT, type LogEntry, type Scenario } from "./scenario.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_SCRIPT = join(HERE, "fake-adb.ts");
export const FIXTURES_DIR = resolve(HERE, "..", "fixtures");
export const SCENARIOS_DIR = join(FIXTURES_DIR, "scenarios");

/** Tools the fake answers for. Each gets its own wrapper on PATH. */
export const FAKE_TOOLS = ["adb", "agent-device"] as const;

/** One call of the fake, merged from its `start` and `end` log lines. */
export interface FakeCall {
  pid: number;
  tool: string;
  argv: string[];
  androidSerial: string | null;
  start: number;
  /** `null` while the call is still running or when it was killed before answering. */
  end: number | null;
  exit: number | null;
  rule: number | null;
  unmatched: boolean;
}

export interface FakeAdb {
  /** Temporary directory holding everything for this fake. */
  dir: string;
  /** Directory with the `adb` and `agent-device` wrappers; first on `env.PATH`. */
  binDir: string;
  /** `$ADB_AXI_HOME` for the process under test, inside `dir`. */
  home: string;
  /** Environment for the process under test. */
  env: NodeJS.ProcessEnv;
  calls(): FakeCall[];
  /** Calls no rule answered. A passing test expects none. */
  unmatched(): FakeCall[];
  /** Current values of the scenario's state variables. */
  vars(): Record<string, string>;
  /** Put the state variables back to the scenario's initial values, as for a fresh device. */
  resetVars(): void;
  cleanup(): void;
}

export interface FakeAdbOptions {
  /** Directory `stdoutFile` paths resolve against. Defaults to the fixtures directory. */
  baseDir?: string;
  /** Extra environment for the process under test, applied last. */
  env?: Record<string, string | undefined>;
}

/**
 * Set up a fake adb for one test. `scenario` is a scenario object, or the file name of a
 * scenario under `test/fixtures/scenarios/`.
 */
export function createFakeAdb(scenario: Scenario | string, options: FakeAdbOptions = {}): FakeAdb {
  const dir = mkdtempSync(join(tmpdir(), "adb-axi-fake-"));
  const binDir = join(dir, "bin");
  const home = join(dir, "home");
  mkdirSync(binDir);
  mkdirSync(home);

  let scenarioPath: string;
  if (typeof scenario === "string") {
    scenarioPath = join(SCENARIOS_DIR, scenario);
    if (!existsSync(scenarioPath)) throw new Error(`No scenario file ${scenarioPath}`);
  } else {
    scenarioPath = join(dir, "scenario.json");
    writeFileSync(scenarioPath, JSON.stringify(scenario, null, 2));
  }
  const logPath = join(dir, "calls.jsonl");
  const statePath = join(dir, "state.json");
  writeFileSync(logPath, "");

  for (const tool of FAKE_TOOLS) {
    const wrapper = join(binDir, tool);
    writeFileSync(
      wrapper,
      `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(FAKE_SCRIPT)} ${tool} "$@"\n`,
    );
    chmodSync(wrapper, 0o755);
  }

  const overrides: Record<string, string | undefined> = {
    PATH: [binDir, process.env.PATH ?? ""].join(delimiter),
    FAKE_ADB_SCENARIO: scenarioPath,
    FAKE_ADB_LOG: logPath,
    FAKE_ADB_STATE: statePath,
    FAKE_ADB_BASE_DIR: options.baseDir ?? FIXTURES_DIR,
    ADB_AXI_HOME: home,
    ANDROID_HOME: undefined,
    ANDROID_SDK_ROOT: undefined,
    ANDROID_SERIAL: undefined,
    ...options.env,
  };
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries({ ...process.env, ...overrides })) {
    if (value !== undefined) env[key] = value;
  }

  const calls = (): FakeCall[] => readCalls(logPath);
  return {
    dir,
    binDir,
    home,
    env,
    calls,
    unmatched: () => calls().filter((call) => call.unmatched),
    vars: () => readVars(statePath, scenarioPath),
    resetVars: () => {
      rmSync(statePath, { force: true });
    },
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    },
  };
}

function readCalls(logPath: string): FakeCall[] {
  const byPid = new Map<number, FakeCall>();
  const text = readFileSync(logPath, "utf8");
  for (const line of text.split("\n")) {
    if (line === "") continue;
    const entry = JSON.parse(line) as LogEntry;
    if (entry.event === "start") {
      byPid.set(entry.pid, {
        pid: entry.pid,
        tool: entry.tool,
        argv: entry.argv,
        androidSerial: entry.androidSerial,
        start: entry.at,
        end: null,
        exit: null,
        rule: null,
        unmatched: false,
      });
    } else {
      const call = byPid.get(entry.pid);
      if (!call) continue;
      call.end = entry.at;
      call.exit = entry.exit;
      call.rule = entry.rule;
      call.unmatched = entry.unmatched === true || entry.exit === UNMATCHED_EXIT;
    }
  }
  return [...byPid.values()].sort((a, b) => a.start - b.start);
}

function readVars(statePath: string, scenarioPath: string): Record<string, string> {
  if (existsSync(statePath)) {
    return (JSON.parse(readFileSync(statePath, "utf8")) as { vars: Record<string, string> }).vars;
  }
  const scenario = JSON.parse(readFileSync(scenarioPath, "utf8")) as Scenario;
  return { ...(scenario.state ?? {}) };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
