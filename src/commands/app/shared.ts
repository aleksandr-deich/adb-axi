/** How an unknown or absent value prints, in rows and in fields. */
export const UNKNOWN = "-";

/** `1.4.0 (57)`, `- (57)` when only the code is known, `-` when neither is. */
export function formatVersion(name: string | null, code: number | null): string {
  if (name === null && code === null) return UNKNOWN;
  const label = name ?? UNKNOWN;
  return code === null ? label : `${label} (${code})`;
}
