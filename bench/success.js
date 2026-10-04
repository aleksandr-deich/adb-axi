import fs from "node:fs";
import path from "node:path";
import { root } from "./core.js";
export function setupTask(task, devices) {
  devices.reset();
  const phone = devices.owned[0];
  if (["debug", "ui-holder"].includes(task.setup)) {
    devices.adb(phone, ["install", path.join(root, "test/fixtures/apk/probe-debug.apk")]);
    devices.shell(phone, "am start -W -n dev.probe/.MainActivity");
  }
  if (task.setup === "ui-holder") {
    devices.androidLayout(phone);
    phone.uiHolderPid = devices
      .shell(phone, "pidof com.android.cli.interact.instrumentation || true")
      .trim();
    if (
      !/^\d+$/.test(phone.uiHolderPid) ||
      !devices
        .shell(phone, "dumpsys activity processes")
        .includes("com.android.cli.interact.instrumentation")
    )
      throw new Error("Resident UI holder not established");
  }
}
export function checkTask(id, { devices, finalAnswer, audit }) {
  const phone = devices.owned[0];
  const stoppedSerial = id === "8" ? phone.serial : null;
  const recoveredOnline = id === "8" ? devices.current(phone) : false;
  const calls = fs.existsSync(audit)
    ? fs
        .readFileSync(audit, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((x) => JSON.parse(x))
    : [];
  const output = calls.map((c) => `${c.stdout ?? ""}\n${c.stderr ?? ""}`).join("\n");
  const logs = devices.adb(phone, ["logcat", "-d", "-v", "epoch"]);
  const foreground = (d) =>
    /(?:mResumedActivity|topResumedActivity).*dev\.probe/.test(
      devices.shell(d, "dumpsys activity activities"),
    );
  let answer = {};
  try {
    answer = JSON.parse(finalAnswer);
  } catch {
    /* Invalid reports fail their criteria. */
  }
  if (!answer || typeof answer !== "object") answer = {};
  const checks = {};
  const evidence = {};
  if (id === "1" || id === "7") {
    for (const d of id === "7" ? devices.owned : [phone]) {
      checks[`${d.name}:installed`] =
        devices.shell(d, "pm path dev.probe").includes("package:") &&
        /DEBUGGABLE/.test(devices.shell(d, "dumpsys package dev.probe"));
      checks[`${d.name}:foreground`] = foreground(d);
      checks[`${d.name}:cold-start`] = /event=start saved=0 volatile=0 .*restored=false/.test(
        devices.adb(d, ["logcat", "-d", "-s", "ProbeState"]),
      );
      if (id === "7")
        checks[`${d.name}:report`] =
          answer[d === phone ? "phone" : "tablet"]?.serial === d.serial &&
          answer[d === phone ? "phone" : "tablet"]?.foreground === "dev.probe";
    }
  } else if (id === "2") {
    const before = logs.match(/event=inc saved=3 volatile=3 .*pid=(\d+)/);
    const after = logs.match(/event=start saved=3 volatile=0 .*restored=true pid=(\d+)/);
    checks.processDeath = !!before && !!after && before[1] !== after[1];
    checks.foreground = foreground(phone);
    const currentPid = devices.shell(phone, "pidof dev.probe || true").trim();
    const states = [
      ...logs.matchAll(
        /^\s*\d+\.\d+\s+(\d+)\s+\d+\s+I\s+ProbeState:\s+event=\w+ saved=(\d+) volatile=(\d+) .*pid=(\d+)\s*$/gm,
      ),
    ].filter((m) => m[1] === m[4] && m[4] === currentPid);
    const current = states.at(-1);
    checks.currentCounters = !!current && current[2] === "3" && current[3] === "0";
    checks.report =
      answer.before?.saved === 3 &&
      answer.before?.unsaved === 3 &&
      answer.after?.saved === 3 &&
      answer.after?.unsaved === 0 &&
      answer.savedSurvived === true &&
      answer.unsavedReset === true;
  } else if (id === "3") {
    const runtime = logs.match(
      /^\s*\d+\.\d+\s+(\d+)\s+\d+\s+E\s+AndroidRuntime:\s+Process: dev\.probe, PID: (\d+)\s*$/m,
    );
    checks.crash =
      !!runtime &&
      runtime[1] === runtime[2] &&
      new RegExp(
        `^\\s*\\d+\\.\\d+\\s+${runtime[1]}\\s+\\d+\\s+E\\s+AndroidRuntime:\\s+java\\.lang\\.IllegalStateException: probe crash requested\\s*$`,
        "m",
      ).test(logs);
    checks.report =
      ["IllegalStateException", "java.lang.IllegalStateException"].includes(answer.exception) &&
      answer.message === "probe crash requested";
  } else if (id === "4") {
    checks.debugWrite = /event=write .*rows=1/.test(logs);
    checks.databaseRow = calls.some(
      (c) =>
        c.tool === "database-oracle" &&
        c.status === 0 &&
        /(?:^|\n)1\|probe-1(?:\n|$)/.test(c.stdout),
    );
    checks.rowRead =
      calls.some((c) => c.tool !== "database-oracle" && /probe-1/.test(c.stdout ?? "")) &&
      answer.rowText === "probe-1";
    checks.releaseInstalled =
      !/DEBUGGABLE/.test(devices.shell(phone, "dumpsys package dev.probe")) &&
      devices.shell(phone, "pm path dev.probe").includes("package:");
    const releasePid = devices.shell(phone, "pidof dev.probe || true").trim();
    checks.releaseWrite =
      /^\d+$/.test(releasePid) &&
      new RegExp(`event=write .*rows=[1-9]\\d* .*pid=${releasePid}(?:\\s|$)`).test(logs);
    checks.refusedRead =
      /not debuggable|APP_NOT_DEBUGGABLE/i.test(output) &&
      /not debuggable/i.test(devices.shell(phone, "run-as dev.probe ls databases 2>&1 || true"));
    checks.report =
      typeof answer.releaseError === "string" &&
      /not debuggable|non-debuggable|APP_NOT_DEBUGGABLE/i.test(answer.releaseError);
  } else if (id === "5") {
    const opposite = /yes/i.test(phone.night) ? "no" : "yes";
    checks.changedObserved = calls.some(
      (c) =>
        c.tool === "adb" &&
        c.args.join(" ").includes("cmd uimode night") &&
        new RegExp(`Night mode: ${opposite}`, "i").test(c.stdout ?? ""),
    );
    checks.restored = devices.shell(phone, "cmd uimode night").trim() === phone.night;
    const original = phone.night
      .match(/(?:Night mode: )?(yes|no|auto|custom)/i)?.[1]
      ?.toLowerCase();
    checks.report =
      answer.original === original && answer.changed === opposite && answer.restored === original;
  } else if (id === "6") {
    checks.holderReport =
      answer.holder === "com.android.cli.interact.instrumentation" && answer.layoutWorks === true;
    checks.diagnosed = /com.android.cli.interact/.test(output);
    const clear = calls.find(
      (c) =>
        c.tool === "ui-holder-oracle" &&
        c.status === 0 &&
        /^(?:\d+(?:\s+\d+)*)?\s*$/.test(c.stdout) &&
        /^\d+$/.test(phone.uiHolderPid ?? "") &&
        !c.stdout.trim().split(/\s+/).includes(phone.uiHolderPid),
    );
    evidence.initialHolderPid = phone.uiHolderPid;
    evidence.clearedAt = clear?.time ?? null;
    checks.cleared = !!clear;
    checks.layout =
      !!clear &&
      calls.some((c) => {
        if (c.time < clear.time || c.tool !== "android" || c.args[0] !== "layout" || c.status !== 0)
          return false;
        try {
          const layout = JSON.parse(c.stdout);
          return (
            Array.isArray(layout) &&
            layout.some(
              (window) =>
                typeof window?.["window-title"] === "string" &&
                Array.isArray(window.content) &&
                window.content.length > 0,
            )
          );
        } catch {
          return false;
        }
      });
  } else if (id === "8") {
    const stop = calls.find(
      (c) =>
        ((c.tool === "android" && c.args[0] === "emulator" && c.args[1] === "stop") ||
          (c.tool === "adb" && c.args.join(" ").includes("emu kill"))) &&
        c.status === 0,
    );
    const restart = calls.find(
      (c) =>
        stop &&
        c.time > stop.time &&
        c.tool === "android" &&
        c.args[0] === "emulator" &&
        c.args[1] === "start" &&
        c.status === 0,
    );
    checks.stopped = !!stop;
    checks.observed =
      !!stop &&
      calls.some(
        (c) =>
          c.tool === "adb" &&
          c.time >= stop.time &&
          (!restart || c.time < restart.time) &&
          ((c.args[0] === "devices" &&
            c.status === 0 &&
            !(c.stdout ?? "").includes(stoppedSerial)) ||
            /offline|not found|missing|unavailable/i.test(`${c.stdout ?? ""}\n${c.stderr ?? ""}`)),
      );
    checks.online =
      recoveredOnline && devices.shell(phone, "getprop sys.boot_completed").trim() === "1";
    checks.report =
      ["offline", "missing", "unavailable"].includes(answer.unavailableState) &&
      answer.recovered === true;
  } else throw new Error("No success oracle");
  return {
    success: Object.values(checks).every(Boolean),
    checks,
    ...(Object.keys(evidence).length ? { evidence } : {}),
  };
}
