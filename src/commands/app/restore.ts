import type { LaunchType } from "../../android/amstart.js";
import {
  declaredActivities,
  parseActivityFilters,
  readActivityProcessName,
} from "../../android/activities.js";
import { assertPackageName, type Component } from "../../android/component.js";
import { findTask, readRecents } from "../../android/recents.js";
import { AdbAxiError } from "../../core/errors.js";
import { okLine, runHint, type Output } from "../../core/output.js";
import { defineCommand } from "../define.js";
import type { CommandContext } from "../types.js";
import {
  lifecycleCommand,
  packageProcesses,
  requireInstalled,
  type InstalledPackage,
} from "./process.js";
import { readOptions, targetSerial, UNKNOWN } from "./shared.js";
import { amStart, settle, type Seen } from "./start.js";

export const appRestore = defineCommand({
  path: ["app", "restore"],
  summary:
    "Reopen an app from recents so its saved state is restored. It starts the task's own root activity with no launcher category and no flags, which brings the existing task to the front. An app that is still running is brought forward as it is.",
  positionals: [
    { name: "pkg", description: "Package name, for example com.example.notes", required: true },
  ],
  examples: ["adb-axi app restore com.example.notes"],
  shipped: true,
  run: async (context) => {
    const pkg = String(context.positionals.pkg);
    assertPackageName(pkg);
    const installed = await requireInstalled(context, pkg);
    const command = lifecycleCommand(context, ["app", "restore", pkg]);
    const restored = await restoreTask(context, pkg, installed, command);
    const { app, front } = restored;
    if (front !== pkg) {
      return {
        ok: okLine("restore", pkg, `running, ${front ?? "nothing"} in front`),
        app: appRecord(restored),
        help: [runHint(lifecycleCommand(context, ["app", "current"]), "to see what is in front")],
      };
    }
    return {
      ok: okLine(
        "restore",
        pkg,
        `foreground from recents (${app.newProcess ? "new process" : "same process"})`,
      ),
      app: appRecord(restored),
      ...(app.newProcess || !context.isShipped(["app", "kill"])
        ? {}
        : {
            help: [
              runHint(
                lifecycleCommand(context, ["app", "kill", pkg]),
                "first so the restore starts a new process",
              ),
            ],
          }),
    } satisfies Output;
  },
});

/** The app a restore brought up. */
export interface RestoredApp {
  activity: string;
  pid: number;
  launch: LaunchType;
  /** The restored process is not one of the package's processes from before the start. */
  newProcess: boolean;
}

export interface Restored {
  app: RestoredApp;
  /** The package in front once the restore settled, `null` when none is. */
  front: string | null;
}

/** The `app` block as `app restore` prints it. */
export function appRecord(restored: Restored): Record<string, unknown> {
  const { app } = restored;
  return {
    activity: app.activity,
    pid: app.pid,
    launch: app.launch,
    new_process: app.newProcess,
  };
}

/**
 * Reopen an app from its task in recents (L10): `am start -W -n <pkg>/<root activity>`
 * and nothing else. A launcher category, `-f` flags or `monkey` start a fresh task and
 * fake a state-loss bug, so none is ever sent. The launch type is `am`'s own word, and
 * whether the process is new comes from comparing pids, never from the launch type.
 * `command` is what hints name to retry.
 */
export async function restoreTask(
  context: CommandContext,
  pkg: string,
  installed: InstalledPackage,
  command: string[],
): Promise<Restored> {
  const adb = context.adb();
  const serial = targetSerial(context);
  const { userId } = installed;

  const task = findTask(await readRecents(adb, serial, readOptions(context)), pkg);
  if (task === undefined || task.activity === null) throw noTask(context, pkg);
  const component: Component = {
    package: pkg,
    activity: task.activity,
    component: `${pkg}/${task.activity}`,
  };

  const pidsBefore = (await packageProcesses(context, pkg, userId, readOptions(context))).map(
    (process) => process.pid,
  );
  const start = await amStart(context, adb, serial, pkg, component.activity, userId, command, () =>
    declaredActivities(parseActivityFilters(installed.dump), pkg),
  );
  const launched = start.activity ?? component;
  const processName = await readActivityProcessName(
    adb,
    serial,
    launched,
    userId,
    readOptions(context),
  );
  const settled = await settle(context, adb, serial, launched, userId, processName);
  const pid = settled.pid;
  if (settled.state === "stopped" || pid === UNKNOWN) {
    throw diedOnStart(context, launched, processName, settled);
  }
  const inFront = settled.state === "foreground";
  return {
    app: {
      activity: inFront
        ? (settled.front?.activity ?? component.activity)
        : (start.activity?.activity ?? component.activity),
      pid,
      launch: start.launch,
      newProcess: !pidsBefore.includes(pid),
    },
    front: settled.front?.package ?? null,
  };
}

/** `TASK_NOT_IN_RECENTS`: nothing to restore, and a start would be a fresh launch. */
function noTask(context: CommandContext, pkg: string): AdbAxiError {
  return new AdbAxiError(
    "TASK_NOT_IN_RECENTS",
    `${pkg} has no task in recents, so there is nothing to restore`,
    {
      help: context.isShipped(["app", "start"])
        ? [
            runHint(
              lifecycleCommand(context, ["app", "start", pkg]),
              "to start it fresh (its saved state is not restored)",
            ),
          ]
        : [],
    },
  );
}

/** `APP_DIED_ON_START`: the restored process is gone right after the start. */
function diedOnStart(
  context: CommandContext,
  activity: Component,
  processName: string,
  last: Seen,
): AdbAxiError {
  return new AdbAxiError(
    "APP_DIED_ON_START",
    `the ${processName} process of ${activity.component} is gone right after its restore`,
    {
      fields: {
        last: { state: last.state, pid: last.pid, foreground: last.front?.package ?? UNKNOWN },
      },
      help: context.isShipped(["logs", "crash"])
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
        : [],
    },
  );
}
