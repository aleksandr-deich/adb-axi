import { createHash } from "node:crypto";
import { ApkError, readU64, type ByteSource } from "./source.js";

const MAGIC = "APK Sig Block 42";
/** The block ends with its size (8 bytes) and the magic (16 bytes). */
const FOOTER_SIZE = 24;
/** A signing block is a few KB, mostly page-alignment padding; a larger claim is not an APK's. */
const MAX_BLOCK_BYTES = 32 * 1024 * 1024;

const SCHEMES = [
  { id: 0xf05368c0, name: "v3", minSdk: 28 },
  { id: 0x7109871a, name: "v2", minSdk: 24 },
] as const;

export interface SignerDigests {
  /** The scheme the digests were read from. */
  scheme: string;
  /** SHA-256 of each signer's certificate (DER) as lowercase hex, sorted. */
  sha256: string[];
}

/**
 * The signer certificate digests from the APK Signing Block (v2 or v3), the value
 * `apksigner verify --print-certs` prints as "SHA-256 digest". `null` when the APK has no
 * signing block (a v1-only, JAR-signed APK) or none of the schemes read here. It reads
 * whose certificate is in the block; it does not verify the signature.
 */
export function readSignerDigests(
  source: ByteSource,
  centralDirectoryOffset: number,
  api?: number,
): SignerDigests | null {
  const block = findSigningBlock(source, centralDirectoryOffset);
  if (block === null) return null;
  if ((api === undefined || api >= 33) && block.has(0x1b93ad61)) {
    throw new ApkError("v3.1 signer selection is unsupported");
  }
  for (const scheme of SCHEMES) {
    if (api !== undefined && api < scheme.minSdk) continue;
    const value = block.get(scheme.id);
    if (value !== undefined) {
      return { scheme: scheme.name, sha256: signerDigests(value, scheme.name, api) };
    }
  }
  return null;
}

/** The id-value pairs of the signing block that ends right before the central directory. */
function findSigningBlock(
  source: ByteSource,
  centralDirectoryOffset: number,
): Map<number, Buffer> | null {
  if (centralDirectoryOffset < FOOTER_SIZE) return null;
  const footer = source.read(centralDirectoryOffset - FOOTER_SIZE, FOOTER_SIZE);
  if (footer.toString("latin1", 8) !== MAGIC) return null;

  // The size counts everything after the leading size field: the pairs and the footer.
  const blockSize = readU64(footer, 0);
  const total = blockSize + 8;
  if (blockSize < FOOTER_SIZE || total > centralDirectoryOffset || total > MAX_BLOCK_BYTES) {
    throw new ApkError("the APK Signing Block has a bad size");
  }
  const block = source.read(centralDirectoryOffset - total, total);
  if (readU64(block, 0) !== blockSize) throw new ApkError("the APK Signing Block sizes disagree");

  const pairs = new Map<number, Buffer>();
  const end = total - FOOTER_SIZE;
  let cursor = 8;
  while (cursor < end) {
    if (cursor + 12 > end) throw new ApkError("the APK Signing Block is truncated");
    const length = readU64(block, cursor);
    if (length < 4 || cursor + 8 + length > end) {
      throw new ApkError("the APK Signing Block has a bad entry");
    }
    pairs.set(block.readUInt32LE(cursor + 8), block.subarray(cursor + 12, cursor + 8 + length));
    cursor += 8 + length;
  }
  return pairs;
}

/**
 * Walk signers -> signer -> signed data -> certificates, all length-prefixed (APK
 * Signature Scheme v2/v3 specifications), and hash each signer's first certificate. The
 * signed data starts with the digests and then the certificates in both schemes.
 */
function signerDigests(value: Buffer, scheme: "v2" | "v3", api?: number): string[] {
  try {
    const signers = new Section(value).prefixed();
    const digests = new Set<string>();
    while (!signers.done) {
      const signer = signers.prefixed();
      const signedData = signer.prefixed();
      signedData.prefixed();
      const certificate = signedData.prefixed().prefixed().bytes;
      if (certificate.length === 0) throw new ApkError("the signer certificate is empty");
      if (scheme === "v3") {
        const min = signedData.u32();
        const max = signedData.u32();
        if (min > max || signer.u32() !== min || signer.u32() !== max) {
          throw new ApkError("the v3 signer SDK ranges disagree");
        }
        if (api !== undefined && (api < min || api > max)) continue;
      }
      if (scheme === "v3" && api !== undefined && digests.size > 0) {
        throw new ApkError("the v3 signer SDK ranges overlap");
      }
      digests.add(createHash("sha256").update(certificate).digest("hex"));
    }
    if (digests.size === 0) throw new ApkError("the APK Signing Block has no applicable signer");
    return [...digests].sort();
  } catch (error) {
    if (error instanceof ApkError) throw error;
    throw new ApkError("the APK Signing Block signer data is malformed");
  }
}

/** A buffer read front to back as u32 length-prefixed sections. */
class Section {
  private position = 0;

  constructor(readonly bytes: Buffer) {}

  get done(): boolean {
    return this.position >= this.bytes.length;
  }

  u32(): number {
    if (this.position + 4 > this.bytes.length) throw new ApkError("the signer data is truncated");
    const value = this.bytes.readUInt32LE(this.position);
    this.position += 4;
    return value;
  }

  prefixed(): Section {
    if (this.position + 4 > this.bytes.length) throw new ApkError("the signer data is truncated");
    const length = this.bytes.readUInt32LE(this.position);
    const start = this.position + 4;
    if (start + length > this.bytes.length) throw new ApkError("the signer data is truncated");
    this.position = start + length;
    return new Section(this.bytes.subarray(start, start + length));
  }
}
