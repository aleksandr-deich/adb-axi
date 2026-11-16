import { assertPackageName } from "../../android/component.js";
import { readShell } from "../../android/read.js";
import { AdbAxiError } from "../../core/errors.js";
import { runHint, shellWords } from "../../core/output.js";
import { lifecycleCommand } from "../app/process.js";
import { defineCommand } from "../define.js";
import type { DeviceContext } from "../types.js";
import { runAsRefusal } from "./databases.js";
import { assertPrefsFile, MAX_PREFS_BYTES, parsePreferences } from "./prefs-xml.js";
import {
  PREFS_LIST_SCRIPT,
  prefsInventory,
  prefsReadScript,
  prefsSnapshot,
} from "./prefs-files.js";
import { presentPreferences } from "./prefs-output.js";

export const dataPrefs = defineCommand({
  path: ["data", "prefs"],
  summary: "Read a debuggable app's SharedPreferences as typed key/value rows (not DataStore)",
  positionals: [{ name: "pkg", description: "Package name of a debuggable app", required: true }],
  flags: [
    {
      name: "--file",
      type: "string",
      valueName: "<name>",
      description: "Exact XML file name, required when several exist",
    },
    {
      name: "--full",
      type: "boolean",
      description: "Write complete rows to a private output file when the view is truncated",
    },
  ],
  help: [
    "Reads the current Android user's files without changing them; concurrent app writes are not an atomic snapshot",
    "XML is limited to 4 MiB; DTDs and custom entities are refused. Long values are decimal strings; sets are string arrays",
    "Shows up to 50 rows with bounded fields; --full uses the existing private output directory",
    "Float NaN, Infinity, -Infinity and -0.0 are strings; other floats are numbers",
    "Backup files participate in selection; when present, the backup is read as Android would restore it, and source names it",
  ],
  examples: [
    "adb-axi data prefs com.example.notes",
    "adb-axi data prefs com.example.notes --file settings.xml",
  ],
  shipped: true,
  run: async (context) => {
    const pkg = String(context.positionals.pkg);
    assertPackageName(pkg);
    const requested = typeof context.flags.file === "string" ? context.flags.file : undefined;
    if (requested !== undefined) assertPrefsFile(requested);
    const app = await context.device.app(pkg);
    if (!app.installed) {
      throw new AdbAxiError(
        "APP_NOT_INSTALLED",
        `${pkg} is not installed for Android user ${app.userId}`,
      );
    }
    const listing = await prefsRead(
      context,
      pkg,
      app.userId,
      PREFS_LIST_SCRIPT,
      `listing the SharedPreferences of ${pkg}`,
    );
    const files = prefsInventory(listing.stdoutBytes);
    const file = requested ?? (files.length === 1 ? files[0] : undefined);
    if (file === undefined || !files.includes(file)) {
      const ambiguous = requested === undefined && files.length > 1;
      throw new AdbAxiError(
        ambiguous ? "VALIDATION_ERROR" : "PREFS_NOT_FOUND",
        ambiguous
          ? `${pkg} has ${files.length} SharedPreferences files; pick one with --file`
          : `${pkg} has no SharedPreferences${requested === undefined ? " files" : ` file named ${requested}`}`,
        {
          fields: { files },
          help: [
            runHint(
              lifecycleCommand(context, ["data", "prefs", pkg, "--file", "<name>"]),
              "with an existing XML file name; run the app first if none exist",
            ),
          ],
        },
      );
    }
    const read = await prefsRead(
      context,
      pkg,
      app.userId,
      prefsReadScript(file),
      `reading SharedPreferences of ${pkg}`,
      MAX_PREFS_BYTES + 65536,
    );
    try {
      const { source, xml } = prefsSnapshot(read.stdoutBytes, file);
      return presentPreferences(
        file,
        source,
        parsePreferences(xml),
        context.mode,
        pkg,
        context.flags.full === true,
      );
    } catch (error) {
      if (error instanceof AdbAxiError && error.code === "INVALID_OUTPUT") {
        throw new AdbAxiError(error.code, error.message, {
          fields: error.fields,
          help: [
            "The app may be writing this file; run again when its preference writes have finished",
          ],
        });
      }
      throw error;
    }
  },
});

async function prefsRead(
  context: DeviceContext,
  pkg: string,
  user: number,
  script: string,
  step: string,
  maxOutputBytes?: number,
) {
  try {
    return await readShell(
      context.device.adb,
      context.device.serial,
      `run-as ${pkg} --user ${user} sh -c ${shellWords([script])}`,
      step,
      { ...context.device.reads, ...(maxOutputBytes === undefined ? {} : { maxOutputBytes }) },
    );
  } catch (error) {
    if (error instanceof AdbAxiError && error.code === "REMOTE_EXIT") {
      const stderr = typeof error.fields.stderr === "string" ? error.fields.stderr : "";
      const refusal = runAsRefusal(context, pkg, stderr, user);
      if (refusal !== undefined) throw refusal;
    }
    throw error;
  }
}
