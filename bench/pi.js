import fs from "node:fs";
import path from "node:path";
import { command, model } from "./core.js";

export function parsePi(text) {
  const events = text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const messages = events
    .filter((e) => e.type === "message_end" && e.message?.role === "assistant")
    .map((e) => e.message);
  const usage = [
    ...messages.map((m) => m.usage),
    ...events
      .filter((e) => e.type === "compaction_end" && e.result?.usage)
      .map((e) => e.result.usage),
  ];
  if (
    !messages.length ||
    usage.some(
      (u) =>
        !u ||
        ![u.input, u.cacheRead ?? 0, u.cacheWrite ?? 0, u.cost?.total].every(
          (n) => Number.isFinite(n) && n >= 0,
        ),
    )
  )
    throw new Error("Pi returned no usable usage/cost data");
  const sum = (f) => usage.reduce((n, u) => n + f(u), 0);
  return {
    inputTokens: sum((u) => u.input + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0)),
    cost: sum((u) => u.cost.total),
    turns: messages.length,
    finalAnswer: messages
      .at(-1)
      .content.filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n"),
    agentError: messages.some((m) => ["error", "aborted"].includes(m.stopReason)),
  };
}
export function runPi({ binary, env, cwd, skills, prompt, output }) {
  const args = [
    "--print",
    "--mode",
    "json",
    "--model",
    model,
    "--thinking",
    "medium",
    "--no-extensions",
    "--no-skills",
    "--no-context-files",
    "--no-prompt-templates",
    "--no-themes",
    "--no-session",
    "--offline",
    "--tools",
    "read,bash,edit,write",
  ];
  for (const s of skills) args.push("--skill", s.path);
  args.push("--", prompt);
  fs.writeFileSync(
    path.join(cwd, "pi-invocation.json"),
    JSON.stringify({ args, configDir: env.PI_CODING_AGENT_DIR }, null, 2),
  );
  let text;
  try {
    text = command(binary, args, { env, cwd, timeout: 900000 });
  } catch (error) {
    if (error.stdout) {
      fs.writeFileSync(output, error.stdout);
      try {
        error.metrics = parsePi(error.stdout);
      } catch {}
    }
    throw error;
  }
  fs.writeFileSync(output, text);
  return parsePi(text);
}
