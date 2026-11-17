import type { LogLine } from "./logcat.js";

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
  /** The deepest direct Java cause, excluding suppressed exceptions and their causes. */
  rootCause?: { exception: string; message: string };
  /** The first stack frame inside the app, or `null` when the trace has none. */
  appFrame: string | null;
  /** How many stack frames the log carries for it. */
  frames: number;
  /** The whole block as the device printed it, without the log prefixes. */
  trace: string[];
  uid?: number;
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
 * Parse all supplied lines, including any lead-in before the requested window. Callers
 * filter the resulting crashes by epochMs; a native crash uses the matching fatal signal's
 * time when available, otherwise its tombstone header time.
 */
export function parseCrashes(lines: readonly LogLine[]): Crash[] {
  const parser = createCrashParser();
  for (const line of lines) parser.add(line);
  return parser.finish();
}

export function createCrashParser(
  options: {
    onReport?: (order: number, crash: Crash | null) => void;
    onTrace?: (order: number, message: string) => void;
    retain?: boolean;
  } = {},
): {
  add(line: LogLine): void;
  finish(): Crash[];
  readonly degraded: boolean;
} {
  let retainedBytes = 0;
  let summaryBytes = 0;
  let degraded = false;
  const found: { order: number; crash: Crash }[] = [];
  const save = (order: number, crash: Crash): void => {
    options.onReport?.(order, crash);
    if (options.retain === false) return;
    const size = Buffer.byteLength(JSON.stringify({ ...crash, trace: [] }));
    if (summaryBytes + size > 16 * 1024 * 1024 || found.length >= 65536) {
      degraded = true;
      return;
    }
    summaryBytes += size;
    found.push({ order, crash });
  };
  const append = (block: Block | undefined, message: string, raw: string): void => {
    if (block === undefined) return;
    options.onTrace?.(block.order, raw);
    if (block.start.tag === "AndroidRuntime" && block.lines++ === 0) {
      const named = /^Process: ([^,\s]+)(?:, PID: (\d+))?/.exec(message);
      if (named?.[1] !== undefined) block.fields.set("process", named[1]);
      if (named?.[2] !== undefined) block.fields.set("pid", named[2]);
    }
    if (block.start.tag === "ActivityManager") {
      const field = /^(PID|Reason|Parent|ErrorId|Frozen|Load):/.exec(message)?.[1];
      if (field !== undefined) block.fields.set(field, message);
      if (message.startsWith("CPU usage from ")) block.cpu++;
    }
    if (block.start.tag === "DEBUG") {
      const field = TOMBSTONE_PID.test(message)
        ? "pid:"
        : TOMBSTONE_CMDLINE.test(message)
          ? "Cmdline:"
          : TOMBSTONE_SIGNAL.test(message)
            ? "signal "
            : /^Abort message:/.test(message)
              ? "Abort message:"
              : undefined;
      if (field !== undefined && (field !== "signal " || !block.fields.has(field)))
        block.fields.set(field, message);
      const uid = /^uid: (\d+)\s*$/.exec(message)?.[1];
      if (uid !== undefined) {
        block.uids++;
        block.uid = Number(uid);
      }
    }
    if (block.cut) return;
    const bytes = Buffer.byteLength(message) + 128;
    if ((block.bytes ?? 0) + bytes > 256 * 1024 || retainedBytes + bytes > 16 * 1024 * 1024) {
      block.cut = true;
      degraded = true;
      block.rest.push("[trace truncated: retained-state limit]");
      return;
    }
    block.bytes = (block.bytes ?? 0) + bytes;
    retainedBytes += bytes;
    block.rest.push(message);
  };
  let order = 0;
  const java = new Map<number, Block>();
  const anr = new Map<string, Block>();
  const native = new Map<number, Block>();
  const signals: { pid: number; process: string; signal: string; epochMs: number }[] = [];

  const closeJava = (pid: number): void => {
    const block = java.get(pid);
    if (block === undefined) return;
    java.delete(pid);
    save(block.order, buildJava(block));
  };
  const closeAnr = (key: string): void => {
    const block = anr.get(key);
    if (block === undefined) return;
    anr.delete(key);
    save(block.order, buildAnr(block));
  };
  const closeNative = (pid: number): void => {
    const block = native.get(pid);
    if (block === undefined) return;
    native.delete(pid);
    const crash = buildNative(block, signals);
    if (crash !== null) save(block.order, crash);
    else options.onReport?.(block.order, null);
  };

  const add = (input: LogLine): void => {
    if (
      input.tag !== "AndroidRuntime" &&
      input.tag !== "ActivityManager" &&
      input.tag !== "DEBUG" &&
      input.tag !== "libc"
    )
      return;
    const line =
      input.message.length > 64000
        ? { ...input, message: input.message.slice(0, 64000) + " [trace truncated: long line]" }
        : input;
    if (line !== input) degraded = true;
    // Pending report headers and unmatched signals must not grow with an adversarial window.
    if (java.size >= 4096) {
      closeJava(java.keys().next().value ?? line.pid);
      degraded = true;
    }
    if (anr.size >= 4096) {
      closeAnr(anr.keys().next().value ?? "");
      degraded = true;
    }
    if (native.size >= 4096) {
      closeNative(native.keys().next().value ?? line.pid);
      degraded = true;
    }
    const header = (): LogLine => {
      if (line.message.length <= 4096) return line;
      degraded = true;
      return { ...line, message: line.message.slice(0, 4096) };
    };
    if (signals.length >= 4096) {
      signals.shift();
      degraded = true;
    }
    const start = (): Block => {
      const block: Block = {
        order: order++,
        start: header(),
        rest: [],
        fields: new Map(),
        lines: 0,
        cpu: 0,
        uids: 0,
      };
      options.onTrace?.(block.order, input.message);
      return block;
    };
    if (line.tag === "AndroidRuntime" && line.level === "E") {
      if (FATAL.test(line.message)) {
        closeJava(line.pid);
        java.set(line.pid, start());
      } else {
        append(java.get(line.pid), line.message, input.message);
      }
    } else if (line.tag === "ActivityManager") {
      const started = /^Start proc (\d+):/.exec(line.message);
      if (started?.[1] !== undefined) {
        const reused = Number(started[1]);
        const pending = signals.findIndex((entry) => entry.pid === reused);
        if (pending >= 0) signals.splice(pending, 1);
      }
      const key = `${line.pid}:${line.tid}`;
      const block = anr.get(key);
      if (block !== undefined && (line.level !== "E" || line.epochMs !== block.start.epochMs)) {
        closeAnr(key);
      }
      if (line.level === "E") {
        if (ANR_START.test(line.message)) {
          closeAnr(key);
          anr.set(key, start());
        } else {
          const report = anr.get(key);
          if (report !== undefined) {
            const message = line.message;
            const inCpu = report.cpu > 0;
            const field = /^(PID|Reason|Parent|ErrorId|Frozen|Load):/.exec(message)?.[1];
            const repeated = field !== undefined && report.fields.has(field);
            const partOfReport = inCpu
              ? /^(?:CPU usage from |\s*\d+(?:\.\d+)?% )/.test(message)
              : field !== undefined ||
                message === "" ||
                /^(?:----- (?:Output from|End output from) \/proc\/pressure\/|(?:some|full) avg10=|CPU usage from )/.test(
                  message,
                );
            if (repeated || !partOfReport) {
              closeAnr(key);
            } else {
              append(report, message, input.message);
              if (/^\s*\d+(?:\.\d+)?% TOTAL:/.test(message) && report.cpu >= 2) closeAnr(key);
            }
          }
        }
      }
    } else if (line.tag === "DEBUG" && line.level === "F") {
      if (TOMBSTONE_START.test(line.message)) {
        closeNative(line.pid);
        native.set(line.pid, start());
      } else {
        append(native.get(line.pid), line.message, input.message);
      }
    } else if (line.tag === "libc" && line.level === "F") {
      const raised = FATAL_SIGNAL.exec(line.message);
      if (raised?.[1] !== undefined && raised[2] !== undefined && raised[3] !== undefined) {
        const pending = signals.findIndex((entry) => entry.pid === Number(raised[2]));
        if (pending >= 0) signals.splice(pending, 1);
        signals.push({
          pid: Number(raised[2]),
          process: raised[3].slice(0, 4096),
          signal: raised[1],
          epochMs: line.epochMs,
        });
      }
    }
  };
  const finish = (): Crash[] => {
    for (const pid of [...java.keys()]) closeJava(pid);
    for (const key of [...anr.keys()]) closeAnr(key);
    for (const pid of [...native.keys()]) closeNative(pid);
    return found
      .sort((a, b) => a.crash.epochMs - b.crash.epochMs || a.order - b.order)
      .map((entry) => entry.crash);
  };
  return {
    add,
    finish,
    get degraded() {
      return degraded;
    },
  };
}

export function createCrashSeen(): { add(line: LogLine): void; readonly found: boolean } {
  let found = false;
  const native = new Map<number, { owner: boolean; signal: boolean }>();
  return {
    get found() {
      return found;
    },
    add(line) {
      if (found) return;
      if (
        (line.tag === "AndroidRuntime" && line.level === "E" && FATAL.test(line.message)) ||
        (line.tag === "ActivityManager" && line.level === "E" && ANR_START.test(line.message))
      )
        found = true;
      if (line.tag === "DEBUG" && line.level === "F") {
        if (TOMBSTONE_START.test(line.message)) {
          if (native.size >= 4096) native.delete(native.keys().next().value ?? line.pid);
          native.set(line.pid, { owner: false, signal: false });
        } else {
          const block = native.get(line.pid);
          if (block !== undefined) {
            block.owner ||= TOMBSTONE_PID.test(line.message);
            block.signal ||= TOMBSTONE_SIGNAL.test(line.message);
            found = block.owner && block.signal;
          }
        }
      }
      if (found) native.clear();
    },
  };
}

/** Whether a process belongs to a package: the main process or a `<pkg>:<name>` one. */
export function belongsTo(process: { name: string }, pkg: string): boolean {
  return process.name === pkg || process.name.startsWith(`${pkg}:`);
}

/** Whether the crash happened in a process of the package: by name, never by uid or pid. */
export function crashBelongsTo(crash: Crash, pkg: string): boolean {
  return belongsTo({ name: crash.process }, pkg);
}

interface Block {
  order: number;
  start: LogLine;
  /** The messages of the block's later lines. */
  rest: string[];
  bytes?: number;
  cut?: boolean;
  fields: Map<string, string>;
  lines: number;
  cpu: number;
  uids: number;
  uid?: number;
}

const FATAL = /^FATAL EXCEPTION(?: IN SYSTEM PROCESS)?:/;
const FRAME = /^\s*at\s+(\S.*?)\s*$/;
const END_OF_MESSAGE = /^\s*(?:Caused by: |Suppressed: |\.\.\. \d+ more)/;

/** Class prefixes of the platform and its libraries, never the app's own code. */
const PLATFORM_FRAME =
  /^(?:android|androidx|java|javax|kotlin|kotlinx|dalvik|libcore|sun|jdk|com\.android|com\.google\.android|org\.jetbrains)\./;

function buildJava(block: Block): Crash {
  const body = [...block.rest];
  const process =
    block.fields.get("process") ??
    (block.start.message.includes("IN SYSTEM PROCESS") ? "system_server" : "-");
  const knownPid = block.fields.get("pid");
  const pid = knownPid === undefined ? block.start.pid : Number(knownPid);
  if (/^Process: [^,\s]+/.test(body[0] ?? "")) body.shift();
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
  const cause = rootCause(body);
  return {
    kind: "java",
    epochMs: block.start.epochMs,
    process,
    pid,
    exception: header?.[1] ?? "-",
    message: messageLines.join(" ").trim(),
    ...(cause === undefined ? {} : { rootCause: cause }),
    appFrame: firstAppFrame(frames, process),
    frames: frames.length,
    trace: [block.start.message, ...block.rest],
  };
}

/** Java prints direct causes without indentation; suppressed branches are indented. */
function rootCause(body: readonly string[]): Crash["rootCause"] {
  const index = body.findLastIndex((message) => /^Caused by: /.test(message));
  if (index < 0) return undefined;
  const header = /^Caused by: ([A-Za-z_$][\w$.]*)(?::\s?(.*))?$/.exec(body[index] ?? "");
  if (header?.[1] === undefined) return undefined;
  const messages = [header[2] ?? ""];
  for (let next = index + 1; next < body.length; next++) {
    const message = body[next] ?? "";
    if (FRAME.test(message) || END_OF_MESSAGE.test(message)) break;
    messages.push(message.trim());
  }
  return { exception: header[1], message: messages.join(" ").trim() };
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
  const pid = /^PID: (\d+)/.exec(block.fields.get("PID") ?? "")?.[1];
  const reason = /^Reason: (.*)$/.exec(block.fields.get("Reason") ?? "")?.[1];
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
  for (const message of [...messages, ...block.fields.values()]) {
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
    ...(block.uids === 1 && Number.isSafeInteger(block.uid) ? { uid: block.uid } : {}),
    trace: messages,
  };
}
