import { assertPackageName } from "../../android/component.js";
import { AdbAxiError } from "../../core/errors.js";
import { okLine, runHint } from "../../core/output.js";
import { defineCommand } from "../define.js";
import type { CommandContext } from "../types.js";
import { textDiff, takeSnapshot, type Snapshot } from "./compare.js";
import { killProcess, killRecord, type KillResult } from "./kill.js";
import { lifecycleCommand, requireInstalled } from "./process.js";
import { restoreTask, type Restored } from "./restore.js";

export const appDeath = defineCommand({
  path: ["app", "death"],
  summary:
    "Kill and restore an app in one call, with before and after evidence. It runs app kill, then app restore, so an app in front is sent to the background first.",
  positionals: [
    { name: "pkg", description: "Package name, for example com.example.notes", required: true },
  ],
  flags: [
    {
      name: "--compare",
      type: "boolean",
      description:
        "Also diff the visible text before and after, through agent-device (`agent-device snapshot --json`, which must be installed)",
    },
  ],
  defaultTimeoutMs: 30_000,
  examples: [
    "adb-axi app death com.example.notes",
    "adb-axi app death com.example.notes --compare",
  ],
  shipped: true,
  run: async (context) => {
    const pkg = String(context.positionals.pkg);
    assertPackageName(pkg);
    const compare = context.flags.compare === true;
    const installed = await requireInstalled(context, pkg);
    const command = lifecycleCommand(context, [
      "app",
      "death",
      pkg,
      ...(compare ? ["--compare"] : []),
    ]);

    // The kill and the restore run whether or not the comparison can; a snapshot that
    // fails is reported with their evidence once both are done.
    const before = compare ? await takeSnapshot(context) : undefined;
    const killed = await killProcess(context, pkg, installed, command);
    const restored = await afterKill(killed, () => restoreTask(context, pkg, installed, command));
    const death = deathRecord(killed, restored);
    const ok = okLine("death", pkg, deathState(pkg, killed, restored.front));
    if (before === undefined) return { ok, death };

    const after = before.ok ? await takeSnapshot(context) : before;
    if (!before.ok || !after.ok) {
      throw compareUnavailable(context, pkg, killed, death, failed(before, after));
    }
    return { ok, death, diff: textDiff(before.text, after.text) };
  },
});

/** The resulting state of the ok line: what happened to the app and what is in front. */
function deathState(pkg: string, killed: KillResult, front: string | null): string {
  if (front === pkg) {
    return killed.killed
      ? "killed and restored from recents"
      : "restored from recents (it was not running)";
  }
  return `${killed.killed ? "killed and restored" : "restored"}, ${front ?? "nothing"} in front`;
}

/** The `death` block: the process before, after the kill and after the restore. */
function deathRecord(killed: KillResult, restored: Restored): Record<string, unknown> {
  const evidence = killed.killed ? killed.evidence : undefined;
  return {
    pid_before: evidence?.pidBefore ?? null,
    pid_after_kill: null,
    pid_restored: restored.app.pid,
    new_process: restored.app.newProcess,
    launch: restored.app.launch,
    cached_after_ms: evidence?.cachedAfterMs ?? null,
    method: evidence?.method ?? null,
  };
}

/**
 * Run the restore; its failure carries what the kill did, because the process is gone
 * whether or not the restore worked.
 */
async function afterKill(killed: KillResult, restore: () => Promise<Restored>): Promise<Restored> {
  try {
    return await restore();
  } catch (error) {
    if (!(error instanceof AdbAxiError) || !killed.killed) throw error;
    throw new AdbAxiError(error.code, error.message, {
      fields: { ...error.fields, kill: killRecord(killed.evidence) },
      help: error.help,
      cause: error,
    });
  }
}

function failed(before: Snapshot, after: Snapshot): { reason: string; detail?: string } {
  const snapshot = before.ok ? after : before;
  return snapshot.ok ? { reason: "no snapshot" } : snapshot;
}

/** `COMPARE_UNAVAILABLE`: the kill and restore ran; their evidence travels with the error. */
function compareUnavailable(
  context: CommandContext,
  pkg: string,
  killed: KillResult,
  death: Record<string, unknown>,
  why: { reason: string; detail?: string },
): AdbAxiError {
  return new AdbAxiError(
    "COMPARE_UNAVAILABLE",
    `${pkg} was ${killed.killed ? "killed and restored" : "restored"}, but the visible-text comparison could not run: ${why.reason}`,
    {
      fields: { ...(why.detail === undefined ? {} : { detail: why.detail }), death },
      help: [
        runHint(
          lifecycleCommand(context, ["app", "death", pkg]),
          "to repeat the check without --compare",
        ),
      ],
    },
  );
}
