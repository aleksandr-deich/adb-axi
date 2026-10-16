import { AdbAxiError } from "../core/errors.js";

/** 35.0.0 fixed `adb shell` reporting success when the device disconnects.
 * https://developer.android.com/tools/releases/platform-tools#3500_february_2024
 * This is the client shell reader, not the shared server or the device's Android API.
 */
export const MIN_HOST_ADB_VERSION = "35.0.0";

/** Platform-tools build, not the `Android Debug Bridge version 1.0.41` protocol line. */
export function parseAdbVersion(stdout: string): string | undefined {
  return /^Version (\d+(?:\.\d+)*)/m.exec(stdout)?.[1];
}

export function hostAdbVersionError(version: string | undefined): AdbAxiError | undefined {
  if (
    version === undefined ||
    Number(version.split(".")[0]) >= Number(MIN_HOST_ADB_VERSION.split(".")[0])
  )
    return undefined;
  return new AdbAxiError(
    "HOST_ADB_TOO_OLD",
    `adb client ${version} is too old; Android SDK Platform-Tools ${MIN_HOST_ADB_VERSION} or newer is required for reliable shell disconnect exit codes`,
    {
      fields: { found: version, required: MIN_HOST_ADB_VERSION },
      help: [
        `Update Android SDK Platform-Tools to ${MIN_HOST_ADB_VERSION} or newer and ensure that adb is selected on PATH; adb-axi never updates it`,
      ],
    },
  );
}
