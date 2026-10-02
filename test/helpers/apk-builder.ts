import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";

/**
 * Builds small APKs in memory for the parser and install tests: a zip with a binary
 * manifest and, optionally, an APK Signing Block. They are laid out the way AOSP's
 * `ResourceTypes.h` and the APK Signature Scheme v2/v3 specifications describe, so the
 * parser reads them as it reads a real APK; they are not installable.
 */

export const SCHEME_V2 = 0x7109871a;
export const SCHEME_V3 = 0xf05368c0;
export const SCHEME_V3_1 = 0x1b93ad61;

const ANDROID_NS = "http://schemas.android.com/apk/res/android";
const ATTR_VERSION_CODE = 0x0101021b;
const ATTR_VERSION_NAME = 0x0101021c;
const ATTR_VERSION_CODE_MAJOR = 0x01010576;
const NONE = 0xffffffff;

export interface ManifestSpec {
  package: string;
  versionCode?: number;
  versionCodeMajor?: number;
  /** A literal name, or `{ reference }` for `@string/...` which the parser cannot resolve. */
  versionName?: string | { reference: number };
  /** Encode the string pool as UTF-16 instead of UTF-8. */
  utf16?: boolean;
  /** Leave the resource map out, so attributes are known by name only. */
  withoutResourceMap?: boolean;
  /** Name the root element something other than `manifest`. */
  rootName?: string;
}

function u16(value: number): Buffer {
  const out = Buffer.alloc(2);
  out.writeUInt16LE(value);
  return out;
}
function u32(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value >>> 0);
  return out;
}
function u64(value: number): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(BigInt(value));
  return out;
}

export function prefixed(...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  return Buffer.concat([u32(body.length), body]);
}

function poolString(value: string, utf16: boolean): Buffer {
  if (utf16) return Buffer.concat([u16(value.length), Buffer.from(value, "utf16le"), u16(0)]);
  const bytes = Buffer.from(value, "utf8");
  return Buffer.concat([Buffer.from([value.length, bytes.length]), bytes, Buffer.from([0])]);
}

function stringPool(strings: string[], utf16: boolean): Buffer {
  const encoded = strings.map((value) => poolString(value, utf16));
  const offsets: Buffer[] = [];
  let at = 0;
  for (const part of encoded) {
    offsets.push(u32(at));
    at += part.length;
  }
  const headerSize = 28;
  const stringsStart = headerSize + strings.length * 4;
  let data = Buffer.concat(encoded);
  while (data.length % 4 !== 0) data = Buffer.concat([data, Buffer.from([0])]);
  const size = stringsStart + data.length;
  return Buffer.concat([
    u16(0x0001),
    u16(headerSize),
    u32(size),
    u32(strings.length),
    u32(0),
    u32(utf16 ? 0 : 1 << 8),
    u32(stringsStart),
    u32(0),
    ...offsets,
    data,
  ]);
}

/** The binary `AndroidManifest.xml` of an app: the root element and its attributes only. */
export function buildManifest(spec: ManifestSpec): Buffer {
  const utf16 = spec.utf16 === true;
  const strings: string[] = [];
  const index = (value: string): number => {
    const found = strings.indexOf(value);
    if (found !== -1) return found;
    strings.push(value);
    return strings.length - 1;
  };

  // Attribute names that carry a resource id come first, as aapt2 orders its pool.
  interface Attr {
    ns: number;
    name: number;
    raw: number;
    type: number;
    data: number;
    resId?: number;
  }
  const attrs: Attr[] = [];
  const android = index(ANDROID_NS);
  if (spec.versionCode !== undefined) {
    attrs.push({
      ns: android,
      name: index("versionCode"),
      raw: NONE,
      type: 0x10,
      data: spec.versionCode,
      resId: ATTR_VERSION_CODE,
    });
  }
  if (spec.versionCodeMajor !== undefined) {
    attrs.push({
      ns: android,
      name: index("versionCodeMajor"),
      raw: NONE,
      type: 0x10,
      data: spec.versionCodeMajor,
      resId: ATTR_VERSION_CODE_MAJOR,
    });
  }
  if (spec.versionName !== undefined) {
    const name = index("versionName");
    if (typeof spec.versionName === "string") {
      const value = index(spec.versionName);
      attrs.push({
        ns: android,
        name,
        raw: value,
        type: 0x03,
        data: value,
        resId: ATTR_VERSION_NAME,
      });
    } else {
      attrs.push({
        ns: android,
        name,
        raw: NONE,
        type: 0x01,
        data: spec.versionName.reference,
        resId: ATTR_VERSION_NAME,
      });
    }
  }
  const packageValue = index(spec.package);
  attrs.push({
    ns: NONE,
    name: index("package"),
    raw: packageValue,
    type: 0x03,
    data: packageValue,
  });
  const root = index(spec.rootName ?? "manifest");

  const resourceIds = strings.map(() => 0);
  for (const attr of attrs) if (attr.resId !== undefined) resourceIds[attr.name] = attr.resId;
  const resourceMap =
    spec.withoutResourceMap === true
      ? Buffer.alloc(0)
      : Buffer.concat([
          u16(0x0180),
          u16(8),
          u32(8 + resourceIds.length * 4),
          ...resourceIds.map(u32),
        ]);

  const attributeBytes = Buffer.concat(
    attrs.map((attr) =>
      Buffer.concat([
        u32(attr.ns),
        u32(attr.name),
        u32(attr.raw),
        u16(8),
        Buffer.from([0, attr.type]),
        u32(attr.data),
      ]),
    ),
  );
  const startElement = Buffer.concat([
    u16(0x0102),
    u16(16),
    u32(36 + attributeBytes.length),
    u32(1),
    u32(NONE),
    u32(NONE),
    u32(root),
    u16(20),
    u16(20),
    u16(attrs.length),
    u16(0),
    u16(0),
    u16(0),
    attributeBytes,
  ]);
  const endElement = Buffer.concat([
    u16(0x0103),
    u16(16),
    u32(24),
    u32(1),
    u32(NONE),
    u32(NONE),
    u32(root),
  ]);

  const pool = stringPool(strings, utf16);
  const body = Buffer.concat([pool, resourceMap, startElement, endElement]);
  return Buffer.concat([u16(0x0003), u16(8), u32(8 + body.length), body]);
}

/** An APK Signature Scheme v2 or v3 value: one signer per certificate. */
export function signerBlock(
  certificates: Buffer[],
  scheme: "v2" | "v3",
  range = { min: 0, max: 0x7fffffff },
): Buffer {
  const v3Range =
    scheme === "v3" ? Buffer.concat([u32(range.min), u32(range.max)]) : Buffer.alloc(0);
  const signers = certificates.map((certificate) => {
    const signedData = prefixed(
      prefixed(), // digests
      prefixed(prefixed(certificate)),
      v3Range,
      prefixed(), // additional attributes
    );
    return prefixed(signedData, v3Range, prefixed(), prefixed());
  });
  return prefixed(...signers);
}

export interface SigningPair {
  id: number;
  value: Buffer;
}

/** The APK Signing Block that sits between the zip entries and the central directory. */
export function signingBlock(pairs: SigningPair[]): Buffer {
  const entries = pairs.map((pair) =>
    Buffer.concat([u64(pair.value.length + 4), u32(pair.id), pair.value]),
  );
  const size = entries.reduce((sum, entry) => sum + entry.length, 0) + 8 + 16;
  return Buffer.concat([u64(size), ...entries, u64(size), Buffer.from("APK Sig Block 42")]);
}

export interface ZipFile {
  name: string;
  data: Buffer;
  deflate?: boolean;
}

/** A zip with `files`, then `beforeDirectory` bytes (a signing block) before the directory. */
export function buildZip(
  files: ZipFile[],
  options: { beforeDirectory?: Buffer; comment?: string } = {},
): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name);
    const method = file.deflate === true ? 8 : 0;
    const stored = file.deflate === true ? deflateRawSync(file.data) : file.data;
    const local = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(method),
      u16(0),
      u16(0),
      u32(0),
      u32(stored.length),
      u32(file.data.length),
      u16(name.length),
      u16(0),
      name,
      stored,
    ]);
    central.push(
      Buffer.concat([
        u32(0x02014b50),
        u16(20),
        u16(20),
        u16(0),
        u16(method),
        u16(0),
        u16(0),
        u32(0),
        u32(stored.length),
        u32(file.data.length),
        u16(name.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(offset),
        name,
      ]),
    );
    parts.push(local);
    offset += local.length;
  }
  const before = options.beforeDirectory ?? Buffer.alloc(0);
  parts.push(before);
  offset += before.length;
  const directory = Buffer.concat(central);
  const comment = Buffer.from(options.comment ?? "");
  return Buffer.concat([
    ...parts,
    directory,
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(files.length),
    u16(files.length),
    u32(directory.length),
    u32(offset),
    u16(comment.length),
    comment,
  ]);
}

export interface ApkSpec extends ManifestSpec {
  /** Certificates (any bytes stand in for DER) per scheme; none means no signing block. */
  signers?: { v2?: Buffer[]; v3?: Buffer[]; v3_1?: Buffer[] };
  /** Deflate the manifest, as most real APKs do. */
  deflateManifest?: boolean;
}

/** A synthetic APK whose manifest and signing block say what `spec` says. */
export function buildApk(spec: ApkSpec): Buffer {
  const pairs: SigningPair[] = [];
  if (spec.signers?.v2 !== undefined) {
    pairs.push({ id: SCHEME_V2, value: signerBlock(spec.signers.v2, "v2") });
  }
  if (spec.signers?.v3 !== undefined) {
    pairs.push({ id: SCHEME_V3, value: signerBlock(spec.signers.v3, "v3") });
  }
  if (spec.signers?.v3_1 !== undefined) {
    pairs.push({ id: SCHEME_V3_1, value: signerBlock(spec.signers.v3_1, "v3") });
  }
  return buildZip(
    [
      {
        name: "AndroidManifest.xml",
        data: buildManifest(spec),
        deflate: spec.deflateManifest ?? false,
      },
      { name: "classes.dex", data: Buffer.from("dex\n035\0"), deflate: true },
    ],
    pairs.length === 0 ? {} : { beforeDirectory: signingBlock(pairs) },
  );
}

export function withZip64End(apk: Buffer): Buffer {
  const end = apk.subarray(apk.length - 22);
  const record = Buffer.concat([
    u32(0x06064b50),
    u64(44),
    u16(45),
    u16(45),
    u32(0),
    u32(0),
    u64(end.readUInt16LE(8)),
    u64(end.readUInt16LE(10)),
    u64(end.readUInt32LE(12)),
    u64(end.readUInt32LE(16)),
  ]);
  const locator = Buffer.concat([u32(0x07064b50), u32(0), u64(apk.length - 22), u32(1)]);
  const classic = Buffer.from(end);
  classic.writeUInt16LE(0xffff, 8);
  classic.writeUInt16LE(0xffff, 10);
  classic.writeUInt32LE(0xffffffff, 12);
  classic.writeUInt32LE(0xffffffff, 16);
  return Buffer.concat([apk.subarray(0, apk.length - 22), record, locator, classic]);
}

/** The digest the parser should report for a stand-in certificate. */
export function digestOf(certificate: Buffer): string {
  return createHash("sha256").update(certificate).digest("hex");
}
