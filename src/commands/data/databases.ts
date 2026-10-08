import { AdbAxiError } from "../../core/errors.js";
import { readShell } from "../../android/read.js";
import { runHint } from "../../core/output.js";
import type { CommandContext } from "../types.js";
import { lifecycleCommand } from "../app/process.js";
import { readOptions, targetSerial } from "../app/shared.js";

/** One database of an app: its main file and whether a write-ahead log sits next to it. */
export interface DatabaseFile {
  name: string;
  /** Bytes in the main file. With a WAL, recent writes can still be only in the log. */
  size: number;
  /** Bytes in the `-wal` file; `null` when there is none. */
  walSize: number | null;
}

/**
 * `ls -l` lines of toybox and toolbox alike: mode, links, owner, group, size, date, time,
 * name. Only regular files count; directories and links are not databases.
 */
const LS_LINE = /^-\S*\s+\d+\s+\S+\s+\S+\s+(\d+)\s+\d{4}-\d\d-\d\d\s+\d\d:\d\d(?::\d\d)?\s+(.+)$/;

/** Files SQLite keeps next to a database; they are never databases themselves. */
const COMPANION = /-(wal|shm|journal)$/;

/**
 * List the app's databases through `run-as`: every regular file in `databases/` except
 * SQLite's own `-wal`, `-shm` and `-journal` companions. An app without a `databases/`
 * directory has none. A `run-as` refusal becomes `APP_NOT_DEBUGGABLE` or
 * `APP_NOT_INSTALLED`.
 */
export async function listDatabases(
  context: CommandContext,
  pkg: string,
  userId: number,
): Promise<DatabaseFile[]> {
  const step = `listing the databases of ${pkg}`;
  let stdout: string;
  try {
    ({ stdout } = await readShell(
      context.adb(),
      targetSerial(context),
      `run-as ${pkg} --user ${userId} ls -l databases`,
      step,
      readOptions(context),
    ));
  } catch (error) {
    if (error instanceof AdbAxiError && error.code === "REMOTE_EXIT") {
      const stderr = typeof error.fields.stderr === "string" ? error.fields.stderr : "";
      const refusal = runAsRefusal(context, pkg, stderr);
      if (refusal !== undefined) throw refusal;
      if (/No such file or directory/.test(stderr)) return [];
    }
    throw error;
  }

  const sizes = new Map<string, number>();
  for (const line of stdout.split(/\r?\n/)) {
    const match = LS_LINE.exec(line.trim());
    if (match?.[1] !== undefined && match[2] !== undefined) sizes.set(match[2], Number(match[1]));
  }
  return [...sizes]
    .filter(([name]) => !COMPANION.test(name))
    .map(([name, size]) => ({ name, size, walSize: sizes.get(`${name}-wal`) ?? null }));
}

/**
 * The typed error for text `run-as` prints when it refuses (as stderr of a shell call, or
 * as the bytes of an `exec-out` call), or `undefined` when the text is not a refusal.
 */
export function runAsRefusal(
  context: CommandContext,
  pkg: string,
  text: string,
): AdbAxiError | undefined {
  const line = text.trim().split(/\r?\n/)[0] ?? "";
  if (!line.startsWith("run-as:")) return undefined;
  if (/unknown package|is unknown|not installed/i.test(line)) {
    return new AdbAxiError("APP_NOT_INSTALLED", `${pkg} is not installed`, {
      help: [runHint(lifecycleCommand(context, ["app", "list"]), "to see the installed packages")],
    });
  }
  return new AdbAxiError(
    "APP_NOT_DEBUGGABLE",
    `${pkg} is not debuggable, so its private files cannot be read`,
    {
      fields: { detail: line },
      help: [
        'Install a debuggable build of the app (debug variant, or `android:debuggable="true"`) and run the command again',
      ],
    },
  );
}
