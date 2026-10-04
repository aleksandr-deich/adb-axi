import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { TestProject } from "vitest/node";
import { locateAdb } from "../../src/adb/locate.js";
import { exec } from "../../src/core/exec.js";

const ROOT = resolve(import.meta.dirname, "..", "..");

export interface DeviceContext {
  /** The emulator every check drives, always passed as `--device`. */
  serial: string;
  /** The `adb-axi` executable installed from a packed tarball. */
  bin: string;
  /** `ADB_AXI_HOME` for this run, so marks never mix with the host's own state. */
  home: string;
  /** Where each test file writes the transcript of its adb-axi calls. */
  transcripts: string;
}

declare module "vitest" {
  export interface ProvidedContext {
    device: DeviceContext;
  }
}

/**
 * Prepares one run of the real-emulator checks: the target serial, adb-axi installed from
 * a tarball (so the checks run what ships), a fresh state home and the transcript folder,
 * then waits until the emulator's framework services answer.
 */
export default async function setup(project: TestProject): Promise<void> {
  const serial = process.env.ANDROID_SERIAL ?? "";
  if (serial === "") {
    throw new Error(
      "Set ANDROID_SERIAL to the serial of an emulator reserved for these checks, for example emulator-5554",
    );
  }
  const bin = process.env.ADB_AXI_BIN ?? installFromTarball();
  const home = mkdtempSync(join(tmpdir(), "adb-axi-device-home-"));
  const transcripts = resolve(ROOT, "test-results/device");
  rmSync(transcripts, { recursive: true, force: true });
  mkdirSync(transcripts, { recursive: true });
  project.provide("device", { serial, bin, home, transcripts });
  await waitForServices(serial);
}

/** How long the services must keep answering, from one system_server, to count as ready. */
const SETTLE_MS = 10_000;
const READY_DEADLINE_MS = 300_000;
const LOOK_INTERVAL_MS = 1_000;

/**
 * One look calls the package and activity services, not just `service check`, and reads
 * system_server's pid so a framework restart during the settle window starts it over.
 */
const READY_COMMAND =
  "echo pid=$(pidof system_server); pm path android && echo user=$(am get-current-user)";

/**
 * Wait until the package and activity services answer and keep answering from the same
 * system_server for `SETTLE_MS`. `sys.boot_completed` alone is not enough: on API 30 the
 * framework can still be coming up, or restart, seconds after it is set, and the first
 * install then fails with "Can't find service: package" or a broken pipe to the service.
 */
async function waitForServices(serial: string): Promise<void> {
  const adb = locateAdb();
  const started = performance.now();
  let stableSince: { pid: string; at: number } | undefined;
  let last = "no look finished yet";
  while (performance.now() - started < READY_DEADLINE_MS) {
    const result = await exec({
      file: adb,
      args: ["-s", serial, "shell", READY_COMMAND],
      deadlineMs: 10_000,
    });
    const stdout = result.stdout.toString("utf8");
    const pid = /^pid=(\d+)$/m.exec(stdout)?.[1];
    const ready =
      result.kind === "exited" &&
      result.exitCode === 0 &&
      pid !== undefined &&
      /^package:/m.test(stdout) &&
      /^user=\d+$/m.test(stdout);
    const now = performance.now();
    if (!ready) {
      stableSince = undefined;
      last = `${result.kind}, exit ${result.kind === "exited" ? result.exitCode : "-"}: ${stdout}${result.stderr.toString("utf8")}`;
    } else if (stableSince?.pid !== pid) {
      stableSince = { pid, at: now };
    } else if (now - stableSince.at >= SETTLE_MS) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, LOOK_INTERVAL_MS));
  }
  throw new Error(
    `${serial}: the package and activity services did not answer steadily within ${READY_DEADLINE_MS} ms. Last failed look: ${last.trim()}`,
  );
}

/** `npm pack`, then install the tarball into a temporary prefix, as a user would. */
function installFromTarball(): string {
  const work = mkdtempSync(join(tmpdir(), "adb-axi-device-pack-"));
  const packed = execFileSync("npm", ["pack", "--silent", "--pack-destination", work], {
    cwd: ROOT,
    encoding: "utf8",
  });
  const tarball = join(work, packed.trim().split("\n").at(-1) ?? "");
  const prefix = join(work, "prefix");
  execFileSync("npm", ["install", "--global", "--silent", "--prefix", prefix, tarball], {
    cwd: work,
    stdio: "inherit",
  });
  return join(prefix, "bin", "adb-axi");
}
