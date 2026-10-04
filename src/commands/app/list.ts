import { listPackages, parsePackageRecords, type PackageInfo } from "../../android/packages.js";
import { readShell } from "../../android/read.js";
import { AdbAxiError } from "../../core/errors.js";
import { runHint } from "../../core/output.js";
import { defineCommand } from "../define.js";
import { formatVersion, readOptions, targetSerial, UNKNOWN } from "./shared.js";

export const appList = defineCommand({
  path: ["app", "list"],
  summary: "Installed user packages with a count, optionally including system packages",
  flags: [
    { name: "--all", type: "boolean", description: "Include system packages" },
    {
      name: "--grep",
      type: "string",
      valueName: "<re>",
      description: "Only packages whose name matches this regex",
    },
  ],
  examples: ["adb-axi app list", "adb-axi app list --grep example"],
  shipped: true,
  run: async (context) => {
    const all = context.flags.all === true;
    const matches = nameFilter(context.flags.grep);
    const serial = targetSerial(context);
    const options = readOptions(context);
    const adb = context.adb();

    // The user set and the full set are both read, so the count line can say how many
    // packages the device has beyond the user's, whichever of the two is shown.
    const everything = (await listPackages(adb, serial, options)).filter((p) => matches(p.package));
    const userNames = new Set(
      (await listPackages(adb, serial, { ...options, thirdParty: true })).map((p) => p.package),
    );
    const users = everything.filter((p) => userNames.has(p.package));
    const shown = (all ? everything : users).sort((a, b) => a.package.localeCompare(b.package));

    // Version name and the debuggable flag only live in the package manager's own dump.
    const records =
      shown.length === 0
        ? new Map<string, PackageInfo>()
        : parsePackageRecords(
            (
              await readShell(
                adb,
                serial,
                "dumpsys package packages",
                "reading package details",
                options,
              )
            ).stdout,
          );

    const rows = shown.map((listed) => {
      const record = records.get(listed.package);
      return {
        package: listed.package,
        version: formatVersion(
          record?.versionName ?? null,
          record?.versionCode ?? listed.versionCode,
        ),
        debuggable: record === undefined ? UNKNOWN : record.debuggable,
      };
    });

    // Both forms say what is shown, then the user and system split.
    const system = everything.length - users.length;
    const count = all
      ? `${plural(everything.length, "package")} shown: ${users.length} user, ${system} system`
      : `${plural(users.length, "user package")} shown, ${plural(system, "system package")} hidden${system > 0 ? " (use --all)" : ""}`;
    const first = rows[0];
    return {
      count,
      packages: rows,
      ...(first === undefined
        ? {}
        : {
            help: [
              runHint(
                ["app", "info", first.package],
                "for its pid, foreground state and data size",
              ),
            ],
          }),
    };
  },
});

/** The `--grep` regex as a predicate on package names; a bad regex is a usage error. */
function nameFilter(grep: unknown): (name: string) => boolean {
  if (typeof grep !== "string") return () => true;
  try {
    const pattern = new RegExp(grep);
    return (name) => pattern.test(name);
  } catch (error) {
    throw new AdbAxiError("VALIDATION_ERROR", `\`${grep}\` is not a valid regex`, {
      fields: { detail: error instanceof Error ? error.message : String(error) },
      help: [runHint(["app", "list", "--grep", "<re>"], "with a valid regular expression")],
    });
  }
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
