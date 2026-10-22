import { mainProcess, runningProcesses } from "../../android/app-processes.js";
import { readForeground } from "../../android/foreground.js";
import { assertPackageName } from "../../android/component.js";
import { readShell } from "../../android/read.js";
import { AdbAxiError } from "../../core/errors.js";
import { defineCommand } from "../define.js";
import type { DeviceContext } from "../types.js";
import { formatVersion, UNKNOWN } from "./shared.js";

export const appInfo = defineCommand({
  path: ["app", "info"],
  help: ["Reports package facts for the current Android user"],
  summary: "One package's facts: installed, version, debuggable, pid, foreground, data size",
  positionals: [
    {
      name: "pkg",
      description:
        "Package name, for example com.example.notes. One that is not installed answers `installed: false` with exit 0, not an error",
      required: true,
    },
  ],
  examples: [
    "adb-axi app info com.example.notes",
    "adb-axi app info com.example.notes --device Pixel_Tablet --json",
  ],
  shipped: true,
  run: async (context) => {
    const pkg = String(context.positionals.pkg);
    assertPackageName(pkg);
    const serial = context.device.serial;
    const options = context.device.reads;
    const adb = context.device.adb;
    const resolved = await context.device.app(pkg);
    if (!resolved.installed) {
      return { app: { package: pkg, installed: false } };
    }

    const { userId, info: record, identity: app } = resolved;
    const main = mainProcess(app, await runningProcesses(adb, serial, app, options));
    const resumed = await readForeground(adb, serial, { ...options, userId });
    return {
      app: {
        package: pkg,
        installed: true,
        version: formatVersion(record.versionName, record.versionCode),
        debuggable: record.debuggable,
        pid: main?.pid ?? UNKNOWN,
        foreground: resumed?.package === pkg,
        data_size: record.debuggable ? await dataSize(context, pkg, userId) : UNKNOWN,
      },
    };
  },
});

/**
 * The size of a debuggable app's data directory. Only `run-as` can read it, so a refusal
 * is an unknown size, not a failure of the command.
 */
async function dataSize(context: DeviceContext, pkg: string, userId: number): Promise<string> {
  try {
    const result = await readShell(
      context.device.adb,
      context.device.serial,
      `run-as ${pkg} --user ${userId} du -sk .`,
      `measuring the data of ${pkg}`,
      context.device.reads,
    );
    const kb = /^(\d+)\s/.exec(result.stdout)?.[1];
    return kb === undefined ? UNKNOWN : formatKb(Number(kb));
  } catch (error) {
    if (error instanceof AdbAxiError && error.code === "REMOTE_EXIT") return UNKNOWN;
    throw error;
  }
}

function formatKb(kb: number): string {
  return kb < 1024 ? `${kb} KB` : `${(kb / 1024).toFixed(1)} MB`;
}
