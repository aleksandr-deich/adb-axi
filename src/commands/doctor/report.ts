import type { Output } from "../../core/output.js";
import { defineCommand } from "../define.js";
import type { CommandContext } from "../types.js";
import {
  checkAnimations,
  checkBoot,
  checkConsoleToken,
  checkDataFree,
  checkIme,
  checkInstrumentation,
} from "./device-checks.js";
import { checkAdb, checkDevice, checkServer } from "./host-checks.js";
import type { CheckResult } from "./result.js";

export const doctorReport = defineCommand({
  path: ["doctor"],
  summary: "Check the host, the adb server and the target for things that break a run",
  // The report is the answer: the host and every attached device are always examined, so
  // a missing or offline target is a finding here, not an error that stops the command.
  device: "none",
  examples: ["adb-axi doctor", "adb-axi doctor --device emulator-5554"],
  shipped: true,
  run: runDoctor,
});

async function runDoctor(context: CommandContext): Promise<Output> {
  const results: CheckResult[] = [];
  let target: string | undefined;

  // Each stage needs the one before it: no adb, no server; no server, no devices; no usable
  // device, none of the checks that read from it. What cannot run is not reported.
  const adb = await checkAdb(context);
  results.push(adb);
  if (adb.status !== "failed") {
    const server = await checkServer(context);
    results.push(server.result);
    if (server.devices !== undefined) {
      const device = await checkDevice(context, server.devices);
      results.push(device.result);
      if (device.target !== undefined) {
        target = device.target.serial;
        results.push(...(await checkTarget(context, target)));
      }
    }
  }
  return report(results, target);
}

/** The checks that read from the resolved device, in the order they are reported. */
async function checkTarget(context: CommandContext, serial: string): Promise<CheckResult[]> {
  const checks = { context, adb: context.adb(), serial };
  return Promise.all([
    checkBoot(checks),
    checkDataFree(checks),
    checkAnimations(checks),
    checkIme(checks),
    checkInstrumentation(checks),
    checkConsoleToken(checks),
  ]);
}

function report(results: readonly CheckResult[], target: string | undefined): Output {
  const count = (status: CheckResult["status"]): number =>
    results.filter((result) => result.status === status).length;
  const failures = count("failed");
  // A failed check is the answer to the question, not a failure to answer: the report keeps
  // its shape and the exit code says the target is not healthy.
  if (failures > 0) process.exitCode = 1;

  const help = [...new Set(results.flatMap((result) => result.help))];
  return {
    summary: `${results.length} run, ${count("ok")} ok, ${count("warn")} warn, ${failures} failed`,
    ...(target === undefined ? {} : { target }),
    checks: results.map(({ check, status, detail }) => ({ check, status, detail })),
    ...(help.length > 0 ? { help } : {}),
  };
}
