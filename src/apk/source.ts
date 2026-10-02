import { closeSync, fstatSync, openSync, readSync } from "node:fs";

/** Positional APK reads; file-backed sources do not require whole-file buffering. */
export interface ByteSource {
  readonly size: number;
  /** Exactly `length` bytes from `offset`; a range outside the file throws `ApkError`. */
  read(offset: number, length: number): Buffer;
}

/** An APK adb-axi cannot read: corrupt, truncated, or a layout it does not handle. */
export class ApkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApkError";
  }
}

export function bufferSource(bytes: Uint8Array): ByteSource {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    size: buffer.length,
    read(offset, length) {
      checkRange(offset, length, buffer.length);
      return buffer.subarray(offset, offset + length);
    },
  };
}

/** Run `use` on the file at `path`, closing it afterwards. */
export function withFileSource<T>(path: string, use: (source: ByteSource) => T): T {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    return use({
      size,
      read(offset, length) {
        checkRange(offset, length, size);
        const out = Buffer.alloc(length);
        let done = 0;
        while (done < length) {
          const count = readSync(fd, out, done, length - done, offset + done);
          if (count === 0) throw new ApkError("the file ended while it was being read");
          done += count;
        }
        return out;
      },
    });
  } finally {
    closeSync(fd);
  }
}

function checkRange(offset: number, length: number, size: number): void {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0) {
    throw new ApkError("a read outside the file was requested");
  }
  if (offset + length > size) throw new ApkError("a read past the end of the file was requested");
}

/** A 64-bit little-endian value as a number; one above 2^53 is outside any real APK. */
export function readU64(buffer: Buffer, offset: number): number {
  const value = buffer.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new ApkError("a size field is out of range");
  return Number(value);
}
