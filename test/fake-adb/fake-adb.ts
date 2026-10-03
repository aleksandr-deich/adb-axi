/**
 * The fake adb (and agent-device) executable. Tests never run it directly: the harness
 * writes a small `adb` wrapper that execs `node fake-adb.ts adb "$@"`, puts it first on
 * PATH, and points these variables at per-test files:
 *
 *   FAKE_ADB_SCENARIO  scenario JSON (see scenario.ts)
 *   FAKE_ADB_LOG       JSONL call log, appended to by every call
 *   FAKE_ADB_STATE     state file: named variables and per-rule use counts
 *   FAKE_ADB_BASE_DIR  directory `stdoutFile` paths are relative to
 *
 * Every call is its own process, so state lives in a file guarded by a lock file.
 */
import {
  appendFileSync,
  closeSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import {
  BAD_SCENARIO_EXIT,
  UNMATCHED_EXIT,
  UNMATCHED_PREFIX,
  type ArgMatcher,
  type LogEntry,
  type Response,
  type Rule,
  type Scenario,
} from "./scenario.ts";

interface EngineState {
  vars: Record<string, string>;
  /** How many times each rule (by index) has answered. */
  uses: Record<string, number>;
}

const [tool = "adb", ...argv] = process.argv.slice(2);
const env = process.env;

function required(name: string): string {
  const value = env[name];
  if (value === undefined || value === "") {
    process.stderr.write(`FAKE_ADB_BAD_SETUP ${name} is not set\n`);
    process.exit(BAD_SCENARIO_EXIT);
  }
  return value;
}

const scenarioPath = required("FAKE_ADB_SCENARIO");
const logPath = required("FAKE_ADB_LOG");
const statePath = required("FAKE_ADB_STATE");
const baseDir = env.FAKE_ADB_BASE_DIR ?? dirname(scenarioPath);

function log(entry: LogEntry): void {
  appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
}

log({
  event: "start",
  pid: process.pid,
  tool,
  argv,
  androidSerial: env.ANDROID_SERIAL ?? null,
  at: Date.now(),
});

let scenario: Scenario;
try {
  scenario = JSON.parse(readFileSync(scenarioPath, "utf8")) as Scenario;
  if (!Array.isArray(scenario.rules)) throw new Error("scenario has no rules array");
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error);
  process.stderr.write(`FAKE_ADB_BAD_SCENARIO ${scenarioPath}: ${reason}\n`);
  log({ event: "end", pid: process.pid, at: Date.now(), rule: null, exit: BAD_SCENARIO_EXIT });
  process.exit(BAD_SCENARIO_EXIT);
}

function matchArg(matcher: ArgMatcher, arg: string): boolean {
  if (typeof matcher === "string") return matcher === arg;
  if ("re" in matcher) return new RegExp(`^(?:${matcher.re})$`).test(arg);
  return true;
}

function matchArgv(matchers: readonly ArgMatcher[], args: readonly string[]): boolean {
  for (let i = 0; i < matchers.length; i++) {
    const matcher = matchers[i];
    if (matcher === undefined) return false;
    if (typeof matcher === "object" && "rest" in matcher) return true;
    const arg = args[i];
    if (arg === undefined || !matchArg(matcher, arg)) return false;
  }
  return matchers.length === args.length;
}

function holds(when: Record<string, string> | undefined, vars: Record<string, string>): boolean {
  return Object.entries(when ?? {}).every(([key, value]) => vars[key] === value);
}

/** Pick the answering rule and advance state, atomically across concurrent fake calls. */
function choose(): { index: number; response: Response } | undefined {
  return withLock(`${statePath}.lock`, () => {
    const state = readState();
    for (const [index, rule] of scenario.rules.entries()) {
      if ((rule.tool ?? "adb") !== tool) continue;
      if (!matchArgv(rule.match, argv) || !holds(rule.when, state.vars)) continue;
      const used = state.uses[index] ?? 0;
      const response = pickResponse(rule, used);
      if (response === undefined) continue;
      state.uses[index] = used + 1;
      Object.assign(state.vars, rule.set ?? {});
      writeState(state);
      return { index, response };
    }
    return undefined;
  });
}

function pickResponse(rule: Rule, used: number): Response | undefined {
  if (rule.times === undefined || used < rule.times) return rule.respond;
  return rule.then;
}

function readState(): EngineState {
  try {
    return JSON.parse(readFileSync(statePath, "utf8")) as EngineState;
  } catch {
    return { vars: { ...(scenario.state ?? {}) }, uses: {} };
  }
}

function writeState(state: EngineState): void {
  const tmp = `${statePath}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, statePath);
}

function withLock<T>(lockPath: string, body: () => T): T {
  const deadline = Date.now() + 5000;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try {
      const fd = openSync(lockPath, "wx");
      try {
        writeFileSync(fd, String(process.pid));
      } finally {
        closeSync(fd);
      }
      break;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code !== "EEXIST") throw error;
      // A deadline can kill a fake process while it owns the lock.
      let owner: number;
      try {
        owner = Number(readFileSync(lockPath, "utf8"));
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
        throw error;
      }
      if (Number.isInteger(owner) && owner > 0) {
        try {
          process.kill(owner, 0);
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ESRCH") {
            try {
              unlinkSync(lockPath);
            } catch (error) {
              if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
                throw error;
              }
            }
            continue;
          }
        }
      }
      if (Date.now() > deadline) {
        throw new Error(`fake adb: lock ${lockPath} held for 5 s`, { cause: error });
      }
      Atomics.wait(pause, 0, 0, 2);
    }
  }
  try {
    return body();
  } finally {
    unlinkSync(lockPath);
  }
}

const chosen = choose();
if (chosen === undefined) {
  process.stderr.write(`${UNMATCHED_PREFIX} ${tool} ${JSON.stringify(argv)}\n`);
  log({
    event: "end",
    pid: process.pid,
    at: Date.now(),
    rule: null,
    exit: UNMATCHED_EXIT,
    unmatched: true,
  });
  process.exitCode = UNMATCHED_EXIT;
} else {
  const { index, response } = chosen;
  const answer = (): void => {
    if (response.hang === true) {
      // Output the command produced before it stalled stays visible to the caller.
      if (response.stdout !== undefined) process.stdout.write(response.stdout);
      process.stderr.write(response.stderr ?? "- waiting for device -\n");
      // Never exits on its own: only a kill ends it, like adb waiting for a missing device.
      setInterval(() => undefined, 60_000);
      return;
    }
    if (response.stdoutFile !== undefined) {
      process.stdout.write(readFileSync(resolve(baseDir, response.stdoutFile)));
    }
    if (response.stdout !== undefined) process.stdout.write(response.stdout);
    if (response.stderr !== undefined) process.stderr.write(response.stderr);
    const exit = response.exit ?? 0;
    log({ event: "end", pid: process.pid, at: Date.now(), rule: index, exit });
    process.exitCode = exit;
  };
  if (response.delayMs !== undefined && response.delayMs > 0) {
    setTimeout(answer, response.delayMs);
  } else {
    answer();
  }
}
