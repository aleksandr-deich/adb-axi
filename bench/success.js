import fs from "node:fs";
import path from "node:path";
import { root } from "./core.js";
// Recognize device-state output, not the executable that produced it. Unknown
// formats are not evidence; in particular, an AVD inventory is not an attached list.
export function deviceState(call, serial, name) {
  if ((call.args ?? []).some((arg) => ["--help", "-h"].includes(arg))) return null;
  const stdout = call.stdout ?? "";
  const text = `${stdout}\n${call.stderr ?? ""}`;
  if (call.status === 0) {
    try {
      const value = JSON.parse(stdout);
      if (Array.isArray(value.devices)) {
        const device = value.devices.find((d) => d.serial === serial || d.avd === name);
        if (!device) return "missing";
        if (device.state === "device") return "online";
        if (device.state === "offline") return "offline";
      }
    } catch {
      // Text listings and targeted errors below are also valid evidence.
    }
    const table = stdout.match(/^devices\[(\d+)\]\{([^}]+)\}:\s*\n?/m);
    if (table) {
      const fields = table[2].split(",");
      const rows = stdout
        .slice(table.index + table[0].length)
        .split("\n")
        .slice(0, Number(table[1]));
      const serialColumn = fields.indexOf("serial");
      const stateColumn = fields.indexOf("state");
      if (
        serialColumn >= 0 &&
        stateColumn >= 0 &&
        rows.length === Number(table[1]) &&
        rows.every((line) => line.trim().split(",").length === fields.length)
      ) {
        const row = rows
          .map((line) => line.trim().split(","))
          .find((values) => values[serialColumn] === serial);
        if (!row) return "missing";
        if (row[stateColumn] === "device") return "online";
        if (row[stateColumn] === "offline") return "offline";
      }
    }
    if (/^List of devices attached\s*$/m.test(stdout)) {
      const rows = stdout.split("\n").map((line) => line.trim().split(/\s+/));
      const row = rows.find((fields) => fields[0] === serial);
      if (!row) return "missing";
      if (row[1] === "device") return "online";
      if (row[1] === "offline") return "offline";
    }
  }
  const args = call.args ?? [];
  const waitIndex = args.findIndex((arg, index) => arg === "wait" && args[index + 1] === "boot");
  const target = args.flatMap((arg, index) =>
    ["--device", "-s"].includes(arg)
      ? [args[index + 1]]
      : arg.startsWith("--device=")
        ? [arg.slice(9)]
        : [],
  );
  if (
    call.status !== 0 &&
    waitIndex >= 0 &&
    target.length === 1 &&
    (target[0] === serial || target[0] === name)
  ) {
    for (const result of [stdout, call.stderr ?? ""]) {
      let error;
      let code;
      let state;
      try {
        const value = JSON.parse(result);
        error = typeof value.error === "string" ? value.error : value.error?.message;
        code = value.code;
        state = value.last?.state;
      } catch {
        error = result.match(/^error:\s*"?([^\n"]+)/m)?.[1];
        code = result.match(/^code:\s*"?([^\n"]+)/m)?.[1];
        state =
          result.match(/^last\.state:\s*"?(not attached|offline)\b/m)?.[1] ??
          result.match(/^last:\s*\n\s+state:\s*"?(not attached|offline)\b/m)?.[1];
      }
      if (
        typeof error === "string" &&
        (code === "WAIT_TIMEOUT" || /timed out|timeout|deadline/i.test(error)) &&
        (error.includes(serial) || error.includes(name)) &&
        ["not attached", "offline"].includes(state)
      )
        return state === "offline" ? "offline" : "missing";
    }
  }
  if (
    waitIndex >= 0 &&
    (target.length !== 1 ||
      (target[0] !== serial && target[0] !== name) ||
      /"last"\s*:|^last(?:\.state)?:/m.test(text))
  )
    return null;
  // Require identity and state in the same output line. A generic timeout or
  // a command's usage examples cannot establish the target's unavailable state.
  for (const line of text.split("\n")) {
    if (!line.includes(serial) && !line.includes(name)) continue;
    if (/\boffline\b/i.test(line)) return "offline";
    if (/not found|\bmissing\b|no attached device has/i.test(line)) return "missing";
    if (/\bunavailable\b/i.test(line)) return "unavailable";
  }
  return null;
}
const validBootId = (value) =>
  /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value) &&
  !/^0{8}(?:-0{4}){3}-0{12}$/.test(value);
// Keep exception evidence in the same fatal AndroidRuntime event and process.
// A launch crash can wrap the requested exception in RuntimeException.
function requestedCrash(logs) {
  const events = new Map();
  for (const line of logs.split("\n")) {
    const runtime = line.match(/^\s*\d+\.\d+\s+(\d+)\s+\d+\s+E\s+AndroidRuntime:\s+(.+)$/);
    if (!runtime) continue;
    const pid = runtime[1];
    const message = runtime[2].trimEnd();
    if (/^FATAL EXCEPTION:/.test(message)) events.set(pid, { process: false, cause: false });
    const event = events.get(pid);
    if (!event) continue;
    if (message === `Process: dev.probe, PID: ${pid}`) event.process = true;
    if (
      /^(?:Caused by: )?java\.lang\.IllegalStateException: probe crash requested\s*$/.test(message)
    )
      event.cause = true;
    if (event.process && event.cause) return true;
  }
  return false;
}
export function setupTask(task, devices) {
  const phone = devices.owned[0];
  if (task.id === "8") {
    phone.task8BootId = null;
    phone.task8EmulatorPid = null;
  }
  devices.reset();
  if (task.id === "8") {
    phone.task8BootId = devices.shell(phone, "cat /proc/sys/kernel/random/boot_id").trim();
    if (!validBootId(phone.task8BootId)) throw new Error("Invalid initial phone boot ID");
    phone.task8EmulatorPid = devices.emulatorPid(phone);
  }
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
  const measurement = (read) => {
    try {
      return { value: read(), error: null };
    } catch (error) {
      return { value: null, error: String(error) };
    }
  };
  const attached = id === "8" ? measurement(() => devices.current(phone)) : null;
  const calls = fs.existsSync(audit)
    ? fs
        .readFileSync(audit, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((x) => JSON.parse(x))
    : [];
  const output = calls.map((c) => `${c.stdout ?? ""}\n${c.stderr ?? ""}`).join("\n");
  const logs = id === "8" ? "" : devices.adb(phone, ["logcat", "-d", "-v", "epoch"]);
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
    checks.crash = requestedCrash(logs);
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
    const holders =
      typeof answer.holder === "string"
        ? (answer.holder.match(/\b(?:[a-z][\w]*\.)+[a-z][\w]*(?:\/[\w.$]+)?/g) ?? [])
        : [];
    checks.holderReport =
      holders.length > 0 &&
      holders.every((holder) =>
        /^com\.android\.cli\.interact\.instrumentation(?:[./][\w.$]+)?$/.test(holder),
      ) &&
      !/\bnot\s+com\.android\.cli\.interact\.instrumentation\b/i.test(answer.holder) &&
      answer.layoutWorks === true;
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
    const lifecycle = (c) =>
      c.status === 0 &&
      !c.args.some((arg) => ["--help", "-h"].includes(arg)) &&
      !/^(?:KO:|error:)/im.test(`${c.stdout ?? ""}\n${c.stderr ?? ""}`);
    const stops = calls.filter(
      (c) =>
        ((c.tool === "android" &&
          c.args[0] === "emulator" &&
          c.args[1] === "stop" &&
          c.args.at(-1) === phone.name) ||
          (c.tool === "adb" &&
            c.args[0] === "-s" &&
            c.args[1] === stoppedSerial &&
            c.args[2] === "emu" &&
            c.args[3] === "kill")) &&
        lifecycle(c),
    );
    const restarts = calls.filter(
      (c) =>
        c.tool === "android" &&
        c.args[0] === "emulator" &&
        c.args[1] === "start" &&
        c.args.at(-1) === phone.name &&
        lifecycle(c),
    );
    const states = calls
      .map((call) => ({ call, state: deviceState(call, stoppedSerial, phone.name) }))
      .filter(({ state }) => state !== null);
    const observations = states.filter(
      ({ call, state }) =>
        state !== "online" &&
        (stops.some(
          (s) => s.time < call.time && restarts.some((r) => r.time > call.time && r.time > s.time),
        ) ||
          (states.some((s) => s.state === "online" && s.call.time < call.time) &&
            states.some((s) => s.state === "online" && s.call.time > call.time))),
    );
    checks.stopped = observations.length > 0;
    checks.observed = observations.length > 0;
    evidence.unavailableStates = [...new Set(observations.map((s) => s.state))];
    const unavailable = {
      value: null,
      error: "Owned emulator not online; measurement unavailable",
    };
    const final = {
      attached,
      bootCompleted:
        attached.value === true
          ? measurement(() => devices.shell(phone, "getprop sys.boot_completed").trim())
          : unavailable,
      bootId:
        attached.value === true
          ? measurement(() => devices.shell(phone, "cat /proc/sys/kernel/random/boot_id").trim())
          : unavailable,
      emulatorPid:
        attached.value === true ? measurement(() => devices.emulatorPid(phone)) : unavailable,
    };
    const initial = {
      serial: stoppedSerial,
      bootId: phone.task8BootId ?? null,
      emulatorPid: phone.task8EmulatorPid ?? null,
    };
    // null means the measurement could not be made, distinct from a measured
    // false. Sample every conjunct independently, even after an earlier failure.
    const predicates = {
      observedUnavailable: observations.length > 0,
      attached: attached.value,
      bootCompleted: final.bootCompleted.value === null ? null : final.bootCompleted.value === "1",
      initialBootIdValid: initial.bootId === null ? null : validBootId(initial.bootId),
      finalBootIdValid: final.bootId.value === null ? null : validBootId(final.bootId.value),
      bootIdChanged:
        final.bootId.value === null || initial.bootId === null
          ? null
          : initial.bootId.toLowerCase() !== final.bootId.value.toLowerCase(),
      initialEmulatorPidValid:
        initial.emulatorPid === null ? null : /^[1-9]\d*$/.test(initial.emulatorPid),
      finalEmulatorPidValid:
        final.emulatorPid.value === null ? null : /^[1-9]\d*$/.test(final.emulatorPid.value),
      emulatorPidChanged:
        final.emulatorPid.value === null || initial.emulatorPid === null
          ? null
          : final.emulatorPid.value !== initial.emulatorPid,
    };
    evidence.recovery = { initial, final: { serial: phone.serial, ...final }, predicates };
    evidence.observations = observations.map(({ call, state }) => ({ time: call.time, state }));
    evidence.stopTimes = stops.map((call) => call.time);
    evidence.restartTimes = restarts.map((call) => call.time);
    checks.online = Object.values(predicates).every((value) => value === true);
    checks.report =
      (answer.unavailableState === "unavailable"
        ? observations.length > 0
        : evidence.unavailableStates.includes(answer.unavailableState)) &&
      answer.recovered === true;
  } else throw new Error("No success oracle");
  return {
    success: Object.values(checks).every(Boolean),
    checks,
    ...(Object.keys(evidence).length ? { evidence } : {}),
  };
}
