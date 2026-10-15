import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { sharedWithToon } from "../helpers/json.js";
import { Axi, DEBUG_APK, PKG, RELEASE_APK, variantApk } from "./support.js";

const axi = new Axi(import.meta.filename);

beforeEach(absent);

let scratch: string | undefined;
afterEach(() => {
  if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});

function scratchFile(name: string, content: string): string {
  scratch ??= mkdtempSync(join(tmpdir(), "adb-axi-device-apk-"));
  const path = join(scratch, name);
  writeFileSync(path, content);
  return path;
}

async function absent(): Promise<void> {
  await axi.adb(["uninstall", PKG]);
  expect(await axi.sh(`pm path ${PKG} || true`)).toBe("");
}

/** versionCode and DEBUGGABLE as the package manager reports them. */
async function packageFacts(): Promise<{ versionCode: number; debuggable: boolean }> {
  const dump = await axi.sh(`dumpsys package ${PKG} | grep -E 'versionCode=|pkgFlags=' || true`);
  const code = /versionCode=(\d+)/.exec(dump)?.[1];
  expect(code, dump).toBeDefined();
  return { versionCode: Number(code), debuggable: /pkgFlags=\[[^\]]*DEBUGGABLE/.test(dump) };
}

async function installedApkDigest(): Promise<string> {
  const path = /^package:(\S+)$/m.exec(await axi.sh(`pm path ${PKG}`))?.[1];
  expect(path).toBeDefined();
  return (await axi.sh(`sha256sum ${path ?? ""}`)).split(/\s/)[0] ?? "";
}

function digestOf(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** A Room row the probe wrote, read from the app's own WAL bytes rather than through adb-axi. */
async function seedRow(): Promise<void> {
  await absent();
  await axi.ok(["app", "install", DEBUG_APK, "--clean-data"]);
  await axi.mark("row");
  await axi.ok(["app", "start", PKG, "--fresh"]);
  await axi.probe("write");
  await axi.waitLog("event=write .* rows=1 ", "row");
  expect(await rowFiles()).toBe("databases/probe.db-wal");
}

async function rowFiles(): Promise<string> {
  return (await axi.sh(`run-as ${PKG} grep -l probe-1 databases/probe.db-wal || true`)).trim();
}

function packages(record: string): Record<string, unknown> {
  return (JSON.parse(readFileSync(record, "utf8")) as { packages: Record<string, unknown> })
    .packages;
}

function uninstallHelp(): string {
  return `Run \`adb-axi app uninstall ${PKG} --device ${axi.serial}\` and install again (uninstalling deletes the app's data)`;
}

describe("app install against the real package manager", () => {
  test("an upgrade keeps the app's data and waits for the new versionCode; a downgrade is refused with both versions", async () => {
    for (const format of ["json", "toon"] as const) {
      await seedRow();
      const args = ["app", "install", variantApk("v2")];
      const upgrade =
        format === "json" ? sharedWithToon(await axi.ok(args)) : (await axi.text(args)).data;
      expect(upgrade.ok).toBe(`install ${PKG} -> 2.0 (2) with data kept`);
      expect(upgrade.install).toMatchObject({ previous: "1.0 (1)", debuggable: true });
      expect(await packageFacts()).toEqual({ versionCode: 2, debuggable: true });
      expect(await rowFiles()).toBe("databases/probe.db-wal");

      const downgrade = await axi.fails(
        ["app", "install", DEBUG_APK],
        "INSTALL_FAILED_VERSION_DOWNGRADE",
      );
      const { detail, ...refusal } = downgrade;
      expect(detail === undefined || typeof detail === "string").toBe(true);
      expect(refusal).toEqual({
        error: `${PKG} was not installed because its versionCode is lower than the installed version's`,
        code: "INSTALL_FAILED_VERSION_DOWNGRADE",
        package: PKG,
        installed: "2.0 (2)",
        apk_version: "1.0 (1)",
        help: [
          "Build the APK with a higher versionCode than the installed one",
          `Run \`adb-axi app uninstall ${PKG} --device ${axi.serial}\` and install again to go back to the older version (uninstalling deletes the app's data)`,
        ],
      });
      expect(await packageFacts()).toEqual({ versionCode: 2, debuggable: true });
      expect(await rowFiles()).toBe("databases/probe.db-wal");
    }
  });

  test("a same-version swap between the debug and release builds names the debuggable change", async () => {
    await axi.ok(["app", "install", DEBUG_APK, "--clean-data"]);
    const release = sharedWithToon(await axi.ok(["app", "install", RELEASE_APK]));
    expect(release).toMatchObject({
      ok: `install ${PKG} -> 1.0 (1) with data kept`,
      install: { previous: "1.0 (1)", debuggable: false, changed: ["debuggable: true -> false"] },
    });
    expect(await packageFacts()).toEqual({ versionCode: 1, debuggable: false });
    const debug = (await axi.text(["app", "install", DEBUG_APK])).data;
    expect(debug).toMatchObject({
      ok: `install ${PKG} -> 1.0 (1) with data kept`,
      install: { previous: "1.0 (1)", debuggable: true, changed: ["debuggable: false -> true"] },
    });
    expect(await packageFacts()).toEqual({ versionCode: 1, debuggable: true });
  });

  test("if-changed trusts the installed APK over its own record, and the record follows installs and uninstalls", async () => {
    await absent();
    await axi.ok(["app", "install", DEBUG_APK]);
    await axi.adb(["uninstall", PKG]);
    expect((await axi.adb(["install", "-r", variantApk("othersigner")])).exitCode).toBe(0);
    expect(await installedApkDigest()).toBe(digestOf(variantApk("othersigner")));

    const refused = await axi.fails(
      ["app", "install", DEBUG_APK, "--if-changed"],
      "INSTALL_FAILED_UPDATE_INCOMPATIBLE",
    );
    expect(refused).toMatchObject({
      error: `${PKG} was not installed because it is signed with a different key than the installed app`,
      package: PKG,
      help: [
        uninstallHelp(),
        "Or build the APK with the signing key the installed app was installed with",
      ],
    });
    expect(await installedApkDigest()).toBe(digestOf(variantApk("othersigner")));

    // The record still names the debug signer, from adb-axi's own last install.
    await axi.adb(["uninstall", PKG]);
    const other = sharedWithToon(await axi.ok(["app", "install", variantApk("othersigner")]));
    expect(other).toMatchObject({
      ok: `install ${PKG} -> 1.0 (1) (fresh install)`,
      install: {
        previous: "not installed",
        changed: ["signed differently from the last adb-axi install"],
      },
    });
    // An adb-axi uninstall forgets the record, so the next signer is no change.
    expect((await axi.ok(["app", "uninstall", PKG])).ok).toBe(`uninstall ${PKG} -> removed`);
    const fresh = sharedWithToon(await axi.ok(["app", "install", DEBUG_APK]));
    expect(fresh.install).not.toHaveProperty("changed");
    expect(await installedApkDigest()).toBe(digestOf(DEBUG_APK));
  });

  test("a file that is not an APK is the package manager's INSTALL_FAILED_INVALID_APK, and clean-data refuses it before any wipe", async () => {
    await seedRow();
    const pids = await axi.pidsOf(PKG);
    expect(pids).toHaveLength(1);
    const corrupt = scratchFile("corrupt.apk", "not an apk");

    const parsed = await axi.fails(
      ["app", "install", corrupt, "--if-changed"],
      "INSTALL_FAILED_INVALID_APK",
      {
        varies: ["detail"],
      },
    );
    expect(parsed).toMatchObject({
      error: "corrupt.apk was not installed because the package manager cannot read the APK",
      apk: "corrupt.apk",
      pm_code: expect.stringMatching(/^INSTALL_PARSE_FAILED_/) as string,
      help: ["Rebuild the APK then run the same command again"],
    });

    const wipe = await axi.fails(
      ["app", "install", corrupt, "--clean-data"],
      "INSTALL_FAILED_INVALID_APK",
    );
    expect(wipe).toMatchObject({
      error:
        "corrupt.apk was not installed because adb-axi cannot read it to know which package to wipe",
      apk: "corrupt.apk",
      detail: expect.any(String) as string,
      help: ["Rebuild the APK and run the same command again"],
    });
    expect(await packageFacts()).toEqual({ versionCode: 1, debuggable: true });
    expect(await rowFiles()).toBe("databases/probe.db-wal");
    expect(await axi.pidsOf(PKG)).toEqual(pids);
  });

  test("the package manager's requirement refusals come back typed, and nothing is installed", async () => {
    const sdk = Number((await axi.sh("getprop ro.build.version.sdk")).trim());
    const abis = (await axi.sh("getprop ro.product.cpu.abilist")).trim().split(",");
    const cases: { variant: string; code: string | null; reason: string; help: string[] }[] = [
      {
        variant: "flaggedtest",
        code: "INSTALL_FAILED_TEST_ONLY",
        reason: "the APK is marked test-only",
        help: ["Build an APK that is not test-only (for example with `./gradlew assembleDebug`)"],
      },
      {
        variant: "needslib",
        code: "INSTALL_FAILED_MISSING_SHARED_LIBRARY",
        reason: "the APK needs a shared library the device does not have",
        help: ["Remove the library from the manifest or use a device image that includes it"],
      },
      {
        variant: "riscvonly",
        code: abis.includes("riscv64") ? null : "INSTALL_FAILED_NO_MATCHING_ABIS",
        reason: "the APK has no native code for this device's CPU",
        help: ["Build the APK for the device's ABI or use a device with a matching CPU"],
      },
      {
        variant: "minsdk36",
        code: sdk < 36 ? "INSTALL_FAILED_OLDER_SDK" : null,
        reason: "the APK needs a newer Android version than the device runs",
        help: ["Lower the APK's minSdk or install it on a device with a newer Android version"],
      },
    ];
    for (const { variant, code, reason, help } of cases) {
      await absent();
      if (code === null) {
        expect((await axi.ok(["app", "install", variantApk(variant)])).ok).toBe(
          `install ${PKG} -> 1.0 (1) (fresh install)`,
        );
        continue;
      }
      const refused = await axi.fails(["app", "install", variantApk(variant)], code, {
        varies: ["detail"],
      });
      expect(refused).toEqual({
        error: `${PKG} was not installed because ${reason}`,
        code,
        package: PKG,
        detail: expect.any(String) as string,
        help,
      });
      expect(await axi.sh(`pm path ${PKG} || true`)).toBe("");
    }
  });

  test("a broken install record is ignored, and an unwritable state directory only warns", async () => {
    await absent();
    const home = axi.stateHome;
    await axi.ok(["app", "install", DEBUG_APK]);
    const [device] = readdirSync(home);
    expect(device).toBeDefined();
    const deviceDir = join(home, device ?? "");
    const record = join(deviceDir, "last-install.json");
    expect(packages(record)).toHaveProperty([PKG]);
    await absent();
    writeFileSync(record, "{ not json");
    const installed = sharedWithToon(await axi.ok(["app", "install", DEBUG_APK, "--if-changed"]));
    expect(installed.ok).toBe(`install ${PKG} -> 1.0 (1) (fresh install)`);
    expect(installed.install).not.toHaveProperty("warning");
    expect(packages(record)[PKG]).toMatchObject({
      versionCode: 1,
      versionName: "1.0",
      signers: [expect.stringMatching(/^[0-9a-f]{64}$/)],
    });

    mkdirSync(deviceDir, { recursive: true });
    chmodSync(deviceDir, 0o555);
    try {
      const reinstall = sharedWithToon(await axi.ok(["app", "install", DEBUG_APK]));
      expect(reinstall.ok).toBe(`install ${PKG} -> 1.0 (1) with data kept`);
      expect((reinstall.install as Record<string, unknown>).warning).toMatch(
        /^the install was not recorded \(/,
      );
      const removed = sharedWithToon(await axi.ok(["app", "uninstall", PKG]));
      expect(removed.ok).toBe(`uninstall ${PKG} -> removed`);
      expect(removed.warning).toMatch(/^the install record could not be removed \(/);
      expect(await axi.sh(`pm path ${PKG} || true`)).toBe("");
    } finally {
      chmodSync(deviceDir, 0o755);
    }
  });
});
