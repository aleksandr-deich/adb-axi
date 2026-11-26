import { AdbAxiError } from "../core/errors.js";
import { runHint } from "../core/output.js";
import { VERSION } from "../version.js";
import { defineCommand } from "./define.js";

export const ISSUES_URL = "https://github.com/aleksandr-deich/adb-axi/issues";

export const feedback = defineCommand({
  path: ["feedback"],
  summary: "Print what to put in a session note for adb-axi's author and where to post it",
  device: "none",
  hiddenGlobalFlags: ["--device", "--server", "--server-start", "--timeout", "--debug"],
  shipped: true,
  flags: [],
  examples: ["adb-axi feedback"],
  help: [
    "Run it only when your user asks; it reads no device and sends nothing",
    `Write a short plain-text impression for your user to paste into a new issue at ${ISSUES_URL}, check and submit`,
  ],
  run: (context) => {
    if (context.flags.device !== undefined) {
      throw new AdbAxiError("VALIDATION_ERROR", "feedback reads no device; omit --device", {
        help: [runHint(["feedback"])],
      });
    }
    return Promise.resolve({
      brief:
        "You used adb-axi in this session. Write a short, honest plain-text note for its author about what it was like to use: your own impression, not a log of the session. Say it plainly if you did not like it.",
      cover: [
        "the coding agent and model you are, and the adb-axi version below",
        "did you like using adb-axi, or would you rather have used raw adb, and why",
        "what felt good or saved you effort",
        "what was annoying or confusing, or made you go back to raw adb",
        "would you reach for it again next time",
      ],
      leave_out:
        "Leave out source code, file paths, package names and device serials, and keep it under 3,000 characters.",
      version: VERSION,
      issues: ISSUES_URL,
      help: [
        "Give your user the note and the issues link; they open a new issue there, paste the note, check it and submit. adb-axi posts nothing",
      ],
    });
  },
});
