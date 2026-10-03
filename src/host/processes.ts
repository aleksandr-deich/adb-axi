import { exec } from "../core/exec.js";

/** One process on the host: its pid and its full command line. */
export interface HostProcess {
  pid: number;
  args: string;
}

/**
 * The host's process list, or `null` when it cannot be read. Commands take it from their
 * context, so tests replace it without touching the machine they run on.
 */
export type HostProcessList = (deadlineMs: number) => Promise<HostProcess[] | null>;

/**
 * `ps -A -ww -o pid=,args=`: every process, with untruncated command lines and no header.
 * macOS and the procps `ps` of Linux both take these flags.
 */
export const HOST_PS_ARGS = ["-A", "-ww", "-o", "pid=,args="] as const;

export function parseHostPs(stdout: string): HostProcess[] {
  const processes: HostProcess[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    if (match?.[1] === undefined || match[2] === undefined) continue;
    processes.push({ pid: Number(match[1]), args: match[2] });
  }
  return processes;
}

export const readHostProcesses: HostProcessList = async (deadlineMs) => {
  if (deadlineMs <= 0) return null;
  const result = await exec({ file: "ps", args: HOST_PS_ARGS, deadlineMs });
  if (result.kind !== "exited" || result.exitCode !== 0) return null;
  const processes = parseHostPs(result.stdout.toString("utf8"));
  return processes.length > 0 ? processes : null;
};
