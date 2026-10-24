import { declaredActivities, parseActivityFilters } from "../../android/activities.js";
import type { Component } from "../../android/component.js";
import {
  launch,
  type LaunchDeath,
  type LaunchStarted,
  type LaunchTimeout,
} from "../../android/launch.js";
import { formatDuration } from "../../core/duration.js";
import { AdbAxiError } from "../../core/errors.js";
import { runHint } from "../../core/output.js";
import type { DeviceContext } from "../types.js";
import { lifecycleCommand, type InstalledPackage } from "./process.js";
import { UNKNOWN } from "./shared.js";

interface LaunchCommand {
  operation: "start" | "restore";
  command: string[];
}

export async function launchApp(
  context: DeviceContext,
  installed: InstalledPackage,
  component: Component,
  options: LaunchCommand,
): Promise<LaunchStarted> {
  let result;
  try {
    result = await launch(context.device, installed.identity, component);
  } catch (error) {
    if (error instanceof AdbAxiError) {
      if (error.code === "ACTIVITY_NOT_FOUND") {
        throw activityNotFound(
          context,
          component.package,
          component.activity,
          declaredActivities(parseActivityFilters(installed.dump), component.package),
        );
      }
      if (error.code === "REMOTE_EXIT" && error.fields.step === `starting ${component.component}`) {
        throw new AdbAxiError(error.code, error.message, {
          fields: error.fields,
          help: [
            runHint(
              lifecycleCommand(context, ["app", "info", component.package]),
              "to check the package",
            ),
          ],
          cause: error,
        });
      }
    }
    throw error;
  }
  if (result.status === "died") throw diedOnLaunch(context, result, options);
  if (result.status === "timeout")
    throw startTimeout(context, component.package, result, options.command);
  return result;
}

export function activityNotFound(
  context: DeviceContext,
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
  context: DeviceContext,
  pkg: string,
  result: LaunchTimeout,
  command: string[],
): AdbAxiError {
  return new AdbAxiError(
    "WAIT_TIMEOUT",
    `${pkg} did not finish launching within ${formatDuration(context.timeoutMs)}`,
    {
      fields: { last: result.last },
      help: [
        runHint(
          lifecycleCommand(context, ["app", "current"]),
          "to see what is in front (on a physical phone a system dialog such as Play Protect or a permission request can block the launch)",
        ),
        runHint([...command, "--timeout", "30s"], "to give it longer"),
      ],
    },
  );
}

function diedOnLaunch(
  context: DeviceContext,
  result: LaunchDeath,
  options: LaunchCommand,
): AdbAxiError {
  const { launched: activity, processName, settled: last } = result;
  const { operation, command } = options;
  return new AdbAxiError(
    "APP_DIED_ON_START",
    last.state === "crashed"
      ? `the ${processName} process of ${activity.component} crashed during its ${operation}`
      : `the ${processName} process of ${activity.component} is gone right after its ${operation}`,
    {
      fields: {
        last: { state: last.state, pid: last.pid, foreground: last.front?.package ?? UNKNOWN },
      },
      help: [
        ...(context.isShipped(["logs", "crash"])
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
        ...(operation === "start"
          ? [
              runHint(
                context.flags.fresh === true ? command : [...command, "--fresh"],
                "to try a cold start",
              ),
            ]
          : []),
      ],
    },
  );
}
