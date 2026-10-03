import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { findSdkTool } from "../../adb/locate.js";
import { AdbClient } from "../../adb/run.js";
import { AdbAxiError } from "../../core/errors.js";
import { ONLINE, parseDeviceList, type AttachedDevice } from "../../device/list.js";
import { resolveTarget, type Target } from "../../device/resolve.js";
import type { CommandContext } from "../types.js";
import { failed, ok, oneLine, settle, tildePath, warn, type CheckResult } from "./result.js";

/** A single host or device read of a check may take this long; a slower one is a finding. */
export const CHECK_CAP_MS = 5_000;

export function homeDir(env: NodeJS.ProcessEnv): string {
  return env.HOME !== undefined && env.HOME !== "" ? env.HOME : homedir();
}

export function serverPort(env: NodeJS.ProcessEnv): string {
  const port = env.ANDROID_ADB_SERVER_PORT;
  return port !== undefined && /^\d+$/.test(port) ? port : "5037";
}

/** `37.0.0` from the `Version 37.0.0-14910828` line of `adb version`. */
export function parseAdbVersion(stdout: string): string | undefined {
  return /^Version (\d+(?:\.\d+)*)/m.exec(stdout)?.[1];
}

/** Whether two paths are the same file, following symlinks (Homebrew links its adb). */
function sameFile(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return a === b;
  }
}

export async function checkAdb(context: CommandContext): Promise<CheckResult> {
  const home = homeDir(context.env);
  let adb: AdbClient;
  try {
    adb = context.adb();
  } catch (error) {
    if (!(error instanceof AdbAxiError) || error.code !== "ADB_NOT_FOUND") throw error;
    return failed(
      "adb",
      "not found on PATH, ANDROID_HOME, ANDROID_SDK_ROOT or ~/Library/Android/sdk",
      error.help,
    );
  }
  return settle("adb", async () => {
    const reads = { deadline: context.deadline, capMs: CHECK_CAP_MS };
    const answer = await adb.host(["version"], { ...reads, step: "reading the adb version" });
    const version = parseAdbVersion(answer.stdout.toString("utf8"));
    const where = tildePath(adb.path, home);
    if (version === undefined) return warn("adb", `version unknown at ${where}`);

    // Two adb versions on one machine restart each other's server and drop its devices.
    const other = findSdkTool("adb", { ...context.env, PATH: "" }, home).path;
    if (other !== undefined && !sameFile(other, adb.path)) {
      const otherVersion = await versionOf(other, context);
      if (otherVersion !== undefined && otherVersion !== version) {
        return warn(
          "adb",
          `${version} at ${where}, but ${otherVersion} at ${tildePath(other, home)} restarts its server`,
          ["Use one platform-tools install: put the same adb first on PATH everywhere"],
        );
      }
    }
    return ok("adb", `${version} at ${where}`);
  });
}

/** The version of another adb, or `undefined` when it does not answer (it cannot clash then). */
async function versionOf(path: string, context: CommandContext): Promise<string | undefined> {
  try {
    const answer = await new AdbClient(path, { env: context.env, debug: context.debug }).host(
      ["version"],
      {
        deadline: context.deadline,
        capMs: CHECK_CAP_MS,
        step: "reading the version of another adb",
      },
    );
    return parseAdbVersion(answer.stdout.toString("utf8"));
  } catch (error) {
    if (error instanceof AdbAxiError) return undefined;
    throw error;
  }
}

export interface ServerReading {
  result: CheckResult;
  /** Every attached device, or `undefined` when the server did not answer. */
  devices: AttachedDevice[] | undefined;
}

export async function checkServer(context: CommandContext): Promise<ServerReading> {
  const where = `tcp:${serverPort(context.env)}`;
  const adb = context.adb();
  let devices: AttachedDevice[] | undefined;
  const result = await settle("server", async () => {
    try {
      const answer = await adb.host(["devices", "-l"], {
        deadline: context.deadline,
        capMs: CHECK_CAP_MS,
        step: "asking the adb server",
      });
      const stdout = answer.stdout.toString("utf8");
      if (answer.exitCode !== 0 || !/^List of devices attached/m.test(stdout)) {
        return failed("server", `${where} answered, but not with a device list`, STUCK_SERVER);
      }
      devices = parseDeviceList(stdout);
      // adb starts a missing server by itself; that works, but it is worth knowing about.
      const started = /daemon not running|daemon started successfully/.test(
        `${stdout}\n${answer.stderr.toString("utf8")}`,
      );
      return started
        ? warn("server", `${where} was not running, adb started it just now`)
        : ok("server", where);
    } catch (error) {
      if (
        error instanceof AdbAxiError &&
        (error.code === "TIMEOUT" || error.code === "ADB_SERVER_UNREACHABLE")
      ) {
        return failed(
          "server",
          `${where} is not answering: ${oneLine(error.message)}`,
          STUCK_SERVER,
        );
      }
      throw error;
    }
  });
  return { result, devices };
}

const STUCK_SERVER = [
  "Check that nothing else holds the adb server port, then run `adb-axi doctor` again",
];

/** Errors of choosing the device that are findings of the `device` check. */
const SELECTION_CODES = new Set([
  "DEVICE_AMBIGUOUS",
  "DEVICE_NOT_FOUND",
  "DEVICE_OFFLINE",
  "DEVICE_UNAUTHORIZED",
]);

export interface DeviceReading {
  result: CheckResult;
  /** The resolved device, which the remaining checks run on. */
  target: Target | undefined;
}

/**
 * The state of every attached device, and which one the rest of the report is about. The
 * target is chosen like every other command does (7.2), except that a device that cannot be
 * used is a finding, not an error.
 */
export async function checkDevice(
  context: CommandContext,
  devices: readonly AttachedDevice[],
): Promise<DeviceReading> {
  const listing = devices
    .map((device) => `${device.serial} ${device.state === ONLINE ? "online" : device.state}`)
    .join(", ");
  const requested = context.flags.device;
  try {
    const target = await resolveTarget({
      adb: context.adb(),
      deadline: context.deadline,
      env: context.env,
      devices,
      requested: typeof requested === "string" ? requested : undefined,
      commandArgs: ["doctor"],
      isShipped: context.isShipped,
    });
    const allOnline = devices.every((device) => device.state === ONLINE);
    return {
      result: allOnline ? ok("device", listing) : warn("device", listing),
      target,
    };
  } catch (error) {
    if (!(error instanceof AdbAxiError)) throw error;
    if (!SELECTION_CODES.has(error.code)) {
      // The server stopped answering mid-run, or similar: a finding like any unanswered read.
      return { result: await settle("device", () => Promise.reject(error)), target: undefined };
    }
    const named = error.code === "DEVICE_AMBIGUOUS" || error.code === "DEVICE_NOT_FOUND";
    const detail = oneLine(
      devices.length > 0 && named ? `${error.message}: ${listing}` : error.message,
    );
    // The offline hint points back at doctor, which is already running.
    const help =
      error.code === "DEVICE_OFFLINE"
        ? error.help.filter((line) => !line.includes("`adb-axi doctor"))
        : error.help;
    return { result: failed("device", detail, help), target: undefined };
  }
}
