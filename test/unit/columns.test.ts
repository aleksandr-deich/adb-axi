import { describe, expect, it } from "vitest";
import { formatSize, formatUptime, parseDataFree, parseUptime } from "../../src/device/columns.js";

describe("devices --fields helpers", () => {
  it("reads free space from the Available column of df -k", () => {
    const df = [
      "Filesystem        1K-blocks     Used Available Use% Mounted on",
      "/dev/block/dm-47   56000000 30000000   3976328  55% /data",
    ];
    expect(parseDataFree(df)).toBe("3.8G");
    // A filesystem name with spaces still reads from the right.
    expect(parseDataFree([df[0] ?? "", "/dev/block/by name   100 40 60 40% /data"])).toBe("60K");
  });

  it("treats a missing or garbled df as unknown", () => {
    expect(parseDataFree([])).toBe("-");
    expect(parseDataFree(["df: /data: No such file or directory"])).toBe("-");
    expect(parseDataFree(["Filesystem 1K-blocks", "garbled"])).toBe("-");
  });

  it("formats sizes in K, M and G", () => {
    expect(formatSize(96 * 1024)).toBe("96K");
    expect(formatSize(512 * 1024 ** 2)).toBe("512M");
    expect(formatSize(24 * 1024 ** 3)).toBe("24.0G");
  });

  it("formats uptime from /proc/uptime in its two largest units", () => {
    expect(parseUptime("33224.41 114569.60")).toBe("9h13m");
    expect(parseUptime("42.10 10.00")).toBe("42s");
    expect(parseUptime(undefined)).toBe("-");
    expect(parseUptime("soon")).toBe("-");
    expect(formatUptime(125)).toBe("2m05s");
    expect(formatUptime(3 * 86_400 + 4 * 3600 + 59)).toBe("3d04h");
  });
});
