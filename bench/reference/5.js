export default function reference({ shell, phone }, skipRestore = false) {
  const original = shell(phone, "cmd uimode night")
    .match(/Night mode: (yes|no|auto|custom)/i)[1]
    .toLowerCase();
  const changed = original === "yes" ? "no" : "yes";
  shell(phone, `cmd uimode night ${changed}`);
  shell(phone, "cmd uimode night");
  if (!skipRestore) shell(phone, `cmd uimode night ${original}`);
  shell(phone, "cmd uimode night");
  return { original, changed, restored: original };
}
export function wrong(context) {
  return reference(context, true);
}
export const freshWrongSetup = true;
