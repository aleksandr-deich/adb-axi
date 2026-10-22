import type { AdbClient } from "../adb/run.js";
import { identityOf, type AppIdentity } from "../android/app-processes.js";
import { readPackageSnapshot, type PackageInfo } from "../android/packages.js";
import { invalidOutput, readShell, type ReadOptions } from "../android/read.js";
import type { Deadline } from "../core/deadline.js";
import { readShellFacts, type DeviceFacts } from "./facts.js";
import type { Target } from "./resolve.js";

export interface DeviceSession {
  readonly target: Target;
  readonly serial: string;
  readonly adb: AdbClient;
  readonly reads: ReadOptions;
  // A command keeps the user it started with even if the device switches users.
  user(): Promise<number>;
  facts(): Promise<DeviceFacts>;
  // Mutations can change the package record within one command.
  app(pkg: string): Promise<AppRecord>;
}

export type AppRecord =
  | { installed: true; userId: number; info: PackageInfo; dump: string; identity: AppIdentity }
  | { installed: false; userId: number; info: PackageInfo | null; dump: string };

export function openSession(
  target: Target,
  adb: AdbClient,
  deadline: Deadline,
  env: NodeJS.ProcessEnv,
  known?: DeviceFacts,
): DeviceSession {
  const serial = target.serial;
  const reads = { deadline };
  let user: Promise<number> | undefined;
  let facts: Promise<DeviceFacts> | undefined =
    known === undefined ? undefined : Promise.resolve(known);
  const session: DeviceSession = {
    target,
    serial,
    adb,
    reads,
    user() {
      return (user ??= readUser(adb, serial, reads).catch((error: unknown) => {
        user = undefined;
        throw error;
      }));
    },
    facts() {
      return (facts ??= readShellFacts(adb, target.device, { deadline, env }).catch(
        (error: unknown) => {
          facts = undefined;
          throw error;
        },
      ));
    },
    async app(pkg) {
      const userId = await session.user();
      const { info, dump } = await readPackageSnapshot(adb, serial, pkg, reads, userId);
      return info?.installed === true
        ? { installed: true, userId, info, dump, identity: identityOf(info, dump) }
        : { installed: false, userId, info, dump };
    },
  };
  return session;
}

async function readUser(adb: AdbClient, serial: string, reads: ReadOptions): Promise<number> {
  const step = "reading the current Android user";
  const result = await readShell(adb, serial, "am get-current-user", step, reads);
  const user = result.stdout.trim();
  if (!/^\d+$/.test(user) || !Number.isSafeInteger(Number(user))) {
    throw invalidOutput(step, result.stdout);
  }
  return Number(user);
}
