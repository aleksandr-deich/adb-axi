import { createHash } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode } from "@toon-format/toon";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { readApkFile } from "../../src/apk/index.js";
import { createFakeAdb, type FakeAdb } from "../fake-adb/harness.js";
import type { Response, Rule } from "../fake-adb/scenario.js";
import {
  buildApk,
  buildZip,
  digestOf,
  repeatedStringManifest,
  withZip64End,
} from "../helpers/apk-builder.js";
import { runCli, type CliRun } from "../helpers/run.js";
import { sharedWithToon } from "../helpers/json.js";

const SERIAL = "emulator-5554";
const PKG = "com.example.notes";
const ONE_ONLINE = `List of devices attached\n${SERIAL}          device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:1\n\n`;
const DUMPSYS = `dumpsys package ${PKG}`;
const FACTS = { re: "^echo @sdk; .*" };
const APK_PATH = `pm path --user 0 ${PKG}`;
const CAT_APK = "cat /data/app/notes/base.apk";
const SHA_APK = "sha256sum /data/app/notes/base.apk";
const INSTALL_OK = { stdout: "Performing Streamed Install\nSuccess\n" };
const CERT_A = Buffer.from("certificate A");
const CERT_B = Buffer.from("certificate B");

let apkDir: string;
let APK: string; // 1.4.0 (57), signed by A
let APK_OTHER_KEY: string; // 1.4.0 (57), signed by B
let APK_V1_ONLY: string; // 1.4.0 (57), no v2 or v3 signature
let APK_OLDER: string; // 1.3.0 (50)
let APK_CORRUPT: string;
let APK_ZIP64: string;
let APK_OVERSIZED: string;

beforeAll(() => {
  apkDir = mkdtempSync(join(tmpdir(), "adb-axi-apks-"));
  const write = (name: string, bytes: Buffer): string => {
    const path = join(apkDir, name);
    writeFileSync(path, bytes);
    return path;
  };
  const notes = { package: PKG, versionCode: 57, versionName: "1.4.0", deflateManifest: true };
  APK = write("app-debug.apk", buildApk({ ...notes, signers: { v2: [CERT_A] } }));
  APK_OTHER_KEY = write("app-other-key.apk", buildApk({ ...notes, signers: { v2: [CERT_B] } }));
  APK_V1_ONLY = write("app-v1.apk", buildApk(notes));
  APK_OLDER = write(
    "app-older.apk",
    buildApk({ package: PKG, versionCode: 50, versionName: "1.3.0", signers: { v2: [CERT_A] } }),
  );
  APK_CORRUPT = write("corrupt.apk", Buffer.from("PK this was cut off while it was being copied"));
  APK_ZIP64 = write("zip64.apk", withZip64End(buildApk(notes)));
  const bytes = readFileSync(APK);
  const directory = bytes.readUInt32LE(bytes.length - 6);
  const split = directory - Number(bytes.readBigUInt64LE(directory - 24)) - 8;
  const padding = 65 * 1024 * 1024;
  const tail = Buffer.from(bytes.subarray(split));
  tail.writeUInt32LE(directory + padding, tail.length - 6);
  APK_OVERSIZED = join(apkDir, "oversized.apk");
  const fd = openSync(APK_OVERSIZED, "w");
  try {
    writeSync(fd, bytes.subarray(0, split), 0, split, 0);
    writeSync(fd, tail, 0, tail.length, split + padding);
  } finally {
    closeSync(fd);
  }
  for (const method of [0, 8]) {
    const malformed = buildApk({ ...notes, deflateManifest: method === 8 });
    const directory = malformed.readUInt32LE(malformed.length - 6);
    const tail = Buffer.from(malformed.subarray(directory));
    const padding = 1024 * 1024 * 1024;
    tail.writeUInt32LE(512 * 1024 * 1024, 20);
    tail.writeUInt32LE(1024, 24);
    tail.writeUInt32LE(directory + padding, tail.length - 6);
    const path = join(apkDir, `huge-compressed-${method}.apk`);
    const fd = openSync(path, "w");
    try {
      writeSync(fd, malformed.subarray(0, directory), 0, directory, 0);
      writeSync(fd, tail, 0, tail.length, directory + padding);
    } finally {
      closeSync(fd);
    }
  }
});
afterAll(() => {
  rmSync(apkDir, { recursive: true, force: true });
});

let fakes: FakeAdb[] = [];
afterEach(() => {
  for (const fake of fakes) fake.cleanup();
  fakes = [];
});

/** A package record as the `Packages:` section of `dumpsys package` prints it. */
function packageDump(name: string, versionName: string, versionCode: number): Response {
  return {
    stdout: [
      "Packages:",
      `  Package [${name}] (4f2a9c1):`,
      "    appId=10123",
      `    versionCode=${versionCode} minSdk=29 targetSdk=36`,
      `    versionName=${versionName}`,
      "    flags=[ HAS_CODE ]",
      "    User 0: ceDataInode=1 installed=true hidden=false stopped=false",
      "",
    ].join("\n"),
  };
}

const ABSENT: Response = { stdout: "Unable to find package: com.example.notes\n" };
const V56 = packageDump(PKG, "1.4.0", 56);
const V57 = packageDump(PKG, "1.4.0", 57);

const shell = (command: string | { re: string }): (string | { re: string })[] => [
  "-s",
  SERIAL,
  "shell",
  command,
];

interface World {
  /** What `dumpsys package` says in each state of the package, and the state to start in. */
  dumps: Record<string, Response>;
  start: string;
  rules?: Rule[];
  api?: Response;
  installedApk?: string | Response;
  userId?: number;
}

const sha256 = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

/** One online emulator whose package state is a variable that installs and uninstalls move. */
function world(options: World): FakeAdb {
  const fake = createFakeAdb({
    description: "One online emulator with a package that installs and uninstalls change",
    synthetic: true,
    state: { pkg: options.start },
    rules: [
      { match: ["devices", "-l"], respond: { stdout: ONE_ONLINE } },
      ...Object.entries(options.dumps).map(([state, respond]) => ({
        match: shell(DUMPSYS),
        when: { pkg: state },
        respond,
      })),
      ...(options.rules ?? []),
      { match: shell("am get-current-user"), respond: { stdout: `${options.userId ?? 0}\n` } },
      {
        match: shell(FACTS),
        respond: { ...options.api, stdout: `@sdk\n${options.api?.stdout ?? "35\n"}` },
      },
      {
        match: shell(`pm path --user ${options.userId ?? 0} ${PKG}`),
        respond: { stdout: "package:/data/app/notes/base.apk\n" },
      },
      {
        // The base APK holds the bytes of the last APK installed, the committed one by default.
        match: shell(SHA_APK),
        respond: {
          stdout: `${sha256(typeof options.installedApk === "string" ? options.installedApk : APK)}  /data/app/notes/base.apk\n`,
        },
      },
      {
        match: ["-s", SERIAL, "exec-out", CAT_APK],
        respond:
          typeof options.installedApk === "string"
            ? { stdoutFile: options.installedApk }
            : (options.installedApk ?? { stderr: "Permission denied\n", exit: 1 }),
      },
    ],
  });
  fakes.push(fake);
  return fake;
}

function installs(apk: string, respond: Response = INSTALL_OK, to = "new"): Rule {
  return { match: ["-s", SERIAL, "install", "-r", apk], respond, set: { pkg: to } };
}

/** Run a command on a fresh world, once as TOON and once as `--json`; both must say the same. */
async function both(make: () => FakeAdb, args: string[]): Promise<Both> {
  const toonWorld = make();
  const jsonWorld = make();
  const [toon, json] = await Promise.all([
    runCli(args, toonWorld.env),
    runCli([...args, "--json"], jsonWorld.env),
  ]);
  expect(toon.exitCode).toBe(json.exitCode);
  const data = sharedWithToon(JSON.parse(json.stdout) as Record<string, unknown>);
  const decoded = decode(toon.stdout.trimEnd()) as Record<string, unknown>;
  expect(withoutTime(decoded)).toEqual(withoutTime(data));
  return { toon, json, data, fake: toonWorld };
}

interface Both {
  toon: CliRun;
  json: CliRun;
  data: Record<string, unknown>;
  /** The world the TOON run used. */
  fake: FakeAdb;
}

/** `took_ms` differs from run to run; every other field must match exactly. */
function withoutTime(data: Record<string, unknown>): Record<string, unknown> {
  const install = data.install as Record<string, unknown> | undefined;
  if (install?.took_ms === undefined) return data;
  return { ...data, install: { ...install, took_ms: "<n>" } };
}

function toonLines(run: CliRun): string[] {
  return run.stdout
    .replace(/took_ms: \d+/, "took_ms: <n>")
    .trimEnd()
    .split("\n");
}

/** The device-side calls, as `install -r ...` or the shell command, in order. */
function calls(fake: FakeAdb): string[] {
  return fake
    .calls()
    .map((call) => call.argv)
    .filter((argv) => argv[0] !== "devices")
    .map((argv) => argv.slice(2).join(" "));
}

function expectClean(fake: FakeAdb): void {
  expect(fake.unmatched()).toEqual([]);
  for (const call of fake.calls()) {
    if (call.argv[0] !== "devices") expect(call.argv.slice(0, 2)).toEqual(["-s", SERIAL]);
  }
}

function recordFile(fake: FakeAdb): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(join(fake.home, SERIAL, "last-install.json"), "utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return undefined;
  }
}

/** Put a `last-install.json` where the install under test will read it. */
function seedRecord(fake: FakeAdb, record: Record<string, unknown>): void {
  mkdirSync(join(fake.home, SERIAL), { recursive: true });
  writeFileSync(join(fake.home, SERIAL, "last-install.json"), JSON.stringify(record));
}

describe("app install", () => {
  describe("with --if-changed", () => {
    const sameInstall = (): Record<string, unknown> => ({
      packages: {
        [PKG]: {
          versionCode: 57,
          versionName: "1.4.0",
          signers: [digestOf(CERT_A)],
          installedAt: "2026-10-01T10:00:00.000Z",
        },
      },
    });

    /** Both runs need the record, which lives in each world's own home. */
    function withRecord(record: Record<string, unknown>, rules: Rule[] = [installs(APK)]) {
      return (): FakeAdb => {
        const fake = world({
          start: "current",
          dumps: { current: V57, new: V57 },
          rules,
          installedApk: APK,
        });
        seedRecord(fake, record);
        return fake;
      };
    }

    it("falls back to installation when current signer evidence exceeds the collection limit", async () => {
      expect(readApkFile(APK_OVERSIZED)).toMatchObject({
        package: PKG,
        versionCode: 57,
        signers: [digestOf(CERT_A)],
      });
      const { toon, data, fake } = await both(
        () =>
          world({
            start: "current",
            dumps: { current: V57, new: V57 },
            installedApk: APK_OVERSIZED,
            rules: [installs(APK)],
          }),
        ["app", "install", APK, "--if-changed"],
      );
      expect(toon.exitCode).toBe(0);
      expect(data).toMatchObject({
        ok: "install com.example.notes -> 1.4.0 (57) with data kept",
        install: {
          shortcut: "skipped because the installed APK evidence exceeds the host read limit",
        },
      });
      expect(calls(fake)).toContain(`install -r ${APK}`);
      expectClean(fake);
    });

    it.each(["contents"])(
      "falls back to installation when installed APK evidence %s takes too long",
      async (step) => {
        const { toon, data, fake } = await both(
          () =>
            world({
              start: "current",
              dumps: { current: V57, new: V57 },
              installedApk: step === "contents" ? { hang: true } : APK,
              rules: [
                ...(step === "path" ? [{ match: shell(APK_PATH), respond: { hang: true } }] : []),
                installs(APK),
              ],
            }),
          ["app", "install", APK, "--if-changed", "--timeout", "4s"],
        );
        expect(toon.exitCode).toBe(0);
        expect(toon.stdout).toContain("ok: install com.example.notes -> 1.4.0 (57) with data kept");
        expect(data).toMatchObject({
          ok: "install com.example.notes -> 1.4.0 (57) with data kept",
          install: {
            shortcut: "skipped because reading the installed APK evidence took too long",
          },
        });
        expect(calls(fake)).toContain(`install -r ${APK}`);
        expectClean(fake);
      },
    );

    it.each([
      ["unknown API", "unknown\n", () => APK],
      ["unreadable installed APK", "35\n", () => APK_CORRUPT],
      ["installed metadata mismatch", "35\n", () => APK_OLDER],
    ] as const)("uses current target-device evidence: %s", async (_label, sdk, installedFile) => {
      const apk = APK;
      const { toon, data, fake } = await both(
        () =>
          world({
            start: "current",
            dumps: { current: V57, new: V57 },
            api: { stdout: sdk },
            installedApk: installedFile(),
            rules: [installs(apk)],
          }),
        ["app", "install", apk, "--if-changed"],
      );
      expect(toon.exitCode).toBe(0);
      expect(data.install).toHaveProperty("shortcut", expect.stringContaining("skipped because"));
      expect(calls(fake)).toContain(`install -r ${apk}`);
      expectClean(fake);
    });

    it.each([
      ["pm path failure", { stderr: "Permission denied\n", exit: 1 }, false],
      [
        "split APK paths",
        { stdout: "package:/data/app/notes/base.apk\npackage:/data/app/notes/split_config.apk\n" },
        true,
      ],
    ] as const)("handles installed path evidence: %s", async (_label, response, noop) => {
      const { toon, data, fake } = await both(
        () =>
          world({
            start: "current",
            dumps: { current: V57, new: V57 },
            installedApk: APK,
            rules: [
              {
                match: shell(APK_PATH),
                respond: { stdout: "package:/data/app/notes/base.apk\n" },
                times: 1,
              },
              { match: shell(APK_PATH), respond: response, times: 1 },
              installs(APK),
            ],
          }),
        ["app", "install", APK, "--if-changed"],
      );
      expect(toon.exitCode).toBe(0);
      if (noop) expect(data.ok).toContain("already installed");
      else {
        expect(data.install).toHaveProperty("shortcut", expect.stringContaining("skipped because"));
        expect(calls(fake)).toContain(`install -r ${APK}`);
      }
      expectClean(fake);
    });

    it("installs ZIP64 through the unreadable-APK shortcut fallback", async () => {
      const { toon, data, fake } = await both(
        () =>
          world({
            start: "current",
            dumps: { current: V57 },
            rules: [installs(APK_ZIP64, INSTALL_OK, "current")],
          }),
        ["app", "install", APK_ZIP64, "--if-changed"],
      );
      expect(toon.exitCode).toBe(0);
      expect(data.install).toMatchObject({
        shortcut: "skipped because the APK metadata cannot be read (ZIP64 APKs are not supported)",
      });
      expect(calls(fake)).toContain(`install -r ${APK_ZIP64}`);
      expectClean(fake);
    });

    it("installs and says the shortcut was skipped when the installed APK cannot be read", async () => {
      const { data, fake } = await both(
        () =>
          world({ start: "current", dumps: { current: V57, new: V57 }, rules: [installs(APK)] }),
        ["app", "install", APK, "--if-changed"],
      );
      expect(data).toMatchObject({
        install: { shortcut: "skipped because the installed APK cannot be read" },
      });
      expect(calls(fake)).toContain(`install -r ${APK}`);
    });

    it("installs and says the shortcut was skipped when the APK has no readable signature", async () => {
      const { data, fake } = await both(withRecord(sameInstall(), [installs(APK_V1_ONLY)]), [
        "app",
        "install",
        APK_V1_ONLY,
        "--if-changed",
      ]);
      expect(data).toMatchObject({
        ok: "install com.example.notes -> 1.4.0 (57) with data kept",
        install: {
          shortcut:
            "skipped because the APK signature cannot be read (the APK has no v2 or v3 signature)",
        },
      });
      // The version is still verified; only the signer is unknown.
      expect(calls(fake)).toContain(`install -r ${APK_V1_ONLY}`);
      expect(recordFile(fake)).toMatchObject({ packages: { [PKG]: { signers: null } } });
    });

    it.each([8])(
      "safely falls back for a huge declared compressed manifest: method %s",
      async (method) => {
        const apk = join(apkDir, `huge-compressed-${method}.apk`);
        const { toon, data, fake } = await both(
          () =>
            world({
              start: "current",
              dumps: { current: V57 },
              rules: [installs(apk, INSTALL_OK, "current")],
            }),
          ["app", "install", apk, "--if-changed"],
        );
        expect(toon.exitCode).toBe(0);
        expect(data.ok).toBe(
          `install huge-compressed-${method}.apk -> installed, version not verified`,
        );
        expect(data.install).toMatchObject({
          shortcut:
            "skipped because the APK metadata cannot be read (AndroidManifest.xml is larger than adb-axi reads)",
          detail: "AndroidManifest.xml is larger than adb-axi reads",
        });
        expect(calls(fake)).toContain(`install -r ${apk}`);
        expectClean(fake);
      },
    );
  });

  describe("with --clean-data", () => {
    it("clears only the resolved current user's data", async () => {
      const secondary = { stdout: V57.stdout?.replace("User 0:", "User 10:") ?? "" };
      const fake = world({
        userId: 10,
        start: "new",
        dumps: { new: secondary },
        rules: [
          installs(APK),
          { match: shell(`pm clear --user 10 ${PKG}`), respond: { stdout: "Success\n" } },
        ],
      });
      const run = await runCli(["app", "install", APK, "--clean-data", "--json"], fake.env);
      expect(run.exitCode).toBe(0);
      expect((JSON.parse(run.stdout) as Record<string, unknown>).ok).toBe(
        `install ${PKG} -> 1.4.0 (57) with data wiped`,
      );
      expect(calls(fake)).toContain(`shell pm clear --user 10 ${PKG}`);
      expectClean(fake);
    });

    it("fails with INVALID_OUTPUT when pm clear does not say Success", async () => {
      const { toon, data } = await both(
        () =>
          world({
            start: "old",
            dumps: { old: V56, new: V57 },
            rules: [
              installs(APK),
              { match: shell(`pm clear --user 0 ${PKG}`), respond: { stdout: "Failed\n" } },
            ],
          }),
        ["app", "install", APK, "--clean-data"],
      );
      expect(toon.exitCode).toBe(1);
      expect(data).toMatchObject({ code: "INVALID_OUTPUT" });
    });

    it("fails with REMOTE_EXIT when pm clear exits non-zero", async () => {
      const { toon, data } = await both(
        () =>
          world({
            start: "old",
            dumps: { old: V56, new: V57 },
            rules: [
              installs(APK),
              { match: shell(`pm clear --user 0 ${PKG}`), respond: { stderr: "boom\n", exit: 1 } },
            ],
          }),
        ["app", "install", APK, "--clean-data"],
      );
      expect(toon.exitCode).toBe(1);
      expect(data).toMatchObject({ code: "REMOTE_EXIT", exit: 1 });
    });

    // Android reads the first `package` attribute, and its raw string (AOSP `ResXMLParser::
    // indexOfAttribute`, `XmlBlock.getAttributeValue`); `aapt2 dump packagename` reads
    // com.example.other from both. Either the parse matches Android or nothing is wiped.
    it.each([
      ["whose package attribute has two string values", { packageRawValue: "com.example.other" }],
      ["with two package attributes", { earlierPackage: "com.example.other" }],
    ])("never wipes another app for a manifest %s", async (_name, crafted) => {
      const apk = join(apkDir, "two-names.apk");
      writeFileSync(apk, buildApk({ package: PKG, versionCode: 57, ...crafted }));
      const { toon, data, fake } = await both(
        () =>
          world({
            start: "new",
            dumps: { new: V57 },
            rules: [
              installs(apk),
              { match: shell(`pm clear --user 0 ${PKG}`), respond: { stdout: "Success\n" } },
            ],
          }),
        ["app", "install", apk, "--clean-data"],
      );
      expect(toon.exitCode).toBe(1);
      expect(data).toMatchObject({ code: "INSTALL_FAILED_INVALID_APK", apk: "two-names.apk" });
      expect(calls(fake)).toEqual([]);
    });

    it("refuses a tiny APK whose string pool repeats one long string, without running out of memory", async () => {
      const apk = join(apkDir, "repeated-strings.apk");
      const manifest = repeatedStringManifest(64 * 1024, 128 * 1024, 8);
      writeFileSync(
        apk,
        buildZip([{ name: "AndroidManifest.xml", data: manifest, deflate: true }]),
      );
      expect(readFileSync(apk).length).toBeLessThan(1024);
      const fake = world({ start: "old", dumps: { old: V56 } });
      const run = await runCli(["app", "install", apk, "--clean-data", "--json"], {
        ...fake.env,
        // Far below what decoding every pool entry needs, so a regression fails fast.
        NODE_OPTIONS: "--max-old-space-size=256",
      });
      expect(run.exitCode).toBe(1);
      expect(JSON.parse(run.stdout)).toMatchObject({
        code: "INSTALL_FAILED_INVALID_APK",
        detail: "the manifest strings are too large to read",
      });
      expect(calls(fake)).toEqual([]);
    });

    it.each([
      ["runs a different APK", (): Partial<World> => ({ installedApk: APK_OTHER_KEY })],
      [
        "has no base APK",
        (): Partial<World> => ({
          rules: [
            {
              match: shell(`pm path --user 0 ${PKG}`),
              respond: { stdout: "package:/data/app/notes/base.apk\n" },
              times: 2,
            },
            { match: shell(`pm path --user 0 ${PKG}`), respond: { stdout: "" } },
          ],
        }),
      ],
    ])("refuses the wipe when the installed package %s", async (_name, evidence) => {
      const { toon, data, fake } = await both(() => {
        const { rules = [], ...rest } = evidence();
        return world({
          start: "old",
          dumps: { old: V56, new: V57 },
          ...rest,
          rules: [
            ...rules,
            installs(APK),
            { match: shell(`pm clear --user 0 ${PKG}`), respond: { stdout: "Success\n" } },
          ],
        });
      }, ["app", "install", APK, "--clean-data"]);
      expect(toon.exitCode).toBe(1);
      expect(data).toMatchObject({ code: "CLEAR_REFUSED", package: PKG });
      expect(calls(fake)).toContain(`install -r ${APK}`);
      expect(calls(fake)).not.toContain(`shell pm clear --user 0 ${PKG}`);
    });
  });

  describe("when the package manager refuses", () => {
    const refuse = (message: string, apk = APK, start = "old"): (() => FakeAdb) => {
      return () =>
        world({
          start,
          dumps: { old: V56, new: V57, newer: V57 },
          rules: [
            {
              match: ["-s", SERIAL, "install", "-r", apk],
              respond: {
                stdout: "Performing Streamed Install\n",
                stderr: `adb: failed to install ${apk}: ${message}\n`,
                exit: 1,
              },
            },
          ],
        });
    };

    it("gives a code it has no special text for the package manager's message and a generic fix", async () => {
      const { toon, data } = await both(
        refuse("Failure [INSTALL_FAILED_SOMETHING_NEW: the device said no]"),
        ["app", "install", APK],
      );
      expect(toon.exitCode).toBe(1);
      expect(data).toMatchObject({
        code: "INSTALL_FAILED_SOMETHING_NEW",
        detail: "the device said no",
        help: [expect.stringContaining("Read `detail`") as string],
      });
    });

    it("reports a failure with no package manager code as INSTALL_FAILED_UNKNOWN with detail", async () => {
      const { toon, data } = await both(refuse("Exception occurred while executing 'install'"), [
        "app",
        "install",
        APK,
      ]);
      expect(toon.exitCode).toBe(1);
      expect(data).toMatchObject({
        code: "INSTALL_FAILED_UNKNOWN",
        help: [expect.stringContaining("Read `detail`")],
      });
      expect(data.detail).toContain("Exception occurred");
      expect(data.error).toEqual(expect.stringContaining("was not installed because"));
    });

    it("never says Success for a Failure line even when adb exits 0", async () => {
      const { toon, data } = await both(
        () =>
          world({
            start: "old",
            dumps: { old: V56, new: V57 },
            rules: [
              installs(APK, { stdout: "Failure [INSTALL_FAILED_INSUFFICIENT_STORAGE]\n" }, "old"),
            ],
          }),
        ["app", "install", APK],
      );
      expect(toon.exitCode).toBe(1);
      expect(data).toMatchObject({ code: "INSTALL_FAILED_INSUFFICIENT_STORAGE" });
    });
  });

  describe("deadlines", () => {
    it("fails with TIMEOUT naming the step when adb install never returns", async () => {
      const fake = world({
        start: "old",
        dumps: { old: V56 },
        rules: [{ match: ["-s", SERIAL, "install", "-r", APK], respond: { hang: true } }],
      });
      const run = await runCli(["app", "install", APK, "--timeout", "2s"], fake.env);
      expect(run.exitCode).toBe(1);
      expect(run.stdout).toContain("code: TIMEOUT");
      expect(run.stdout).toContain("installing app-debug.apk");
      expect(run.durationMs).toBeLessThan(12_000);
    });

    it("fails with WAIT_TIMEOUT carrying the last observation when the version never shows", async () => {
      const make = (): FakeAdb =>
        // The install succeeds but the package manager keeps reporting the old version.
        world({ start: "old", dumps: { old: V56 }, rules: [installs(APK, INSTALL_OK, "old")] });
      const { toon, data } = await both(make, ["app", "install", APK, "--timeout", "4s"]);
      expect(toon.exitCode).toBe(1);
      expect(data).toMatchObject({
        code: "WAIT_TIMEOUT",
        error: "com.example.notes did not report versionCode 57 within 4 s",
        last: { installed: true, version: "1.4.0 (56)" },
      });
    }, 30_000);
  });

  describe("usage errors", () => {
    it("rejects an APK path that does not exist, before installing", async () => {
      const { toon, data, fake } = await both(
        () => world({ start: "old", dumps: { old: V56 }, rules: [] }),
        ["app", "install", join(apkDir, "missing.apk")],
      );
      expect(toon.exitCode).toBe(2);
      expect(data).toMatchObject({ code: "VALIDATION_ERROR" });
      expect(calls(fake)).toEqual([]);
    });

    it("rejects a directory", async () => {
      const { toon, data } = await both(
        () => world({ start: "old", dumps: { old: V56 }, rules: [] }),
        ["app", "install", apkDir],
      );
      expect(toon.exitCode).toBe(2);
      expect(data).toMatchObject({ code: "VALIDATION_ERROR" });
    });

    it("needs an APK path", async () => {
      const fake = world({ start: "old", dumps: { old: V56 } });
      const run = await runCli(["app", "install"], fake.env);
      expect(run.exitCode).toBe(2);
      expect(run.stdout).toContain("code: VALIDATION_ERROR");
    });
  });
});

describe("app uninstall", () => {
  const uninstalls = (command: string, respond: Response, to = "absent"): Rule => ({
    match: shell(command.replace(/^pm uninstall/, "pm uninstall --user 0")),
    respond,
    set: { pkg: to },
  });

  it("checks and removes only the current user's installation when absent for user 0", async () => {
    const secondary = {
      stdout: `${V57.stdout?.replace("installed=true", "installed=false") ?? ""}    User 10: installed=true\n`,
    };
    const removed = {
      stdout: secondary.stdout.replace("User 10: installed=true", "User 10: installed=false"),
    };
    const fake = world({
      userId: 10,
      start: "current",
      dumps: { current: secondary, removed },
      rules: [
        {
          match: shell(`pm uninstall --user 10 ${PKG}`),
          respond: { stdout: "Success\n" },
          set: { pkg: "removed" },
        },
      ],
    });
    const run = await runCli(["app", "uninstall", PKG, "--json"], fake.env);
    expect(run.exitCode).toBe(0);
    expect((JSON.parse(run.stdout) as Record<string, unknown>).ok).toBe(
      `uninstall ${PKG} -> removed`,
    );
    expect(calls(fake)).toContain(`shell pm uninstall --user 10 ${PKG}`);
    expectClean(fake);
  });

  it("exits 1 with UNINSTALL_FAILED when the package is still installed afterwards", async () => {
    const { toon, data } = await both(
      () =>
        world({
          start: "current",
          dumps: { current: V57 },
          rules: [
            {
              match: shell(`pm uninstall --user 0 ${PKG}`),
              respond: {
                stdout: "Failure [DELETE_FAILED_DEVICE_POLICY_MANAGER]\n",
                exit: 1,
              },
            },
          ],
        }),
      ["app", "uninstall", PKG],
    );
    expect(toon.exitCode).toBe(1);
    expect(toonLines(toon).slice(0, 2)).toEqual([
      "error: com.example.notes is still installed after the uninstall",
      "code: UNINSTALL_FAILED",
    ]);
    expect(data).toMatchObject({
      package: PKG,
      reason: "DELETE_FAILED_DEVICE_POLICY_MANAGER",
      help: [
        expect.stringContaining("system app") as string,
        expect.stringContaining("app info") as string,
      ],
    });
  });

  it("does not trust Success after reverting a system update for user 10 with --keep-data", async () => {
    const userId = 10;
    const systemDump = (dump: Response): Response => ({
      stdout: (dump.stdout ?? "")
        .replace("flags=[ HAS_CODE ]", "flags=[ SYSTEM HAS_CODE ]")
        .replace("User 0:", `User ${userId}:`),
    });
    const { toon, data } = await both(
      () =>
        world({
          userId,
          start: "current",
          dumps: { current: systemDump(V57), factory: systemDump(V56) },
          rules: [
            {
              match: shell(`pm uninstall -k ${PKG}`),
              respond: { stdout: "Success\n" },
              set: { pkg: "factory" },
            },
          ],
        }),
      ["app", "uninstall", PKG, "--keep-data"],
    );
    expect(toon.exitCode).toBe(1);
    expect(data).toMatchObject({
      code: "UNINSTALL_FAILED",
      reason: "the package manager reported success",
    });
    expect(data.help).toContainEqual(expect.stringContaining("for all users"));
  });

  it("succeeds when pm complains but the package is gone afterwards", async () => {
    const { toon, data } = await both(
      () =>
        world({
          start: "current",
          dumps: { current: V57, absent: ABSENT },
          rules: [
            uninstalls(
              `pm uninstall ${PKG}`,
              { stdout: "Failure [DELETE_FAILED_INTERNAL_ERROR]\n", exit: 1 },
              "absent",
            ),
          ],
        }),
      ["app", "uninstall", PKG],
    );
    expect(toon.exitCode).toBe(0);
    expect(data.ok).toBe("uninstall com.example.notes -> removed");
  });

  it("rejects a package name that is not one, before touching the device", async () => {
    const { toon, data, fake } = await both(
      () => world({ start: "current", dumps: { current: V57 } }),
      ["app", "uninstall", "not a package; rm -rf /"],
    );
    expect(toon.exitCode).toBe(2);
    expect(data).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(calls(fake)).toEqual([]);
  });
});
