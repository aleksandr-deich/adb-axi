const SIGNALS = ["SIGINT", "SIGTERM"] as const;

/** Undo steps for SIGINT and SIGTERM, newest first, as nested `finally` blocks would run. */
const cleanups: (() => void)[] = [];

/**
 * Run `cleanup` if SIGINT or SIGTERM ends the process before the returned function is
 * called. Node.js exits on these signals without running `finally` blocks, so anything a
 * command must not leave behind (a copied app database, a running child) registers here
 * as well. After the cleanups the signal is raised again, so the process still ends the
 * way the signal ends it: killed by it, with status 130 or 143 in a shell.
 */
export function onInterrupt(cleanup: () => void): () => void {
  cleanups.push(cleanup);
  if (cleanups.length === 1) {
    for (const signal of SIGNALS) process.on(signal, interrupted);
  }
  return () => {
    const index = cleanups.lastIndexOf(cleanup);
    if (index === -1) return;
    cleanups.splice(index, 1);
    if (cleanups.length === 0) {
      for (const signal of SIGNALS) process.off(signal, interrupted);
    }
  };
}

function interrupted(signal: NodeJS.Signals): void {
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      cleanup();
    } catch {
      // The other cleanups still run; the process is ending either way.
    }
  }
  for (const each of SIGNALS) process.off(each, interrupted);
  process.kill(process.pid, signal);
}
