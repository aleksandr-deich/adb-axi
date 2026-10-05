export default function reference({ shell, android, phone }) {
  shell(phone, "dumpsys activity processes");
  shell(phone, "ps -A");
  shell(phone, "am force-stop --user 0 com.android.cli.interact.instrumentation");
  android(["layout", `--device=${phone.serial}`]);
  return { holder: "com.android.cli.interact.instrumentation", layoutWorks: true };
}
export function wrong({ shell, phone }) {
  shell(phone, "dumpsys activity processes");
  return { holder: "com.android.cli.interact.instrumentation", layoutWorks: true };
}
export function treatment({ axi, android, phone }) {
  axi(["doctor", "ui", "-s", phone.serial, "--json"]);
  axi(["app", "stop", "com.android.cli.interact.instrumentation", "-s", phone.serial]);
  android(["layout", `--device=${phone.serial}`]);
  return { holder: "com.android.cli.interact.instrumentation (Android CLI)", layoutWorks: true };
}
export function wrongReport(answer) {
  return { ...answer, holder: "com.unrelated.instrumentation" };
}
export const freshWrongSetup = true;
