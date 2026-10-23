export function formatDuration(ms: number, style: "display" | "argument" = "display"): string {
  const separator = style === "argument" ? "" : " ";
  return ms % 1000 === 0 ? `${ms / 1000}${separator}s` : `${ms}${separator}ms`;
}
