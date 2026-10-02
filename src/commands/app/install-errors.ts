import type { PmFailure } from "../../android/pm-result.js";
import { AdbAxiError, type ErrorCode } from "../../core/errors.js";
import { runHint } from "../../core/output.js";

/** What the error text and its fix may name. */
export interface InstallFailureContext {
  /** The APK's package, when its manifest could be read. */
  pkg: string | undefined;
  /** The APK file name, always known. */
  apk: string;
  /** The version the device has now, `-` when unknown or not installed. */
  installed: string;
  /** The APK's own version, `-` when its manifest could not be read. */
  apkVersion: string;
  /** Whether `adb-axi doctor` ships in this build, so help never names one that does not. */
  doctorShips: boolean;
}

interface Known {
  reason: string;
  fix: (context: InstallFailureContext) => string[];
}

/** Help lines avoid commas and colons, which TOON would quote inside its inline `help` list. */
function uninstallHint(context: InstallFailureContext, purpose: string): string {
  return runHint(
    ["app", "uninstall", context.pkg ?? "<pkg>"],
    `and install again${purpose} (uninstalling deletes the app's data)`,
  );
}

/**
 * The package manager's install codes (AOSP `PackageManager.INSTALL_FAILED_*`) that
 * adb-axi can say something specific about. Any other `INSTALL_FAILED_*` code still becomes
 * a typed error, with the package manager's own message and a generic fix.
 */
const KNOWN: Readonly<Record<string, Known>> = {
  INSTALL_FAILED_UPDATE_INCOMPATIBLE: {
    reason: "it is signed with a different key than the installed app",
    fix: (context) => [
      uninstallHint(context, ""),
      "Or build the APK with the signing key the installed app was installed with",
    ],
  },
  INSTALL_FAILED_INSUFFICIENT_STORAGE: {
    reason: "the device does not have enough free storage",
    fix: (context) => [
      ...(context.doctorShips ? [runHint(["doctor"], "to see how much storage is free")] : []),
      "Free space on the device (for example by uninstalling apps it no longer needs) then run the same command again",
    ],
  },
  INSTALL_FAILED_VERSION_DOWNGRADE: {
    reason: "its versionCode is lower than the installed version's",
    fix: (context) => [
      "Build the APK with a higher versionCode than the installed one",
      uninstallHint(context, " to go back to the older version"),
    ],
  },
  INSTALL_FAILED_INVALID_APK: {
    reason: "the package manager cannot read the APK",
    fix: () => ["Rebuild the APK then run the same command again"],
  },
  INSTALL_FAILED_ALREADY_EXISTS: {
    reason: "the package is already installed and was not replaced",
    fix: () => ["Run the same command again"],
  },
  INSTALL_FAILED_DUPLICATE_PACKAGE: {
    reason: "another package with the same name is being installed",
    fix: () => ["Wait for the other install to finish then run the same command again"],
  },
  INSTALL_FAILED_OLDER_SDK: {
    reason: "the APK needs a newer Android version than the device runs",
    fix: () => ["Lower the APK's minSdk or install it on a device with a newer Android version"],
  },
  INSTALL_FAILED_NEWER_SDK: {
    reason: "the APK was built for an older Android version than the device runs",
    fix: () => [
      "Rebuild the APK with a higher maxSdk or use a device with an older Android version",
    ],
  },
  INSTALL_FAILED_CPU_ABI_INCOMPATIBLE: {
    reason: "the APK has no native code for this device's CPU",
    fix: () => ["Build the APK for the device's ABI or use a device with a matching CPU"],
  },
  INSTALL_FAILED_NO_MATCHING_ABIS: {
    reason: "the APK has no native code for this device's CPU",
    fix: () => ["Build the APK for the device's ABI or use a device with a matching CPU"],
  },
  INSTALL_FAILED_MISSING_SHARED_LIBRARY: {
    reason: "the APK needs a shared library the device does not have",
    fix: () => ["Remove the library from the manifest or use a device image that includes it"],
  },
  INSTALL_FAILED_MISSING_FEATURE: {
    reason: "the APK requires a hardware feature the device does not have",
    fix: () => ["Mark the feature as not required in the manifest or use a device that has it"],
  },
  INSTALL_FAILED_TEST_ONLY: {
    reason: "the APK is marked test-only",
    fix: () => ["Build an APK that is not test-only (for example with `./gradlew assembleDebug`)"],
  },
  INSTALL_FAILED_CONFLICTING_PROVIDER: {
    reason: "a content provider authority is already used by another app",
    fix: () => ["Change the provider's authority in the manifest or uninstall the other app"],
  },
  INSTALL_FAILED_DUPLICATE_PERMISSION: {
    reason: "the APK declares a permission another app already declares",
    fix: () => ["Rename the permission in the manifest or uninstall the app that declares it"],
  },
  INSTALL_FAILED_SHARED_USER_INCOMPATIBLE: {
    reason: "the shared user id is signed with a different key",
    fix: () => ["Sign the APK with the key of the apps that share its user id"],
  },
  INSTALL_FAILED_USER_RESTRICTED: {
    reason: "the device's user is not allowed to install apps",
    fix: () => [
      "Allow installs over USB in the device's developer settings then run the same command again",
    ],
  },
  INSTALL_FAILED_VERIFICATION_FAILURE: {
    reason: "a package verifier rejected the APK",
    fix: () => [
      "Turn off app verification over USB in the device's settings then run the same command again",
    ],
  },
  INSTALL_FAILED_VERIFICATION_TIMEOUT: {
    reason: "package verification timed out",
    fix: () => ["Run the same command again"],
  },
  INSTALL_FAILED_ABORTED: {
    reason: "the install was stopped before it finished",
    fix: () => ["Run the same command again"],
  },
  INSTALL_FAILED_INTERNAL_ERROR: {
    reason: "the package manager hit an internal error",
    fix: () => ["Run the same command again"],
  },
  INSTALL_FAILED_DEXOPT: {
    reason: "the APK's code could not be optimized for this device",
    fix: () => ["Rebuild the APK then run the same command again"],
  },
  INSTALL_FAILED_MISSING_SPLIT: {
    reason: "the app needs split APKs that were not installed with it",
    fix: () => ["Install the full APK and not a single split"],
  },
};

/**
 * The error code for a package manager code. `INSTALL_PARSE_FAILED_*` is the package
 * manager rejecting a file it cannot parse, so it joins `INSTALL_FAILED_INVALID_APK`; a
 * code outside the `INSTALL_FAILED_*` family is reported as `INSTALL_FAILED_UNKNOWN`.
 */
function installCode(code: string | undefined): ErrorCode {
  if (code === undefined) return "INSTALL_FAILED_UNKNOWN";
  if (code.startsWith("INSTALL_PARSE_FAILED_")) return "INSTALL_FAILED_INVALID_APK";
  return /^INSTALL_FAILED_[A-Z0-9_]+$/.test(code) ? (code as ErrorCode) : "INSTALL_FAILED_UNKNOWN";
}

/**
 * The typed error for one package manager refusal, carrying what to do about it.
 * `output` is what adb printed, kept as `detail` when the package manager gave no message.
 */
export function installFailureError(
  failure: PmFailure | null,
  context: InstallFailureContext,
  output: string,
): AdbAxiError {
  const target = context.pkg ?? context.apk;
  const code = installCode(failure?.code);
  const known = KNOWN[code];
  const reason =
    known?.reason ?? (failure === null ? "adb did not say why" : "the package manager refused it");
  const detail = failure?.message ?? (failure === null ? output.trim().slice(0, 300) : "");
  const fields: Record<string, unknown> = {
    ...(context.pkg === undefined ? { apk: context.apk } : { package: context.pkg }),
    ...(code === "INSTALL_FAILED_VERSION_DOWNGRADE"
      ? { installed: context.installed, apk_version: context.apkVersion }
      : {}),
    ...(failure !== null && failure.code !== code ? { pm_code: failure.code } : {}),
    ...(detail === "" ? {} : { detail }),
  };
  return new AdbAxiError(code, `${target} was not installed because ${reason}`, {
    fields,
    help: known?.fix(context) ?? [
      "Read `detail` for the reason, fix what it names and run the same command again",
    ],
  });
}
