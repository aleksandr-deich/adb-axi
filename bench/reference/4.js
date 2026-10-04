import fs from "node:fs";
import path from "node:path";
import { command } from "../core.js";
export default function reference({ adb, shell, phone, wait, directory, release }) {
  shell(phone, "am start -W -n dev.probe/.MainActivity --es probe write");
  wait(() => /event=write .*rows=1/.test(adb(phone, ["logcat", "-d", "-s", "ProbeState"])));
  for (const name of ["probe.db", "probe.db-wal"])
    fs.writeFileSync(
      path.join(directory, name),
      adb(phone, ["exec-out", "run-as", "dev.probe", "cat", `databases/${name}`], {
        encoding: null,
      }),
    );
  const rowText = command("/usr/bin/sqlite3", [
    path.join(directory, "probe.db"),
    "SELECT text FROM notes ORDER BY id;",
  ]).trim();
  adb(phone, ["uninstall", "dev.probe"]);
  adb(phone, ["install", release]);
  shell(phone, "am start -W -n dev.probe/.MainActivity --es probe write");
  wait(
    () =>
      adb(phone, ["logcat", "-d", "-s", "ProbeState"]).match(/event=write .*rows=1/g)?.length === 2,
  );
  const releaseError = shell(phone, "run-as dev.probe cat databases/probe.db 2>&1 || true").trim();
  return { rowText, releaseError };
}
export function wrong(context, correct) {
  return { ...correct, releaseError: "Read succeeded" };
}
