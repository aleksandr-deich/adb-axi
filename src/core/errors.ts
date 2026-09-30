import { AxiError } from "axi-sdk-js";

/**
 * Every error code adb-axi can print. Exit 2 is reserved for usage errors; every other
 * code exits 1. `INSTALL_FAILED_*` codes come from the package manager and are accepted
 * through `ErrorCode` without being listed one by one.
 */
export const ERROR_CATALOGUE = {
  VALIDATION_ERROR: "Unknown flag or value, missing argument, or a flag before the command",
  ADB_NOT_FOUND: "No adb executable in any searched location",
  ADB_SERVER_UNREACHABLE: "The adb server did not answer within the deadline",
  DEVICE_AMBIGUOUS: "Several devices match and none was selected",
  DEVICE_OFFLINE: "The target device is offline",
  DEVICE_UNAUTHORIZED: "USB debugging is not authorized on the target device",
  DEVICE_NOT_FOUND: "The serial or AVD name is not attached",
  WAIT_TIMEOUT: "A wait passed its deadline; the last observation is included",
  TIMEOUT: "A step passed its deadline; the running step is named",
  REMOTE_EXIT: "The remote shell command exited non-zero",
  HOLDER_PROTECTED: "A live UiAutomation holder was not touched",
  APP_NOT_INSTALLED: "The package is not installed",
  ACTIVITY_NOT_FOUND: "The activity does not exist; existing ones are listed",
  APP_DIED_ON_START: "The process was gone right after start or restore",
  STOP_FAILED: "The process was still present at the deadline after a force-stop",
  KILL_TIMEOUT: "The process was still alive at the deadline",
  TASK_NOT_IN_RECENTS: "There is no task in recents to restore",
  COMPARE_UNAVAILABLE: "The UI comparison could not run; kill and restore evidence is included",
  MARK_NOT_FOUND: "No log mark with that name on this device",
  APP_NOT_DEBUGGABLE: "run-as refused, so private app files cannot be read",
  DB_NOT_FOUND: "No such database; existing ones are listed",
  INVALID_OUTPUT: "Copied bytes are not the expected file",
  SQL_ERROR: "sqlite3 rejected the query",
  NOT_IMPLEMENTED: "The command is registered but not available in this build",
  UPDATE_ERROR: "The self-update could not complete",
  INTERNAL_ERROR: "adb-axi hit an unexpected internal failure",
} as const;

export type CatalogueCode = keyof typeof ERROR_CATALOGUE;
export type InstallFailedCode = `INSTALL_FAILED_${string}`;
export type ErrorCode = CatalogueCode | InstallFailedCode;

const INSTALL_FAILED_PATTERN = /^INSTALL_FAILED_[A-Z0-9_]+$/;

export function isErrorCode(code: string): code is ErrorCode {
  return Object.hasOwn(ERROR_CATALOGUE, code) || INSTALL_FAILED_PATTERN.test(code);
}

/** Keys the error shape owns; structured fields may not reuse them. */
const RESERVED_KEYS = new Set(["error", "code", "help"]);

export type ErrorFields = Record<string, unknown>;

export interface AdbAxiErrorOptions {
  /** Structured fields printed between `code` and `help`, in insertion order. */
  fields?: ErrorFields;
  /** Next-step commands, printed as `help[N]`. */
  help?: readonly string[];
  cause?: unknown;
}

/** The one error type commands throw. Rendered as `error, code, <fields>, help`. */
export class AdbAxiError extends AxiError {
  override readonly code: ErrorCode;
  readonly fields: ErrorFields;

  constructor(code: ErrorCode, message: string, options: AdbAxiErrorOptions = {}) {
    super(message, checkedCode(code), [...(options.help ?? [])]);
    const fields = options.fields ?? {};
    for (const key of Object.keys(fields)) {
      if (RESERVED_KEYS.has(key)) {
        throw new TypeError(`Error field "${key}" collides with the error shape`);
      }
    }
    this.name = "AdbAxiError";
    this.code = code;
    this.fields = fields;
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }

  get help(): readonly string[] {
    return this.suggestions;
  }
}

function checkedCode(code: string): ErrorCode {
  if (!isErrorCode(code)) {
    throw new TypeError(`Unknown adb-axi error code: ${code}`);
  }
  return code;
}

export function exitCodeForCode(code: string): 1 | 2 {
  return code === "VALIDATION_ERROR" ? 2 : 1;
}

/**
 * The error shape as one ordered object: `error`, `code`, structured fields, `help`.
 * TOON and JSON are both rendered from this object, so their keys always match.
 */
export function errorObject(error: unknown): Record<string, unknown> {
  if (error instanceof AdbAxiError) {
    return shape(error.message, error.code, error.fields, error.help);
  }
  if (error instanceof AxiError) {
    return shape(error.message, error.code, {}, error.suggestions);
  }
  // Unexpected failures never pass raw text off as the message; it goes in `detail`.
  const detail = error instanceof Error ? error.message : String(error);
  return shape("adb-axi hit an internal error", "INTERNAL_ERROR", { detail }, []);
}

function shape(
  message: string,
  code: string,
  fields: ErrorFields,
  help: readonly string[],
): Record<string, unknown> {
  const output: Record<string, unknown> = { error: message, code };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      output[key] = value;
    }
  }
  if (help.length > 0) {
    output.help = [...help];
  }
  return output;
}

export function exitCodeForError(error: unknown): 1 | 2 {
  return error instanceof AxiError ? exitCodeForCode(error.code) : 1;
}
