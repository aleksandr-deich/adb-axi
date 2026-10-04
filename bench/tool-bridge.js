import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
const config = JSON.parse(fs.readFileSync(process.env.BENCH_TOOLS, "utf8"));
const [tool, ...args] = process.argv.slice(2);
const serials = config.devices.map((d) => d.serial);
const names = config.devices.map((d) => d.name);
let binary = config.bins[tool];
let forwarded = args;
function reject(message) {
  process.stderr.write(message + "\n");
  process.exit(2);
}
if (tool === "adb") {
  if (args[0] === "devices") {
    const r = spawnSync(binary, args, { encoding: "utf8", timeout: 10000 });
    const stdout =
      "List of devices attached\n" +
      (r.stdout ?? "")
        .split("\n")
        .filter((l) => serials.some((s) => l.startsWith(s) && /\s/.test(l[s.length] ?? "")))
        .join("\n") +
      "\n";
    fs.appendFileSync(
      config.audit,
      JSON.stringify({ time: Date.now(), tool, args, status: r.status, stdout, stderr: r.stderr }) +
        "\n",
    );
    process.stdout.write(stdout);
    process.exit(r.status ?? 1);
  }
  let serial = process.env.ANDROID_SERIAL;
  if (args[0] === "-s") {
    serial = args[1];
    forwarded = args.slice(2);
  }
  if (!serials.includes(serial)) reject("Select a benchmark-owned emulator by serial");
  if (["kill-server", "start-server", "connect", "disconnect", "reconnect"].includes(forwarded[0]))
    reject("Shared server operations are prohibited");
  forwarded = ["-s", serial, ...forwarded];
} else if (tool === "android") {
  if (args[0] === "emulator") {
    if (!["start", "stop"].includes(args[1]) || !names.includes(args.at(-1)))
      reject("Only owned AVD start/stop allowed");
  } else if (["layout", "screen", "install", "run"].includes(args[0])) {
    const target =
      args.find((a) => a.startsWith("--device="))?.slice(9) ?? args[args.indexOf("--device") + 1];
    if (!serials.includes(target)) reject("Explicit owned --device required");
  } else if (!["help", "docs", "--help", "--version", "-V"].includes(args[0]))
    reject("Unsupported benchmark operation");
} else if (tool === "adb-axi" || tool === "npx") {
  if (config.condition !== "adb-axi") reject("Unavailable tool");
  binary = config.bins.npx;
  if (tool === "npx") {
    const prefix = args[0] === "-y" ? 1 : 0;
    if (!/^adb-axi(?:@.*)?$/.test(args[prefix] ?? ""))
      reject("Only the selected published package is available");
    forwarded = args.slice(prefix + 1);
  }
  forwarded = ["-y", `adb-axi@${config.version}`, ...forwarded];
}
// Preserve a read-only database oracle before the agent replaces the debug build.
// This is not exposed to the agent and never drives the app.
if (
  config.task === "4" &&
  ["adb", "android"].includes(tool) &&
  (args.some((a) => ["install", "uninstall"].includes(a)) ||
    (tool === "adb" && forwarded[2] === "shell" && /^\s*pm\s+uninstall(?:\s|$)/.test(forwarded.slice(3).join(" "))))
) {
  const serial = config.devices[0].serial;
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR, "db-oracle-"));
  try {
    for (const name of ["probe.db", "probe.db-wal"]) {
      const copied = spawnSync(
        config.bins.adb,
        ["-s", serial, "exec-out", "run-as", "dev.probe", "cat", `databases/${name}`],
        { timeout: 10000 },
      );
      if (copied.status === 0) fs.writeFileSync(path.join(dir, name), copied.stdout);
    }
    if (fs.existsSync(path.join(dir, "probe.db"))) {
      const rows = spawnSync(
        "/usr/bin/sqlite3",
        [path.join(dir, "probe.db"), "SELECT id, text FROM notes ORDER BY id;"],
        { encoding: "utf8", timeout: 10000 },
      );
      fs.appendFileSync(
        config.audit,
        JSON.stringify({
          time: Date.now(),
          tool: "database-oracle",
          args: [],
          status: rows.status,
          stdout: rows.stdout,
          stderr: rows.stderr,
        }) + "\n",
      );
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
const r = spawnSync(binary, forwarded, {
  encoding: null,
  timeout: 180000,
  maxBuffer: 16 * 1024 * 1024,
  env: { ...process.env, BENCH_OBSERVER_DEPTH: "1" },
});
const completedAt = Date.now();
fs.appendFileSync(
  config.audit,
  JSON.stringify({
    time: completedAt,
    tool,
    args,
    status: r.status,
    stdout: r.stdout?.toString("utf8"),
    stderr: r.stderr?.toString("utf8"),
  }) + "\n",
);
// A neutral device-state oracle observes clearing without requiring a particular
// tool or command. Observe only outer calls so nested CLI transport adds no samples.
if (config.task === "6" && process.env.BENCH_OBSERVER_DEPTH !== "1") {
  const holder = spawnSync(
    config.bins.adb,
    [
      "-s",
      config.devices[0].serial,
      "shell",
      "pidof com.android.cli.interact.instrumentation || true",
    ],
    { encoding: "utf8", timeout: 10000 },
  );
  fs.appendFileSync(
    config.audit,
    JSON.stringify({
      time: completedAt,
      tool: "ui-holder-oracle",
      args: [],
      status: holder.status,
      stdout: holder.stdout ?? "",
      stderr: holder.stderr ?? "",
    }) + "\n",
  );
}
process.stdout.write(r.stdout ?? "");
process.stderr.write(r.stderr ?? "");
// Do not terminate before large piped output drains, and keep exec-out bytes intact.
process.exitCode = r.status ?? 1;
