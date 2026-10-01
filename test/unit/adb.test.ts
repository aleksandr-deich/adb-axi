import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execOut } from "../../src/adb/execout.js";
import { findSdkTool, locateAdb } from "../../src/adb/locate.js";
import { AdbClient } from "../../src/adb/run.js";
import { runShell } from "../../src/adb/shell.js";
import { classifyAdbFailure, classifyShellFailure } from "../../src/adb/variants.js";
import { Deadline } from "../../src/core/deadline.js";
import { AdbAxiError, errorObject } from "../../src/core/errors.js";
import { isProcessAlive } from "../../src/core/exec.js";
import { createFakeAdb, type FakeAdb } from "../fake-adb/harness.js";
import type { Scenario } from "../fake-adb/scenario.js";

const MARGIN_MS = 750;

let fake: FakeAdb | undefined;
afterEach(() => {
  fake?.cleanup();
  fake = undefined;
});

function client(scenario: Scenario | string, log?: string[]): { f: FakeAdb; adb: AdbClient } {
  fake = createFakeAdb(scenario);
  const adb = new AdbClient(join(fake.binDir, "adb"), {
    env: fake.env,
    ...(log === undefined ? {} : { debug: true, log: (line: string) => log.push(line) }),
  });
  return { f: fake, adb };
}

async function failure(promise: Promise<unknown>): Promise<AdbAxiError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AdbAxiError);
    return error as AdbAxiError;
  }
  throw new Error("expected a failure");
}

function executable(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, "#!/bin/sh\n");
  chmodSync(path, 0o755);
  return path;
}

describe("locating adb", () => {
  const empty = (): string => mkdtempSync(join(tmpdir(), "adb-axi-locate-"));

  it("searches PATH, then ANDROID_HOME, then ANDROID_SDK_ROOT, then ~/Library/Android/sdk", () => {
    const home = empty();
    const onPath = empty();
    const androidHome = empty();
    const sdkRoot = empty();
    const libraryAdb = executable(join(home, "Library", "Android", "sdk", "platform-tools"), "adb");
    const sdkRootAdb = executable(join(sdkRoot, "platform-tools"), "adb");
    const androidHomeAdb = executable(join(androidHome, "platform-tools"), "adb");
    const pathAdb = executable(onPath, "adb");

    const env = {
      PATH: [empty(), onPath].join(delimiter),
      ANDROID_HOME: androidHome,
      ANDROID_SDK_ROOT: sdkRoot,
    };
    expect(locateAdb(env, home)).toBe(pathAdb);
    expect(locateAdb({ ...env, PATH: "" }, home)).toBe(androidHomeAdb);
    expect(locateAdb({ ANDROID_SDK_ROOT: sdkRoot }, home)).toBe(sdkRootAdb);
    expect(locateAdb({}, home)).toBe(libraryAdb);
  });

  it("skips files that are not executable", () => {
    const dir = empty();
    writeFileSync(join(dir, "adb"), "");
    expect(findSdkTool("adb", { PATH: dir }, empty()).path).toBeUndefined();
  });

  it("fails with ADB_NOT_FOUND listing every place searched", () => {
    const home = empty();
    const error = (() => {
      try {
        locateAdb({ PATH: [empty(), empty()].join(delimiter), ANDROID_HOME: "/opt/sdk" }, home);
      } catch (e) {
        return errorObject(e);
      }
      throw new Error("expected ADB_NOT_FOUND");
    })();
    expect(error).toMatchObject({ error: "adb was not found", code: "ADB_NOT_FOUND" });
    expect(error.searched).toEqual([
      "PATH (2 directories)",
      "$ANDROID_HOME/platform-tools (/opt/sdk/platform-tools/adb)",
      "$ANDROID_SDK_ROOT/platform-tools ($ANDROID_SDK_ROOT is not set)",
      join(home, "Library", "Android", "sdk", "platform-tools", "adb"),
    ]);
  });
});

describe("adb error variants (H7-H9)", () => {
  it.each([
    ["error: device 'bogus-9999' not found", "DEVICE_NOT_FOUND"],
    ["adb: device 'bogus-9999' not found", "DEVICE_NOT_FOUND"],
    ["adb: error: failed to get feature set: device 'bogus-9999' not found", "DEVICE_NOT_FOUND"],
    ["adb: no devices/emulators found", "DEVICE_NOT_FOUND"],
    ["error: device offline", "DEVICE_OFFLINE"],
    ["adb: device offline", "DEVICE_OFFLINE"],
    [
      "error: device unauthorized.\nThis adb server's $ADB_VENDOR_KEYS is not set",
      "DEVICE_UNAUTHORIZED",
    ],
    ["error: insufficient permissions for device: user in plugdev group", "DEVICE_UNAUTHORIZED"],
    ["* cannot connect to daemon at tcp:5037: Connection refused", "ADB_SERVER_UNREACHABLE"],
    ["adb: failed to check server version: cannot connect to daemon", "ADB_SERVER_UNREACHABLE"],
    ["error: more than one device/emulator", "DEVICE_AMBIGUOUS"],
    ["adb: adb devices [-l]", "INTERNAL_ERROR"],
    ["adb: unknown command shell", "INTERNAL_ERROR"],
  ])("maps %j to %s", (text, code) => {
    expect(classifyAdbFailure(text)).toBe(code);
    expect(classifyShellFailure(text)).toBe(code);
  });

  it("ignores text a remote command prints about devices", () => {
    expect(classifyAdbFailure("ls: /data/misc: Permission denied")).toBeUndefined();
    expect(classifyAdbFailure("my app says: device offline")).toBeUndefined();
    expect(classifyAdbFailure("")).toBeUndefined();
  });

  it("reads remote shell stderr as adb's own failure only with adb's prefix", () => {
    for (const text of [
      "Device offline",
      "device unauthorized",
      "more than one device",
      "no devices/emulators found",
      "cannot connect to daemon",
    ]) {
      expect(classifyShellFailure(text)).toBeUndefined();
    }
  });
});

describe("AdbClient", () => {
  it("always puts -s <serial> first and never uses a host shell", async () => {
    const { f, adb } = client({
      rules: [
        { match: ["-s", "emulator-5554", "shell", "echo $HOME; true"], respond: { stdout: "/\n" } },
      ],
    });
    const result = await adb.device("emulator-5554", ["shell", "echo $HOME; true"], {
      deadline: new Deadline(10_000),
      step: "test",
    });
    expect(result.stdout.toString()).toBe("/\n");
    expect(f.calls().map((call) => call.argv)).toEqual([
      ["-s", "emulator-5554", "shell", "echo $HOME; true"],
    ]);
  });

  it("maps every shape of a missing device to DEVICE_NOT_FOUND with raw text only in detail", async () => {
    const { adb } = client("error-variants.json");
    const options = { deadline: new Deadline(10_000), step: "test" };
    const errors = await Promise.all([
      failure(adb.device("bogus-9999", ["exec-out", "screencap", "-p"], options)),
      failure(adb.device("bogus-9999", ["shell", "true"], options)),
      failure(adb.device("bogus-9999", ["install", "x.apk"], options)),
      failure(adb.device("bogus-9999", ["pull", "/x", "/tmp/x"], options)),
    ]);
    for (const error of errors) {
      expect(errorObject(error)).toMatchObject({
        error: "bogus-9999 is not attached",
        code: "DEVICE_NOT_FOUND",
      });
      expect(String(error.fields.detail)).toMatch(/device 'bogus-9999' not found/);
    }
  });

  it("treats adb usage text as adb-axi's own bug, not a device state (H9)", async () => {
    const { adb } = client("error-variants.json");
    const error = await failure(
      adb.host(["devices", "--bogus"], { deadline: new Deadline(10_000), step: "t" }),
    );
    expect(error.code).toBe("INTERNAL_ERROR");
  });

  it("returns a plain non-zero exit when the output is not an adb failure (H6)", async () => {
    const { adb } = client("error-variants.json");
    const result = await adb.device("bogus-9999", ["emu", "avd", "name"], {
      deadline: new Deadline(10_000),
      step: "t",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout.length + result.stderr.length).toBe(0);
  });

  it("kills a hung call at the deadline, names the step, and leaves no process behind (H1-H4)", async () => {
    const { f, adb } = client("hang-missing-offline.json");
    const started = performance.now();
    const error = await failure(
      adb.device("bogus-9999", ["logcat", "-d"], {
        deadline: new Deadline(600),
        step: "dumping the log",
      }),
    );
    const elapsed = performance.now() - started;
    expect(errorObject(error)).toMatchObject({
      error: "dumping the log did not finish before the 600 ms deadline",
      code: "TIMEOUT",
      step: "dumping the log",
    });
    expect(elapsed).toBeLessThan(600 + MARGIN_MS);
    const [call] = f.calls();
    expect(call?.end).toBeNull();
    expect(isProcessAlive(call?.pid ?? 0)).toBe(false);
  });

  it("does not start a call once the deadline has passed", async () => {
    const { f, adb } = client("hang-missing-offline.json");
    const error = await failure(
      adb.device("bogus-9999", ["logcat", "-d"], {
        deadline: new Deadline(0),
        step: "dumping the log",
      }),
    );
    expect(error.code).toBe("TIMEOUT");
    expect(f.calls()).toEqual([]);
  });

  it("prints the argv and outcome on stderr with --debug", async () => {
    const log: string[] = [];
    const { adb } = client(
      { rules: [{ match: ["devices", "-l"], respond: { stdout: "x" } }] },
      log,
    );
    await adb.host(["devices", "-l"], { deadline: new Deadline(10_000), step: "t" });
    expect(log).toHaveLength(2);
    expect(log[0]).toBe("debug: adb devices -l");
    expect(log[1]).toMatch(/^debug: {3}exit 0 in \d+ ms$/);
  });

  it("reports an adb that cannot be started as ADB_NOT_FOUND", async () => {
    const adb = new AdbClient("/nonexistent/adb");
    const error = await failure(adb.host(["version"], { deadline: new Deadline(5000), step: "t" }));
    expect(error.code).toBe("ADB_NOT_FOUND");
  });
});

describe("shell_v2 runner (S2)", () => {
  it("returns the remote exit code with stdout and stderr apart", async () => {
    const { adb } = client({
      rules: [
        {
          match: ["-s", "emulator-5554", "shell", "ls /data/local/tmp/missing"],
          respond: {
            stdout: "",
            stderr: "ls: /data/local/tmp/missing: No such file or directory\n",
            exit: 1,
          },
        },
      ],
    });
    const result = await runShell(adb, "emulator-5554", "ls /data/local/tmp/missing", {
      deadline: new Deadline(10_000),
      step: "t",
    });
    expect(result).toMatchObject({
      exitCode: 1,
      stdout: "",
      stderr: "ls: /data/local/tmp/missing: No such file or directory\n",
    });
  });

  it("keeps partial output when the deadline passes", async () => {
    // A hanging fake writes `- waiting for device -` first, so there is partial output to keep.
    const { adb } = client({
      rules: [{ match: ["-s", "emulator-5554", "shell", "logcat"], respond: { hang: true } }],
    });
    const error = await failure(
      runShell(adb, "emulator-5554", "logcat", {
        deadline: new Deadline(400),
        step: "running the shell command",
      }),
    );
    expect(error.code).toBe("TIMEOUT");
    expect(error.fields).toEqual({
      step: "running the shell command",
      stdout: "",
      stderr: "- waiting for device -\n",
    });
  });
});

describe("exec-out (S1)", () => {
  it("returns the bytes even when adb exits 0 with error text as the content", async () => {
    const { adb } = client({
      rules: [
        {
          match: [
            "-s",
            "emulator-5554",
            "exec-out",
            "run-as",
            "com.example",
            "cat",
            "databases/app.db",
          ],
          respond: { stdout: "run-as: package not debuggable: com.example\n", exit: 0 },
        },
      ],
    });
    const bytes = await execOut(
      adb,
      "emulator-5554",
      ["run-as", "com.example", "cat", "databases/app.db"],
      {
        deadline: new Deadline(10_000),
        step: "copying the database",
      },
    );
    expect(bytes.toString()).toBe("run-as: package not debuggable: com.example\n");
  });
});
