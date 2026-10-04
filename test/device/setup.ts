import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { TestProject } from "vitest/node";

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
 * a tarball (so the checks run what ships), a fresh state home and the transcript folder.
 */
export default function setup(project: TestProject): void {
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
