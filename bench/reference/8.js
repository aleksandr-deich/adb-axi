export default function reference({ android, adb, phone, wait }, skipRecover = false) {
  android(["emulator", "stop", phone.name]);
  wait(() => !adb(null, ["devices"]).includes(phone.serial));
  if (!skipRecover) {
    android(["emulator", "start", "--headless", "--cold", phone.name]);
    wait(() => adb(phone, ["shell", "getprop sys.boot_completed"]).trim() === "1");
  }
  return { unavailableState: "missing", recovered: true };
}
export function wrong(context) {
  return reference(context, true);
}
export const freshWrongSetup = true;
