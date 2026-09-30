import { defineCommand } from "../define.js";

export const appRestore = defineCommand({
  path: ["app", "restore"],
  summary: "Reopen an app from recents so its saved state is restored",
  positionals: [
    { name: "pkg", description: "Package name, for example com.example.notes", required: true },
  ],
  examples: ["adb-axi app restore com.example.notes"],
});
