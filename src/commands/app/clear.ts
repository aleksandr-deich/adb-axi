import { runShell } from "../../adb/shell.js";
import { assertPackageName } from "../../android/component.js";
import { invalidOutput, readShell } from "../../android/read.js";
import { AdbAxiError } from "../../core/errors.js";
import { okLine, runHint } from "../../core/output.js";
import { defineCommand } from "../define.js";
import type { CommandContext } from "../types.js";
import { lifecycleCommand, requireInstalled, stopFailed, waitForExit } from "./process.js";
import { readOptions, targetSerial } from "./shared.js";

/** How many of the files left after a clear the error lists. */
const LISTED_FILES = 10;

export const appClear = defineCommand({
  path: ["app", "clear"],
  summary:
    "Clear the current Android user's app data, verify it is cleared, and report the process stopped. Android also stops the app's running processes for other Android users, leaving their data intact.",
  positionals: [
    { name: "pkg", description: "Package name, for example com.example.notes", required: true },
  ],
  flags: [
    {
      name: "--full",
      type: "boolean",
      description: "List all files left if data verification fails",
    },
  ],
  examples: ["adb-axi app clear com.example.notes"],
  shipped: true,
  run: async (context) => {
    const pkg = String(context.positionals.pkg);
    assertPackageName(pkg);
    const serial = targetSerial(context);
    const adb = context.adb();

    const { info, userId } = await requireInstalled(context, pkg);

    // `pm clear` waits for the system to report the data cleared, then prints `Success`;
    // a refusal prints `Failed` and exits 1 (AOSP `PackageManagerShellCommand.runClear`).
    // Clearing also force-stops the app, which the pid check below verifies.
    const step = `clearing the data of ${pkg}`;
    const result = await readShell(
      adb,
      serial,
      `pm clear --user ${userId} ${pkg}`,
      step,
      readOptions(context),
    );
    if (result.stdout.trim() !== "Success") throw invalidOutput(step, result.stdout);

    const exit = await waitForExit(context, pkg, userId);
    if (!exit.gone) {
      throw stopFailed(context, pkg, exit.last, context.timeoutMs, {
        command: lifecycleCommand(context, [
          "app",
          "clear",
          pkg,
          ...(context.flags.full === true ? ["--full"] : []),
        ]),
        step: "pm clear",
      });
    }

    const listed = info.debuggable && (await checkNoFiles(context, pkg, userId));
    return {
      ok: okLine("clear", pkg, "data cleared, process stopped"),
      confirmed_by: listed ? ["pm clear", "run-as"] : ["pm clear"],
    };
  },
});

/**
 * List every regular file left in the app's data directory (`databases`, `shared_prefs`,
 * `files`, ...). An empty `cache` or `code_cache` directory is not data; any file is.
 * Only `run-as` can list them, so a refusal means the files were not listed (`false`).
 */
async function checkNoFiles(
  context: CommandContext,
  pkg: string,
  userId: number,
): Promise<boolean> {
  const result = await runShell(
    context.adb(),
    targetSerial(context),
    `run-as ${pkg} --user ${userId} find . -type f`,
    { deadline: context.deadline, step: `listing the data files of ${pkg}` },
  );
  const files = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => line.replace(/^\.\//, ""));
  if (files.length === 0) return result.exitCode === 0;
  const full = context.flags.full === true;
  throw new AdbAxiError(
    "CLEAR_FAILED",
    `${pkg} still has ${files.length === 1 ? "1 file" : `${files.length} files`} in its data directory after pm clear`,
    {
      fields: { left: { count: files.length, files: full ? files : files.slice(0, LISTED_FILES) } },
      help: [
        ...(!full && files.length > LISTED_FILES
          ? [
              runHint(
                lifecycleCommand(context, ["app", "clear", pkg, "--full"]),
                "to list all remaining files",
              ),
            ]
          : []),
        runHint(
          lifecycleCommand(context, ["app", "clear", pkg, ...(full ? ["--full"] : [])]),
          "to clear it again",
        ),
        runHint(lifecycleCommand(context, ["app", "info", pkg]), "for its data size"),
      ],
    },
  );
}
