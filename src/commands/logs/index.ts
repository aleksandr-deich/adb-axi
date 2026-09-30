import { defineGroup } from "../define.js";
import { logsCrash } from "./crash.js";
import { logsDump } from "./dump.js";
import { logsMark } from "./mark.js";

export const logs = defineGroup({
  name: "logs",
  summary: "Run-scoped logs and crashes",
  defaultCommand: logsDump,
  subcommands: [logsMark, logsCrash],
});
