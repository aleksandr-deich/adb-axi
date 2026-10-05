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
          (adb(device, ["emu", "avd", "name"]).split("\n")[0].trim() ||
            adb(device, ["shell", "getprop ro.boot.qemu.avd_name"]).trim()) === phone.name
        );
      });
      if (!current) return false;
      return adb({ serial: current }, ["shell", "getprop sys.boot_completed"]).trim() === "1";
    });
  }
  return { unavailableState: "missing", recovered: true };
}
// Wrong outcome: stop and restart, but never inspect the unavailable state.
export function wrong({ android, phone }) {
  android(["emulator", "stop", phone.name]);
  android(["emulator", "start", "--headless", "--cold", phone.name]);
  return { unavailableState: "missing", recovered: true };
}
export function treatment({ android, axi, phone, wait }) {
  axi(["devices", "--json"]);
  android(["emulator", "stop", phone.name]);
  wait(
    () => !JSON.parse(axi(["devices", "--json"])).devices.some((d) => d.serial === phone.serial),
  );
  android(["emulator", "start", "--headless", "--cold", phone.name]);
  axi(["wait", "boot", "-s", phone.name, "--json"]);
  return { unavailableState: "missing", recovered: true };
}
export function wrongReport(answer) {
  return { ...answer, unavailableState: "offline" };
}
export const freshWrongSetup = true;
