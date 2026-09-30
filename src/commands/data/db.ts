import { defineCommand } from "../define.js";

export const dataDb = defineCommand({
  path: ["data", "db"],
  summary: "List an app's databases, or run a read-only query on a copy that includes the WAL",
  positionals: [
    { name: "pkg", description: "Package name of a debuggable app", required: true },
    { name: "sql", description: "A read-only SQL query", required: false },
  ],
  flags: [
    {
      name: "--db",
      type: "string",
      valueName: "<name>",
      description: "Database file name, required when the app has several",
    },
    { name: "--full", type: "boolean", description: "Write rows past the cap to a file" },
  ],
  examples: [
    "adb-axi data db com.example.notes",
    "adb-axi data db com.example.notes 'SELECT id, title FROM note LIMIT 3'",
  ],
});
