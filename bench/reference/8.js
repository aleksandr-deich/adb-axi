export default function reference({ android, adb, phone, wait }, skipRecover = false) {
  android(["emulator", "stop", phone.name]);
  wait(() => !adb(null, ["devices"]).includes(phone.serial));
  if (!skipRecover) {
    android(["emulator", "start", "--headless", "--cold", phone.name]);
    wait(() => {
      const serials = [...adb(null, ["devices"]).matchAll(/^(emulator-\d+)\s+device\s*$/gm)].map(
        (match) => match[1],
      );
      const current = serials.find((serial) => {
        const device = { serial };
        return (
          adb(device, ["emu", "avd", "name"]).split("\n")[0].trim() ||
          adb(device, ["shell", "getprop ro.boot.qemu.avd_name"]).trim()
        ) === phone.name;
      });
      if (!current) return false;
      return adb({ serial: current }, ["shell", "getprop sys.boot_completed"]).trim() === "1";
    });
  }
  return { unavailableState: "missing", recovered: true };
}
export function wrong(context) {
  return reference(context, true);
}
export const freshWrongSetup = true;
