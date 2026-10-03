import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode } from "@toon-format/toon";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exec } from "../../src/core/exec.js";
import { VERSION } from "../../src/version.js";
import { createFakeAdb } from "../fake-adb/harness.js";
import { ROOT } from "../helpers/run.js";

/**
 * What ships is what is tested: the package is packed into a tarball, installed into a
 * temporary global prefix the way `npm install -g adb-axi` installs it, and run from there.
 */

let dir: string;
let bin: string;

async function run(
  file: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv },
) {
  const result = await exec({ file, args, deadlineMs: 180_000, ...options });
  if (result.kind !== "exited")
    throw new Error(`${file} ${args.join(" ")} did not exit: ${result.kind}`);
  const stdout = result.stdout.toString("utf8");
  const stderr = result.stderr.toString("utf8");
  expect(result.exitCode, `${file} ${args.join(" ")}\n${stderr}`).toBe(0);
  return { stdout, stderr };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "adb-axi-install-"));
  // --ignore-scripts: the gate has already built dist, so prepack need not run again.
  await run("npm", ["pack", "--ignore-scripts", "--pack-destination", dir], { cwd: ROOT });
  const tarball = readdirSync(dir).find((name) => name.endsWith(".tgz"));
  if (tarball === undefined) throw new Error(`npm pack wrote no tarball to ${dir}`);
  const prefix = join(dir, "prefix");
  await run(
    "npm",
    ["install", "--global", "--prefix", prefix, "--no-audit", "--no-fund", join(dir, tarball)],
    { cwd: dir },
  );
  bin = join(prefix, "bin", "adb-axi");
}, 240_000);

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("the installed package", () => {
  it("prints its version", async () => {
    const { stdout } = await run(bin, ["--version"], { cwd: dir });
    expect(stdout).toBe(`${VERSION}\n`);
  });

  it("shows the home view", async () => {
    const fake = createFakeAdb("devices-empty.json");
    try {
      const { stdout } = await run(bin, [], { cwd: dir, env: fake.env });
      const home = decode(stdout.trimEnd()) as Record<string, unknown>;
      expect(home.bin).toMatch(/\/prefix\/bin\/adb-axi$/);
      expect(home).toMatchObject({ count: "0 attached, 0 online", devices: [], target: "-" });
      expect(fake.unmatched()).toEqual([]);
    } finally {
      fake.cleanup();
    }
  });
});
