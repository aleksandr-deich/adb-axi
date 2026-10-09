import { createHash } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { ApkError, bufferSource, readApkFile, readApkInfo, type ApkInfo } from "../../apk/index.js";
import type { AdbClient } from "../../adb/run.js";
import { assertPackageName } from "../../android/component.js";
import { readPackage, type PackageInfo } from "../../android/packages.js";
import { parsePmFailure } from "../../android/pm-result.js";
import { readCurrentUser } from "../../android/users.js";
import { invalidOutput, readShell, type ReadOptions } from "../../android/read.js";
import { formatDuration } from "../../core/args.js";
import { Deadline } from "../../core/deadline.js";
import { AdbAxiError } from "../../core/errors.js";
import { noop, okLine, runHint, shellWords, type Output } from "../../core/output.js";
import { MAX_INTERVAL_MS, poll } from "../../core/poll.js";
import { isErrno } from "../../core/state.js";
import { defineCommand } from "../define.js";
import type { CommandContext } from "../types.js";
import { installFailureError } from "./install-errors.js";
import { readInstallRecord, writeInstallRecord, type InstallRecord } from "./install-record.js";
import { formatVersion, readOptions, targetSerial, UNKNOWN } from "./shared.js";

const MAX_INSTALLED_APK_BYTES = 64 * 1024 * 1024;

export const appInstall = defineCommand({
  path: ["app", "install"],
  summary: "Install an APK, keeping app data, and wait until the new version is live",
  positionals: [{ name: "apk", description: "Path to the APK on this machine", required: true }],
  flags: [
    {
      name: "--clean-data",
      type: "boolean",
      description: "Wipe the app's data as part of the install; takes precedence over --if-changed",
    },
    {
      name: "--if-changed",
      type: "boolean",
      description:
        "Skip builds with the same versionCode and signer, including debug and release variants",
    },
  ],
  defaultTimeoutMs: 180_000,
  examples: [
    "adb-axi app install app/build/outputs/apk/debug/app-debug.apk",
    "adb-axi app install app-debug.apk --if-changed",
  ],
  shipped: true,
  run: runInstall,
});

/** What reading the APK gave: its facts, or why they are unknown. */
type ApkRead = { ok: true; info: ApkInfo } | { ok: false; reason: string };

async function runInstall(context: CommandContext): Promise<Output> {
  const started = performance.now();
  const clean = context.flags["clean-data"] === true;
  const ifChanged = context.flags["if-changed"] === true;
  const apkPath = apkFile(String(context.positionals.apk));
  const apkName = basename(apkPath);
  const serial = targetSerial(context);
  const options = readOptions(context);
  const adb = context.adb();

  let read = readApk(apkPath);
  const api = read.ok ? await readApi(adb, serial, options) : null;
  if (read.ok) {
    read =
      api === null
        ? {
            ok: true,
            info: {
              ...read.info,
              signers: null,
              signerUnreadable: "the device API level is unknown",
            },
          }
        : readApk(apkPath, api);
  }
  if (!read.ok && clean) {
    throw new AdbAxiError(
      "INSTALL_FAILED_INVALID_APK",
      `${apkName} was not installed because adb-axi cannot read it to know which package to wipe`,
      {
        fields: { apk: apkName, detail: read.reason },
        help: ["Rebuild the APK and run the same command again"],
      },
    );
  }
  // Taken before the install, so the wipe below is tied to the very bytes adb installs.
  const digest = read.ok && clean ? await fileDigest(apkPath) : null;
  const userId = read.ok ? await readCurrentUser(adb, serial, options) : 0;
  const before = read.ok
    ? await readPackage(adb, serial, read.info.package, options, userId)
    : null;
  const previous = before?.installed === true ? before : null;

  let shortcut: string | undefined;
  if (ifChanged && !clean) {
    const decision = await decideShortcut(read, previous, adb, serial, api, options);
    if (decision.kind === "unchanged" && read.ok) {
      return {
        ok: okLine(
          "install",
          read.info.package,
          noop("already installed (same versionCode and signature)"),
        ),
      };
    }
    if (decision.kind === "skipped") shortcut = `skipped because ${decision.reason}`;
  }

  await runAdbInstall(context, adb, serial, apkPath, apkName, read, previous);

  if (!read.ok) {
    return {
      ok: okLine("install", apkName, "installed, version not verified"),
      install: {
        ...(shortcut === undefined ? {} : { shortcut }),
        note: "adb-axi could not read the APK metadata so it did not check which version is live",
        detail: read.reason,
        took_ms: elapsed(started),
      },
    };
  }

  const info = read.info;
  let installed = await waitForVersion(context, adb, serial, info, options, userId);
  if (digest !== null) {
    await confirmInstalledFile(adb, serial, info.package, apkName, digest, options, userId);
    await clearData(adb, serial, info.package, options, userId);
    // The package must survive the wipe at the version just installed.
    installed = await waitForVersion(context, adb, serial, info, options, userId);
  }

  // A swap between a debug and a release build keeps the version, so say what did change.
  const last = readInstallRecord(serial, info.package, context.env);
  const changed = [
    ...(previous !== null && previous.debuggable !== installed.debuggable
      ? [`debuggable: ${previous.debuggable} -> ${installed.debuggable}`]
      : []),
    ...(last !== undefined &&
    last.signers !== null &&
    info.signers !== null &&
    !sameSigners(last.signers, info.signers)
      ? ["signed differently from the last adb-axi install"]
      : []),
  ];
  const warning = saveRecord(serial, info, context.env);
  return {
    ok: okLine(
      "install",
      info.package,
      `${formatVersion(info.versionName, info.versionCode)} ${clean ? "with data wiped" : before === null ? "(fresh install)" : "with data kept"}`,
    ),
    install: {
      previous:
        previous === null
          ? "not installed"
          : formatVersion(previous.versionName, previous.versionCode),
      debuggable: installed.debuggable,
      ...(changed.length === 0 ? {} : { changed }),
      ...(shortcut === undefined ? {} : { shortcut }),
      ...(warning === undefined ? {} : { warning }),
      took_ms: elapsed(started),
    },
  };
}

/** The APK path as an absolute path, or a usage error when there is no such file. */
function apkFile(argument: string): string {
  const path = resolve(argument);
  const problem = (message: string): AdbAxiError =>
    new AdbAxiError("VALIDATION_ERROR", message, {
      help: ["Pass the path of an APK, for example `app/build/outputs/apk/debug/app-debug.apk`"],
    });
  try {
    if (!statSync(path).isFile()) throw problem(`\`${argument}\` is not a file`);
  } catch (error) {
    if (error instanceof AdbAxiError) throw error;
    if (isErrno(error, "ENOENT") || isErrno(error, "ENOTDIR")) {
      throw problem(`there is no file \`${argument}\``);
    }
    throw problem(`\`${argument}\` cannot be read`);
  }
  return path;
}

function readApk(path: string, api?: number): ApkRead {
  try {
    return { ok: true, info: readApkFile(path, api) };
  } catch (error) {
    if (error instanceof ApkError) return { ok: false, reason: error.message };
    if (isErrno(error, "EACCES") || isErrno(error, "EISDIR") || isErrno(error, "EIO")) {
      return { ok: false, reason: "the file could not be read" };
    }
    throw error;
  }
}

type Shortcut =
  | { kind: "unchanged" }
  /** The versions differ or the package is absent: an install is the normal outcome. */
  | { kind: "changed" }
  /** The shortcut could not be proven either way, so the install runs without it. */
  | { kind: "skipped"; reason: string };

async function decideShortcut(
  read: ApkRead,
  previous: PackageInfo | null,
  adb: AdbClient,
  serial: string,
  api: number | null,
  options: ReadOptions,
): Promise<Shortcut> {
  if (!read.ok)
    return { kind: "skipped", reason: `the APK metadata cannot be read (${read.reason})` };
  const info = read.info;
  if (previous === null || previous.versionCode !== info.versionCode) return { kind: "changed" };
  if (api === null) return { kind: "skipped", reason: "the device API level is unknown" };
  const signers = info.signers;
  if (signers === null) {
    return {
      kind: "skipped",
      reason: `the APK signature cannot be read (${info.signerUnreadable ?? "unknown"})`,
    };
  }
  const evidenceOptions = {
    ...options,
    capMs: Math.min(30_000, options.deadline.remainingMs() / 2, options.capMs ?? Infinity),
  };
  try {
    const path = await installedApkPath(adb, serial, `pm path ${info.package}`, evidenceOptions);
    if (path === undefined) {
      return { kind: "skipped", reason: "the installed APK path cannot be established" };
    }
    const bytes = await adb.device(serial, ["exec-out", shellWords(["cat", path])], {
      ...evidenceOptions,
      step: "reading the installed APK",
      remoteOutput: true,
      maxOutputBytes: MAX_INSTALLED_APK_BYTES,
    });
    if (bytes.exitCode !== 0)
      return { kind: "skipped", reason: "the installed APK cannot be read" };
    const installed = readApkInfo(bufferSource(bytes.stdout), api);
    if (installed.package !== info.package || installed.versionCode !== info.versionCode) {
      return {
        kind: "skipped",
        reason: "the installed APK metadata does not match the device observation",
      };
    }
    if (installed.signers === null) {
      return {
        kind: "skipped",
        reason: `the installed APK signature cannot be read (${installed.signerUnreadable ?? "unknown"})`,
      };
    }
    return installed.signers.length === signers.length &&
      installed.signers.every((s, i) => s === signers[i])
      ? { kind: "unchanged" }
      : { kind: "skipped", reason: "the APK is signed differently from the installed app" };
  } catch (error) {
    if (error instanceof AdbAxiError && error.code === "TIMEOUT") {
      return { kind: "skipped", reason: "reading the installed APK evidence took too long" };
    }
    if (error instanceof AdbAxiError && error.code === "INVALID_OUTPUT") {
      return { kind: "skipped", reason: "the installed APK evidence exceeds the host read limit" };
    }
    if (
      error instanceof ApkError ||
      (error instanceof AdbAxiError && error.code === "REMOTE_EXIT")
    ) {
      return { kind: "skipped", reason: "the installed APK evidence cannot be read" };
    }
    throw error;
  }
}

/** The package's base APK on the device, from `pm path`, or `undefined` when it is unclear. */
async function installedApkPath(
  adb: AdbClient,
  serial: string,
  command: string,
  options: ReadOptions,
): Promise<string | undefined> {
  const paths = await readShell(adb, serial, command, "reading the installed APK path", options);
  const files = paths.stdout
    .trim()
    .split(/\r?\n/)
    .map((line) => /^package:(\/[^\r\n]+\.apk)$/.exec(line)?.[1]);
  const bases = files.filter((path) => path?.endsWith("/base.apk"));
  const path = bases.length === 1 ? bases[0] : files.length === 1 ? files[0] : undefined;
  return path === undefined || files.some((file) => file === undefined) ? undefined : path;
}

/** The SHA-256 of a host file, lowercase hex. */
async function fileDigest(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/**
 * Before a wipe, prove that `pkg` now runs the APK just installed: its base APK on the device
 * must hold the same bytes. adb-axi names the package from its own reading of the manifest,
 * and Android installs the package its own reading names; this catches any difference
 * between the two before it can wipe some other app.
 */
async function confirmInstalledFile(
  adb: AdbClient,
  serial: string,
  pkg: string,
  apkName: string,
  digest: string,
  options: ReadOptions,
  userId: number,
): Promise<void> {
  assertPackageName(pkg);
  const refuse = (reason: string): AdbAxiError =>
    new AdbAxiError(
      "CLEAR_REFUSED",
      `${apkName} was installed, but adb-axi did not wipe ${pkg} because ${reason}`,
      {
        fields: { apk: apkName, package: pkg },
        help: [
          runHint(["app", "info", pkg], "for the version the device has installed"),
          `Wipe ${pkg} only once it is known to be the package ${apkName} installs`,
        ],
      },
    );
  const path = await installedApkPath(adb, serial, `pm path --user ${userId} ${pkg}`, options);
  if (path === undefined) throw refuse("its installed APK cannot be found on the device");
  const step = `checking the installed APK of ${pkg}`;
  const result = await readShell(adb, serial, shellWords(["sha256sum", path]), step, options);
  const installed = /^([0-9a-f]{64})\s/.exec(result.stdout)?.[1];
  if (installed === undefined) throw invalidOutput(step, result.stdout);
  if (installed !== digest) throw refuse(`the APK it runs is not ${apkName}`);
}

async function readApi(
  adb: AdbClient,
  serial: string,
  options: ReadOptions,
): Promise<number | null> {
  try {
    const result = await readShell(
      adb,
      serial,
      "getprop ro.build.version.sdk",
      "reading the device API level",
      options,
    );
    const value = result.stdout.trim();
    return /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
  } catch (error) {
    if (error instanceof AdbAxiError && error.code === "REMOTE_EXIT") return null;
    throw error;
  }
}

async function runAdbInstall(
  context: CommandContext,
  adb: AdbClient,
  serial: string,
  apkPath: string,
  apkName: string,
  read: ApkRead,
  previous: PackageInfo | null,
): Promise<void> {
  // `-r` keeps the app's data. adb exits 0 only when the package manager said Success.
  const result = await adb.device(serial, ["install", "-r", apkPath], {
    deadline: context.deadline,
    step: `installing ${apkName}`,
  });
  const output = `${result.stdout.toString("utf8")}\n${result.stderr.toString("utf8")}`;
  const failure = parsePmFailure(output);
  if (failure === null && result.exitCode === 0) return;
  throw installFailureError(
    failure,
    failureContext(
      context,
      apkName,
      read.ok ? read.info : undefined,
      previous === null ? UNKNOWN : formatVersion(previous.versionName, previous.versionCode),
    ),
    output,
  );
}

function failureContext(
  context: CommandContext,
  apkName: string,
  info: ApkInfo | undefined,
  installed: string,
) {
  return {
    pkg: info?.package,
    apk: apkName,
    installed,
    apkVersion: info === undefined ? UNKNOWN : formatVersion(info.versionName, info.versionCode),
    doctorShips: context.isShipped(["doctor"]),
  };
}

/**
 * Wait until the package manager reports the APK's versionCode. `adb install` returns when
 * the install is committed, so this normally holds at once; it is the proof, not a delay.
 */
async function waitForVersion(
  context: CommandContext,
  adb: AdbClient,
  serial: string,
  info: ApkInfo,
  options: ReadOptions,
  userId: number,
): Promise<PackageInfo> {
  assertPackageName(info.package);
  let latest: PackageInfo | null | undefined;
  const result = await poll({
    timeoutMs: context.deadline.remainingMs(),
    check: async (remainingMs) => {
      const reads =
        remainingMs < MAX_INTERVAL_MS ? { deadline: new Deadline(MAX_INTERVAL_MS) } : options;
      try {
        latest = await readPackage(adb, serial, info.package, reads, userId);
      } catch (error) {
        // A read cut off by the deadline ends the wait; the last full read is the evidence.
        if (error instanceof AdbAxiError && error.code === "TIMEOUT") {
          return { done: false, last: latest };
        }
        throw error;
      }
      return latest?.installed === true && latest.versionCode === info.versionCode
        ? { done: true, value: latest }
        : { done: false, last: latest };
    },
  });
  if (result.ok) return result.value;
  throw new AdbAxiError(
    "WAIT_TIMEOUT",
    `${info.package} did not report versionCode ${info.versionCode} within ${formatDuration(context.timeoutMs)}`,
    {
      fields: {
        last:
          latest?.installed === true
            ? { installed: true, version: formatVersion(latest.versionName, latest.versionCode) }
            : { installed: false },
      },
      help: [runHint(["app", "info", info.package], "for the version the device reports")],
    },
  );
}

/** `pm clear` wipes the app's data and stops it; the package stays installed. */
async function clearData(
  adb: AdbClient,
  serial: string,
  pkg: string,
  options: ReadOptions,
  userId: number,
): Promise<void> {
  const step = `wiping the data of ${pkg}`;
  const result = await readShell(adb, serial, `pm clear --user ${userId} ${pkg}`, step, options);
  if (!/^Success\b/m.test(result.stdout)) throw invalidOutput(step, result.stdout);
}

/** Remember what was installed. A state file that cannot be written is a warning. */
function saveRecord(serial: string, info: ApkInfo, env: NodeJS.ProcessEnv): string | undefined {
  const record: InstallRecord = {
    versionCode: info.versionCode,
    versionName: info.versionName,
    signers: info.signers,
    installedAt: new Date().toISOString(),
  };
  try {
    writeInstallRecord(serial, info.package, record, env);
    return undefined;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return `the install was not recorded (${reason})`;
  }
}

function sameSigners(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((signer, index) => signer === b[index]);
}

function elapsed(started: number): number {
  return Math.round(performance.now() - started);
}
