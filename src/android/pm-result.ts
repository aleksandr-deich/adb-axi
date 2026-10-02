/** A package manager failure: its code and the message after it, when it printed one. */
export interface PmFailure {
  code: string;
  message: string | null;
}

/**
 * `pm install`, `pm uninstall` and `adb install` report a refusal as
 * `Failure [<CODE>]` or `Failure [<CODE>: <message>]` (AOSP `PackageManagerShellCommand`),
 * and adb wraps it as `adb: failed to install x.apk: Failure [...]`. The code is what
 * adb-axi maps; the message is kept as evidence. Returns `null` for output without a code.
 */
export function parsePmFailure(output: string): PmFailure | null {
  const bracketed = /Failure \[([A-Z][A-Z0-9_]*)(?::\s*([^\]]*))?\]/.exec(output);
  if (bracketed?.[1] !== undefined) {
    const message = bracketed[2]?.trim();
    return {
      code: bracketed[1],
      message: message === undefined || message === "" ? null : message,
    };
  }
  // Some paths print the bare code, for example in an exception message.
  const bare = /\b((?:INSTALL|DELETE)_(?:PARSE_)?FAILED_[A-Z0-9_]+)\b/.exec(output);
  return bare?.[1] === undefined ? null : { code: bare[1], message: null };
}
