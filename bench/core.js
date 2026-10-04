import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
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
  if (opts.runs > opts.maxRuns) throw new Error(`${opts.runs} exceeds --max-runs ${opts.maxRuns}`);
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
  fs.writeFileSync(file, JSON.stringify(record, null, 2) + "\n", { flag: "wx" });
  return file;
}
export function aggregate(records) {
  const groups = new Map();
  for (const r of records) {
    const key = `${r.task}/${r.condition}`;
    const g = groups.get(key) ?? {
      task: r.task,
      condition: r.condition,
      runs: 0,
      successes: 0,
      inputTokens: 0,
      cost: 0,
      turns: 0,
      wallTimeMs: 0,
      missingMetrics: 0,
    };
    g.runs++;
    g.successes += Number(r.success === true);
    for (const k of ["inputTokens", "cost", "turns", "wallTimeMs"])
      if (typeof r[k] === "number") g[k] += r[k];
      else g.missingMetrics++;
    groups.set(key, g);
  }
  return [...groups.values()].map((g) => ({ ...g, successRate: g.successes / g.runs }));
}
