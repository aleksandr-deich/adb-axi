import { spawnSync } from "node:child_process";
import { command } from "./core.js";

export function emulatorPid(processes, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const avd = new RegExp(`(?:^|\\s)-avd\\s+${escaped}(?=\\s|$)`);
  const matches = processes.split("\n").flatMap((line) => {
    const match = line.match(/^\s*([1-9]\d*)\s+(\S+)\s*(.*)$/);
    if (!match || !/^(?:emulator|qemu-system-[\w.-]+)$/.test(match[2].split("/").at(-1)))
      return [];
    return avd.test(`${match[2]} ${match[3]}`) ? [match[1]] : [];
  });
  if (matches.length !== 1) throw new Error(`Cannot identify one emulator process for ${name}`);
  return matches[0];
}
export class Devices {
  constructor(bins, names) {
    this.bins = bins;
    this.names = names;
    this.owned = [];
  }
  list() {
    return command(this.bins.adb, ["devices"])
      .split("\n")
      .slice(1)
      .filter((x) => /\S+\s+(device|offline|unauthorized)/.test(x))
      .map((x) => ({ serial: x.split(/\s/)[0], state: x.split(/\s+/)[1] }));
  }
  name(serial) {
    const consoleName = command(this.bins.adb, ["-s", serial, "emu", "avd", "name"])
      .split("\n")[0]
      .trim();
    // Some emulator consoles silently return no bytes after a restart. The boot
    // property is an independent identity check, not an assumed serial mapping.
    return (
      consoleName ||
      command(this.bins.adb, ["-s", serial, "shell", "getprop ro.boot.qemu.avd_name"]).trim()
    );
  }
  boot() {
    // Refuse an AVD already running, even if it has not registered with the server yet.
    const processes = command("/bin/ps", ["-axo", "command"]);
    for (const name of this.names)
      if (new RegExp(`-avd ${name.replaceAll(".", "\\.")}(?:\\s|$)`).test(processes))
        throw new Error(`AVD already in use: ${name}`);
    for (const name of this.names) {
      const before = new Set(this.list().map((d) => d.serial));
      command(this.bins.android, ["emulator", "start", "--headless", "--cold", name], {
        timeout: 240000,
      });
      const added = this.list().filter(
        (d) =>
          !before.has(d.serial) &&
          d.state === "device" &&
          d.serial.startsWith("emulator-") &&
          this.name(d.serial) === name,
      );
      if (added.length !== 1) throw new Error(`Cannot prove ownership of ${name}`);
      const d = { ...added[0], name };
      this.owned.push(d);
      this.ready(d);
      d.night = this.shell(d, "cmd uimode night").trim();
      d.density = this.shell(d, "wm density").trim();
    }
  }
  emulatorPid(d) {
    if (!this.owned.includes(d) || !this.current(d))
      throw new Error("Unowned or offline emulator");
    return emulatorPid(command("/bin/ps", ["-axo", "pid=,command="]), d.name);
  }
  assert(d) {
    if (
      !this.owned.includes(d) ||
      !/^emulator-\d+$/.test(d.serial) ||
      this.name(d.serial) !== d.name
    )
      throw new Error("Unowned emulator");
  }
  adb(d, args) {
    this.assert(d);
    return command(this.bins.adb, ["-s", d.serial, ...args]);
  }
  shell(d, text) {
    return this.adb(d, ["shell", text]);
  }
  ready(d) {
    const end = Date.now() + 120000;
    while (Date.now() < end) {
      try {
        if (
          this.shell(d, "getprop sys.boot_completed").trim() === "1" &&
          this.shell(d, "pm path android").includes("package:")
        )
          return;
      } catch {
        /* boot is transient */
      }
      spawnSync("/bin/sleep", ["1"]);
    }
    throw new Error(`Boot deadline: ${d.name}`);
  }
  current(d) {
    if (!this.owned.includes(d)) throw new Error("Unowned emulator");
    const matches = this.list().filter(
      (x) =>
        x.state === "device" && /^emulator-\d+$/.test(x.serial) && this.name(x.serial) === d.name,
    );
    if (matches.length > 1) throw new Error(`Ambiguous owned AVD: ${d.name}`);
    if (!matches.length) return false;
    d.serial = matches[0].serial;
    return true;
  }
  recover(d) {
    if (!this.current(d)) {
      const before = new Set(this.list().map((x) => x.serial));
      command(this.bins.android, ["emulator", "start", "--headless", "--cold", d.name], {
        timeout: 240000,
      });
      const added = this.list().filter(
        (x) =>
          !before.has(x.serial) &&
          x.state === "device" &&
          x.serial.startsWith("emulator-") &&
          this.name(x.serial) === d.name,
      );
      if (added.length !== 1) throw new Error("Cannot prove recovered ownership");
      d.serial = added[0].serial;
    }
    this.ready(d);
  }
  reset() {
    for (const d of this.owned) {
      this.recover(d);
      const night = d.night.match(/(?:Night mode: )?(yes|no|auto|custom)/i)?.[1];
      if (!night) throw new Error(`Unknown night setting: ${d.night}`);
      this.shell(d, `cmd uimode night ${night.toLowerCase()}`);
      const density = d.density.match(/Override density: (\d+)/)?.[1] ?? "reset";
      this.shell(d, `wm density ${density}`);
      this.shell(d, "am force-stop com.android.cli.interact.instrumentation");
      if (this.shell(d, "pm path dev.probe || true").includes("package:"))
        this.adb(d, ["uninstall", "dev.probe"]);
      this.adb(d, ["logcat", "-c"]);
      if (
        this.shell(d, "pm path dev.probe || true").includes("package:") ||
        this.shell(d, "pidof com.android.cli.interact.instrumentation || true").trim() ||
        this.shell(d, "cmd uimode night").trim() !== d.night ||
        this.shell(d, "wm density").trim() !== d.density
      )
        throw new Error("Reset verification failed");
    }
  }
  shutdown() {
    for (const d of this.owned) {
      if (!this.current(d)) continue;
      this.assert(d);
      command(this.bins.android, ["emulator", "stop", d.name], { timeout: 90000 });
      if (this.list().some((x) => x.serial === d.serial))
        throw new Error(`Owned emulator did not shut down: ${d.name}`);
    }
  }
}
