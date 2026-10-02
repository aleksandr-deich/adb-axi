import { join } from "node:path";
import { deviceStateDir, readJson, writeJsonAtomic } from "../../core/state.js";

/** What adb-axi last installed for one package on one device. */
export interface InstallRecord {
  versionCode: number;
  versionName: string | null;
  /** Signer certificate digests (SHA-256), or `null` when the APK's signature could not be read. */
  signers: string[] | null;
  installedAt: string;
}

interface RecordFile {
  packages: Record<string, InstallRecord>;
}

function recordPath(serial: string, env: NodeJS.ProcessEnv): string {
  return join(deviceStateDir(serial, env), "last-install.json");
}

/**
 * The records of one device, keyed by package. A file that is missing, unreadable or not in
 * this shape is no record: `--if-changed` then installs, which is always safe.
 */
function readRecords(serial: string, env: NodeJS.ProcessEnv): Record<string, InstallRecord> {
  let parsed: unknown;
  try {
    parsed = readJson(recordPath(serial, env));
  } catch {
    return {};
  }
  const packages = (parsed as { packages?: unknown } | undefined)?.packages;
  if (typeof packages !== "object" || packages === null) return {};
  const valid: Record<string, InstallRecord> = {};
  for (const [name, value] of Object.entries(packages)) {
    if (isRecord(value)) valid[name] = value;
  }
  return valid;
}

export function readInstallRecord(
  serial: string,
  pkg: string,
  env: NodeJS.ProcessEnv,
): InstallRecord | undefined {
  return readRecords(serial, env)[pkg];
}

export function writeInstallRecord(
  serial: string,
  pkg: string,
  record: InstallRecord,
  env: NodeJS.ProcessEnv,
): void {
  const packages = readRecords(serial, env);
  packages[pkg] = record;
  writeJsonAtomic(recordPath(serial, env), { packages } satisfies RecordFile);
}

/** Drop a package's record, for example once it is uninstalled. */
export function forgetInstallRecord(serial: string, pkg: string, env: NodeJS.ProcessEnv): void {
  const all = readRecords(serial, env);
  if (!Object.hasOwn(all, pkg)) return;
  const packages = Object.fromEntries(Object.entries(all).filter(([name]) => name !== pkg));
  writeJsonAtomic(recordPath(serial, env), { packages } satisfies RecordFile);
}

function isRecord(value: unknown): value is InstallRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.versionCode === "number" &&
    (record.versionName === null || typeof record.versionName === "string") &&
    (record.signers === null ||
      (Array.isArray(record.signers) && record.signers.every((s) => typeof s === "string"))) &&
    typeof record.installedAt === "string"
  );
}
