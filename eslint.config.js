import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "node_modules/", "coverage/", "test/device/probe-app/"] },
  eslint.configs.recommended,
  tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
    rules: {
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
    },
  },
  {
    files: ["**/*.js"],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    // Waits poll observable state; only the poll loop, the process runner and the query
    // process (which cannot use the runner's deadline) set timers.
    files: ["src/**/*.ts"],
    ignores: ["src/core/poll.ts", "src/core/exec.ts", "src/commands/data/sqlite-child.ts"],
    rules: {
      "no-restricted-globals": [
        "error",
        { name: "setTimeout", message: "Poll observable state through src/core/poll.ts." },
        { name: "setInterval", message: "Poll observable state through src/core/poll.ts." },
      ],
    },
  },
  {
    // Host processes run only through src/core/exec.ts, with an argument array, never a shell.
    files: ["src/**/*.ts"],
    ignores: ["src/core/exec.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "node:child_process", message: "Run host processes through src/core/exec.ts." },
            { name: "child_process", message: "Run host processes through src/core/exec.ts." },
          ],
        },
      ],
    },
  },
  {
    files: ["src/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "Property[key.name='shell'][value.value=true]",
          message: "Never run a host process through a shell.",
        },
      ],
    },
  },
);
