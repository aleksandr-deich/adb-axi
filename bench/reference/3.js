export default function reference({ adb, shell, phone, wait }) {
  shell(phone, "am start -n dev.probe/.MainActivity --es probe crash");
  wait(() =>
    /java.lang.IllegalStateException: probe crash requested/.test(
      adb(phone, ["logcat", "-d", "-b", "all"]),
    ),
  );
  return { exception: "java.lang.IllegalStateException", message: "probe crash requested" };
}
export function wrong() {
  return { exception: "NullPointerException", message: "probe crash requested" };
}
