import {
  ANDROID_CLI_PACKAGE,
  WEDGE_SIGNATURE,
  type AppProcessServer,
  type Forward,
  type Holder,
} from "../../android/holders.js";
import type { HostProcess } from "../../host/processes.js";

/**
 * `resident` is the Android CLI's UI server idling between `android` commands: no host
 * client, but kept on purpose. It only blocks instrumentation tests.
 */
export type HolderState = "live" | "resident" | "leaked" | "wedged";

/** A tool that leaves a UiAutomation holder on the device, and how its host side shows. */
interface Tool {
  /** How the holder is named in rows, given what was found on the device. */
  label: (found: Found) => string;
  /** The host process that uses the holder while it is live. */
  client: (process: HostProcess) => boolean;
  /** What a client process is called in the `why` column. */
  clientName: (process: HostProcess) => string;
  /** What would release a live holder, given its client. */
  release: (process: HostProcess | undefined) => string;
  /**
   * For a server reached through `adb forward`, the remote end of that forward. Without
   * one on the target, no host process can be using the server.
   */
  forwardRemote?: RegExp;
}

type Found = Holder | AppProcessServer;

/** The command line's words, and its program's base name. */
function words(process: HostProcess): string[] {
  return process.args.split(/\s+/);
}

function program(process: HostProcess): string {
  return (words(process)[0] ?? "").split("/").at(-1) ?? "";
}

/** Whether any word of the command line runs a script or binary named `name`. */
function runs(process: HostProcess, name: RegExp): boolean {
  return words(process).some((word) => name.test(word.split("/").at(-1) ?? ""));
}

function runsClient(process: HostProcess, name: string): boolean {
  if (program(process) === name) return true;
  if (!/^(?:node|node\.exe|npx|npx\.cmd)$/.test(program(process))) return false;
  const script = words(process)
    .slice(1)
    .find((word) => !word.startsWith("-"));
  if (script === undefined) return false;
  return script.split("/").at(-1) === name || script.split("/").includes(name);
}

const isAdbShell = (process: HostProcess, command: RegExp): boolean =>
  program(process) === "adb" && words(process).includes("shell") && command.test(process.args);

const GRADLE = /^(?:gradlew|gradle|gradle-wrapper\.jar)$|GradleWrapperMain|GradleMain/;

/** A Gradle build running a `connected*` device-test task. */
const isConnectedGradle = (process: HostProcess): boolean =>
  (runs(process, GRADLE) || /\bGradleWrapperMain\b|\bGradleMain\b/.test(process.args)) &&
  words(process).some((word) => /^(?:\S*:)?connected[A-Z]\w*$/.test(word));

const pidOf = (process: HostProcess | undefined): string =>
  process === undefined ? "" : ` (pid ${process.pid})`;

const MOBILECLI: Tool = {
  label: () => "mobilecli DeviceServer (mobile-mcp)",
  client: (process) => runsClient(process, "mobile-mcp") || runsClient(process, "mobilecli"),
  clientName: () => "mobile-mcp",
  release: (process) => `Close the mobile-mcp session${pidOf(process)} when it is done`,
  forwardRemote: /^localabstract:mobilecli/,
};

const UIAUTOMATOR: Tool = {
  label: () => "uiautomator (adb shell uiautomator)",
  client: (process) => isAdbShell(process, /\buiautomator\b/),
  clientName: () => "adb shell uiautomator",
  release: (process) => `Wait for \`adb shell uiautomator\`${pidOf(process)} to finish`,
};

const ANDROID_CLI: Tool = {
  label: (found) => `${found.kind === "server" ? found.className : found.package} (Android CLI)`,
  client: (process) => program(process) === "android" || program(process) === "android-cli",
  clientName: () => "android",
  release: (process) => `Wait for the \`android\` command${pidOf(process)} to finish`,
};

const AGENT_DEVICE: Tool = {
  label: (found) => `${found.kind === "server" ? found.className : found.package} (agent-device)`,
  client: (process) => runsClient(process, "agent-device"),
  clientName: () => "agent-device",
  release: () => "Run `agent-device close` in the worktree that opened the session when it is done",
};

const AM_INSTRUMENT: Tool = {
  label: (found) => `${found.kind === "server" ? found.className : found.package} (am instrument)`,
  client: (process) => isConnectedGradle(process) || isAdbShell(process, /\bam instrument\b/),
  clientName: (process) =>
    isConnectedGradle(process) ? "a Gradle connected* task" : "adb shell am instrument",
  release: (process) =>
    process !== undefined && isConnectedGradle(process)
      ? `Wait for the Gradle connected* task${pidOf(process)} to finish, or stop it`
      : `Wait for \`adb shell am instrument\`${pidOf(process)} to finish, or stop it`,
};

/** The tool behind a holder, from the class or package that droid-eval saw each one leave. */
function toolOf(found: Found): Tool | undefined {
  if (found.kind === "server") {
    if (found.className === "com.mobilenext.mobilecli.DeviceServer") return MOBILECLI;
    if (found.className === "com.android.commands.uiautomator.Launcher") return UIAUTOMATOR;
    return undefined;
  }
  if (!found.uiAutomation) return undefined;
  if (found.package === ANDROID_CLI_PACKAGE) return ANDROID_CLI;
  if (/SnapshotInstrumentation/.test(found.component) || /agentdevice/.test(found.package)) {
    return AGENT_DEVICE;
  }
  return AM_INSTRUMENT;
}

/** One holder of UiAutomation on the target, and what `doctor ui` makes of it. */
export interface ClassifiedHolder {
  found: Found;
  label: string;
  pids: number[];
  state: HolderState;
  why: string;
  /** What would release a live holder; `undefined` for the others. */
  release: string | undefined;
}

/** What `doctor ui` read to classify the holders. `null` means it could not be read. */
export interface Evidence {
  serial: string;
  instrumentations: readonly Holder[];
  servers: readonly AppProcessServer[];
  wedgedPids: ReadonlySet<number>;
  host: readonly HostProcess[] | null;
  forwards: readonly Forward[] | null;
  serials: ReadonlySet<string>;
  avd: string | null;
  /** adb-axi's own pid, never a client. */
  selfPid: number;
}

/** The UiAutomation holders on the device: instrumentations with a connection and known servers. */
export function findHolders(
  instrumentations: readonly Holder[],
  servers: readonly AppProcessServer[],
): Found[] {
  return [...instrumentations, ...servers].filter((found) => toolOf(found) !== undefined);
}

/** Whether a host process may be driving the target. Unknown names may be AVDs. */
function mayTarget(process: HostProcess, evidence: Evidence): boolean {
  const named = /(?:^|\s)(?:-s|--serial|--device)(?:\s+|=)(\S+)/.exec(process.args)?.[1];
  if (named === undefined || named === evidence.serial || named === evidence.avd) return true;
  if (evidence.serial.startsWith("emulator-") && evidence.avd === null) {
    return !/^emulator-\d+$/.test(named) && !evidence.serials.has(named);
  }
  return false;
}

function componentName(component: string): string {
  const [pkg = "", cls = ""] = component.split("/");
  return `${pkg}/${cls.startsWith(".") ? pkg + cls : cls}`;
}

function mayUseHolder(process: HostProcess, found: Found): boolean {
  if (found.kind !== "instrumentation") return true;
  if (!isAdbShell(process, /\bam instrument\b/)) return true;
  const args = words(process);
  const at = args.findIndex((word, index) => word === "am" && args[index + 1] === "instrument");
  const named = args
    .slice(at + 2)
    .filter((word) => /^[\w.]+\/[\w.$]+$/.test(word))
    .at(-1);
  return named === undefined || componentName(named) === componentName(found.component);
}

/**
 * Classify every holder. Live: a host client of its tool may be using it, or its liveness
 * could not be read. Wedged: its own pid logged the wedge signature. Resident: the Android
 * CLI's server with no `android` command running, as it is kept between commands. Leaked:
 * none of these.
 * A live holder is never reported as anything else, so `--fix` cannot touch it.
 */
export function classifyHolders(evidence: Evidence): ClassifiedHolder[] {
  return findHolders(evidence.instrumentations, evidence.servers).flatMap((found) => {
    const tool = toolOf(found);
    return tool === undefined ? [] : [classify(found, tool, evidence)];
  });
}

function classify(found: Found, tool: Tool, evidence: Evidence): ClassifiedHolder {
  const pids =
    found.kind === "server" ? [found.pid] : found.processes.map((process) => process.pid);
  const label = tool.label(found);
  const live = (why: string, client: HostProcess | undefined): ClassifiedHolder => ({
    found,
    label,
    pids,
    state: "live",
    why,
    release: tool.release(client),
  });

  if (evidence.host === null)
    return live("liveness unknown (host processes unreadable)", undefined);
  const client = evidence.host.find(
    (process) =>
      process.pid !== evidence.selfPid &&
      tool.client(process) &&
      mayTarget(process, evidence) &&
      mayUseHolder(process, found),
  );
  let forwarded = true;
  if (tool.forwardRemote !== undefined) {
    if (evidence.forwards === null)
      return live("liveness unknown (adb forwards unreadable)", client);
    const remote = tool.forwardRemote;
    forwarded = evidence.forwards.some(
      (forward) => forward.serial === evidence.serial && remote.test(forward.remote),
    );
  }
  if (client !== undefined && forwarded) {
    return live(`${tool.clientName(client)} pid ${client.pid} on the host`, client);
  }
  if (pids.some((pid) => evidence.wedgedPids.has(pid))) {
    return {
      found,
      label,
      pids,
      state: "wedged",
      why: `logged ${WEDGE_SIGNATURE}`,
      release: undefined,
    };
  }
  const why =
    client === undefined
      ? "no host client"
      : `${tool.clientName(client)} runs on the host but no adb forward reaches the server`;
  const state = tool === ANDROID_CLI && client === undefined ? "resident" : "leaked";
  return { found, label, pids, state, why, release: undefined };
}
