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
  let strings = new StringPool(bytes);
  let resourceIds: number[] = [];
  let cursor = bytes.readUInt16LE(2);

  while (cursor + 8 <= end) {
    const type = bytes.readUInt16LE(cursor);
    const headerSize = bytes.readUInt16LE(cursor + 2);
    const size = bytes.readUInt32LE(cursor + 4);
    if (size < 8 || cursor + size > end) throw new ApkError("AndroidManifest.xml is truncated");

    if (type === RES_STRING_POOL) {
      strings = new StringPool(bytes, cursor);
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

type Field = "package" | "versionCode" | "versionCodeMajor" | "versionName";

function readRoot(
  bytes: Buffer,
  chunk: number,
  strings: StringPool,
  resourceIds: readonly number[],
): ManifestInfo {
  const body = chunk + 16;
  // The name is not quoted back: a crafted one can be any length.
  if (strings.at(bytes.readUInt32LE(body + 4)) !== "manifest") {
    throw new ApkError("the root element of AndroidManifest.xml is not <manifest>");
  }
  const attributeStart = bytes.readUInt16LE(body + 8);
  const attributeSize = bytes.readUInt16LE(body + 10);
  const attributeCount = bytes.readUInt16LE(body + 12);

  // Android takes the first attribute with a name (`ResXMLParser::indexOfAttribute`). A
  // package named twice could be read either way, so the manifest is refused instead.
  const fields = new Map<Field, Attribute>();
  for (let index = 0; index < attributeCount; index++) {
    const at = body + attributeStart + index * attributeSize;
    const attribute: Attribute = {
      ns: bytes.readUInt32LE(at),
      name: bytes.readUInt32LE(at + 4),
      rawValue: bytes.readUInt32LE(at + 8),
      type: bytes.readUInt8(at + 15),
      data: bytes.readUInt32LE(at + 16),
    };
    const name = strings.at(attribute.name);
    const resourceId = resourceIds[attribute.name];
    const android = attribute.ns !== NONE && strings.at(attribute.ns) === ANDROID_NS;

    let field: Field | undefined;
    if (attribute.ns === NONE && name === "package") {
      field = "package";
    } else if (resourceId === ATTR_VERSION_CODE || (android && name === "versionCode")) {
      field = "versionCode";
    } else if (resourceId === ATTR_VERSION_CODE_MAJOR || (android && name === "versionCodeMajor")) {
      field = "versionCodeMajor";
    } else if (resourceId === ATTR_VERSION_NAME || (android && name === "versionName")) {
      field = "versionName";
    }
    if (field === undefined) continue;
    if (field === "package" && fields.has(field)) {
      throw new ApkError("the manifest has more than one package attribute");
    }
    if (!fields.has(field)) fields.set(field, attribute);
  }

  const packageAttribute = fields.get("package");
  const pkg = packageAttribute === undefined ? null : stringValue(packageAttribute, strings);
  if (pkg === null || pkg === "") throw new ApkError("the manifest names no package");
  // A manifest without versionCode (an instrumentation APK) installs as version 0.
  const versionCode = integerValue(fields.get("versionCode"));
  const versionCodeMajor = integerValue(fields.get("versionCodeMajor"));
  const versionNameAttribute = fields.get("versionName");
  const versionName =
    versionNameAttribute?.type === TYPE_STRING ? stringValue(versionNameAttribute, strings) : null;

  // `versionCodeMajor` is the high 32 bits of the long version code (API 28+).
  const combined = (BigInt(versionCodeMajor) << 32n) | BigInt(versionCode);
  if (combined > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ApkError("the manifest's versionCode is out of range");
  }
  return { package: pkg, versionCode: Number(combined), versionName };
}

/**
 * An attribute's string as Android reads it (`XmlBlock.getAttributeValue`): the raw string,
 * or `null` when there is none, such as a reference to a resource. A typed string that
 * names a different pool string from the raw one could be read either way, so it is refused.
 */
function stringValue(attribute: Attribute, strings: StringPool): string | null {
  if (attribute.type === TYPE_STRING && attribute.data !== attribute.rawValue) {
    throw new ApkError("a manifest attribute has two different string values");
  }
  return attribute.rawValue === NONE ? null : strings.at(attribute.rawValue);
}

/** A manifest integer; AAPT2 writes `versionCode` as a decimal or hex typed value. */
function integerValue(attribute: Attribute | undefined): number {
  if (attribute === undefined) return 0;
  if (attribute.type !== TYPE_INT_DEC && attribute.type !== TYPE_INT_HEX) {
    throw new ApkError("a manifest version attribute is not an integer");
  }
  return attribute.data;
}

/** At most this many bytes of pool strings are decoded; the root element needs a few hundred. */
const MAX_DECODED_BYTES = 1024 * 1024;

/**
 * The string pool chunk: an offset table, then UTF-8 or UTF-16 strings with length prefixes.
 * Strings are decoded only when read, and only up to `MAX_DECODED_BYTES` in all: offsets may
 * overlap, so a small pool can name the same long string many times over.
 */
class StringPool {
  private readonly count: number = 0;
  private readonly table: number = 0;
  private readonly stringsStart: number = 0;
  private readonly chunkEnd: number = 0;
  private readonly utf8: boolean = false;
  private readonly decoded = new Map<number, string>();
  private decodedBytes = 0;

  /** The pool chunk at `chunk`, or an empty pool when there is none. */
  constructor(
    private readonly bytes: Buffer,
    chunk?: number,
  ) {
    if (chunk === undefined) return;
    const headerSize = bytes.readUInt16LE(chunk + 2);
    const size = bytes.readUInt32LE(chunk + 4);
    this.count = bytes.readUInt32LE(chunk + 8);
    if (headerSize + this.count * 4 > size) {
      throw new ApkError("the manifest string pool is truncated");
    }
    this.table = chunk + headerSize;
    this.stringsStart = chunk + bytes.readUInt32LE(chunk + 20);
    this.chunkEnd = chunk + size;
    this.utf8 = (bytes.readUInt32LE(chunk + 16) & UTF8_FLAG) !== 0;
  }

  at(index: number): string {
    const cached = this.decoded.get(index);
    if (cached !== undefined) return cached;
    if (index >= this.count) {
      throw new ApkError("the manifest refers to a string that is not there");
    }
    const at = this.stringsStart + this.bytes.readUInt32LE(this.table + index * 4);
    if (at >= this.chunkEnd) throw new ApkError("the manifest string pool is truncated");
    const [start, end, encoding] = this.utf8 ? this.utf8Range(at) : this.utf16Range(at);
    if (end > this.chunkEnd) throw new ApkError("the manifest string pool is truncated");
    this.decodedBytes += end - start;
    if (this.decodedBytes > MAX_DECODED_BYTES) {
      throw new ApkError("the manifest strings are too large to read");
    }
    const value = this.bytes.toString(encoding, start, end);
    this.decoded.set(index, value);
    return value;
  }

  private utf8Range(at: number): [number, number, "utf8"] {
    // Two lengths: characters, then bytes. Each is one byte, or two when the high bit is set.
    let cursor = at;
    cursor += this.bytes.readUInt8(cursor) & 0x80 ? 2 : 1;
    const first = this.bytes.readUInt8(cursor);
    const byteLength =
      first & 0x80 ? ((first & 0x7f) << 8) | this.bytes.readUInt8(cursor + 1) : first;
    cursor += first & 0x80 ? 2 : 1;
    return [cursor, cursor + byteLength, "utf8"];
  }

  private utf16Range(at: number): [number, number, "utf16le"] {
    const first = this.bytes.readUInt16LE(at);
    let length = first;
    let cursor = at + 2;
    if (first & 0x8000) {
      length = ((first & 0x7fff) << 16) | this.bytes.readUInt16LE(cursor);
      cursor += 2;
    }
    return [cursor, cursor + length * 2, "utf16le"];
  }
}
