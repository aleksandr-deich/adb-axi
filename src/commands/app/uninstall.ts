import { assertPackageName } from "../../android/component.js";
import { readPackage } from "../../android/packages.js";
import { parsePmFailure } from "../../android/pm-result.js";
import { runShell } from "../../adb/shell.js";
import { AdbAxiError } from "../../core/errors.js";
import { noop, okLine, runHint } from "../../core/output.js";
import { defineCommand } from "../define.js";
import { forgetInstallRecord } from "./install-record.js";

export const appUninstall = defineCommand({
  path: ["app", "uninstall"],
  summary:
    "Remove a package for the current user; absent packages are a no-op. System-app updates revert to the factory version for all users (platform behaviour)",
  positionals: [
    { name: "pkg", description: "Package name, for example com.example.notes", required: true },
  ],
  flags: [{ name: "--keep-data", type: "boolean", description: "Keep the app's data directory" }],
  examples: [
    "adb-axi app uninstall com.example.notes",
    "adb-axi app uninstall com.example.notes --keep-data",
  ],
  shipped: true,
  run: async (context) => {
    const pkg = String(context.positionals.pkg);
    assertPackageName(pkg);
    const keepData = context.flags["keep-data"] === true;
    const serial = context.device.serial;
    const options = context.device.reads;
    const adb = context.device.adb;
    const userId = await context.device.user();

    const record = await readPackage(adb, serial, pkg, options, userId);
    if (record === null || !record.installed) {
      const warning = forgetInstallRecord(serial, pkg, context.env);
      return {
        ok: okLine("uninstall", pkg, noop("already not installed")),
        ...(warning === undefined ? {} : { warning }),
      };
    }

    const result = await runShell(
      adb,
      serial,
      `pm uninstall${record.system ? "" : ` --user ${userId}`}${keepData ? " -k" : ""} ${pkg}`,
      {
        deadline: context.deadline,
        step: `uninstalling ${pkg}`,
      },
    );

    // The package manager's word is not the answer: the device is read again.
    const after = await readPackage(adb, serial, pkg, options, userId);
    if (after?.installed === true) {
      const output = `${result.stdout}\n${result.stderr}`;
      const failure = parsePmFailure(output);
      throw new AdbAxiError("UNINSTALL_FAILED", `${pkg} is still installed after the uninstall`, {
        fields: {
          package: pkg,
          reason:
            failure?.code ??
            (result.exitCode === 0
              ? "the package manager reported success"
              : `exit ${result.exitCode}`),
          ...(failure?.message == null ? {} : { detail: failure.message }),
        },
        help: [
          "A system app cannot be removed; uninstalling its update reverts it to the factory version for all users (platform behaviour). A device policy can also block removal",
          runHint(["app", "info", pkg], "for the version that is installed now"),
        ],
      });
    }

    const warning = forgetInstallRecord(serial, pkg, context.env);
    return {
      ok: okLine("uninstall", pkg, keepData ? "removed with data kept" : "removed"),
      ...(warning === undefined ? {} : { warning }),
    };
  },
});
