import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import process from "node:process";
import { spawnSync } from "node:child_process";

export const root = path.dirname(import.meta.dirname);
export const model = "openai-codex/gpt-6.1-sol";
export function parseTask(text, file = "task") {
  const t = JSON.parse(text);
  for (const k of ["id", "prompt", "setup", "reset", "success", "reference"])
    if (typeof t[k] !== "string" || !t[k]) throw new Error(`Missing task ${k}: ${file}`);
  if (
    !/^[1-8]$/.test(t.id) ||
    !["clean", "debug", "ui-holder"].includes(t.setup) ||
    t.reset !== "clean-both" ||
    t.success !== `bench/tasks/${t.id}.js` ||
    t.reference !== `bench/reference/${t.id}.js`
  )
    throw new Error(`Invalid task definition: ${file}`);
  if (/adb-axi|raw adb/i.test(t.prompt)) throw new Error(`Non-neutral prompt: ${file}`);
  return t;
}
export function tasks() {
  return fs
    .readdirSync(path.join(root, "bench/tasks"))
    .filter((x) => x.endsWith(".json"))
    .sort()
    .map((x) => {
      return parseTask(fs.readFileSync(path.join(root, "bench/tasks", x), "utf8"), x);
    });
}
export function plan(argv) {
  const opts = {
    run: false,
    repeats: 1,
    tasks: tasks().map((t) => t.id),
    maxRuns: 80,
    version: null,
    phone: "Pixel_10_Pro_XL",
    tablet: "medium_tablet",
    conditions: ["baseline", "adb-axi"],
    resultsDir: path.join(root, "bench/results"),
  };
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--"))
      throw new Error(`Options must use explicit -- flags: ${argv[i]}`);
    const key = argv[i].slice(2);
    if (key === "run") {
      opts.run = true;
      continue;
    }
    const keys = {
      repeats: "repeats",
      tasks: "tasks",
      "max-runs": "maxRuns",
      version: "version",
      phone: "phone",
      tablet: "tablet",
      "results-dir": "resultsDir",
    };
    if (!keys[key] || !argv[i + 1]) throw new Error(`Unknown or incomplete option: ${argv[i]}`);
    const value = argv[++i];
    seen.add(key);
    opts[keys[key]] = ["repeats", "max-runs"].includes(key)
      ? Number(value)
      : key === "tasks"
        ? value.split(",")
        : value;
  }
  if (opts.run && (!seen.has("repeats") || !seen.has("tasks") || !opts.version))
    throw new Error("--run requires explicit --repeats, --tasks and --version");
  for (const n of [opts.repeats, opts.maxRuns])
    if (!Number.isSafeInteger(n) || n < 1) throw new Error("Counts must be positive integers");
  const all = tasks().map((t) => t.id);
  if (
    !opts.tasks.length ||
    opts.tasks.some((t) => !all.includes(t)) ||
    new Set(opts.tasks).size !== opts.tasks.length
  )
    throw new Error("Unknown or duplicate task");
  if (opts.version && !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(opts.version))
    throw new Error("Version must be an exact release version");
  if (
    opts.phone === opts.tablet ||
    [opts.phone, opts.tablet].some(
      (x) =>
        !/^\w[\w.-]*$/.test(x) ||
        ["pixel_10_pro_xl_sasha", "small_phone"].includes(x.toLowerCase()),
    )
  )
    throw new Error("Unsafe AVD selection");
  opts.runs = opts.tasks.length * opts.conditions.length * opts.repeats;
  opts.resultsDir = path.resolve(opts.resultsDir);
  if (fs.existsSync(opts.resultsDir) && !fs.statSync(opts.resultsDir).isDirectory())
    throw new Error(`Results path is not a directory: ${opts.resultsDir}`);
  return opts;
}
export function command(bin, args, options = {}) {
  const r = spawnSync(bin, args, {
    encoding: "utf8",
    timeout: 60000,
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  if (r.error || r.status !== 0) {
    const error = new Error(
      `${bin} ${args.join(" ")}: ${r.error?.message ?? r.stderr ?? r.stdout}`,
    );
    error.stdout = r.stdout;
    throw error;
  }
  return r.stdout;
}
export function verifyPath(env, condition) {
  const found = spawnSync("/bin/sh", ["-c", "command -v adb-axi"], { env, encoding: "utf8" });
  const evidence = {
    path: env.PATH,
    command: "command -v adb-axi",
    status: found.status,
    resolved: found.stdout.trim(),
  };
  if (
    condition === "baseline"
      ? evidence.status === 0 || !!evidence.resolved
      : evidence.status !== 0 || !evidence.resolved
  )
    throw new Error("PATH condition violated");
  return evidence;
}
export function skillEvidence(directory, condition) {
  const evidence = [];
  const visit = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, e.name);
      if (e.isDirectory()) visit(file);
      else {
        const text = fs.readFileSync(file, "utf8");
        if (condition === "baseline" && /adb-axi/i.test(text))
          throw new Error(`Baseline skill contamination: ${file}`);
        if (e.name === "SKILL.md") {
          const name = text.match(/^name:\s*(.+)$/m)?.[1];
          if (!name || !/^description:/m.test(text)) throw new Error(`Invalid skill ${file}`);
          evidence.push({
            name,
            path: file,
            sha256: crypto.createHash("sha256").update(text).digest("hex"),
          });
        }
      }
    }
  };
  visit(directory);
  if (!evidence.length || new Set(evidence.map((s) => s.name)).size !== evidence.length)
    throw new Error("Empty or duplicate skills");
  return evidence;
}
export function writeRecord(dir, record) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${record.id}.json`);
  if (fs.existsSync(file)) throw new Error(`Record already exists: ${file}`);
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temporary, "wx");
    try {
      fs.writeFileSync(fd, JSON.stringify(record, null, 2) + "\n");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, file);
    const directory = fs.openSync(dir, "r");
    try {
      fs.fsyncSync(directory);
    } finally {
      fs.closeSync(directory);
    }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return file;
}
export function acquireLock(lock, names) {
  const claim = `${lock}.reclaim`;
  fs.mkdirSync(claim);
  try {
    let previous = null;
    if (fs.existsSync(lock)) {
      previous = JSON.parse(fs.readFileSync(path.join(lock, "owner.json"), "utf8"));
      try {
        process.kill(previous.pid, 0);
        throw new Error("Benchmark runner is still active");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
      if (JSON.stringify(previous.names) !== JSON.stringify(names))
        throw new Error(
          "Interrupted benchmark owns different AVDs; resume with its original AVD names",
        );
    } else fs.mkdirSync(lock);
    const owner = { pid: process.pid, names, owned: previous?.owned ?? [] };
    const file = path.join(lock, "owner.json");
    const temp = `${file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ ...owner, id: "owner" }));
    fs.renameSync(temp, file);
    return {
      previous,
      save(owned) {
        fs.writeFileSync(temp, JSON.stringify({ ...owner, owned }));
        fs.renameSync(temp, file);
      },
    };
  } finally {
    fs.rmdirSync(claim);
  }
}
export function readRecords(dir) {
  if (!fs.existsSync(dir)) return [];
  if (!fs.statSync(dir).isDirectory()) throw new Error(`Results path is not a directory: ${dir}`);
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json") && !f.endsWith(".invocation.json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
}
export function complete(record) {
  return typeof record.success === "boolean" && record.verdictProduced === true;
}
export function resumePlan(options, records, enforceCap = true) {
  const skipped = [],
    toRun = [],
    groups = [];
  for (const task of tasks().filter((t) => options.tasks.includes(t.id))) {
    for (const condition of options.conditions) {
      const group = { task: task.id, condition, done: 0, failedWithoutVerdict: 0, remaining: 0 };
      for (let repeat = 1; repeat <= options.repeats; repeat++) {
        const matching = records.filter(
          (r) => r.task === task.id && r.condition === condition && r.repeat === repeat,
        );
        if (matching.some(complete)) group.done++;
        else {
          group.remaining++;
          if (matching.length) group.failedWithoutVerdict++;
        }
      }
      groups.push(group);
    }
    for (let repeat = 1; repeat <= options.repeats; repeat++)
      for (const condition of options.conditions) {
        const run = { task: task.id, condition, repeat };
        (records.some(
          (r) =>
            r.task === run.task && r.condition === condition && r.repeat === repeat && complete(r),
        )
          ? skipped
          : toRun
        ).push(run);
      }
  }
  if (enforceCap && toRun.length > options.maxRuns)
    throw new Error(`${toRun.length} exceeds --max-runs ${options.maxRuns}`);
  return {
    skipped,
    toRun,
    skippedCount: skipped.length,
    toRunCount: toRun.length,
    groups,
    totalRemaining: toRun.length,
  };
}
export function manifestHashes() {
  const hashes = {};
  for (const condition of ["baseline", "adb-axi"]) {
    const manifest = fs.readFileSync(path.join(root, `bench/conditions/${condition}.json`));
    const hash = crypto.createHash("sha256").update(manifest);
    const visit = (dir, prefix) => {
      for (const entry of fs
        .readdirSync(dir, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name))) {
        const relative = `${prefix}/${entry.name}`;
        if (entry.isDirectory()) visit(path.join(dir, entry.name), relative);
        else hash.update(relative).update(fs.readFileSync(path.join(dir, entry.name)));
      }
    };
    for (const source of JSON.parse(manifest).skills) visit(path.join(root, source), source);
    hashes[condition] = hash.digest("hex");
  }
  return hashes;
}
export function assertConsistency(records, current) {
  const mismatches = [];
  for (const record of records)
    for (const field of [
      "model",
      "effort",
      "agentVersion",
      "adbAxiVersion",
      "benchmarkRevision",
      "skillManifestHashes",
    ])
      if (JSON.stringify(record[field]) !== JSON.stringify(current[field]))
        mismatches.push(
          `${record.id}: ${field}: recorded ${JSON.stringify(record[field])}, current ${JSON.stringify(current[field])}`,
        );
  if (mismatches.length) throw new Error(`Inconsistent experiment:\n${mismatches.join("\n")}`);
}
export function aggregate(records) {
  const groups = new Map();
  const completed = new Set();
  for (const r of records) {
    const key = `${r.task}/${r.condition}`;
    const g = groups.get(key) ?? {
      task: r.task,
      condition: r.condition,
      runs: 0,
      failedAttempts: 0,
      successes: 0,
      inputTokens: 0,
      cost: 0,
      turns: 0,
      wallTimeMs: 0,
      missingMetrics: 0,
    };
    if (!complete(r)) {
      g.failedAttempts++;
      groups.set(key, g);
      continue;
    }
    const slot = `${key}/${r.repeat}`;
    if (completed.has(slot)) continue;
    completed.add(slot);
    g.runs++;
    g.successes += Number(r.success === true);
    for (const k of ["inputTokens", "cost", "turns", "wallTimeMs"])
      if (typeof r[k] === "number") g[k] += r[k];
      else g.missingMetrics++;
    groups.set(key, g);
  }
  return [...groups.values()].map((g) => ({
    ...g,
    successRate: g.runs ? g.successes / g.runs : null,
  }));
}
