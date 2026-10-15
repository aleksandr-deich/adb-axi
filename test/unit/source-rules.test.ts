import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "../helpers/run.js";

function files(dir: string, keep: (path: string) => boolean): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    // Build output and caches, including the probe app's Gradle directories.
    if (
      ["node_modules", "dist", ".git", "coverage", "build", ".gradle", ".kotlin"].includes(name)
    ) {
      continue;
    }
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...files(path, keep));
    else if (keep(path)) out.push(path);
  }
  return out;
}

/** Built from its code point so this file does not contain the character it bans. */
const EM_DASH = String.fromCodePoint(0x2014);

describe("source rules", () => {
  it("uses no em dash in any project file", () => {
    const text = files(ROOT, (path) =>
      /\.(ts|js|json|md|ya?ml)$|LICENSE$|\.prettierrc$/.test(path),
    );
    const offenders = text
      .filter((path) => readFileSync(path, "utf8").includes(EM_DASH))
      .map((path) => relative(ROOT, path));
    expect(offenders).toEqual([]);
  });
});
