import {
  chmodSync,
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
import { createFakeAdb, FIXTURES_DIR, type FakeAdb } from "../fake-adb/harness.js";
import type { Response, Rule } from "../fake-adb/scenario.js";
import { buildApk, digestOf, withZip64End } from "../helpers/apk-builder.js";
import { runCli, type CliRun } from "../helpers/run.js";

const SERIAL = "emulator-5554";
const PKG = "com.example.notes";
const ONE_ONLINE = `List of devices attached\n${SERIAL}          device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:1\n\n`;
const DUMPSYS = `dumpsys package ${PKG}`;
const SDK = "getprop ro.build.version.sdk";
const APK_PATH = `pm path ${PKG}`;
const CAT_APK = "cat /data/app/notes/base.apk";
const INSTALL_OK = { stdout: "Performing Streamed Install\nSuccess\n" };
const CERT_A = Buffer.from("certificate A");
const CERT_B = Buffer.from("certificate B");
const DEBUG_KEY_SHA256 = "201dd47659cf511c7f2d5278e906d349ba0ed8cb2ce8ddb55caa10fb300133f2";

let apkDir: string;
let APK: string; // 1.4.0 (57), signed by A
let APK_OTHER_KEY: string; // 1.4.0 (57), signed by B
let APK_V1_ONLY: string; // 1.4.0 (57), no v2 or v3 signature
let APK_OLDER: string; // 1.3.0 (50)
let APK_CORRUPT: string;
let APK_ROTATED: string;
let APK_V31: string;
let APK_ZIP64: string;
let APK_OVERSIZED: string;
let PROBE_APK: string;

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
  APK_ROTATED = write(
    "rotated.apk",
    buildApk({ ...notes, signers: { v2: [CERT_A], v3: [CERT_B] } }),
  );
  APK_V31 = write(
    "v31.apk",
    buildApk({ ...notes, signers: { v2: [CERT_A], v3: [CERT_A], v3_1: [CERT_B] } }),
  );
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
  PROBE_APK = join(FIXTURES_DIR, "apk", "probe-debug.apk");
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
const KEPT: Response = {
  stdout: V57.stdout?.replace("installed=true", "installed=false") ?? "",
};

const shell = (command: string): string[] => ["-s", SERIAL, "shell", command];

interface World {
  /** What `dumpsys package` says in each state of the package, and the state to start in. */
  dumps: Record<string, Response>;
  start: string;
  rules?: Rule[];
  api?: Response;
  installedApk?: string | Response;
}

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
      { match: shell(SDK), respond: options.api ?? { stdout: "35\n" } },
      { match: shell(APK_PATH), respond: { stdout: "package:/data/app/notes/base.apk\n" } },
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
  const data = JSON.parse(json.stdout) as Record<string, unknown>;
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
  it("installs over an older version, keeps data, and waits for the new versionCode", async () => {
    const { toon, data, fake } = await both(
      () => world({ start: "old", dumps: { old: V56, new: V57 }, rules: [installs(APK)] }),
      ["app", "install", APK],
    );
    expect(toon.exitCode).toBe(0);
    expect(toonLines(toon)).toEqual([
      "ok: install com.example.notes -> 1.4.0 (57) with data kept",
      "install:",
      "  previous: 1.4.0 (56)",
      "  took_ms: <n>",
    ]);
    expect(data).toMatchObject({
      ok: "install com.example.notes -> 1.4.0 (57) with data kept",
      install: { previous: "1.4.0 (56)" },
    });
    // `-r` keeps the data; the device is read before the install and after it.
    expect(calls(fake)).toEqual([
      `shell ${SDK}`,
      `shell ${DUMPSYS}`,
      `install -r ${APK}`,
      `shell ${DUMPSYS}`,
    ]);
    expectClean(fake);
    expect(toon.stderr).toBe("");
  });

  it("installs a package the device does not have, with no previous version", async () => {
    const { toon, data } = await both(
      () => world({ start: "absent", dumps: { absent: ABSENT, new: V57 }, rules: [installs(APK)] }),
      ["app", "install", APK],
    );
    expect(toon.exitCode).toBe(0);
    expect(data).toMatchObject({ install: { previous: "not installed" } });
  });

  it("treats a package kept after `uninstall -k` as not installed", async () => {
    const { data } = await both(
      () => world({ start: "kept", dumps: { kept: KEPT, new: V57 }, rules: [installs(APK)] }),
      ["app", "install", APK],
    );
    expect(data).toMatchObject({ install: { previous: "not installed" } });
  });

  it("records the installed versionCode and signer digest per serial", async () => {
    const { fake } = await both(
      () => world({ start: "old", dumps: { old: V56, new: V57 }, rules: [installs(APK)] }),
      ["app", "install", APK],
    );
    const record = recordFile(fake) as { packages: Record<string, Record<string, unknown>> };
    expect(record.packages[PKG]).toMatchObject({
      versionCode: 57,
      versionName: "1.4.0",
      signers: [digestOf(CERT_A)],
    });
    expect(typeof record.packages[PKG]?.installedAt).toBe("string");
  });

  it("installs the committed probe APK as its own package, read from the APK", async () => {
    const make = (): FakeAdb => {
      const fake = createFakeAdb({
        synthetic: true,
        state: { pkg: "absent" },
        rules: [
          { match: ["devices", "-l"], respond: { stdout: ONE_ONLINE } },
          { match: shell(SDK), respond: { stdout: "35\n" } },
          {
            match: shell("dumpsys package dev.probe"),
            when: { pkg: "absent" },
            respond: { stdoutFile: "captured/35/dumpsys-package-absent.txt" },
          },
          {
            match: shell("dumpsys package dev.probe"),
            when: { pkg: "new" },
            respond: { stdoutFile: "captured/35/dumpsys-package-debug.txt" },
          },
          {
            match: ["-s", SERIAL, "install", "-r", PROBE_APK],
            respond: { stdoutFile: "captured/35/install-debug.txt" },
            set: { pkg: "new" },
          },
        ],
      });
      fakes.push(fake);
      return fake;
    };
    const { toon, data, fake } = await both(make, ["app", "install", PROBE_APK]);
    expect(toon.exitCode).toBe(0);
    expect(data).toMatchObject({
      ok: "install dev.probe -> 1.0 (1) with data kept",
      install: { previous: "not installed" },
    });
    expect(recordFile(fake)).toMatchObject({
      packages: { "dev.probe": { versionCode: 1, signers: [DEBUG_KEY_SHA256] } },
    });
  });

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

    it("is the already-installed no-op when versionCode and signature match", async () => {
      const { toon, data, fake } = await both(withRecord(sameInstall()), [
        "app",
        "install",
        APK,
        "--if-changed",
      ]);
      expect(toon.exitCode).toBe(0);
      expect(toonLines(toon)).toEqual([
        "ok: install com.example.notes -> already installed (same versionCode and signature)",
      ]);
      expect(data).toEqual({
        ok: "install com.example.notes -> already installed (same versionCode and signature)",
      });
      expect(calls(fake)).toEqual([
        `shell ${SDK}`,
        `shell ${DUMPSYS}`,
        `shell ${APK_PATH}`,
        `exec-out ${CAT_APK}`,
      ]);
      expectClean(fake);
    });

    it("does not trust a historical record after an external same-version replacement", async () => {
      const { toon, data, fake } = await both(() => {
        const fake = world({
          start: "current",
          dumps: { current: V57 },
          installedApk: APK_OTHER_KEY,
          rules: [
            installs(
              APK,
              { stdout: "Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE]\n", exit: 1 },
              "current",
            ),
          ],
        });
        seedRecord(fake, sameInstall());
        return fake;
      }, ["app", "install", APK, "--if-changed"]);
      expect(toon.exitCode).toBe(1);
      expect(data.code).toBe("INSTALL_FAILED_UPDATE_INCOMPATIBLE");
      expect(calls(fake)).toContain(`install -r ${APK}`);
      expectClean(fake);
    });

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

    it("can prove the no-op without any historical record", async () => {
      const { toon, fake } = await both(
        () =>
          world({
            start: "current",
            dumps: { current: V57 },
            installedApk: APK,
          }),
        ["app", "install", APK, "--if-changed"],
      );
      expect(toon.exitCode).toBe(0);
      expect(toon.stdout).toContain("already installed");
      expect(recordFile(fake)).toBeUndefined();
      expectClean(fake);
    });

    it.each([
      ["v2 on API 27", "27\n", () => APK_ROTATED, () => APK, true],
      ["v3 on API 28", "28\n", () => APK_ROTATED, () => APK_ROTATED, true],
      ["different current v3 signer", "28\n", () => APK_ROTATED, () => APK, false],
      ["v3.1 unsupported on API 35", "35\n", () => APK_V31, () => APK_V31, false],
      ["v3.1 ignored on API 32", "32\n", () => APK_V31, () => APK, true],
      ["v2 unsupported on API 23", "23\n", () => APK, () => APK, false],
      ["unknown API", "unknown\n", () => APK, () => APK, false],
      ["installed v1 signature", "35\n", () => APK, () => APK_V1_ONLY, false],
      ["installed unsupported v3.1", "35\n", () => APK, () => APK_V31, false],
      ["unreadable installed APK", "35\n", () => APK, () => APK_CORRUPT, false],
      ["installed metadata mismatch", "35\n", () => APK, () => APK_OLDER, false],
    ] as const)(
      "uses current target-device evidence: %s",
      async (_label, sdk, apkFile, installedFile, noop) => {
        const apk = apkFile();
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
        if (noop) {
          expect(data.ok).toContain("already installed");
          expect(calls(fake)).not.toContain(`install -r ${apk}`);
        } else {
          expect(data.install).toHaveProperty(
            "shortcut",
            expect.stringContaining("skipped because"),
          );
          expect(calls(fake)).toContain(`install -r ${apk}`);
        }
        expectClean(fake);
      },
    );

    it.each([
      ["pm path failure", { stderr: "Permission denied\n", exit: 1 }, false],
      ["malformed path", { stdout: "not a package path\n" }, false],
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
            rules: [{ match: shell(APK_PATH), respond: response }, installs(APK)],
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

    it("uses the device-applicable signer in the install record", async () => {
      const { toon, fake } = await both(
        () =>
          world({
            start: "old",
            dumps: { old: V56, new: V57 },
            api: { stdout: "27\n" },
            rules: [installs(APK_ROTATED)],
          }),
        ["app", "install", APK_ROTATED],
      );
      expect(toon.exitCode).toBe(0);
      expect(recordFile(fake)).toMatchObject({
        packages: { [PKG]: { signers: [digestOf(CERT_A)] } },
      });
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
      expect(calls(fake)).toEqual([`install -r ${APK_ZIP64}`]);
      expectClean(fake);
    });

    it("installs when the device has a different versionCode", async () => {
      const { toon, fake } = await both(() => {
        const f = world({ start: "old", dumps: { old: V56, new: V57 }, rules: [installs(APK)] });
        seedRecord(f, sameInstall());
        return f;
      }, ["app", "install", APK, "--if-changed"]);
      expect(toonLines(toon)).toEqual([
        "ok: install com.example.notes -> 1.4.0 (57) with data kept",
        "install:",
        "  previous: 1.4.0 (56)",
        "  took_ms: <n>",
      ]);
      expect(calls(fake)).toContain(`install -r ${APK}`);
    });

    it("installs when the package is not on the device", async () => {
      const { data } = await both(
        () =>
          world({ start: "absent", dumps: { absent: ABSENT, new: V57 }, rules: [installs(APK)] }),
        ["app", "install", APK, "--if-changed"],
      );
      expect(data).toMatchObject({ install: { previous: "not installed" } });
      expect(data.install).not.toHaveProperty("shortcut");
    });

    it("installs and says the shortcut was skipped when the APK is signed differently", async () => {
      const { toon, data, fake } = await both(
        withRecord(sameInstall(), [installs(APK_OTHER_KEY)]),
        ["app", "install", APK_OTHER_KEY, "--if-changed"],
      );
      expect(toon.exitCode).toBe(0);
      expect(data).toMatchObject({
        install: {
          shortcut: "skipped because the APK is signed differently from the installed app",
        },
      });
      expect(calls(fake)).toContain(`install -r ${APK_OTHER_KEY}`);
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

    it("ignores a last-install.json that is not valid", async () => {
      const make = (): FakeAdb => {
        const fake = world({
          start: "current",
          dumps: { current: V57, new: V57 },
          rules: [installs(APK)],
        });
        mkdirSync(join(fake.home, SERIAL), { recursive: true });
        writeFileSync(join(fake.home, SERIAL, "last-install.json"), "{ not json");
        return fake;
      };
      const { toon, fake } = await both(make, ["app", "install", APK, "--if-changed"]);
      expect(toon.exitCode).toBe(0);
      // The install ran, and recorded itself over the unreadable file.
      expect(recordFile(fake)).toMatchObject({ packages: { [PKG]: { versionCode: 57 } } });
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

    it("installs a corrupt APK anyway and says the shortcut was skipped", async () => {
      const { toon, data, fake } = await both(
        () =>
          world({
            start: "current",
            dumps: { current: V57 },
            rules: [installs(APK_CORRUPT, INSTALL_OK, "current")],
          }),
        ["app", "install", APK_CORRUPT, "--if-changed"],
      );
      expect(toon.exitCode).toBe(0);
      expect(data.ok).toBe("install corrupt.apk -> installed, version not verified");
      expect(data.install).toMatchObject({
        shortcut: expect.stringMatching(
          /^skipped because the APK metadata cannot be read \(.*zip/,
        ) as string,
        note: expect.stringContaining("did not check which version is live") as string,
        detail: expect.stringContaining("zip") as string,
      });
      expect(calls(fake)).toEqual([`install -r ${APK_CORRUPT}`]);
      expectClean(fake);
    });
  });

  it("installs an APK it cannot read when the package manager accepts it, without --if-changed", async () => {
    const { toon, data } = await both(
      () => world({ start: "absent", dumps: { absent: ABSENT }, rules: [installs(APK_CORRUPT)] }),
      ["app", "install", APK_CORRUPT],
    );
    expect(toon.exitCode).toBe(0);
    expect(data.ok).toBe("install corrupt.apk -> installed, version not verified");
    expect(data.install).not.toHaveProperty("shortcut");
  });

  describe("with --clean-data", () => {
    const make = (): FakeAdb =>
      world({
        start: "old",
        dumps: { old: V56, new: V57 },
        rules: [
          installs(APK),
          { match: shell(`pm clear ${PKG}`), respond: { stdout: "Success\n" } },
        ],
      });

    it("installs with -r, clears the data, then verifies the version", async () => {
      const { toon, data, fake } = await both(make, ["app", "install", APK, "--clean-data"]);
      expect(toon.exitCode).toBe(0);
      expect(data.ok).toBe("install com.example.notes -> 1.4.0 (57) with data wiped");
      expect(calls(fake)).toEqual([
        `shell ${SDK}`,
        `shell ${DUMPSYS}`,
        `install -r ${APK}`,
        `shell ${DUMPSYS}`,
        `shell pm clear ${PKG}`,
        `shell ${DUMPSYS}`,
      ]);
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
              { match: shell(`pm clear ${PKG}`), respond: { stdout: "Failed\n" } },
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
              { match: shell(`pm clear ${PKG}`), respond: { stderr: "boom\n", exit: 1 } },
            ],
          }),
        ["app", "install", APK, "--clean-data"],
      );
      expect(toon.exitCode).toBe(1);
      expect(data).toMatchObject({ code: "REMOTE_EXIT", exit: 1 });
    });

    it.each([["--clean-data"], ["--clean-data", "--if-changed"]])(
      "refuses an unreadable APK before a wipe: %s",
      async (...flags) => {
        const { toon, data, fake } = await both(
          () => world({ start: "old", dumps: { old: V56 }, rules: [] }),
          ["app", "install", APK_CORRUPT, ...flags],
        );
        expect(toon.exitCode).toBe(1);
        expect(data).toMatchObject({
          code: "INSTALL_FAILED_INVALID_APK",
          apk: "corrupt.apk",
          help: [expect.stringContaining("Rebuild the APK")],
        });
        expect(calls(fake)).toEqual([]);
      },
    );

    it("takes precedence over --if-changed even when the same version and signer are installed", async () => {
      const { toon, data, fake } = await both(
        () =>
          world({
            start: "new",
            dumps: { new: V57 },
            installedApk: APK,
            rules: [
              installs(APK),
              { match: shell(`pm clear ${PKG}`), respond: { stdout: "Success\n" } },
            ],
          }),
        ["app", "install", APK, "--clean-data", "--if-changed"],
      );
      expect(toon.exitCode).toBe(0);
      expect(data.ok).toBe("install com.example.notes -> 1.4.0 (57) with data wiped");
      expect(data.install).not.toHaveProperty("shortcut");
      expect(calls(fake)).toEqual([
        `shell ${SDK}`,
        `shell ${DUMPSYS}`,
        `install -r ${APK}`,
        `shell ${DUMPSYS}`,
        `shell pm clear ${PKG}`,
        `shell ${DUMPSYS}`,
      ]);
      expectClean(fake);
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

    it.each([
      ["UPDATE_INCOMPATIBLE", "signing key"],
      ["INSUFFICIENT_STORAGE", "Free space"],
      ["VERSION_DOWNGRADE", "higher versionCode"],
      ["INVALID_APK", "Rebuild"],
      ["ALREADY_EXISTS", "Run the same command"],
      ["DUPLICATE_PACKAGE", "Wait for the other install"],
      ["OLDER_SDK", "minSdk"],
      ["NEWER_SDK", "maxSdk"],
      ["CPU_ABI_INCOMPATIBLE", "ABI"],
      ["NO_MATCHING_ABIS", "ABI"],
      ["MISSING_SHARED_LIBRARY", "library"],
      ["MISSING_FEATURE", "feature"],
      ["TEST_ONLY", "not test-only"],
      ["CONFLICTING_PROVIDER", "authority"],
      ["DUPLICATE_PERMISSION", "Rename the permission"],
      ["SHARED_USER_INCOMPATIBLE", "Sign the APK"],
      ["USER_RESTRICTED", "Allow installs over USB"],
      ["VERIFICATION_FAILURE", "Turn off app verification"],
      ["VERIFICATION_TIMEOUT", "Run the same command"],
      ["ABORTED", "Run the same command"],
      ["INTERNAL_ERROR", "Run the same command"],
      ["DEXOPT", "Rebuild"],
      ["MISSING_SPLIT", "full APK"],
    ])("exposes INSTALL_FAILED_%s with actionable help and format parity", async (suffix, fix) => {
      const code = `INSTALL_FAILED_${suffix}`;
      const { toon, data, fake } = await both(
        refuse(`Failure [${code}: refused by package manager]`),
        ["app", "install", APK],
      );
      expect(toon.exitCode).toBe(1);
      expect(data).toMatchObject({ code, package: PKG, detail: "refused by package manager" });
      expect(data.error).toEqual(expect.stringContaining("was not installed because"));
      expect(Array.isArray(data.help)).toBe(true);
      expect((data.help as string[]).some((help) => help.includes(fix))).toBe(true);
      expect(recordFile(fake)).toBeUndefined();
      expectClean(fake);
    });

    it("maps INSTALL_FAILED_UPDATE_INCOMPATIBLE and warns that uninstalling loses data", async () => {
      const { toon, data, fake } = await both(
        refuse(
          `Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: Package ${PKG} signatures do not match previously installed version; ignoring!]`,
          APK_OTHER_KEY,
        ),
        ["app", "install", APK_OTHER_KEY],
      );
      expect(toon.exitCode).toBe(1);
      expect(toonLines(toon).slice(0, 2)).toEqual([
        "error: com.example.notes was not installed because it is signed with a different key than the installed app",
        "code: INSTALL_FAILED_UPDATE_INCOMPATIBLE",
      ]);
      expect(data).toMatchObject({
        package: PKG,
        detail: `Package ${PKG} signatures do not match previously installed version; ignoring!`,
        help: [
          expect.stringContaining(`Run \`adb-axi app uninstall ${PKG}\``) as string,
          expect.stringContaining("signing key") as string,
        ],
      });
      expect(JSON.stringify(data.help)).toContain("deletes the app's data");
      // The installed version is not touched, so nothing is recorded.
      expect(recordFile(fake)).toBeUndefined();
    });

    it("maps INSTALL_FAILED_INSUFFICIENT_STORAGE, and does not point at doctor before it ships", async () => {
      const { toon, data } = await both(refuse("Failure [INSTALL_FAILED_INSUFFICIENT_STORAGE]"), [
        "app",
        "install",
        APK,
      ]);
      expect(toon.exitCode).toBe(1);
      expect(data).toMatchObject({ code: "INSTALL_FAILED_INSUFFICIENT_STORAGE", package: PKG });
      expect(JSON.stringify(data.help)).toContain("Free space");
      expect(JSON.stringify(data.help)).not.toContain("doctor");
    });

    it("maps INSTALL_FAILED_VERSION_DOWNGRADE with the installed and APK versions", async () => {
      const { toon, data } = await both(
        refuse(
          `Failure [INSTALL_FAILED_VERSION_DOWNGRADE: Downgrade detected: Update version code 50 is older than current 56]`,
          APK_OLDER,
        ),
        ["app", "install", APK_OLDER],
      );
      expect(toon.exitCode).toBe(1);
      expect(data).toMatchObject({
        code: "INSTALL_FAILED_VERSION_DOWNGRADE",
        installed: "1.4.0 (56)",
        apk_version: "1.3.0 (50)",
        help: [
          expect.stringContaining("higher versionCode") as string,
          expect.stringContaining(`app uninstall ${PKG}`) as string,
        ],
      });
    });

    it("maps a parse failure to INSTALL_FAILED_INVALID_APK and keeps the original code", async () => {
      const { toon, data } = await both(
        refuse(
          "Failure [INSTALL_PARSE_FAILED_NOT_APK: Scanning Failed.: Package not an APK]",
          APK_CORRUPT,
          "old",
        ),
        ["app", "install", APK_CORRUPT],
      );
      expect(toon.exitCode).toBe(1);
      expect(data).toMatchObject({
        code: "INSTALL_FAILED_INVALID_APK",
        apk: "corrupt.apk",
        pm_code: "INSTALL_PARSE_FAILED_NOT_APK",
      });
    });

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
        error: "com.example.notes did not report versionCode 57 within 4s",
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

  it("is shipped: help lists it and its flags", async () => {
    const fake = world({ start: "old", dumps: { old: V56 } });
    const run = await runCli(["app", "install", "--help"], fake.env);
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("--clean-data");
    expect(run.stdout).toContain("--if-changed");
    expect(run.stdout).toContain("180s");
  });
});

describe("app uninstall", () => {
  const uninstalls = (command: string, respond: Response, to = "absent"): Rule => ({
    match: shell(command),
    respond,
    set: { pkg: to },
  });

  it("removes an installed package and checks that it is gone", async () => {
    const { toon, data, fake } = await both(
      () =>
        world({
          start: "current",
          dumps: { current: V57, absent: ABSENT },
          rules: [uninstalls(`pm uninstall ${PKG}`, { stdout: "Success\n" })],
        }),
      ["app", "uninstall", PKG],
    );
    expect(toon.exitCode).toBe(0);
    expect(toonLines(toon)).toEqual(["ok: uninstall com.example.notes -> removed"]);
    expect(data).toEqual({ ok: "uninstall com.example.notes -> removed" });
    expect(calls(fake)).toEqual([
      `shell ${DUMPSYS}`,
      `shell pm uninstall ${PKG}`,
      `shell ${DUMPSYS}`,
    ]);
    expectClean(fake);
  });

  it("is the already-not-installed no-op, exit 0, when the package is not there", async () => {
    const { toon, data, fake } = await both(
      () => world({ start: "absent", dumps: { absent: ABSENT }, rules: [] }),
      ["app", "uninstall", PKG],
    );
    expect(toon.exitCode).toBe(0);
    expect(toonLines(toon)).toEqual([
      "ok: uninstall com.example.notes -> already not installed (no-op)",
    ]);
    expect(data).toEqual({ ok: "uninstall com.example.notes -> already not installed (no-op)" });
    // Raw adb would fail with DELETE_FAILED_INTERNAL_ERROR; uninstall is never even sent.
    expect(calls(fake)).toEqual([`shell ${DUMPSYS}`]);
  });

  it("is the same no-op for a package kept after `uninstall -k`", async () => {
    const { toon, data, fake } = await both(
      () => world({ start: "kept", dumps: { kept: KEPT }, rules: [] }),
      ["app", "uninstall", PKG],
    );
    expect(toon.exitCode).toBe(0);
    expect(data.ok).toBe("uninstall com.example.notes -> already not installed (no-op)");
    expect(calls(fake)).toEqual([`shell ${DUMPSYS}`]);
  });

  it("replays a real device: the missing-package failure never reaches the user", async () => {
    const fake = createFakeAdb("uninstall-missing.json");
    fakes.push(fake);
    const run = await runCli(["app", "uninstall", "dev.probe"], fake.env);
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe("ok: uninstall dev.probe -> already not installed (no-op)\n");
  });

  it("keeps the data with --keep-data (pm uninstall -k)", async () => {
    const { toon, data, fake } = await both(
      () =>
        world({
          start: "current",
          dumps: { current: V57, kept: KEPT },
          rules: [uninstalls(`pm uninstall -k ${PKG}`, { stdout: "Success\n" }, "kept")],
        }),
      ["app", "uninstall", PKG, "--keep-data"],
    );
    expect(toon.exitCode).toBe(0);
    expect(data.ok).toBe("uninstall com.example.notes -> removed with data kept");
    expect(calls(fake)).toContain(`shell pm uninstall -k ${PKG}`);
  });

  it("forgets the install record of a package it removes", async () => {
    const fake = world({
      start: "current",
      dumps: { current: V57, absent: ABSENT },
      rules: [uninstalls(`pm uninstall ${PKG}`, { stdout: "Success\n" })],
    });
    seedRecord(fake, {
      packages: {
        [PKG]: { versionCode: 57, versionName: "1.4.0", signers: null, installedAt: "x" },
        "com.example.other": { versionCode: 1, versionName: null, signers: null, installedAt: "x" },
      },
    });
    const run = await runCli(["app", "uninstall", PKG], fake.env);
    expect(run.exitCode).toBe(0);
    expect(Object.keys((recordFile(fake) as { packages: object }).packages)).toEqual([
      "com.example.other",
    ]);
  });

  it.each([
    ["absent", false, "already not installed (no-op)"],
    ["current", false, "removed"],
    ["current", true, "removed with data kept"],
  ])(
    "preserves success despite unwritable cache cleanup: %s keep=%s",
    async (start, keep, outcome) => {
      const fake = world({
        start: start as string,
        dumps: { current: V57, absent: ABSENT, kept: KEPT },
        rules: [
          uninstalls(
            `pm uninstall${keep ? " -k" : ""} ${PKG}`,
            { stdout: "Success\n" },
            keep ? "kept" : "absent",
          ),
        ],
      });
      seedRecord(fake, {
        packages: {
          [PKG]: { versionCode: 57, versionName: "1.4.0", signers: null, installedAt: "x" },
        },
      });
      const directory = join(fake.home, SERIAL);
      chmodSync(directory, 0o555);
      try {
        const run = await runCli(
          ["app", "uninstall", PKG, ...(keep ? ["--keep-data"] : []), "--json"],
          fake.env,
        );
        expect(run.exitCode).toBe(0);
        expect(JSON.parse(run.stdout)).toMatchObject({
          ok: `uninstall ${PKG} -> ${outcome}`,
          warning: expect.stringContaining("the install record could not be removed"),
        });
        expectClean(fake);
      } finally {
        chmodSync(directory, 0o755);
      }
    },
  );

  it("exits 1 with UNINSTALL_FAILED when the package is still installed afterwards", async () => {
    const { toon, data } = await both(
      () =>
        world({
          start: "current",
          dumps: { current: V57 },
          rules: [
            {
              match: shell(`pm uninstall ${PKG}`),
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

  it("does not trust a Success that leaves the package installed (a system app's update)", async () => {
    const { toon, data } = await both(
      () =>
        world({
          start: "current",
          dumps: { current: V57 },
          rules: [{ match: shell(`pm uninstall ${PKG}`), respond: { stdout: "Success\n" } }],
        }),
      ["app", "uninstall", PKG],
    );
    expect(toon.exitCode).toBe(1);
    expect(data).toMatchObject({
      code: "UNINSTALL_FAILED",
      reason: "the package manager reported success",
    });
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

  it("fails with TIMEOUT naming the step when the device hangs", async () => {
    const fake = world({
      start: "current",
      dumps: { current: V57 },
      rules: [{ match: shell(`pm uninstall ${PKG}`), respond: { hang: true } }],
    });
    const run = await runCli(["app", "uninstall", PKG, "--timeout", "2s"], fake.env);
    expect(run.exitCode).toBe(1);
    expect(run.stdout).toContain("code: TIMEOUT");
    expect(run.stdout).toContain(`uninstalling ${PKG}`);
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

  it("is shipped: help lists it and --keep-data", async () => {
    const fake = world({ start: "current", dumps: { current: V57 } });
    const run = await runCli(["app", "uninstall", "--help"], fake.env);
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("--keep-data");
  });
});
