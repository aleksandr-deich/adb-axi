import type { AdbClient } from "../adb/run.js";
import { assertPackageName, isPackageName } from "./component.js";
import { readShell, type ReadOptions } from "./read.js";

/** One line of `pm list packages [-U] [--show-versioncode]`. */
export interface ListedPackage {
  package: string;
  versionCode: number | null;
  uid: number | null;
}

/**
 * `pm list packages` prints `package:<name>`, then ` versionCode:<n>` with
 * `--show-versioncode` and ` uid:<n>` with `-U`, in that order (AOSP
 * `PackageManagerShellCommand.runListPackages`, the same from API 29 to 37). With `-f` the
 * name follows `<apk path>=`. Lines that are not package lines are skipped.
 */
export function parsePackageList(stdout: string): ListedPackage[] {
  const packages: ListedPackage[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith("package:")) continue;
    const [first = "", ...rest] = line.slice("package:".length).split(/\s+/);
    const name = first.slice(first.lastIndexOf("=") + 1);
    if (!isPackageName(name)) continue;
    const fields = new Map<string, string>();
    for (const token of rest) {
      const match = /^([A-Za-z]+)[:=](.*)$/.exec(token);
      if (match?.[1] !== undefined && match[2] !== undefined) fields.set(match[1], match[2]);
    }
    packages.push({
      package: name,
      versionCode: integer(fields.get("versionCode")),
      uid: integer(fields.get("uid")),
    });
  }
  return packages;
}

/** What `dumpsys package <pkg>` says about one package. */
export interface PackageInfo {
  package: string;
  /**
   * Installed for the selected Android user. A package uninstalled with its data kept
   * (`pm uninstall -k`) still has a record, with `installed=false`.
   */
  installed: boolean;
  versionName: string | null;
  versionCode: number | null;
  debuggable: boolean;
  system: boolean;
  /** The selected user's UID, not merely the package's app id. */
  uid: number | null;
  minSdk: number | null;
  targetSdk: number | null;
}

/**
 * Every package record in the `Packages:` section of `dumpsys package` output, keyed by
 * name. Records under `Hidden system packages:` (the factory copy of an updated system
 * app) are not the installed package and are left out.
 *
 * Field names follow AOSP `Settings.dumpPackageLPr`: the app id is `userId=` up to API 30
 * and `appId=` from API 31; flags are `flags=[ DEBUGGABLE HAS_CODE ... ]`; each user has a
 * `User <n>: ... installed=<bool> ...` line. Installation is read for `userId` (default 0)
 * and is false if that user's line is absent. The UID is `userId * 100000 + appId`.
 */
export function parsePackageRecords(stdout: string, userId = 0): Map<string, PackageInfo> {
  const records = new Map<string, PackageInfo>();
  let inPackages = false;
  let current: { info: PackageInfo; seenUser: boolean } | undefined;

  for (const line of stdout.split(/\r?\n/)) {
    if (/^\S/.test(line)) {
      // A top-level section heading ends the previous section.
      inPackages = line.trimEnd() === "Packages:";
      current = undefined;
      continue;
    }
    if (!inPackages) continue;

    const header = /^ {2}Package \[([^\]]+)\] \([0-9a-f]+\):\s*$/.exec(line);
    if (header?.[1] !== undefined) {
      const info: PackageInfo = {
        package: header[1],
        installed: false,
        versionName: null,
        versionCode: null,
        debuggable: false,
        system: false,
        uid: null,
        minSdk: null,
        targetSdk: null,
      };
      records.set(info.package, info);
      current = { info, seenUser: false };
      continue;
    }
    if (current === undefined) continue;
    const info = current.info;
    const text = line.trim();

    const id = /^(?:appId|userId)=(\d+)$/.exec(text);
    if (id?.[1] !== undefined) {
      info.uid = userId * 100000 + Number(id[1]);
      continue;
    }
    const version = /^versionCode=(\d+)(?: minSdk=(\d+))?(?: targetSdk=(\d+))?/.exec(text);
    if (version?.[1] !== undefined) {
      info.versionCode = Number(version[1]);
      info.minSdk = integer(version[2]);
      info.targetSdk = integer(version[3]);
      continue;
    }
    const name = /^versionName=(.*)$/.exec(text);
    if (name?.[1] !== undefined) {
      info.versionName = name[1] === "null" || name[1] === "" ? null : name[1];
      continue;
    }
    const flags = /^flags=\[(.*)\]$/.exec(text);
    if (flags?.[1] !== undefined) {
      const values = flags[1].trim().split(/\s+/);
      info.debuggable = values.includes("DEBUGGABLE");
      info.system = values.includes("SYSTEM");
      continue;
    }
    const user = /^User (\d+): .*\binstalled=(true|false)\b/.exec(text);
    if (user?.[2] !== undefined && Number(user[1]) === userId && !current.seenUser) {
      info.installed = user[2] === "true";
      current.seenUser = true;
    }
  }
  return records;
}

/** One package's record, or `null` when the device has none (never installed). */
export function parseDumpsysPackage(stdout: string, pkg: string, userId = 0): PackageInfo | null {
  return parsePackageRecords(stdout, userId).get(pkg) ?? null;
}

/**
 * Read one package with `dumpsys package <pkg>`. `null` means no record at all; a record
 * can still say `installed: false` (uninstalled with its data kept), so callers check
 * `installed` before treating the package as present.
 */
export async function readPackage(
  adb: AdbClient,
  serial: string,
  pkg: string,
  options: ReadOptions,
  userId = 0,
): Promise<PackageInfo | null> {
  assertPackageName(pkg);
  const result = await readShell(
    adb,
    serial,
    `dumpsys package ${pkg}`,
    `reading package ${pkg}`,
    options,
  );
  return parseDumpsysPackage(result.stdout, pkg, userId);
}

/**
 * List installed packages with versionCode and uid. `thirdParty` keeps only user-installed
 * packages (`-3`).
 */
export async function listPackages(
  adb: AdbClient,
  serial: string,
  options: ReadOptions & { thirdParty?: boolean },
): Promise<ListedPackage[]> {
  const command = `pm list packages --show-versioncode -U${options.thirdParty === true ? " -3" : ""}`;
  const result = await readShell(adb, serial, command, "listing packages", options);
  return parsePackageList(result.stdout);
}

function integer(text: string | undefined): number | null {
  if (text === undefined || !/^-?\d+$/.test(text)) return null;
  return Number(text);
}
