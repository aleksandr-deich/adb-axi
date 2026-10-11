import { afterEach, expect, it } from "vitest";
import { createFakeAdb, type FakeAdb } from "../fake-adb/harness.js";
import type { Response, Rule } from "../fake-adb/scenario.js";
import { runCli } from "../helpers/run.js";

let fake: FakeAdb | undefined;
afterEach(() => fake?.cleanup());

function setup(console: Response, property: Response, serials = ["emulator-5554"]): FakeAdb {
  const rules: Rule[] = serials.flatMap((serial) => [
    { match: ["-s", serial, "emu", "avd", "name"], respond: console },
    { match: ["-s", serial, "shell", "getprop ro.boot.qemu.avd_name"], respond: property },
    { match: ["-s", serial, "shell", "echo hi"], respond: { stdout: "hi\n" } },
    {
      match: ["-s", serial, "shell", { re: "echo @sdk; .*" }],
      respond: { stdout: "@sdk\n37\n@boot_completed\n1\n" },
    },
  ]);
  fake = createFakeAdb({
    synthetic: true,
    description: "Emulator console unavailable, with an independent device-property name",
    rules: [
      {
        match: ["devices", "-l"],
        respond: {
          stdout: `List of devices attached\n${serials.map((s) => `${s} device`).join("\n")}\n`,
        },
      },
      ...rules,
    ],
  });
  return fake;
}

it.each([
  ["empty", { stdout: "" }],
  ["refused", { exit: 1, stderr: "console authentication unavailable" }],
  ["timed out", { hang: true }],
] satisfies [string, Response][])(
  "resolves the property name when the console is %s",
  async (_, console) => {
    const f = setup(console, { stdout: "notessa_decoy\n" });
    const result = await runCli(
      ["shell", "--device", "notessa_decoy", "--timeout", "1s", "--json", "--", "echo hi"],
      f.env,
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ exit: 0, stdout: "hi" });
    expect(f.unmatched()).toEqual([]);
  },
  20_000,
);

it("explains unavailable names and points to doctor in devices and DEVICE_NOT_FOUND", async () => {
  const f = setup({ exit: 1 }, { stdout: "\n" });
  const listed = await runCli(["devices", "--json"], f.env);
  const missing = await runCli(
    ["shell", "--device", "notessa_decoy", "--json", "--", "echo hi"],
    f.env,
  );
  expect(listed.exitCode).toBe(0);
  expect(missing.exitCode).toBe(1);
  expect((JSON.parse(missing.stdout) as { code: string }).code).toBe("DEVICE_NOT_FOUND");
  for (const result of [listed, missing]) {
    const data = JSON.parse(result.stdout) as { devices: { avd: string }[]; help: string[] };
    expect(data.devices[0]?.avd).toBe("-");
    expect(data.help.join("\n")).toContain("AVD name unavailable");
    expect(data.help.join("\n")).toContain("emulator console and ro.boot.qemu.avd_name");
    expect(data.help.join("\n")).toContain("adb-axi doctor --device emulator-5554");
  }
  expect(f.unmatched()).toEqual([]);
});

it("refuses duplicate fallback names rather than choosing an emulator", async () => {
  const f = setup({ exit: 1 }, { stdout: "notessa_decoy\n" }, ["emulator-5554", "emulator-5556"]);
  const result = await runCli(
    ["shell", "--device", "notessa_decoy", "--json", "--", "echo hi"],
    f.env,
  );
  expect(result.exitCode).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({
    code: "DEVICE_AMBIGUOUS",
    devices: [{ serial: "emulator-5554" }, { serial: "emulator-5556" }],
  });
  expect(f.calls().some((call) => call.argv.at(-1) === "echo hi")).toBe(false);
  expect(f.unmatched()).toEqual([]);
});

it("never queries or selects a physical device by AVD property name", async () => {
  const f = setup({ exit: 1 }, { stdout: "notessa_decoy\n" }, ["physical-phone"]);
  const result = await runCli(
    ["shell", "--device", "notessa_decoy", "--json", "--", "echo hi"],
    f.env,
  );
  expect(result.exitCode).toBe(1);
  expect((JSON.parse(result.stdout) as { code: string }).code).toBe("DEVICE_NOT_FOUND");
  expect(f.calls().map((call) => call.argv)).toEqual([["devices", "-l"]]);
  expect(f.unmatched()).toEqual([]);
});
