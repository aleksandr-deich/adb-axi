import type { AdbClient } from "../../adb/run.js";
import { runShell } from "../../adb/shell.js";
import {
  declaredActivities,
  resolveLauncherActivity,
  parseActivityFilters,
  readActivityProcessName,
} from "../../android/activities.js";
import { parseAmStart, wasRecreated, type AmStart } from "../../android/amstart.js";
import {
  activityClassName,
  assertPackageName,
  type ActivityRecord,
  type Component,
} from "../../android/component.js";
import { readForeground } from "../../android/foreground.js";
import { invalidOutput } from "../../android/read.js";
import { AdbAxiError } from "../../core/errors.js";
import { okLine, runHint, type Output } from "../../core/output.js";
import { poll } from "../../core/poll.js";
import { logsCrash } from "../logs/crash.js";
import { defineCommand } from "../define.js";
import type { CommandContext } from "../types.js";
import {
  formatDuration,
  forceStop,
  lifecycleCommand,
  packageProcesses,
  requireInstalled,
  stopFailed,
  waitForExit,
} from "./process.js";
import { readOptions, targetSerial, UNKNOWN } from "./shared.js";

/**
 * How long a started app gets to be seen in front with a live process. `am start -W` has
 * already waited for the launch, so this only covers a crash or a redirect just after it.
 */
const SETTLE_MS = 2000;

/**
 * Activity class names as `am start -n` takes them: `.MainActivity`, a full class name, or
 * a nested class with `$`. Anything else never reaches the device shell.
 */
const ACTIVITY_NAME = /^\.?[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/;

export const appStart = defineCommand({
  path: ["app", "start"],
  summary: "Start an app, then report what is in the foreground and how it launched",
  positionals: [
    {
      name: "pkg",
      description: "Package name, optionally with /<activity>",
      required: true,
    },
  ],
  flags: [
    { name: "--fresh", type: "boolean", description: "Force-stop first so the start is cold" },
    {
      name: "--activity",
      type: "string",
      valueName: "<name>",
      description: "Activity to start instead of the launcher activity",
    },
  ],
  examples: ["adb-axi app start com.example.notes", "adb-axi app start com.example.notes --fresh"],
  shipped: true,
  run: async (context) => {
    const { pkg, activity: requested } = startTarget(context);
    const serial = targetSerial(context);
    const adb = context.adb();

    const fresh = context.flags.fresh === true;
    const command = lifecycleCommand(context, [
      "app",
      "start",
      requested === null ? pkg : `${pkg}/${requested}`,
      ...(fresh ? ["--fresh"] : []),
    ]);
    const { dump, userId } = await requireInstalled(context, pkg);
    const filters = parseActivityFilters(dump);
    const activity =
      requested ?? (await resolveLauncherActivity(adb, serial, pkg, userId, readOptions(context)));
    if (activity === null) {
      throw activityNotFound(context, pkg, null, declaredActivities(filters, pkg));
    }

    if (fresh) {
      await forceStop(adb, serial, pkg, userId, readOptions(context));
      const exit = await waitForExit(context, pkg, userId);
      if (!exit.gone) {
        throw stopFailed(context, pkg, exit.last, context.timeoutMs, {
          command,
          step: "am force-stop",
        });
      }
    }

    const start = await amStart(context, adb, serial, pkg, activity, userId, command, () =>
      declaredActivities(filters, pkg),
    );
    const launched = start.activity ?? { package: pkg, activity, component: `${pkg}/${activity}` };
    const processName = await readActivityProcessName(
      adb,
      serial,
      launched,
      userId,
      readOptions(context),
    );
    const settled = await settle(context, adb, serial, launched, userId, processName);
    if (settled.state === "stopped")
      throw diedOnStart(context, launched, processName, settled, command);
    return report(context, pkg, activity, fresh, start, settled, command);
  },
});

/** `<pkg>[/<activity>]` and `--activity`, checked before any device call. */
function startTarget(context: CommandContext): { pkg: string; activity: string | null } {
  const raw = String(context.positionals.pkg);
  const slash = raw.indexOf("/");
  const pkg = slash === -1 ? raw : raw.slice(0, slash);
  const fromTarget = slash === -1 ? null : raw.slice(slash + 1);
  const fromFlag = typeof context.flags.activity === "string" ? context.flags.activity : null;
  assertPackageName(pkg);
  if (fromTarget !== null && fromFlag !== null) {
    throw new AdbAxiError(
      "VALIDATION_ERROR",
      `the activity is given twice, as ${fromTarget} and as --activity ${fromFlag}`,
      {
        help: [
          runHint(
            lifecycleCommand(context, [
              "app",
              "start",
              `${pkg}/${fromFlag}`,
              ...(context.flags.fresh === true ? ["--fresh"] : []),
            ]),
            "naming the activity once",
          ),
        ],
      },
    );
  }
  const activity = fromTarget ?? fromFlag;
  if (activity !== null && !ACTIVITY_NAME.test(activity)) {
    throw new AdbAxiError("VALIDATION_ERROR", `"${activity}" is not a valid activity name`, {
      help: [`Pass an activity such as \`.MainActivity\` or \`${pkg}.MainActivity\``],
    });
  }
  return { pkg, activity };
}

/**
 * `am start -W -n <pkg>/<activity>`, read from its text. A start that outlives the
 * deadline, or that am itself reports as `Status: timeout` (with exit 0), is `WAIT_TIMEOUT`.
 */
async function amStart(
  context: CommandContext,
  adb: AdbClient,
  serial: string,
  pkg: string,
  activity: string,
  userId: number,
  command: string[],
  activities: () => string[],
): Promise<AmStart> {
  const component = `${pkg}/${activity}`;
  const step = `starting ${component}`;
  let output: string;
  let exitCode: number;
  try {
    // Single quotes keep a nested class's `$` away from the device shell.
    const result = await runShell(adb, serial, `am start --user ${userId} -W -n '${component}'`, {
      deadline: context.deadline,
      step,
    });
    output = `${result.stdout}\n${result.stderr}`;
    exitCode = result.exitCode;
  } catch (error) {
    if (error instanceof AdbAxiError && error.code === "TIMEOUT") {
      throw startTimeout(context, pkg, { status: "no answer", activity }, command);
    }
    throw error;
  }

  const start = parseAmStart(output);
  if (start.error?.classNotFound === true) {
    throw activityNotFound(context, pkg, activity, activities());
  }
  if (start.error !== null || exitCode !== 0) {
    throw new AdbAxiError("REMOTE_EXIT", `${step} failed: the activity manager refused it`, {
      fields: {
        step,
        exit: exitCode,
        detail: start.error?.detail ?? output.trim().slice(0, 200),
      },
      help: [runHint(lifecycleCommand(context, ["app", "info", pkg]), "to check the package")],
    });
  }
  if (start.status === null) throw invalidOutput(step, output);
  if (start.status === "timeout") {
    throw startTimeout(
      context,
      pkg,
      {
        status: "timeout",
        activity: start.activity?.activity ?? activity,
      },
      command,
    );
  }
  return start;
}

/** One look at the started app: its pid and the activity in front. */
interface Seen {
  state: "foreground" | "running" | "stopped";
  pid: number | "-";
  /** The resumed activity, whichever app it belongs to. */
  front: ActivityRecord | null;
}

/**
 * Observe the app until it is in front, or its process is gone, for at most `SETTLE_MS`
 * of what is left of the deadline. The first observation usually settles it.
 */
async function settle(
  context: CommandContext,
  adb: AdbClient,
  serial: string,
  activity: Component,
  userId: number,
  processName: string,
): Promise<Seen> {
  const result = await poll<Seen, Seen>({
    timeoutMs: Math.min(SETTLE_MS, context.deadline.remainingMs()),
    check: async () => {
      const processes = await packageProcesses(context, activity.package, userId);
      const front = await readForeground(adb, serial, { ...readOptions(context), userId });
      const pid = processes.find((process) => process.process === processName)?.pid ?? UNKNOWN;
      const inFront =
        front?.package === activity.package &&
        activityClassName(front) === activityClassName(activity);
      const state = pid === UNKNOWN ? "stopped" : inFront ? "foreground" : "running";
      const seen: Seen = { state, pid, front };
      return state === "running" ? { done: false, last: seen } : { done: true, value: seen };
    },
  });
  // A poll always observes once, so a timed-out one has a last observation.
  return result.ok ? result.value : (result.last as Seen);
}

function report(
  context: CommandContext,
  pkg: string,
  activity: string,
  fresh: boolean,
  start: AmStart,
  settled: Seen,
  command: string[],
): Output {
  const recreated = wasRecreated(start);
  const inFront = settled.state === "foreground";
  const app = {
    activity: inFront
      ? (settled.front?.activity ?? activity)
      : (start.activity?.activity ?? activity),
    pid: settled.pid,
    launch: start.launch,
    recreated,
    ...(recreated && start.totalTimeMs !== null ? { took_ms: start.totalTimeMs } : {}),
  };

  if (!inFront) {
    return {
      ok: okLine("start", pkg, `running, ${settled.front?.package ?? "nothing"} in front`),
      app,
      help: [runHint(lifecycleCommand(context, ["app", "current"]), "to see what is in front")],
    };
  }
  return {
    ok: okLine("start", pkg, `foreground (${how(start, recreated)})`),
    app,
    ...(recreated || fresh
      ? {}
      : {
          help: [runHint([...command, "--fresh"], "to kill the process and cold-start")],
        }),
  };
}

/** The parenthesised part of the ok line: what the start actually did. */
function how(start: AmStart, recreated: boolean): string {
  if (!recreated) {
    if (start.notStarted === "brought-to-front") return "existing task brought to front";
    if (start.notStarted === "delivered-to-top") return "already on top, intent delivered to it";
    if (start.notStarted === "kept") return "current activity kept";
    return "hot start";
  }
  if (start.launch === "cold") return "cold start";
  if (start.launch === "warm") return "warm start";
  return "started";
}

function activityNotFound(
  context: CommandContext,
  pkg: string,
  activity: string | null,
  activities: readonly string[],
): AdbAxiError {
  const message =
    activity === null ? `${pkg} has no launcher activity` : `${pkg} has no activity ${activity}`;
  const first = activities[0];
  return new AdbAxiError("ACTIVITY_NOT_FOUND", message, {
    fields: { activities: [...activities] },
    help: [
      first === undefined
        ? runHint(
            lifecycleCommand(context, ["app", "start", `${pkg}/<activity>`]),
            "naming an activity of the app",
          )
        : runHint(
            lifecycleCommand(context, ["app", "start", `${pkg}/${first}`]),
            "to start a listed activity",
          ),
    ],
  });
}

function startTimeout(
  context: CommandContext,
  pkg: string,
  last: { status: string; activity: string },
  command: string[],
): AdbAxiError {
  return new AdbAxiError(
    "WAIT_TIMEOUT",
    `${pkg} did not finish launching within ${formatDuration(context.timeoutMs)}`,
    {
      fields: { last },
      help: [
        runHint(lifecycleCommand(context, ["app", "current"]), "to see what is in front"),
        runHint([...command, "--timeout", "30s"], "to give it longer"),
      ],
    },
  );
}

function diedOnStart(
  context: CommandContext,
  activity: Component,
  processName: string,
  last: Seen,
  command: string[],
): AdbAxiError {
  return new AdbAxiError(
    "APP_DIED_ON_START",
    `the ${processName} process of ${activity.component} is gone right after its start`,
    {
      fields: {
        last: { state: last.state, pid: last.pid, foreground: last.front?.package ?? UNKNOWN },
      },
      help: [
        ...(logsCrash.shipped
          ? [
              runHint(
                lifecycleCommand(context, [
                  "logs",
                  "crash",
                  "--pkg",
                  activity.package,
                  "--since",
                  "1m",
                ]),
                "for the crash",
              ),
            ]
          : []),
        runHint(
          context.flags.fresh === true ? command : [...command, "--fresh"],
          "to try a cold start",
        ),
      ],
    },
  );
}
