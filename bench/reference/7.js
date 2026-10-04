export default function reference({ adb, shell, phone, tablet, debug, wait }, skipTablet = false) {
  for (const device of skipTablet ? [phone] : [phone, tablet]) {
    adb(device, ["install", debug]);
    shell(device, "am start -W -S -n dev.probe/.MainActivity");
    wait(() =>
      /event=start saved=0 volatile=0/.test(adb(device, ["logcat", "-d", "-s", "ProbeState"])),
    );
    shell(device, "dumpsys activity activities");
  }
  return {
    phone: { serial: phone.serial, foreground: "dev.probe" },
    tablet: { serial: tablet.serial, foreground: "dev.probe" },
  };
}
export function wrong(context) {
  return reference(context, true);
}
export const freshWrongSetup = true;
