/**
 * Split the output of a script that introduces each part with an `@name` marker line
 * (`echo @boot_completed; getprop ...`) into those parts, so one failing command cannot
 * shift the others. Blank lines are dropped.
 */
export function splitSections(stdout: string): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    const marker = /^@([a-z_]+)$/.exec(line);
    if (marker?.[1] !== undefined) {
      current = [];
      sections.set(marker[1], current);
    } else if (current && line !== "") {
      current.push(line);
    }
  }
  return sections;
}
