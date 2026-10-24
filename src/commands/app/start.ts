import {
  declaredActivities,
  resolveLauncherActivity,
  parseActivityFilters,
} from "../../android/activities.js";
import { wasRecreated, type AmStart } from "../../android/amstart.js";
import { assertPackageName } from "../../android/component.js";
import type { Seen } from "../../android/launch.js";
import { AdbAxiError } from "../../core/errors.js";
import { okLine, runHint, type Output } from "../../core/output.js";
import { defineCommand } from "../define.js";
import type { DeviceContext } from "../types.js";
import {
  appPids,
  forceStop,
  lifecycleCommand,
  requireInstalled,
  stopFailed,
  waitForExit,
} from "./process.js";
import { activityNotFound, launchApp } from "./launch.js";

/**
 * Activity class names as `am start -n` takes them: `.MainActivity`, a full class name, or
 * a nested class with `$`. Anything else never reaches the device shell.
 */
const ACTIVITY_NAME = /^\.?[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/;

export const appStart = defineCommand({
  path: ["app", "start"],
  help: [
    "Starts the app for the current Android user",
    "Post-launch re-observation stops after 2s or the remaining deadline, whichever is shorter; the first observation may use the remaining --timeout on a slow device; a live app may be reported with another app in front",
  ],
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
    const serial = context.device.serial;
    const adb = context.device.adb;

    const fresh = context.flags.fresh === true;
    const command = lifecycleCommand(context, [
      "app",
      "start",
      requested === null ? pkg : `${pkg}/${requested}`,
      ...(fresh ? ["--fresh"] : []),
    ]);
    const installed = await requireInstalled(context, pkg);
    const { dump, userId, identity: app } = installed;
    const filters = parseActivityFilters(dump);
    const activity =
      requested ?? (await resolveLauncherActivity(adb, serial, pkg, userId, context.device.reads));
    if (activity === null) {
      throw activityNotFound(context, pkg, null, declaredActivities(filters, pkg));
    }

    if (fresh) {
      const before = await appPids(context, app);
      const stop = () => forceStop(adb, serial, pkg, userId, context.device.reads);
      await stop();
      const exit = await waitForExit(context, app, before, stop);
      if (!exit.gone) {
        throw stopFailed(context, pkg, exit.last, context.timeoutMs, {
          command,
          step: "am force-stop",
        });
      }
    }

    const { start, settled } = await launchApp(
      context,
      installed,
      { package: pkg, activity, component: `${pkg}/${activity}` },
      { operation: "start", command },
    );
    return report(context, pkg, activity, fresh, start, settled, command);
  },
});

/** `<pkg>[/<activity>]` and `--activity`, checked before any device call. */
function startTarget(context: DeviceContext): { pkg: string; activity: string | null } {
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

function report(
  context: DeviceContext,
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
