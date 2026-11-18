import { readFileSync } from "node:fs";
import { AdbAxiError } from "../core/errors.js";
import { runHint, type Output } from "../core/output.js";
import { VERSION } from "../version.js";
import { defineCommand } from "./define.js";

export const ISSUE_FORM_URL =
  "https://github.com/aleksandr-deich/adb-axi/issues/new?template=agent-report.yml";

/** Longest prefilled link adb-axi prints; longer ones are cut off by browsers or GitHub. */
export const MAX_URL_LENGTH = 8_000;

const TITLE_PREFIX = "Agent report";

/** The issue form's dropdown options, keyed by the `--device-kind` value. */
const DEVICE_OPTIONS = { emulator: "Emulator", phone: "Physical phone", both: "Both" } as const;
type DeviceKind = keyof typeof DEVICE_OPTIONS;

const BRIEF =
  "You used adb-axi in this session. Write a short factual report for its author, using only what actually happened; no guessing, no praise.";
const COVER = [
  "the task in one line",
  "every adb-axi command you ran and whether it worked, with exact errors",
  "every raw adb command you ran instead and why",
  "anywhere the output or --help was unclear or made you retry",
  "anything on the device neither tool made easy",
];
const LEAVE_OUT =
  "Leave out source code, file paths, package names and device serials, and keep it under 3,000 characters.";

const SUBMIT = [
  "feedback",
  "--agent",
  "'<agent and model>'",
  "--device-kind",
  "<emulator|phone|both>",
  "--report",
  "<file>",
];

/** Things a shared report should not carry; each match is a warning, never a refusal. */
const PRIVATE_PATTERNS: readonly { kind: string; pattern: RegExp }[] = [
  {
    kind: "absolute path",
    pattern: /(?:\/(?:Users|home|root|private|Volumes)\/|\b[A-Za-z]:\\)\S*/g,
  },
  { kind: "emulator serial", pattern: /\bemulator-\d+\b/g },
  { kind: "network device serial", pattern: /\b(?:\d{1,3}\.){3}\d{1,3}:\d{1,5}\b/g },
  {
    kind: "wireless device serial",
    pattern: /\badb-[\w-]+\._adb-tls-(?:connect|pairing)\._tcp\b/g,
  },
  {
    kind: "device serial",
    pattern: /\b(?=[A-Z0-9]*[A-Z])(?=(?:[A-Z]*\d){2})[A-Z0-9]{8,16}\b/g,
  },
];

export const feedback = defineCommand({
  path: ["feedback"],
  summary:
    "Print what to put in a session report for adb-axi's author, or turn a written report into a prefilled GitHub issue link",
  device: "none",
  hiddenGlobalFlags: ["--device", "--server", "--server-start", "--timeout", "--debug"],
  shipped: true,
  flags: [
    {
      name: "--report",
      type: "string",
      valueName: "<file|->",
      description: "The written report, as a file or - for stdin",
    },
    {
      name: "--agent",
      type: "string",
      valueName: "<text>",
      description: "The coding agent and model that ran the session; required with --report",
    },
    {
      name: "--device-kind",
      type: "enum",
      values: Object.keys(DEVICE_OPTIONS),
      description: "What the session ran on: an emulator, a physical phone, or both",
      default: "left for the person to choose",
    },
    {
      name: "--title",
      type: "string",
      valueName: "<text>",
      description: `Issue title after "${TITLE_PREFIX}: "`,
      default: TITLE_PREFIX,
    },
  ],
  examples: [
    "adb-axi feedback",
    "adb-axi feedback --agent 'Claude Code with Sonnet' --device-kind emulator --report report.md",
  ],
  help: [
    "Run it only when your user asks for a report; it reads no device and sends nothing",
    `The link opens the ${ISSUE_FORM_URL} form with the title, agent, adb-axi version, device and report filled in; the person opens it, reviews every field, ticks the privacy check and submits`,
    `A link longer than ${MAX_URL_LENGTH.toLocaleString("en-US")} characters is refused; shorten the report and run it again`,
    "Absolute paths and device serials in the report are listed as warnings so they can be removed before sharing",
  ],
  run: (context) => {
    const { report, agent, title } = context.flags;
    const device = context.flags["device-kind"];
    if (report === undefined) {
      if (agent !== undefined || device !== undefined || title !== undefined) {
        throw usage("--report is required to build the issue link", "with your written report");
      }
      return Promise.resolve(instructions());
    }
    if (typeof agent !== "string" || agent.trim() === "") {
      throw usage("--agent is required with --report", "naming the agent and model");
    }
    return Promise.resolve(
      issueLink({
        report: readReport(String(report)),
        agent: agent.trim(),
        device: typeof device === "string" ? (device as DeviceKind) : undefined,
        title: typeof title === "string" ? title.trim() : undefined,
      }),
    );
  },
});

function instructions(): Output {
  return {
    brief: BRIEF,
    cover: COVER,
    leave_out: LEAVE_OUT,
    help: [
      runHint(
        SUBMIT,
        "once the report is saved, to get a prefilled issue link; pass --report - to read it from stdin",
      ),
    ],
  };
}

interface IssueInput {
  report: string;
  agent: string;
  device: DeviceKind | undefined;
  title: string | undefined;
}

function issueLink(input: IssueInput): Output {
  const title =
    input.title === undefined || input.title === "" || input.title === TITLE_PREFIX
      ? TITLE_PREFIX
      : `${TITLE_PREFIX}: ${input.title}`;
  const fields: [string, string][] = [
    ["title", title],
    ["agent", input.agent],
    ["version", VERSION],
    ...(input.device === undefined
      ? []
      : [["device", DEVICE_OPTIONS[input.device]] as [string, string]]),
    ["report", input.report],
  ];
  const url = `${ISSUE_FORM_URL}&${fields.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join("&")}`;
  if (url.length > MAX_URL_LENGTH) {
    throw new AdbAxiError(
      "REPORT_TOO_LONG",
      `the issue link would be ${url.length.toLocaleString("en-US")} characters, over the ${MAX_URL_LENGTH.toLocaleString("en-US")}-character limit`,
      {
        fields: {
          url_length: url.length,
          limit: MAX_URL_LENGTH,
          report_characters: input.report.length,
        },
        help: [
          runHint(
            SUBMIT,
            `again after cutting at least ${(url.length - MAX_URL_LENGTH).toLocaleString("en-US")} link characters from the report; non-ASCII text and punctuation take several each`,
          ),
        ],
      },
    );
  }
  const warnings = privateMatches(input.report);
  return {
    url,
    title,
    agent: input.agent,
    version: VERSION,
    device: input.device === undefined ? "not set" : DEVICE_OPTIONS[input.device],
    report: `${input.report.length.toLocaleString("en-US")} characters`,
    ...(warnings.length === 0 ? {} : { warnings }),
    help: [
      ...(warnings.length === 0
        ? []
        : [
            "The report may hold private details listed in warnings; remove them and run it again unless they are safe to share",
          ]),
      "Give the url to your user to open, review every field, tick the privacy check and submit; adb-axi posted nothing",
    ],
  };
}

function readReport(source: string): string {
  let text: string;
  try {
    text = readFileSync(source === "-" ? 0 : source, "utf8");
  } catch (error) {
    const reason = error instanceof Error && "code" in error ? String(error.code) : String(error);
    throw usage(
      `cannot read the report from ${source === "-" ? "stdin" : source} (${reason})`,
      "with a readable report file",
    );
  }
  const report = text.trimEnd();
  if (report.trim() === "") {
    throw usage(
      `the report from ${source === "-" ? "stdin" : source} is empty`,
      "after writing the report",
    );
  }
  return report;
}

function privateMatches(report: string): { kind: string; text: string }[] {
  const seen = new Set<string>();
  const matches: { kind: string; text: string }[] = [];
  for (const { kind, pattern } of PRIVATE_PATTERNS) {
    for (const match of report.matchAll(pattern)) {
      const text = match[0].replace(/[.,;:!?)\]}'"`>]+$/, "");
      if (seen.has(text)) continue;
      seen.add(text);
      matches.push({ kind, text });
    }
  }
  return matches;
}

function usage(message: string, reason: string): AdbAxiError {
  return new AdbAxiError("VALIDATION_ERROR", message, { help: [runHint(SUBMIT, reason)] });
}
