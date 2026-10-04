export default function reference({ adb, shell, phone, debug, wait }) {
  adb(phone, ["install", debug]);
  shell(phone, "am start -W -S -n dev.probe/.MainActivity");
  wait(() =>
    /event=start saved=0 volatile=0/.test(adb(phone, ["logcat", "-d", "-s", "ProbeState"])),
  );
  shell(phone, "dumpsys activity activities");
  return {};
}
export function wrong({ shell, phone }) {
  shell(phone, "input keyevent KEYCODE_HOME");
  return {};
}
