export default function reference({ adb, shell, phone, wait }) {
  for (let i = 1; i <= 3; i++) {
    shell(phone, "am start -W -n dev.probe/.MainActivity --es probe inc");
    wait(() =>
      adb(phone, ["logcat", "-d", "-s", "ProbeState"]).includes(
        `event=inc saved=${i} volatile=${i}`,
      ),
    );
  }
  const pid = shell(phone, "pidof dev.probe").trim();
  shell(phone, "input keyevent KEYCODE_HOME");
  wait(() => /(?:prev|cch).*dev\.probe/.test(shell(phone, "dumpsys activity lru")));
  shell(phone, `run-as dev.probe kill -9 ${pid}`);
  wait(() => !shell(phone, "pidof dev.probe || true").trim());
  shell(phone, "am start -W -n dev.probe/.MainActivity");
  wait(() =>
    /event=start saved=3 volatile=0 .*restored=true/.test(
      adb(phone, ["logcat", "-d", "-s", "ProbeState"]),
    ),
  );
  return {
    before: { saved: 3, unsaved: 3 },
    after: { saved: 3, unsaved: 0 },
    savedSurvived: true,
    unsavedReset: true,
  };
}
export function wrong(context, correct) {
  return { ...correct, after: { saved: 3, unsaved: 3 }, unsavedReset: false };
}
