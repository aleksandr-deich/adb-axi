import { parseManifest, type ManifestInfo } from "./manifest.js";
import { readSignerDigests } from "./signing.js";
import { ApkError, withFileSource, type ByteSource } from "./source.js";
import { readZipDirectory, readZipEntry } from "./zip.js";

export { ApkError, bufferSource, type ByteSource } from "./source.js";

export interface ApkInfo extends ManifestInfo {
  /**
   * The signer certificate digests (SHA-256, lowercase hex, sorted), or `null` with the
   * reason in `signerUnreadable`: no v2 or v3 signing block, or one that cannot be read.
   */
  signers: string[] | null;
  signerUnreadable: string | null;
}

/**
 * Read an APK's package, version and signer on the host, with no Android build tools.
 * Throws `ApkError` when the file is not an APK whose manifest can be read; a signer that
 * cannot be read is not an error here, because the install does not depend on it.
 */
export function readApkInfo(source: ByteSource): ApkInfo {
  try {
    const { entries, centralDirectoryOffset } = readZipDirectory(source);
    const manifest = entries.get("AndroidManifest.xml");
    if (manifest === undefined) throw new ApkError("the file has no AndroidManifest.xml");
    const info = parseManifest(readZipEntry(source, manifest));

    try {
      const digests = readSignerDigests(source, centralDirectoryOffset);
      return digests === null
        ? { ...info, signers: null, signerUnreadable: "the APK has no v2 or v3 signature" }
        : { ...info, signers: digests.sha256, signerUnreadable: null };
    } catch (error) {
      if (!(error instanceof ApkError)) throw error;
      return { ...info, signers: null, signerUnreadable: error.message };
    }
  } catch (error) {
    if (error instanceof ApkError) throw error;
    // Zip structures read past their end throw RangeError; to the caller that is a bad file.
    if (error instanceof RangeError) throw new ApkError("the file is not a readable APK");
    throw error;
  }
}

export function readApkFile(path: string): ApkInfo {
  return withFileSource(path, readApkInfo);
}
