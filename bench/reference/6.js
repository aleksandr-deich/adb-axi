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
export const freshWrongSetup = true;
