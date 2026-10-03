import {
  parseForwards,
  probeAppProcessServers,
  probeHolders,
  readWedgedPids,
  type Forward,
} from "../../android/holders.js";
import { runShell } from "../../adb/shell.js";
import { AdbAxiError } from "../../core/errors.js";
import { listDevices } from "../../device/list.js";
import { noop, okLine, runHint, type Output } from "../../core/output.js";
import { poll } from "../../core/poll.js";
import { UNKNOWN, readOptions, targetSerial } from "../app/shared.js";
import { defineCommand } from "../define.js";
import type { CommandContext } from "../types.js";
import { CHECK_CAP_MS } from "./host-checks.js";
import { classifyHolders, findHolders, type ClassifiedHolder } from "./ui-holders.js";

/** How long `--fix` waits for cleared holders to be gone before it reports what is left. */
const SETTLE_MS = 5_000;

export const doctorUi = defineCommand({
  path: ["doctor", "ui"],
  summary: "Find on-device UiAutomation holders and classify them as live, leaked or wedged",
  flags: [
    {
      name: "--fix",
      type: "boolean",
      description:
        "Clear leaked and wedged holders, then check again: kill app_process servers; force-stop instrumentation runners and their target app packages (stopping their app processes). Live ones are never touched",
    },
  ],
  examples: ["adb-axi doctor ui", "adb-axi doctor ui --fix"],
  shipped: true,
  run: (context) => (context.flags.fix === true ? fix(context) : report(context)),
});

/** Every UiAutomation holder on the target, classified against the host. */
async function inspect(context: CommandContext): Promise<ClassifiedHolder[]> {
  const serial = targetSerial(context);
  const adb = context.adb();
  const reads = readOptions(context);
  const [instrumentations, servers] = await Promise.all([
    probeHolders(adb, serial, reads),
    probeAppProcessServers(adb, serial, reads),
  ]);
  const found = findHolders(instrumentations, servers);
  if (found.length === 0) return [];

  const [wedgedPids, host, forwards, devices] = await Promise.all([
    readWedgedPids(adb, serial, reads),
    context.hostProcesses(Math.min(context.deadline.remainingMs(), CHECK_CAP_MS)),
    found.some((holder) => holder.kind === "server") ? readForwards(context) : [],
    listDevices(adb, context.deadline),
  ]);
  return classifyHolders({
    serial,
    instrumentations,
    servers,
    wedgedPids,
    host,
    forwards,
    serials: new Set(devices.map((device) => device.serial)),
    selfPid: process.pid,
  });
}

/** `adb forward --list`, or `null` when they cannot be listed: liveness is then unknown. */
async function readForwards(context: CommandContext): Promise<Forward[] | null> {
  try {
    const answer = await context.adb().host(["forward", "--list"], {
      deadline: context.deadline,
      capMs: CHECK_CAP_MS,
      step: "listing adb forwards",
    });
    return answer.exitCode === 0 ? parseForwards(answer.stdout.toString("utf8")) : null;
  } catch (error) {
    if (error instanceof AdbAxiError) return null;
    throw error;
  }
}

function pidCell(holder: ClassifiedHolder): number | string {
  const [first] = holder.pids;
  if (first === undefined) return UNKNOWN;
  return holder.pids.length === 1 ? first : holder.pids.join(" ");
}

function rows(holders: readonly ClassifiedHolder[]): Record<string, unknown>[] {
  return holders.map((holder) => ({
    pid: pidCell(holder),
    holder: holder.label,
    state: holder.state,
    why: holder.why,
  }));
}

function clearCommands(holder: ClassifiedHolder): string[] {
  if (holder.found.kind === "server") return [`kill ${holder.found.pid}`];
  const packages = new Set([
    holder.found.package,
    ...holder.found.processes.map((process) => process.package),
  ]);
  return [...packages].map((pkg) => `am force-stop ${pkg}`);
}

function clearWords(holder: ClassifiedHolder): string {
  return holder.found.kind === "server"
    ? `kill pid ${holder.found.pid}`
    : joinWords(clearCommands(holder).map((command) => command.replace("am ", "")));
}

function sameHolder(a: ClassifiedHolder, b: ClassifiedHolder): boolean {
  if (a.found.kind === "server" || b.found.kind === "server") {
    return a.found.kind === b.found.kind && a.pids[0] === b.pids[0];
  }
  return a.found.component === b.found.component;
}

const isLive = (holder: ClassifiedHolder): boolean => holder.state === "live";

/** What would release each live holder, without repeats. */
function releaseLines(holders: readonly ClassifiedHolder[]): string[] {
  return [...new Set(holders.flatMap((holder) => holder.release ?? []))];
}

function fixHint(context: CommandContext, stuck: readonly ClassifiedHolder[]): string {
  return runHint(
    ["doctor", "ui", "--fix", "--device", targetSerial(context)],
    `to ${joinWords(stuck.map(clearWords))}`,
  );
}

function joinWords(parts: readonly string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1) ?? ""}`;
}

async function report(context: CommandContext): Promise<Output> {
  const holders = await inspect(context);
  if (holders.length === 0) return { uiautomation: "free" };
  const stuck = holders.filter((holder) => !isLive(holder));
  // A leaked or wedged holder is the answer, not a failure to answer: the report keeps its
  // shape and the exit code says UiAutomation is not usable.
  if (stuck.length > 0) process.exitCode = 1;
  const help = [...(stuck.length > 0 ? [fixHint(context, stuck)] : []), ...releaseLines(holders)];
  return {
    uiautomation: stuck.length > 0 ? "busy" : "in use",
    holders: rows(holders),
    help,
  };
}

async function fix(context: CommandContext): Promise<Output> {
  const serial = targetSerial(context);
  const before = await inspect(context);
  if (before.length === 0) {
    return { ok: okLine("doctor ui", serial, noop("uiautomation free")) };
  }

  const targets = before.filter((holder) => !isLive(holder));
  for (const holder of targets) {
    // A failed kill shows in the re-check, which is what decides the outcome.
    for (const command of clearCommands(holder)) {
      await runShell(context.adb(), serial, command, {
        deadline: context.deadline,
        step: `clearing ${holder.label}`,
      });
    }
  }
  const after = targets.length === 0 ? before : await recheck(context, targets);

  const cleared = targets
    .filter((target) => !after.some((holder) => sameHolder(holder, target)))
    .map((holder) => ({
      pid: pidCell(holder),
      holder: holder.label,
      was: holder.state,
      action: clearCommands(holder).join("; "),
    }));
  const clearedField = cleared.length > 0 ? { cleared } : {};

  const stuck = after.filter((holder) => !isLive(holder));
  if (stuck.length > 0) {
    process.exitCode = 1;
    return {
      uiautomation: "busy",
      ...clearedField,
      holders: rows(after),
      help: [fixHint(context, stuck), ...releaseLines(after)],
    };
  }

  const live = after.filter(isLive);
  if (live.length > 0) {
    const [only] = live;
    throw new AdbAxiError(
      "HOLDER_PROTECTED",
      live.length === 1 && only !== undefined
        ? `${only.label} is live and --fix left it alone`
        : `${live.length} live holders were left alone`,
      {
        fields: {
          ...clearedField,
          protected: live.map((holder) => ({
            pid: pidCell(holder),
            holder: holder.label,
            why: holder.why,
          })),
        },
        help: releaseLines(live),
      },
    );
  }
  return {
    ok: okLine("doctor ui", serial, `uiautomation free (${cleared.length} cleared)`),
    cleared,
  };
}

/** Look again until every cleared holder is gone, or the settle time passes. */
async function recheck(
  context: CommandContext,
  targets: readonly ClassifiedHolder[],
): Promise<ClassifiedHolder[]> {
  let last: ClassifiedHolder[] | undefined;
  const result = await poll<ClassifiedHolder[], ClassifiedHolder[] | undefined>({
    timeoutMs: Math.min(context.deadline.remainingMs(), SETTLE_MS),
    check: async () => {
      try {
        last = await inspect(context);
      } catch (error) {
        // A look cut short by the deadline leaves the previous one as the evidence.
        if (error instanceof AdbAxiError && error.code === "TIMEOUT" && last !== undefined) {
          return { done: false, last };
        }
        throw error;
      }
      const holders = last;
      const gone = targets.every((target) => !holders.some((h) => sameHolder(h, target)));
      return gone ? { done: true, value: holders } : { done: false, last: holders };
    },
  });
  if (result.ok) return result.value;
  // The first look either answered or threw, so there is always a last one here.
  if (last === undefined) throw new Error("re-check ended without a look at the device");
  return last;
}
