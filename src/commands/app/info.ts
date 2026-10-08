import { readForeground } from "../../android/foreground.js";
import { assertPackageName } from "../../android/component.js";
import { readPackage } from "../../android/packages.js";
import { pidof } from "../../android/pidof.js";
import { readCurrentUser } from "../../android/users.js";
import { readShell } from "../../android/read.js";
import { AdbAxiError } from "../../core/errors.js";
import { defineCommand } from "../define.js";
import type { CommandContext } from "../types.js";
import { formatVersion, readOptions, targetSerial, UNKNOWN } from "./shared.js";

export const appInfo = defineCommand({
  path: ["app", "info"],
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
    const serial = targetSerial(context);
    const options = readOptions(context);
    const adb = context.adb();
    const userId = await readCurrentUser(adb, serial, options);

    // Not installed is an answer. A record that says `installed=false` is a package
    // uninstalled with its data kept, which is not installed either.
    const record = await readPackage(adb, serial, pkg, options, userId);
    if (record === null || !record.installed) {
      return { app: { package: pkg, installed: false } };
    }

    const pids = await pidof(adb, serial, pkg, options);
    const resumed = await readForeground(adb, serial, options);
    return {
      app: {
        package: pkg,
        installed: true,
        version: formatVersion(record.versionName, record.versionCode),
        debuggable: record.debuggable,
        pid: pids[0] ?? UNKNOWN,
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
async function dataSize(context: CommandContext, pkg: string, userId: number): Promise<string> {
  try {
    const result = await readShell(
      context.adb(),
      targetSerial(context),
      `run-as ${pkg} --user ${userId} du -sk .`,
      `measuring the data of ${pkg}`,
      readOptions(context),
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
