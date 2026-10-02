import { inflateRawSync } from "node:zlib";
import { ApkError, readU64, type ByteSource } from "./source.js";

const EOCD_SIGNATURE = 0x06054b50;
const EOCD_MIN_SIZE = 22;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_LOCATOR_SIZE = 20;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const CENTRAL_FIXED_SIZE = 46;
const LOCAL_SIGNATURE = 0x04034b50;
const LOCAL_FIXED_SIZE = 30;
/** The comment field of the end record is at most 65535 bytes. */
const MAX_COMMENT = 0xffff;
/** No real APK has a central directory or an entry we extract beyond this. */
const MAX_DIRECTORY_BYTES = 64 * 1024 * 1024;
export const MAX_ENTRY_BYTES = 64 * 1024 * 1024;

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

export interface ZipDirectory {
  entries: Map<string, ZipEntry>;
  /** Where the central directory starts; the APK Signing Block ends right before it. */
  centralDirectoryOffset: number;
}

/** Read the central directory of a zip, which is where an APK keeps its file index. */
export function readZipDirectory(source: ByteSource): ZipDirectory {
  const eocdOffset = findEndRecord(source);
  const eocd = source.read(eocdOffset, EOCD_MIN_SIZE);
  let count = eocd.readUInt16LE(10);
  let size = eocd.readUInt32LE(12);
  let offset = eocd.readUInt32LE(16);

  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) {
    ({ count, size, offset } = readZip64End(source, eocdOffset));
  }
  if (size > MAX_DIRECTORY_BYTES || offset + size > eocdOffset) {
    throw new ApkError("the zip central directory is outside the file");
  }

  const directory = source.read(offset, size);
  const entries = new Map<string, ZipEntry>();
  let cursor = 0;
  for (let index = 0; index < count; index++) {
    if (cursor + CENTRAL_FIXED_SIZE > directory.length) {
      throw new ApkError("the zip central directory is truncated");
    }
    if (directory.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw new ApkError("the zip central directory has a bad entry");
    }
    const flags = directory.readUInt16LE(cursor + 8);
    const nameLength = directory.readUInt16LE(cursor + 28);
    const extraLength = directory.readUInt16LE(cursor + 30);
    const commentLength = directory.readUInt16LE(cursor + 32);
    const next = cursor + CENTRAL_FIXED_SIZE + nameLength + extraLength + commentLength;
    if (next > directory.length) throw new ApkError("the zip central directory is truncated");
    const name = directory
      .subarray(cursor + CENTRAL_FIXED_SIZE, cursor + CENTRAL_FIXED_SIZE + nameLength)
      .toString("utf8");
    const entry: ZipEntry = {
      name,
      method: directory.readUInt16LE(cursor + 10),
      compressedSize: directory.readUInt32LE(cursor + 20),
      uncompressedSize: directory.readUInt32LE(cursor + 24),
      localHeaderOffset: directory.readUInt32LE(cursor + 42),
    };
    // Entries bit 0 (encrypted) and the zip64 size markers are not something an APK uses.
    if ((flags & 1) === 0 && !hasZip64Marker(entry)) entries.set(name, entry);
    cursor = next;
  }
  return { entries, centralDirectoryOffset: offset };
}

/** The bytes of one entry, inflated when it is deflated. */
export function readZipEntry(source: ByteSource, entry: ZipEntry): Buffer {
  if (entry.uncompressedSize > MAX_ENTRY_BYTES) {
    throw new ApkError(`${entry.name} is larger than adb-axi reads`);
  }
  const header = source.read(entry.localHeaderOffset, LOCAL_FIXED_SIZE);
  if (header.readUInt32LE(0) !== LOCAL_SIGNATURE) {
    throw new ApkError(`the local header of ${entry.name} is bad`);
  }
  const dataStart =
    entry.localHeaderOffset + LOCAL_FIXED_SIZE + header.readUInt16LE(26) + header.readUInt16LE(28);
  const stored = source.read(dataStart, entry.compressedSize);
  if (entry.method === 0) return stored;
  if (entry.method !== 8)
    throw new ApkError(`${entry.name} uses compression method ${entry.method}`);
  let inflated: Buffer;
  try {
    inflated = inflateRawSync(stored, { maxOutputLength: MAX_ENTRY_BYTES });
  } catch (error) {
    throw new ApkError(
      `${entry.name} does not inflate: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (inflated.length !== entry.uncompressedSize) {
    throw new ApkError(`${entry.name} inflated to an unexpected size`);
  }
  return inflated;
}

function hasZip64Marker(entry: ZipEntry): boolean {
  return (
    entry.compressedSize === 0xffffffff ||
    entry.uncompressedSize === 0xffffffff ||
    entry.localHeaderOffset === 0xffffffff
  );
}

/** The end-of-central-directory record is the last one with a comment length that fits the file. */
function findEndRecord(source: ByteSource): number {
  if (source.size < EOCD_MIN_SIZE) throw new ApkError("the file is too small to be a zip");
  const tailLength = Math.min(source.size, EOCD_MIN_SIZE + MAX_COMMENT);
  const tailStart = source.size - tailLength;
  const tail = source.read(tailStart, tailLength);
  for (let at = tail.length - EOCD_MIN_SIZE; at >= 0; at--) {
    if (tail.readUInt32LE(at) !== EOCD_SIGNATURE) continue;
    if (at + EOCD_MIN_SIZE + tail.readUInt16LE(at + 20) === tail.length) return tailStart + at;
  }
  throw new ApkError("the file is not a zip (no end of central directory record)");
}

function readZip64End(
  source: ByteSource,
  eocdOffset: number,
): { count: number; size: number; offset: number } {
  const locatorAt = eocdOffset - ZIP64_LOCATOR_SIZE;
  if (locatorAt < 0) throw new ApkError("the zip64 locator is missing");
  const locator = source.read(locatorAt, ZIP64_LOCATOR_SIZE);
  if (locator.readUInt32LE(0) !== ZIP64_LOCATOR_SIGNATURE) {
    throw new ApkError("the zip64 locator is missing");
  }
  const recordAt = readU64(locator, 8);
  const record = source.read(recordAt, 56);
  if (record.readUInt32LE(0) !== ZIP64_EOCD_SIGNATURE) {
    throw new ApkError("the zip64 end record is bad");
  }
  return { count: readU64(record, 32), size: readU64(record, 40), offset: readU64(record, 48) };
}
