import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ApkError, bufferSource, readApkFile, readApkInfo } from "../../src/apk/index.js";
import { FIXTURES_DIR } from "../fake-adb/harness.js";
import {
  buildApk,
  buildManifest,
  buildZip,
  digestOf,
  SCHEME_V2,
  SCHEME_V3,
  signerBlock,
  signingBlock,
} from "../helpers/apk-builder.js";

const DEBUG_APK = join(FIXTURES_DIR, "apk", "probe-debug.apk");
const RELEASE_APK = join(FIXTURES_DIR, "apk", "probe-release.apk");
/** `apksigner verify --print-certs` on both probe APKs: they share the debug key. */
const DEBUG_KEY_SHA256 = "201dd47659cf511c7f2d5278e906d349ba0ed8cb2ce8ddb55caa10fb300133f2";

const CERT_A = Buffer.from("certificate A");
const CERT_B = Buffer.from("certificate B");
const info = (bytes: Buffer) => readApkInfo(bufferSource(bytes));

describe("the committed probe APKs", () => {
  it.each([
    ["debug", DEBUG_APK],
    ["release", RELEASE_APK],
  ])("read the package, version and signer digest of the %s build", (_name, path) => {
    expect(readApkFile(path)).toEqual({
      package: "dev.probe",
      versionCode: 1,
      versionName: "1.0",
      signers: [DEBUG_KEY_SHA256],
      signerUnreadable: null,
    });
  });
});

describe("the binary manifest", () => {
  it("reads package, versionCode and versionName from a deflated manifest", () => {
    const apk = buildApk({
      package: "com.example.notes",
      versionCode: 57,
      versionName: "1.4.0",
      deflateManifest: true,
    });
    expect(info(apk)).toMatchObject({
      package: "com.example.notes",
      versionCode: 57,
      versionName: "1.4.0",
    });
  });

  it("reads a UTF-16 string pool and attributes known only by name", () => {
    const apk = buildApk({
      package: "com.example.notes",
      versionCode: 8,
      versionName: "2.0",
      utf16: true,
      withoutResourceMap: true,
    });
    expect(info(apk)).toMatchObject({ package: "com.example.notes", versionCode: 8 });
  });

  it("joins versionCodeMajor and versionCode into one long version code", () => {
    const apk = buildApk({ package: "a.b", versionCode: 5, versionCodeMajor: 2 });
    expect(info(apk).versionCode).toBe(2 * 2 ** 32 + 5);
  });

  it("treats a manifest without versionCode (an instrumentation APK) as version 0", () => {
    expect(info(buildApk({ package: "a.b.test" }))).toMatchObject({
      package: "a.b.test",
      versionCode: 0,
      versionName: null,
    });
  });

  it("has no versionName when it points at a resource", () => {
    const apk = buildApk({
      package: "a.b",
      versionCode: 1,
      versionName: { reference: 0x7f010000 },
    });
    expect(info(apk).versionName).toBeNull();
  });

  it("rejects a manifest whose root is not <manifest>", () => {
    expect(() =>
      info(buildApk({ package: "a.b", versionCode: 1, rootName: "application" })),
    ).toThrow(/not <manifest>/);
  });
});

describe("the signer digest", () => {
  it("is the SHA-256 of the v2 certificate", () => {
    const apk = buildApk({ package: "a.b", versionCode: 1, signers: { v2: [CERT_A] } });
    expect(info(apk)).toMatchObject({ signers: [digestOf(CERT_A)], signerUnreadable: null });
  });

  it("selects v2 or v3 for the target API and reports unsupported v3.1", () => {
    const both = buildApk({
      package: "a.b",
      versionCode: 1,
      signers: { v2: [CERT_A], v3: [CERT_B] },
    });
    expect(info(both).signers).toEqual([digestOf(CERT_B)]);
    expect(readApkInfo(bufferSource(both), 27).signers).toEqual([digestOf(CERT_A)]);
    expect(readApkInfo(bufferSource(both), 28).signers).toEqual([digestOf(CERT_B)]);
    expect(readApkInfo(bufferSource(both), 23).signers).toBeNull();
    const rotated = buildApk({
      package: "a.b",
      versionCode: 1,
      signers: { v2: [CERT_A], v3: [CERT_A], v3_1: [CERT_B] },
    });
    expect(info(rotated)).toMatchObject({
      signers: null,
      signerUnreadable: "v3.1 signer selection is unsupported",
    });
    expect(readApkInfo(bufferSource(rotated), 32).signers).toEqual([digestOf(CERT_A)]);
    expect(readApkInfo(bufferSource(rotated), 33).signers).toBeNull();
  });

  it("selects the v3 signer whose SDK range includes the target", () => {
    const value = (min: number, max: number, certificate: Buffer) =>
      signerBlock([certificate], "v3", { min, max }).subarray(4);
    const signers = Buffer.concat([value(28, 32, CERT_A), value(33, 40, CERT_B)]);
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32LE(signers.length);
    const apk = buildZip(
      [{ name: "AndroidManifest.xml", data: buildManifest({ package: "a.b" }) }],
      {
        beforeDirectory: signingBlock([{ id: SCHEME_V3, value: Buffer.concat([prefix, signers]) }]),
      },
    );
    expect(readApkInfo(bufferSource(apk), 32).signers).toEqual([digestOf(CERT_A)]);
    expect(readApkInfo(bufferSource(apk), 33).signers).toEqual([digestOf(CERT_B)]);
    expect(readApkInfo(bufferSource(apk), 41)).toMatchObject({
      signers: null,
      signerUnreadable: expect.stringContaining("no applicable signer"),
    });
  });

  it("rejects overlapping v3 signer ranges for the target", () => {
    const apk = buildApk({ package: "a.b", signers: { v3: [CERT_A, CERT_B] } });
    expect(readApkInfo(bufferSource(apk), 35)).toMatchObject({
      signers: null,
      signerUnreadable: expect.stringContaining("overlap"),
    });
  });

  it("lists every signer, sorted", () => {
    const apk = buildApk({ package: "a.b", versionCode: 1, signers: { v2: [CERT_B, CERT_A] } });
    expect(info(apk).signers).toEqual([digestOf(CERT_A), digestOf(CERT_B)].sort());
  });

  it("is unreadable, with the reason, for a v1-only APK that has no signing block", () => {
    expect(info(buildApk({ package: "a.b", versionCode: 1 }))).toMatchObject({
      package: "a.b",
      signers: null,
      signerUnreadable: "the APK has no v2 or v3 signature",
    });
  });

  it("is unreadable when the block holds only a scheme this does not read", () => {
    const block = signingBlock([{ id: 0x12345678, value: Buffer.from("unknown") }]);
    const apk = buildZip(
      [{ name: "AndroidManifest.xml", data: buildManifest({ package: "a.b" }) }],
      {
        beforeDirectory: block,
      },
    );
    expect(info(apk).signers).toBeNull();
  });

  it("is unreadable, without failing the read, when the block is malformed", () => {
    const block = signingBlock([{ id: SCHEME_V2, value: Buffer.from([1, 2, 3]) }]);
    const apk = buildZip(
      [{ name: "AndroidManifest.xml", data: buildManifest({ package: "a.b" }) }],
      {
        beforeDirectory: block,
      },
    );
    const read = info(apk);
    expect(read.package).toBe("a.b");
    expect(read.signers).toBeNull();
    expect(read.signerUnreadable).toMatch(/signer data/);
  });

  it("is unreadable when the block's sizes disagree", () => {
    const block = signingBlock([{ id: SCHEME_V3, value: signerBlock([CERT_A], "v3") }]);
    block.writeBigUInt64LE(9999n, 0);
    const apk = buildZip(
      [{ name: "AndroidManifest.xml", data: buildManifest({ package: "a.b" }) }],
      {
        beforeDirectory: block,
      },
    );
    expect(info(apk).signerUnreadable).toMatch(/Signing Block/);
  });
});

describe("a file that is not a readable APK", () => {
  it.each([
    ["empty", Buffer.alloc(0)],
    ["text", Buffer.from("this is not an APK\n".repeat(20))],
    ["only a zip header", Buffer.from([0x50, 0x4b, 0x03, 0x04])],
    ["a zip with no manifest", buildZip([{ name: "classes.dex", data: Buffer.from("x") }])],
    [
      "a zip with a manifest that is not binary XML",
      buildZip([{ name: "AndroidManifest.xml", data: Buffer.from("<manifest/>") }]),
    ],
  ])("is an ApkError: %s", (_name, bytes) => {
    expect(() => info(bytes)).toThrow(ApkError);
  });

  it.each([8, 10, 12, 16])("rejects the ZIP64 end-record marker at offset %s", (offset) => {
    const apk = buildApk({ package: "a.b" });
    const end = apk.length - 22;
    if (offset === 8 || offset === 10) apk.writeUInt16LE(0xffff, end + offset);
    else apk.writeUInt32LE(0xffffffff, end + offset);
    expect(() => info(apk)).toThrow(/ZIP64/);
  });

  it("is an ApkError when the file is cut short", () => {
    const apk = readFileSync(DEBUG_APK);
    for (const keep of [10, 4096, Math.floor(apk.length / 2), apk.length - 30]) {
      expect(() => info(apk.subarray(0, keep))).toThrow(ApkError);
    }
  });

  it("never throws anything but ApkError, whatever bytes of a real APK are damaged", () => {
    const apk = Buffer.from(readFileSync(RELEASE_APK));
    // A deterministic spread of single-byte and range corruptions across the whole file.
    let seed = 12345;
    const next = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
    for (let round = 0; round < 300; round++) {
      const damaged = Buffer.from(apk);
      const at = round < 100 ? damaged.length - 1 - (next() % 300) : next() % damaged.length;
      damaged[at] = next() & 0xff;
      try {
        info(damaged);
      } catch (error) {
        expect(error).toBeInstanceOf(ApkError);
      }
    }
  });
});
