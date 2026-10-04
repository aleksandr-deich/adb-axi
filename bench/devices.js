import { spawnSync } from "node:child_process";
import { command } from "./core.js";

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
    return command(this.bins.adb, ["-s", serial, "emu", "avd", "name"]).split("\n")[0].trim();
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
  recover(d) {
    if (!this.list().some((x) => x.serial === d.serial && x.state === "device")) {
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
    for (const d of this.owned)
      if (this.list().some((x) => x.serial === d.serial && x.state === "device"))
        this.adb(d, ["emu", "kill"]);
  }
}
