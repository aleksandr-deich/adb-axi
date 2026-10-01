import { assertPackageName } from "../../android/component.js";
import { invalidOutput, readShell } from "../../android/read.js";
import { okLine } from "../../core/output.js";
import { defineCommand } from "../define.js";
import { requireInstalled, stopFailed, waitForExit } from "./process.js";
import { readOptions, targetSerial } from "./shared.js";

export const appClear = defineCommand({
  path: ["app", "clear"],
  summary: "Clear an app's data, verify it is cleared, and report the process stopped",
  positionals: [
    { name: "pkg", description: "Package name, for example com.example.notes", required: true },
  ],
  examples: ["adb-axi app clear com.example.notes"],
  shipped: true,
  run: async (context) => {
    const pkg = String(context.positionals.pkg);
    assertPackageName(pkg);
    const serial = targetSerial(context);
    const adb = context.adb();

    await requireInstalled(context, pkg);

    // `pm clear` waits for the system to report the data cleared, then prints `Success`;
    // a refusal prints `Failed` and exits 1 (AOSP `PackageManagerShellCommand.runClear`).
    // Clearing also force-stops the app, which the pid check below verifies.
    const step = `clearing the data of ${pkg}`;
    const result = await readShell(adb, serial, `pm clear ${pkg}`, step, readOptions(context));
    if (result.stdout.trim() !== "Success") throw invalidOutput(step, result.stdout);

    const exit = await waitForExit(adb, serial, pkg, context);
    if (!exit.gone) throw stopFailed(pkg, exit.last, context.timeoutMs);
    return { ok: okLine("clear", pkg, "data cleared, process stopped") };
  },
});
