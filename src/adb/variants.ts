import { AdbAxiError, type ErrorCode } from "../core/errors.js";

/**
 * One adb failure has several shapes (H6-H9): `error: device 'x' not found` (exit 255),
 * `adb: device 'x' not found` (exit 1), `adb: error: failed to get feature set: ...`, and
 * usage text with the same exit as a runtime failure. Each shape maps to exactly one code
 * here; the raw text only ever appears in `detail`.
 */
const MESSAGES: readonly [RegExp, ErrorCode][] = [
  [
    /(cannot connect to daemon|failed to start daemon|failed to check server version)/,
    "ADB_SERVER_UNREACHABLE",
  ],
  [/(device '[^']*' not found|no devices\/emulators found)/, "DEVICE_NOT_FOUND"],
  [
    /(device unauthorized|device still authorizing|insufficient permissions for device)/,
    "DEVICE_UNAUTHORIZED",
  ],
  [/(device offline|device still connecting)/, "DEVICE_OFFLINE"],
  [/more than one (device|emulator)/, "DEVICE_AMBIGUOUS"],
];

// adb printing its own usage means adb-axi built a bad argv: a bug, not a device state.
const USAGE: [RegExp, ErrorCode] = [/^adb: (adb \S+|usage:|unknown command)/m, "INTERNAL_ERROR"];

const VARIANTS = table(String.raw`(?:\* )?(?:adb: )?(?:error: )?`);

/** For remote command output: only a line that carries one of adb's own prefixes is adb's. */
const PREFIXED_VARIANTS = table(String.raw`(?:\* |adb: (?:error: )?|error: )`);

/**
 * Anchor every message to the start of a line, after adb's own prefixes (`adb: `,
 * `error: `, `* `, `failed to get feature set: `). Output a remote command prints
 * mid-line, such as `ls` complaining about a path, never matches.
 */
function table(prefixes: string): readonly [RegExp, ErrorCode][] {
  return [
    ...MESSAGES.map(([pattern, code]): [RegExp, ErrorCode] => [
      new RegExp(`^${prefixes}(?:failed to get feature set: )?${pattern.source}`, "im"),
      code,
    ]),
    USAGE,
  ];
}

/**
 * adb's own line for a device connection that closed under a call, for example when the
 * emulator is killed mid-command. On its own it does not say whether the device is gone.
 */
const TRANSPORT_CLOSED = /^(?:adb: )?error: (?:closed|protocol fault\b.*)$/m;

export function isTransportClosed(stderr: string): boolean {
  return TRANSPORT_CLOSED.test(stderr);
}

export function classifyAdbFailure(text: string): ErrorCode | undefined {
  return classify(VARIANTS, text);
}

/**
 * Classify the stderr of a failed `adb shell`. It mixes adb's own failure with whatever
 * the remote command printed, so a line counts only with adb's own prefix, and stdout,
 * which only the remote command writes, is never read.
 */
export function classifyShellFailure(stderr: string): ErrorCode | undefined {
  return classify(PREFIXED_VARIANTS, stderr);
}

function classify(variants: readonly [RegExp, ErrorCode][], text: string): ErrorCode | undefined {
  for (const [pattern, code] of variants) {
    if (pattern.test(text)) return code;
  }
  return undefined;
}

/** The typed error for a classified adb failure on `serial` (or on the host when undefined). */
export function adbFailureError(
  code: ErrorCode,
  serial: string | undefined,
  detail: string,
): AdbAxiError {
  const target = serial ?? "the adb server";
  const fields = { detail: detail.trim() };
  switch (code) {
    case "DEVICE_NOT_FOUND":
      return new AdbAxiError(code, `${target} is not attached`, {
        fields,
        help: ["Check the serial or AVD name and that the device is still connected"],
      });
    case "DEVICE_OFFLINE":
      return new AdbAxiError(code, `${target} is offline`, { fields });
    case "DEVICE_UNAUTHORIZED":
      return new AdbAxiError(
        code,
        `${target} has not authorized USB debugging from this computer`,
        {
          fields,
          help: ["Accept the USB debugging prompt on the device, then run the command again"],
        },
      );
    case "ADB_SERVER_UNREACHABLE":
      return serverUnreachable(detail);
    case "DEVICE_AMBIGUOUS":
      return new AdbAxiError(code, "adb could not tell which device to use", { fields });
    default:
      return new AdbAxiError("INTERNAL_ERROR", "adb rejected the arguments adb-axi sent", {
        fields,
      });
  }
}

export function serverUnreachable(detail?: string): AdbAxiError {
  return new AdbAxiError("ADB_SERVER_UNREACHABLE", "the adb server did not answer", {
    fields: detail === undefined || detail.trim() === "" ? {} : { detail: detail.trim() },
    help: ["Check that nothing else holds tcp:5037, then run the command again"],
  });
}
