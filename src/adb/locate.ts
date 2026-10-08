import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { AdbAxiError } from "../core/errors.js";

export interface SdkToolSearch {
  /** The executable, if found. */
  path: string | undefined;
  /** Every place looked at, in order, for the error when nothing is found. */
  searched: string[];
}

/**
 * Find an Android SDK platform-tools executable (adb): `PATH`, then
 * `$ANDROID_HOME/platform-tools`, then `$ANDROID_SDK_ROOT/platform-tools`, then
 * `~/Library/Android/sdk/platform-tools` (7.3).
 */
export function findSdkTool(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): SdkToolSearch {
  const searched: string[] = [];
  const pathDirs = (env.PATH ?? "").split(delimiter).filter((dir) => dir !== "");
  searched.push(`PATH (${pathDirs.length} directories)`);
  for (const dir of pathDirs) {
    const candidate = join(dir, name);
    if (isExecutableFile(candidate)) return { path: candidate, searched };
  }

  const sdkDirs: [label: string, dir: string | undefined][] = [
    ["$ANDROID_HOME", env.ANDROID_HOME],
    ["$ANDROID_SDK_ROOT", env.ANDROID_SDK_ROOT],
    ["~/Library/Android/sdk", join(home, "Library", "Android", "sdk")],
  ];
  for (const [label, dir] of sdkDirs) {
    if (dir === undefined || dir === "") {
      searched.push(`${label}/platform-tools (${label} is not set)`);
      continue;
    }
    const candidate = join(dir, "platform-tools", name);
    searched.push(label.startsWith("$") ? `${label}/platform-tools (${candidate})` : candidate);
    if (isExecutableFile(candidate)) return { path: candidate, searched };
  }
  return { path: undefined, searched };
}

/** Locate adb or fail with `ADB_NOT_FOUND`, listing where it looked. */
export function locateAdb(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const { path, searched } = findSdkTool("adb", env, home);
  if (path !== undefined) return path;
  throw new AdbAxiError("ADB_NOT_FOUND", "adb was not found", {
    fields: { searched },
    help: [
      "Install the Android SDK platform-tools, or set ANDROID_HOME to the SDK directory, then run the command again",
    ],
  });
}

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
