import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { exec } from "../../src/core/exec.js";
import { VERSION } from "../../src/version.js";
import { ROOT } from "../helpers/run.js";

interface Tarball {
  files: { path: string }[];
}

interface PackageJson {
  name: string;
  version: string;
  license: string;
  engines: { node: string };
  bin: Record<string, string>;
}

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as PackageJson;

describe("npm package", () => {
  it("publishes only the build, the license and the readme", async () => {
    // --ignore-scripts: the gate has already built dist, so prepack need not run again.
    const result = await exec({
      file: "npm",
      args: ["pack", "--dry-run", "--json", "--ignore-scripts"],
      cwd: ROOT,
      deadlineMs: 60_000,
    });
    expect(result.kind).toBe("exited");
    if (result.kind !== "exited") return;
    expect(result.exitCode, result.stderr.toString("utf8")).toBe(0);
    // npm 10 and 11 print an array of tarballs; npm 12 prints an object keyed by package name.
    type PackReport = Tarball[] | Record<string, Tarball>;
    const report = JSON.parse(result.stdout.toString("utf8")) as PackReport;
    const tarball = Array.isArray(report) ? report[0] : report[pkg.name];
    const files = (tarball?.files ?? []).map((file) => file.path);
    expect(files).toContain("dist/bin/adb-axi.js");
    const unexpected = files.filter(
      (path) =>
        !(path.startsWith("dist/") && path.endsWith(".js")) &&
        !["LICENSE", "README.md", "package.json"].includes(path),
    );
    // No captures, APKs, probe-app sources or other test material.
    expect(unexpected).toEqual([]);
    expect(files.filter((path) => path.startsWith("dist/test/"))).toEqual([]);
  });

  it("states the version once, in package.json and the fast-path module alike", () => {
    expect(VERSION).toBe(pkg.version);
  });

  it("declares the Node floor, the license and the bin", () => {
    expect(pkg.engines.node).toBe(">=22");
    expect(pkg.license).toBe("MIT");
    expect(pkg.bin).toEqual({ "adb-axi": "dist/bin/adb-axi.js" });
  });
});
