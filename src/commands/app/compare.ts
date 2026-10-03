import { exec } from "../../core/exec.js";
import type { CommandContext } from "../types.js";
import { targetSerial } from "./shared.js";

/** The most `agent-device snapshot --json` output read; a UI tree is far smaller. */
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;

export type Snapshot =
  { ok: true; text: string[] } | { ok: false; reason: string; detail?: string };

/**
 * The visible text of the screen, from `agent-device snapshot --json`. adb-axi opens no
 * UiAutomation connection of its own: this is the only UI read, and it is only made for
 * `app death --compare`. The tool runs for the device the command targets and under what
 * is left of the command deadline.
 */
export async function takeSnapshot(context: CommandContext): Promise<Snapshot> {
  const result = await exec({
    file: "agent-device",
    args: ["snapshot", "--json"],
    deadlineMs: context.deadline.remainingMs(),
    env: { ...context.env, ANDROID_SERIAL: targetSerial(context) },
    maxOutputBytes: MAX_SNAPSHOT_BYTES,
  });
  switch (result.kind) {
    case "spawn-error":
      return { ok: false, reason: "agent-device is not installed or not on PATH" };
    case "timeout":
      return { ok: false, reason: "agent-device snapshot did not answer before the deadline" };
    case "output-limit":
      return { ok: false, reason: "agent-device snapshot printed more than 8 MiB" };
    case "exited":
      break;
  }
  const stdout = result.stdout.toString("utf8");
  if (result.exitCode !== 0) {
    return {
      ok: false,
      reason: `agent-device snapshot exited ${result.exitCode ?? "without a code"}`,
      detail: (result.stderr.toString("utf8").trim() || stdout.trim()).slice(0, 200),
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return {
      ok: false,
      reason: "agent-device snapshot did not print JSON",
      detail: stdout.trim().slice(0, 200),
    };
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    !("nodes" in parsed) ||
    !Array.isArray(parsed.nodes) ||
    !validNodes(parsed.nodes)
  ) {
    return { ok: false, reason: "agent-device snapshot did not contain a UI tree" };
  }
  return { ok: true, text: visibleText(parsed) };
}

function validNodes(nodes: unknown[]): boolean {
  return nodes.every((node) => {
    if (typeof node !== "object" || node === null || Array.isArray(node)) return false;
    for (const key of ["nodes", "children"]) {
      if (key in node) {
        const children = (node as Record<string, unknown>)[key];
        if (!Array.isArray(children) || !validNodes(children)) return false;
      }
    }
    return true;
  });
}

/** Node fields that carry text a user can see. */
const TEXT_KEYS = new Set(["text", "label", "value"]);

/** Every non-empty text field of the snapshot tree, in document order. */
export function visibleText(snapshot: unknown): string[] {
  const found: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
    } else if (typeof node === "object" && node !== null) {
      for (const [key, value] of Object.entries(node)) {
        if (TEXT_KEYS.has(key) && typeof value === "string") {
          const text = value.trim();
          if (text !== "") found.push(text);
        } else {
          walk(value);
        }
      }
    }
  };
  walk(snapshot);
  return found;
}

/**
 * The text lines that differ, `- ` for one only in `before` and `+ ` for one only in
 * `after`. Repeats are counted: a line shown twice before and once after is one removal.
 */
export function textDiff(before: readonly string[], after: readonly string[]): string[] {
  const count = (lines: readonly string[]): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);
    return counts;
  };
  const unmatched = (
    from: readonly string[],
    against: readonly string[],
    sign: string,
  ): string[] => {
    const left = count(against);
    const diff: string[] = [];
    for (const line of from) {
      const remaining = left.get(line) ?? 0;
      if (remaining > 0) left.set(line, remaining - 1);
      else diff.push(`${sign} ${line}`);
    }
    return diff;
  };
  return [...unmatched(before, after, "-"), ...unmatched(after, before, "+")];
}
