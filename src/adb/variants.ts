import { AdbAxiError, type ErrorCode } from "../core/errors.js";

/**
 * One adb failure has several shapes (H6-H9): `error: device 'x' not found` (exit 255),
 * `adb: device 'x' not found` (exit 1), `adb: error: failed to get feature set: ...`, and
 * usage text with the same exit as a runtime failure. Each shape maps to exactly one code
 * here; the raw text only ever appears in `detail`.
 */
const VARIANTS: readonly [RegExp, ErrorCode][] = [
  [
    line(/(cannot connect to daemon|failed to start daemon|failed to check server version)/),
    "ADB_SERVER_UNREACHABLE",
  ],
  [line(/(device '[^']*' not found|no devices\/emulators found)/), "DEVICE_NOT_FOUND"],
  [
    line(/(device unauthorized|device still authorizing|insufficient permissions for device)/),
    "DEVICE_UNAUTHORIZED",
  ],
  [line(/(device offline|device still connecting)/), "DEVICE_OFFLINE"],
  [line(/more than one (device|emulator)/), "DEVICE_AMBIGUOUS"],
  // adb printing its own usage means adb-axi built a bad argv: a bug, not a device state.
  [/^adb: (adb \S+|usage:|unknown command)/m, "INTERNAL_ERROR"],
];

/**
 * Anchor a pattern to the start of a line, after adb's own prefixes (`adb: `, `error: `,
 * `* `, `failed to get feature set: `). Output a remote command prints mid-line, such as
 * `ls` complaining about a path, never matches.
 */
function line(pattern: RegExp): RegExp {
  const prefixes = String.raw`^(?:\* )?(?:adb: )?(?:error: )?(?:failed to get feature set: )?`;
  return new RegExp(prefixes + pattern.source, "im");
}

export function classifyAdbFailure(text: string): ErrorCode | undefined {
  for (const [pattern, code] of VARIANTS) {
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
