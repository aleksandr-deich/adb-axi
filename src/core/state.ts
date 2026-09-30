import { randomBytes } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Root of adb-axi's on-disk state: `$ADB_AXI_HOME` when set (tests always set it),
 * otherwise `~/.adb-axi`.
 */
export function adbAxiHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.ADB_AXI_HOME;
  return override !== undefined && override !== "" ? override : join(homedir(), ".adb-axi");
}

/**
 * Per-device state directory. Serials such as `192.168.1.20:5555` or mDNS names are
 * percent-encoded so every serial maps to exactly one safe directory name.
 */
export function deviceStateDir(serial: string, env: NodeJS.ProcessEnv = process.env): string {
  if (serial === "") {
    throw new TypeError("A device serial is required for per-device state");
  }
  return join(adbAxiHome(env), encodeSerial(serial));
}

export function encodeSerial(serial: string): string {
  const encoded = encodeURIComponent(serial).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  // `.` and `..` are the only names that survive encodeURIComponent and are still unsafe.
  return encoded === "." || encoded === ".." ? encoded.replaceAll(".", "%2E") : encoded;
}

/**
 * Replace a file atomically: write a sibling temporary file, flush it, then rename it
 * over the target. Readers see the old content or the new content, never a mix.
 */
export function writeFileAtomic(path: string, content: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    const fd = openSync(tmp, "wx", 0o644);
    try {
      writeSync(fd, typeof content === "string" ? Buffer.from(content, "utf8") : content);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

export function writeJsonAtomic(path: string, value: unknown): void {
  writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Read a JSON state file. A missing file is `undefined`; a file that is not valid JSON
 * throws, naming the file, because silently treating it as empty would hide state.
 */
export function readJson(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`State file ${path} is not valid JSON`, { cause: error });
  }
}

export function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
