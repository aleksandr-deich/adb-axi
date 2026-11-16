import { assertPackageName } from "../../android/component.js";
import { readShell } from "../../android/read.js";
import { AdbAxiError } from "../../core/errors.js";
import { render, runHint, shellWords, type Output } from "../../core/output.js";
import { truncateField, writeFullOutput } from "../../core/truncate.js";
import { lifecycleCommand } from "../app/process.js";
import { defineCommand } from "../define.js";
import type { DeviceContext } from "../types.js";
import { runAsRefusal } from "./databases.js";
import { assertPrefsFile, MAX_PREFS_BYTES, parsePreferences } from "./prefs-xml.js";

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
    const { stdout } = await prefsRead(
      context,
      pkg,
      app.userId,
      "if [ ! -e shared_prefs ]; then exit 0; fi; if [ -L shared_prefs ] || [ ! -d shared_prefs ]; then exit 1; fi; find shared_prefs -maxdepth 1 -type f -name '*.xml' -print0",
      `listing the SharedPreferences of ${pkg}`,
    );
    const files = stdout
      .split("\0")
      .filter(Boolean)
      .map((path) => {
        if (!path.startsWith("shared_prefs/"))
          throw new AdbAxiError("INVALID_OUTPUT", "Unexpected SharedPreferences file listing");
        const name = path.slice("shared_prefs/".length);
        assertPrefsFile(name);
        return name;
      })
      .sort();
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
    const path = shellWords([`shared_prefs/${file}`]);
    const read = await prefsRead(
      context,
      pkg,
      app.userId,
      `if [ -L shared_prefs ] || [ -L ${path} ] || [ ! -f ${path} ]; then exit 1; fi; head -c ${MAX_PREFS_BYTES + 1} ${path}`,
      `reading SharedPreferences of ${pkg}`,
      MAX_PREFS_BYTES + 65536,
    );
    const rows = parsePreferences(read.stdout);
    let cut = rows.length > 50;
    const shown = rows.slice(0, 50).map((row) => {
      const key = truncateField(row.key);
      let value = row.value;
      if (typeof value === "string") value = truncateField(value);
      else if (Array.isArray(value)) {
        const preview = truncateField(JSON.stringify(value));
        if (preview !== JSON.stringify(value)) value = preview;
      }
      if (key !== row.key || value !== row.value) cut = true;
      return { ...row, key, value };
    });
    const out: Output = { file, count: `${rows.length} preferences`, rows: shown };
    if (cut) {
      out.shown = `${shown.length} of ${rows.length} rows; long fields truncated`;
      if (context.flags.full === true)
        out.full = writeFullOutput(`prefs-${pkg}`, `${render({ file, rows }, context.mode)}\n`);
      else
        out.help = ["Run the same command with `--full` to write complete rows to a private file"];
    }
    return out;
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
      const refusal = runAsRefusal(context, pkg, stderr);
      if (refusal !== undefined) throw refusal;
    }
    throw error;
  }
}
