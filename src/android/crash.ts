import type { LogLine } from "./logcat.js";
import { belongsTo } from "./ps.js";

export type CrashKind = "java" | "anr" | "native";

/** One crash, ANR or native crash found in a log window. */
export interface Crash {
  kind: CrashKind;
  /** When it happened, on the device clock, in epoch milliseconds. */
  epochMs: number;
  /** The process that crashed, as the log names it (`<pkg>` or `<pkg>:<name>`); `-` when unnamed. */
  process: string;
  pid: number | null;
  /** The exception class, `ANR`, or the signal name of a native crash. */
  exception: string;
  message: string;
  /** The first stack frame inside the app, or `null` when the trace has none. */
  appFrame: string | null;
  /** How many stack frames the log carries for it. */
  frames: number;
  /** The whole block as the device printed it, without the log prefixes. */
  trace: string[];
}

/** The `Process:` name without its `:<name>` suffix: the package that owns the process. */
const mainPackage = (process: string): string => process.split(":")[0] ?? process;

/**
 * Find the Java crashes, ANRs and native crashes in a window of log lines, in the order
 * they started. Each is recognised from its own lines by the process name it carries, so a
 * block is found whichever uid, pid or buffer printed it.
 *
 * - Java: an `E AndroidRuntime` `FATAL EXCEPTION` block, whose lines come from the crashing
 *   process (AOSP `RuntimeInit.KillApplicationHandler`).
 * - ANR: an `E ActivityManager` `ANR in <process>` block printed by system_server in the
 *   system buffer (AOSP `ProcessRecord.appNotResponding`). logcat has no stack for it.
 * - Native: the `F DEBUG` tombstone summary that begins with `*** *** ***`, printed by
 *   crash_dump with the crashing process in its `pid: ... >>> <process> <<<` line.
 *
 * A block whose first line is before the window is not seen: its trailing lines belong to
 * no open block.
 */
export function parseCrashes(lines: readonly LogLine[]): Crash[] {
  const found: { order: number; crash: Crash }[] = [];
  let order = 0;
  const java = new Map<number, Block>();
  const anr = new Map<string, Block>();
  const native = new Map<number, Block>();
  const signals: { pid: number; process: string; signal: string; epochMs: number }[] = [];

  const closeJava = (pid: number): void => {
    const block = java.get(pid);
    if (block === undefined) return;
    java.delete(pid);
    found.push({ order: block.order, crash: buildJava(block) });
  };
  const closeAnr = (key: string): void => {
    const block = anr.get(key);
    if (block === undefined) return;
    anr.delete(key);
    found.push({ order: block.order, crash: buildAnr(block) });
  };
  const closeNative = (pid: number): void => {
    const block = native.get(pid);
    if (block === undefined) return;
    native.delete(pid);
    const crash = buildNative(block, signals);
    if (crash !== null) found.push({ order: block.order, crash });
  };

  for (const line of lines) {
    if (line.tag === "AndroidRuntime" && line.level === "E") {
      if (FATAL.test(line.message)) {
        closeJava(line.pid);
        java.set(line.pid, { order: order++, start: line, rest: [] });
      } else {
        java.get(line.pid)?.rest.push(line.message);
      }
    } else if (line.tag === "ActivityManager") {
      const key = `${line.pid}:${line.tid}`;
      const block = anr.get(key);
      if (block !== undefined && (line.level !== "E" || line.epochMs !== block.start.epochMs)) {
        closeAnr(key);
      }
      if (line.level === "E") {
        if (ANR_START.test(line.message)) {
          closeAnr(key);
          anr.set(key, { order: order++, start: line, rest: [] });
        } else {
          const report = anr.get(key);
          if (report !== undefined) {
            report.rest.push(line.message);
            if (
              /^\s*\d+(?:\.\d+)?% TOTAL:/.test(line.message) &&
              report.rest.filter((message) => message.startsWith("CPU usage from ")).length >= 2
            )
              closeAnr(key);
          }
        }
      }
    } else if (line.tag === "DEBUG" && line.level === "F") {
      if (TOMBSTONE_START.test(line.message)) {
        closeNative(line.pid);
        native.set(line.pid, { order: order++, start: line, rest: [] });
      } else {
        native.get(line.pid)?.rest.push(line.message);
      }
    } else if (line.tag === "libc" && line.level === "F") {
      const raised = FATAL_SIGNAL.exec(line.message);
      if (raised?.[1] !== undefined && raised[2] !== undefined && raised[3] !== undefined) {
        signals.push({
          pid: Number(raised[2]),
          process: raised[3],
          signal: raised[1],
          epochMs: line.epochMs,
        });
      }
    }
  }
  for (const pid of [...java.keys()]) closeJava(pid);
  for (const key of [...anr.keys()]) closeAnr(key);
  for (const pid of [...native.keys()]) closeNative(pid);
  return found
    .sort((a, b) => a.crash.epochMs - b.crash.epochMs || a.order - b.order)
    .map((entry) => entry.crash);
}

/** Whether the crash happened in a process of the package: by name, never by uid or pid. */
export function crashBelongsTo(crash: Crash, pkg: string): boolean {
  return belongsTo({ pid: crash.pid ?? 0, name: crash.process }, pkg);
}

interface Block {
  order: number;
  start: LogLine;
  /** The messages of the block's later lines. */
  rest: string[];
}

const FATAL = /^FATAL EXCEPTION(?: IN SYSTEM PROCESS)?:/;
const FRAME = /^\s*at\s+(\S.*?)\s*$/;
const END_OF_MESSAGE = /^(?:Caused by: |Suppressed: |\s*\.\.\. \d+ more)/;

/** Class prefixes of the platform and its libraries, never the app's own code. */
const PLATFORM_FRAME =
  /^(?:android|androidx|java|javax|kotlin|kotlinx|dalvik|libcore|sun|jdk|com\.android|com\.google\.android|org\.jetbrains)\./;

function buildJava(block: Block): Crash {
  const body = [...block.rest];
  let process = block.start.message.includes("IN SYSTEM PROCESS") ? "system_server" : "-";
  let pid: number | null = block.start.pid;
  const named = /^Process: ([^,\s]+)(?:, PID: (\d+))?/.exec(body[0] ?? "");
  if (named?.[1] !== undefined) {
    process = named[1];
    if (named[2] !== undefined) pid = Number(named[2]);
    body.shift();
  }
  const header = /^([A-Za-z_$][\w$.]*)(?::\s?(.*))?$/.exec(body[0] ?? "");
  const messageLines = header === null ? [] : [header[2] ?? ""];
  let next = 1;
  while (
    header !== null &&
    next < body.length &&
    !FRAME.test(body[next] ?? "") &&
    !END_OF_MESSAGE.test(body[next] ?? "")
  ) {
    messageLines.push((body[next] ?? "").trim());
    next++;
  }
  const frames = body.flatMap((message) => FRAME.exec(message)?.[1] ?? []);
  return {
    kind: "java",
    epochMs: block.start.epochMs,
    process,
    pid,
    exception: header?.[1] ?? "-",
    message: messageLines.join(" ").trim(),
    appFrame: firstAppFrame(frames, process),
    frames: frames.length,
    trace: [block.start.message, ...block.rest],
  };
}

/** The first frame in the app's package, else the first one outside the platform. */
function firstAppFrame(frames: readonly string[], process: string): string | null {
  const own = `${mainPackage(process)}.`;
  return (
    frames.find((frame) => frame.startsWith(own)) ??
    frames.find((frame) => !PLATFORM_FRAME.test(frame)) ??
    null
  );
}

const ANR_START = /^ANR in \S/;

function buildAnr(block: Block): Crash {
  const named = /^ANR in (\S+)/.exec(block.start.message);
  const pid = block.rest.map((message) => /^PID: (\d+)/.exec(message)?.[1]).find(Boolean);
  const reason = block.rest.map((message) => /^Reason: (.*)$/.exec(message)?.[1]).find(Boolean);
  return {
    kind: "anr",
    epochMs: block.start.epochMs,
    process: named?.[1] ?? "-",
    pid: pid === undefined ? null : Number(pid),
    exception: "ANR",
    message: reason ?? "",
    appFrame: null,
    frames: 0,
    trace: [block.start.message, ...block.rest],
  };
}

const TOMBSTONE_START = /^\*\*\* \*\*\* \*\*\*/;
const FATAL_SIGNAL = /^Fatal signal \d+ \((\w+)\).*\bpid (\d+) \(([^)]+)\)/;
const TOMBSTONE_PID = /^pid: (\d+),(?: ppid: \d+,)? tid: \d+, name: .*?\s+>>> (.+) <<<\s*$/;
const TOMBSTONE_CMDLINE = /^Cmdline: (\S+)/;
const TOMBSTONE_SIGNAL = /^signal \d+ \((\w+)\)/;
const BACKTRACE_FRAME =
  /^\s*#\d+ pc ([0-9a-fA-F]+)\s+(\[[^\]]*\]|\S+)(?:\s+\(offset [^)]*\))?(?:\s+\((.*)\))?\s*$/;
const BUILD_ID = /\s+\(BuildId: [^)]*\)\s*$/;

function buildNative(
  block: Block,
  signals: { pid: number; process: string; signal: string; epochMs: number }[],
): Crash | null {
  const messages = [block.start.message, ...block.rest];
  let process = "-";
  let pid: number | null = null;
  let signal: string | undefined;
  let signalName = "-";
  let abort: string | undefined;
  const frames: { path: string; pc: string; symbol: string | undefined }[] = [];
  for (const message of messages) {
    const owner = TOMBSTONE_PID.exec(message);
    if (owner?.[1] !== undefined && owner[2] !== undefined) {
      pid = Number(owner[1]);
      process = owner[2];
    }
    const cmdline = TOMBSTONE_CMDLINE.exec(message)?.[1];
    if (cmdline !== undefined && process === "-") process = cmdline;
    const kind = TOMBSTONE_SIGNAL.exec(message);
    if (kind?.[1] !== undefined && signal === undefined) {
      signal = message;
      signalName = kind[1];
    }
    const note = /^Abort message: '?(.*?)'?\s*$/.exec(message);
    if (note?.[1] !== undefined) abort = note[1];
    const frame = BACKTRACE_FRAME.exec(message.replace(BUILD_ID, ""));
    if (frame?.[1] !== undefined && frame[2] !== undefined) {
      frames.push({ path: frame[2], pc: frame[1], symbol: frame[3] });
    }
  }
  if (pid === null || signal === undefined || process === "-") return null;
  const raisedIndex = signals.findLastIndex(
    (entry) =>
      entry.pid === pid &&
      entry.process === process &&
      entry.signal === signalName &&
      entry.epochMs <= block.start.epochMs,
  );
  const raised = raisedIndex < 0 ? undefined : signals.splice(raisedIndex, 1)[0];
  const app = frames.find((frame) => frame.path.includes("/data/app/"));
  const file = (path: string): string => path.replace(/\]$/, "").replace(/^.*\//, "");
  return {
    kind: "native",
    epochMs: raised?.epochMs ?? block.start.epochMs,
    process,
    pid,
    exception: signalName,
    message: [signal, abort === undefined ? undefined : `abort message: ${abort}`]
      .filter((part) => part !== undefined)
      .join("; "),
    appFrame:
      app === undefined
        ? null
        : app.symbol === undefined
          ? `${file(app.path)} pc ${app.pc}`
          : `${app.symbol} (${file(app.path)})`,
    frames: frames.length,
    trace: messages,
  };
}
