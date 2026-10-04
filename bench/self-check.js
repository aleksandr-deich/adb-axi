import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import console from "node:console";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { command, root, tasks, writeRecord } from "./core.js";
import { Devices } from "./devices.js";
import { environment } from "./run.js";
import { setupTask } from "./success.js";

export function evaluate(check, devices, answer, audit) {
  try {
    return check({ devices, finalAnswer: JSON.stringify(answer), audit });
  } catch (error) {
    return { success: false, error: String(error) };
  }
}
export async function selfCheck(options) {
  if (options.run || options.repeats !== 1)
    throw new Error("self-check never runs an agent; omit --run and use one repeat");
  const bins = Object.fromEntries(
    ["adb", "android", "node"].map((t) => [
      t,
      command("/bin/sh", ["-c", `command -v ${t}`]).trim(),
    ]),
  );
  const lock = path.join(os.tmpdir(), "android-repeatable-benchmark.lock");
  fs.mkdirSync(lock);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "android-benchmark-self-check-"));
  const devices = new Devices(bins, [options.phone, options.tablet]);
  devices.androidLayout = (d) => command(bins.android, ["layout", `--device=${d.serial}`]);
  const results = path.join(root, "bench/results/self-check");
  const records = [];
  try {
    devices.boot();
    for (const task of tasks().filter((t) => options.tasks.includes(t.id))) {
      const id = `${Date.now()}-${task.id}-${crypto.randomUUID()}`;
      const record = { id, task: task.id, kind: "self-check", agentRuns: 0, success: false };
      const checker = (await import(pathToFileURL(path.join(root, task.success)).href)).default;
      const reference = await import(pathToFileURL(path.join(root, task.reference)).href);
      let count = 0;
      const created = [];
      const context = () => {
        const directory = path.join(work, `${id}-${count++}`);
        const controlled = environment(
          directory,
          "baseline",
          options.version,
          bins,
          devices.owned,
          task.id,
        );
        const run = (tool, args, extra = {}) => {
          const r = spawnSync(path.join(directory, "bin", tool), args, {
            env: controlled.env,
            cwd: directory,
            encoding: "utf8",
            timeout: 240000,
            maxBuffer: 32 * 1024 * 1024,
            ...extra,
          });
          if (r.error || r.status !== 0)
            throw new Error(`${tool} ${args.join(" ")}: ${r.error?.message ?? r.stderr}`);
          return r.stdout;
        };
        const adb = (device, args, extra) =>
          run("adb", [...(device ? ["-s", device.serial] : []), ...args], extra);
        const shell = (device, text) => adb(device, ["shell", text]);
        const wait = (predicate) => {
          const deadline = Date.now() + 30000;
          while (Date.now() < deadline) {
            if (predicate()) return;
            spawnSync("/bin/sleep", ["0.25"]);
          }
          throw new Error("Reference state did not settle within 30 seconds");
        };
        const ctx = {
          directory,
          audit: controlled.audit,
          phone: devices.owned[0],
          tablet: devices.owned[1],
          adb,
          shell,
          wait,
          android: (args) => run("android", args),
          debug: path.join(root, "test/fixtures/apk/probe-debug.apk"),
          release: path.join(root, "test/fixtures/apk/probe-release.apk"),
        };
        created.push(ctx);
        return ctx;
      };
      const archive = (ctx, phase) => {
        fs.mkdirSync(results, { recursive: true });
        if (fs.existsSync(ctx.audit))
          fs.copyFileSync(ctx.audit, path.join(results, `${id}.${phase}.jsonl`));
      };
      try {
        setupTask(task, devices);
        const empty = context();
        record.setupOnly = evaluate(checker, devices, {}, empty.audit);
        record.setupRejected = record.setupOnly.success === false;
        archive(empty, "setup");
        devices.reset();
        setupTask(task, devices);
        const correctContext = context();
        const answer = reference.default(correctContext);
        record.reference = evaluate(checker, devices, answer, correctContext.audit);
        record.referencePassed = record.reference.success === true;
        // A forged correct-looking answer must not make untouched setup pass.
        devices.reset();
        setupTask(task, devices);
        const untouched = context();
        record.claimOnly = evaluate(checker, devices, answer, untouched.audit);
        record.claimRejected = record.claimOnly.success === false;
        archive(untouched, "claim");
        if (reference.freshWrongSetup) {
          const wrongContext = context();
          const wrongAnswer = reference.wrong(wrongContext, answer);
          record.wrong = evaluate(checker, devices, wrongAnswer, wrongContext.audit);
          archive(wrongContext, "wrong");
        } else {
          devices.reset();
          setupTask(task, devices);
          const wrongContext = context();
          const correctAgain = reference.default(wrongContext);
          record.wrong = evaluate(
            checker,
            devices,
            reference.wrong(wrongContext, correctAgain),
            wrongContext.audit,
          );
          archive(wrongContext, "wrong");
        }
        record.wrongRejected = record.wrong.success === false;
        record.success =
          record.setupRejected &&
          record.claimRejected &&
          record.referencePassed &&
          record.wrongRejected;
        archive(correctContext, "reference");
      } catch (error) {
        record.error = String(error);
      } finally {
        for (let i = 0; i < created.length; i++) archive(created[i], `attempt-${i}`);
        try {
          devices.reset();
          record.reset = "verified";
        } catch (error) {
          record.reset = String(error);
          record.success = false;
        }
        writeRecord(results, record);
      }
      records.push(record);
      console.log(JSON.stringify(record));
      if (record.reset !== "verified") throw new Error("Self-check reset failure; aborting");
    }
    if (records.some((r) => !r.success)) process.exitCode = 1;
    return records;
  } finally {
    try {
      devices.shutdown();
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
      fs.rmdirSync(lock);
    }
  }
}
