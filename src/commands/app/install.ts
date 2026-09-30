import { defineCommand } from "../define.js";

export const appInstall = defineCommand({
  path: ["app", "install"],
  summary: "Install an APK, keeping app data, and wait until the new version is live",
  positionals: [{ name: "apk", description: "Path to the APK on this machine", required: true }],
  flags: [
    {
      name: "--clean-data",
      type: "boolean",
      description: "Wipe the app's data as part of the install",
    },
    {
      name: "--if-changed",
      type: "boolean",
      description: "Skip the install when the same versionCode and signature are installed",
    },
  ],
  defaultTimeoutMs: 180_000,
  examples: [
    "adb-axi app install app/build/outputs/apk/debug/app-debug.apk",
    "adb-axi app install app-debug.apk --if-changed",
  ],
});
