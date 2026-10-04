import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runShell } from "../../adb/shell.js";
import type { AdbClient } from "../../adb/run.js";
import { ANDROID_CLI_PACKAGE, probeHolders, readWedgedPids } from "../../android/holders.js";
import { readBoot } from "../../android/boot.js";
import { formatSpan, readDeviceClock } from "../../android/clock.js";
import { readShell } from "../../android/read.js";
import { runHint } from "../../core/output.js";
import { formatUptime, formatSize } from "../../device/columns.js";
import { parseAvdName } from "../../device/facts.js";
import type { CommandContext } from "../types.js";
import { classifyHolders } from "./ui-holders.js";
import { avdName } from "../../device/facts.js";
import { listDevices } from "../../device/list.js";
import { CHECK_CAP_MS, homeDir } from "./host-checks.js";
import { failed, ok, settle, tildePath, warn, type CheckResult } from "./result.js";

/** Everything the checks on the resolved device need. */
export interface DeviceChecks {
  context: CommandContext;
  adb: AdbClient;
  serial: string;
}

function reads(checks: DeviceChecks): { deadline: CommandContext["deadline"]; capMs: number } {
  return { deadline: checks.context.deadline, capMs: CHECK_CAP_MS };
}

/** A next step that runs a command this build ships, aimed at the device; none otherwise (6.3). */
function hint(
  checks: DeviceChecks,
  path: readonly string[],
  args: readonly string[],
  reason: string,
  afterFlags: readonly string[] = [],
): string[] {
  if (!checks.context.isShipped(path)) return [];
  return [runHint([...path, ...args, "--device", checks.serial, ...afterFlags], reason)];
}

export async function checkBoot(checks: DeviceChecks): Promise<CheckResult> {
  return settle("boot", async () => {
    const { adb, serial } = checks;
    const boot = await readBoot(adb, serial, reads(checks));
    if (!boot.bootCompleted) {
      const up = boot.uptimeS === null ? "" : `, up ${formatUptime(boot.uptimeS)}`;
      return failed(
        "boot",
        `still booting (boot_completed 0${up})`,
        hint(checks, ["wait", "boot"], [], "to wait for the boot to finish"),
      );
    }
    // The property is set before every service is up; the package manager answering is the proof.
    const packages = await runShell(adb, serial, "pm path android", {
      ...reads(checks),
      step: "asking the package manager",
    });
    return packages.exitCode === 0 && packages.stdout.startsWith("package:")
      ? ok("boot", "boot finished")
      : warn("boot", "boot finished, but the package manager does not answer yet");
  });
}

/** How far the device clock may be from the host's before log times read wrong against it. */
export const CLOCK_SKEW_WARN_MS = 60_000;

export async function checkClock(checks: DeviceChecks): Promise<CheckResult> {
  return settle("clock", async () => {
    const before = Date.now();
    const device = await readDeviceClock(checks.adb, checks.serial, reads(checks));
    // The device answered somewhere between the two host readings.
    const skew = device.epochMs - (before + Date.now()) / 2;
    if (Math.abs(skew) <= CLOCK_SKEW_WARN_MS) return ok("clock", "within a minute of the host");
    return warn(
      "clock",
      `${formatSpan(skew)} ${skew < 0 ? "behind" : "ahead of"} the host; log times and log marks use the device clock`,
    );
  });
}

/** Free space below which installing and running a test is likely to fail, and below which it is tight. */
export const DATA_FAILED_BELOW = 256 * 1024 ** 2;
export const DATA_WARN_BELOW = 1024 ** 3;

/** The `Available` column of the last line of `df -k /data`, in bytes. The name may be anything. */
export function parseAvailableBytes(stdout: string): number | null {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const last = lines.at(-1);
  if (last === undefined || lines.length < 2) return null;
  const columns = last.split(/\s+/);
  const use = columns.findIndex((column) => /^\d+%$/.test(column));
  const kib = use > 0 ? Number(columns[use - 1]) : Number.NaN;
  return Number.isFinite(kib) && kib >= 0 ? kib * 1024 : null;
}

export async function checkDataFree(checks: DeviceChecks): Promise<CheckResult> {
  return settle("data_free", async () => {
    const df = await readShell(
      checks.adb,
      checks.serial,
      "df -k /data",
      "reading free space on /data",
      reads(checks),
    );
    const bytes = parseAvailableBytes(df.stdout);
    if (bytes === null) return warn("data_free", "free space on /data is unreadable");
    const free = formatSize(bytes);
    if (bytes < DATA_FAILED_BELOW) {
      return failed(
        "data_free",
        `${free} free, too little to install or run`,
        hint(checks, ["app", "uninstall"], ["<pkg>"], "to free space"),
      );
    }
    if (bytes < DATA_WARN_BELOW) {
      return warn(
        "data_free",
        `${free} free, getting tight`,
        hint(checks, ["app", "uninstall"], ["<pkg>"], "to free space"),
      );
    }
    return ok("data_free", `${free} free`);
  });
}

const ANIMATION_SETTINGS = [
  ["window", "window_animation_scale"],
  ["transition", "transition_animation_scale"],
  ["animator", "animator_duration_scale"],
] as const;

const ANIMATIONS_OFF = ANIMATION_SETTINGS.map(([, key]) => `settings put global ${key} 0`).join(
  "; ",
);

/** A scale as `settings get` prints it. `null` means never set, which Android reads as 1.0. */
function parseScale(text: string): { text: string; value: number } | undefined {
  if (text === "null") return { text: "1.0", value: 1 };
  const value = Number(text);
  return text !== "" && Number.isFinite(value) && value >= 0 ? { text, value } : undefined;
}

export async function checkAnimations(checks: DeviceChecks): Promise<CheckResult> {
  return settle("animations", async () => {
    const script = ANIMATION_SETTINGS.map(([, key]) => `settings get global ${key}`).join("; ");
    const answer = await runShell(checks.adb, checks.serial, script, {
      ...reads(checks),
      step: "reading the animation scales",
    });
    // The last command's exit code is the script's; a down settings service fails them all.
    if (answer.exitCode !== 0) {
      return failed("animations", `the settings service does not answer (exit ${answer.exitCode})`);
    }
    const lines = answer.stdout.split(/\r?\n/).map((line) => line.trim());
    const scales = ANIMATION_SETTINGS.map((_, index) => parseScale(lines[index] ?? ""));
    if (scales.some((scale) => scale === undefined) || lines.filter((l) => l !== "").length !== 3) {
      return warn("animations", "the animation scales are unreadable");
    }
    const values = scales.flatMap((scale) => (scale === undefined ? [] : [scale]));
    if (values.every((scale) => scale.value === 0)) return ok("animations", "scales 0");
    const same = values.every((scale) => scale.value === values[0]?.value);
    const shown = same
      ? `scales ${values[0]?.text ?? ""}`
      : ANIMATION_SETTINGS.map(([name], index) => `${name} ${values[index]?.text ?? ""}`).join(
          ", ",
        );
    return warn(
      "animations",
      `${shown}, animations can make UI steps flaky`,
      hint(checks, ["shell"], [], "to turn animations off", ["--", ANIMATIONS_OFF]),
    );
  });
}

/** Keyboards that ship with Android or the Google apps. */
const STOCK_KEYBOARDS = new Set([
  "com.google.android.inputmethod.latin",
  "com.android.inputmethod.latin",
]);

/** Keyboards that test tools install to type text and often leave selected after a run. */
const AUTOMATION_KEYBOARDS = new Set([
  "com.android.adbkeyboard",
  "io.appium.settings",
  "com.github.uiautomator",
]);

export async function checkIme(checks: DeviceChecks): Promise<CheckResult> {
  return settle("ime", async () => {
    const answer = await runShell(
      checks.adb,
      checks.serial,
      "settings get secure default_input_method",
      { ...reads(checks), step: "reading the default keyboard" },
    );
    if (answer.exitCode !== 0) {
      return failed("ime", `the settings service does not answer (exit ${answer.exitCode})`);
    }
    const id = answer.stdout.trim();
    if (id === "" || id === "null") {
      return failed("ime", "no default keyboard is set, typing goes nowhere");
    }
    const pkg = id.split("/")[0] ?? id;
    if (AUTOMATION_KEYBOARDS.has(pkg)) {
      return warn(
        "ime",
        `${pkg} is still the default keyboard`,
        hint(checks, ["shell"], [], "to restore the default keyboard", ["--", "ime reset"]),
      );
    }
    return ok("ime", STOCK_KEYBOARDS.has(pkg) ? "standard keyboard" : pkg);
  });
}

export async function checkInstrumentation(checks: DeviceChecks): Promise<CheckResult> {
  return settle("instrumentation", async () => {
    const holders = await probeHolders(checks.adb, checks.serial, reads(checks));
    if (holders.length === 0) return ok("instrumentation", "none running");

    const holding = holders.filter((holder) => holder.uiAutomation);
    const packages = [...new Set((holding.length > 0 ? holding : holders).map((h) => h.package))];
    if (holding.length === 0) {
      return warn("instrumentation", `${packages.join(", ")} runs an instrumentation`);
    }
    const first = packages[0] ?? "";
    const next = checks.context.isShipped(["doctor", "ui"])
      ? hint(checks, ["doctor", "ui"], [], "to see what holds UiAutomation")
      : hint(checks, ["app", "stop"], [first], "to end its instrumentation");
    // The Android CLI keeps its UI server between commands. Unless it is wedged, it only
    // stands in the way of instrumentation tests.
    if (holding.every((holder) => holder.package === ANDROID_CLI_PACKAGE)) {
      const wedged = await readWedgedPids(checks.adb, checks.serial, reads(checks));
      const [host, devices, avd] = await Promise.all([
        checks.context.hostProcesses(Math.min(checks.context.deadline.remainingMs(), CHECK_CAP_MS)),
        listDevices(checks.adb, checks.context.deadline),
        avdName(checks.adb, checks.serial, null, {
          deadline: checks.context.deadline,
          env: checks.context.env,
        }),
      ]);
      const classified = classifyHolders({
        serial: checks.serial,
        instrumentations: holding,
        servers: [],
        wedgedPids: wedged,
        host,
        forwards: [],
        serials: new Set(devices.map((device) => device.serial)),
        avd,
        selfPid: process.pid,
      });
      const live = classified.filter((holder) => holder.state === "live");
      if (live.length > 0) {
        return warn(
          "instrumentation",
          `the Android CLI's UI server holds UiAutomation; ${live.map((holder) => (holder.why.startsWith("liveness unknown") ? holder.why : `in use by ${holder.why}`)).join("; ")}`,
          next,
        );
      }
      if (classified.every((holder) => holder.state === "resident")) {
        return warn(
          "instrumentation",
          "the Android CLI's UI server holds UiAutomation; harmless, but instrumentation tests cannot start while it runs",
          next,
        );
      }
    }
    return failed("instrumentation", `UiAutomation is held by ${packages.join(", ")}`, next);
  });
}

export async function checkConsoleToken(checks: DeviceChecks): Promise<CheckResult> {
  return settle("console_token", async () => {
    if (!checks.serial.startsWith("emulator-"))
      return ok("console_token", "no console on a physical device");

    const path = join(homeDir(checks.context.env), ".emulator_console_auth_token");
    const shown = tildePath(path, homeDir(checks.context.env));
    let token: string;
    try {
      token = readFileSync(path, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return warn(
          "console_token",
          `${shown} is missing, the emulator console may refuse commands`,
          ["Restart the emulator so it writes a fresh console token"],
        );
      }
      return failed("console_token", `${shown} cannot be read`);
    }
    if (token.trim() === "") {
      return failed("console_token", `${shown} is empty`, [
        "Restart the emulator so it writes a fresh console token",
      ]);
    }
    // A token the running emulator does not accept looks the same as a good one on disk.
    const response = await checks.adb.device(checks.serial, ["emu", "avd", "name"], {
      ...reads(checks),
      step: `checking the emulator console of ${checks.serial}`,
    });
    if (response.exitCode !== 0 || parseAvdName(response.stdout.toString("utf8")) === null) {
      return failed("console_token", "present, but the emulator console did not answer", [
        "Restart the emulator so its console token matches the one on disk",
      ]);
    }
    return ok("console_token", "token present, console answers");
  });
}
