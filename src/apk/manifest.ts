import { ApkError } from "./source.js";

/** What the binary `AndroidManifest.xml` says about the app. */
export interface ManifestInfo {
  package: string;
  versionCode: number;
  /** `null` when the manifest has none, or points at a resource that is not read here. */
  versionName: string | null;
}

const RES_XML = 0x0003;
const RES_STRING_POOL = 0x0001;
const RES_XML_RESOURCE_MAP = 0x0180;
const RES_XML_START_ELEMENT = 0x0102;

const UTF8_FLAG = 1 << 8;
const NONE = 0xffffffff;

const TYPE_STRING = 0x03;
const TYPE_INT_DEC = 0x10;
const TYPE_INT_HEX = 0x11;

const ANDROID_NS = "http://schemas.android.com/apk/res/android";
/** Attribute resource ids from `android.R.attr`; stable across every Android release. */
const ATTR_VERSION_CODE = 0x0101021b;
const ATTR_VERSION_NAME = 0x0101021c;
const ATTR_VERSION_CODE_MAJOR = 0x01010576;

interface Attribute {
  ns: number;
  name: number;
  rawValue: number;
  type: number;
  data: number;
}

/**
 * Read the manifest's root element from Android's binary XML (AOSP `ResourceTypes.h`):
 * a chunk stream of a string pool, a resource map giving each attribute name its
 * `android.R.attr` id, and the elements. Only the root `<manifest>` carries what adb-axi
 * needs, so reading stops there.
 */
export function parseManifest(bytes: Buffer): ManifestInfo {
  try {
    return readManifest(bytes);
  } catch (error) {
    if (error instanceof ApkError) throw error;
    // A Buffer read past the end throws a RangeError; to the caller that is a bad manifest.
    throw new ApkError("AndroidManifest.xml is not valid binary XML");
  }
}

function readManifest(bytes: Buffer): ManifestInfo {
  if (bytes.length < 8 || bytes.readUInt16LE(0) !== RES_XML) {
    throw new ApkError("AndroidManifest.xml is not binary XML");
  }
  const end = Math.min(bytes.length, bytes.readUInt32LE(4));
  let strings: string[] = [];
  let resourceIds: number[] = [];
  let cursor = bytes.readUInt16LE(2);

  while (cursor + 8 <= end) {
    const type = bytes.readUInt16LE(cursor);
    const headerSize = bytes.readUInt16LE(cursor + 2);
    const size = bytes.readUInt32LE(cursor + 4);
    if (size < 8 || cursor + size > end) throw new ApkError("AndroidManifest.xml is truncated");

    if (type === RES_STRING_POOL) {
      strings = readStringPool(bytes, cursor);
    } else if (type === RES_XML_RESOURCE_MAP) {
      resourceIds = [];
      for (let at = cursor + headerSize; at + 4 <= cursor + size; at += 4) {
        resourceIds.push(bytes.readUInt32LE(at));
      }
    } else if (type === RES_XML_START_ELEMENT) {
      return readRoot(bytes, cursor, strings, resourceIds);
    }
    cursor += size;
  }
  throw new ApkError("AndroidManifest.xml has no root element");
}

function readRoot(
  bytes: Buffer,
  chunk: number,
  strings: readonly string[],
  resourceIds: readonly number[],
): ManifestInfo {
  const body = chunk + 16;
  const elementName = stringAt(strings, bytes.readUInt32LE(body + 4));
  if (elementName !== "manifest") {
    throw new ApkError(`AndroidManifest.xml starts with <${elementName}>, not <manifest>`);
  }
  const attributeStart = bytes.readUInt16LE(body + 8);
  const attributeSize = bytes.readUInt16LE(body + 10);
  const attributeCount = bytes.readUInt16LE(body + 12);

  let pkg: string | undefined;
  // A manifest without versionCode (an instrumentation APK) installs as version 0.
  let versionCode = 0;
  let versionCodeMajor = 0;
  let versionName: string | null = null;

  for (let index = 0; index < attributeCount; index++) {
    const at = body + attributeStart + index * attributeSize;
    const attribute: Attribute = {
      ns: bytes.readUInt32LE(at),
      name: bytes.readUInt32LE(at + 4),
      rawValue: bytes.readUInt32LE(at + 8),
      type: bytes.readUInt8(at + 15),
      data: bytes.readUInt32LE(at + 16),
    };
    const name = stringAt(strings, attribute.name);
    const resourceId = resourceIds[attribute.name];
    const android = attribute.ns !== NONE && stringAt(strings, attribute.ns) === ANDROID_NS;

    if (attribute.ns === NONE && name === "package") {
      pkg = stringValue(attribute, strings);
    } else if (resourceId === ATTR_VERSION_CODE || (android && name === "versionCode")) {
      versionCode = integerValue(attribute);
    } else if (resourceId === ATTR_VERSION_CODE_MAJOR || (android && name === "versionCodeMajor")) {
      versionCodeMajor = integerValue(attribute);
    } else if (resourceId === ATTR_VERSION_NAME || (android && name === "versionName")) {
      versionName = attribute.type === TYPE_STRING ? stringValue(attribute, strings) : null;
    }
  }

  if (pkg === undefined || pkg === "") throw new ApkError("the manifest names no package");
  // `versionCodeMajor` is the high 32 bits of the long version code (API 28+).
  const combined = (BigInt(versionCodeMajor) << 32n) | BigInt(versionCode);
  if (combined > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ApkError("the manifest's versionCode is out of range");
  }
  return { package: pkg, versionCode: Number(combined), versionName };
}

function stringValue(attribute: Attribute, strings: readonly string[]): string {
  if (attribute.type === TYPE_STRING) return stringAt(strings, attribute.data);
  if (attribute.rawValue !== NONE) return stringAt(strings, attribute.rawValue);
  throw new ApkError("a manifest attribute is not a string");
}

/** A manifest integer; AAPT2 writes `versionCode` as a decimal or hex typed value. */
function integerValue(attribute: Attribute): number {
  if (attribute.type !== TYPE_INT_DEC && attribute.type !== TYPE_INT_HEX) {
    throw new ApkError("a manifest version attribute is not an integer");
  }
  return attribute.data;
}

function stringAt(strings: readonly string[], index: number): string {
  const value = strings[index];
  if (value === undefined) throw new ApkError("the manifest refers to a string that is not there");
  return value;
}

/** The string pool chunk: an offset table, then UTF-8 or UTF-16 strings with length prefixes. */
function readStringPool(bytes: Buffer, chunk: number): string[] {
  const headerSize = bytes.readUInt16LE(chunk + 2);
  const size = bytes.readUInt32LE(chunk + 4);
  const count = bytes.readUInt32LE(chunk + 8);
  const flags = bytes.readUInt32LE(chunk + 16);
  const stringsStart = chunk + bytes.readUInt32LE(chunk + 20);
  const chunkEnd = chunk + size;
  if (headerSize + count * 4 > size) throw new ApkError("the manifest string pool is truncated");

  const utf8 = (flags & UTF8_FLAG) !== 0;
  const strings: string[] = [];
  for (let index = 0; index < count; index++) {
    const at = stringsStart + bytes.readUInt32LE(chunk + headerSize + index * 4);
    if (at >= chunkEnd) throw new ApkError("the manifest string pool is truncated");
    strings.push(utf8 ? readUtf8(bytes, at, chunkEnd) : readUtf16(bytes, at, chunkEnd));
  }
  return strings;
}

function readUtf8(bytes: Buffer, at: number, limit: number): string {
  // Two lengths: characters, then bytes. Each is one byte, or two when the high bit is set.
  let cursor = at;
  cursor += bytes.readUInt8(cursor) & 0x80 ? 2 : 1;
  const first = bytes.readUInt8(cursor);
  const byteLength = first & 0x80 ? ((first & 0x7f) << 8) | bytes.readUInt8(cursor + 1) : first;
  cursor += first & 0x80 ? 2 : 1;
  if (cursor + byteLength > limit) throw new ApkError("the manifest string pool is truncated");
  return bytes.toString("utf8", cursor, cursor + byteLength);
}

function readUtf16(bytes: Buffer, at: number, limit: number): string {
  const first = bytes.readUInt16LE(at);
  let length = first;
  let cursor = at + 2;
  if (first & 0x8000) {
    length = ((first & 0x7fff) << 16) | bytes.readUInt16LE(cursor);
    cursor += 2;
  }
  if (cursor + length * 2 > limit) throw new ApkError("the manifest string pool is truncated");
  return bytes.toString("utf16le", cursor, cursor + length * 2);
}
