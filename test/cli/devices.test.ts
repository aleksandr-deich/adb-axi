import { decode } from "@toon-format/toon";
import { afterEach, describe, expect, it } from "vitest";
import { isProcessAlive } from "../../src/core/exec.js";
import { createFakeAdb, type FakeAdb } from "../fake-adb/harness.js";
import type { Scenario } from "../fake-adb/scenario.js";
import { runCli } from "../helpers/run.js";

let fake: FakeAdb | undefined;
afterEach(() => {
  fake?.cleanup();
  fake = undefined;
});

function withFake(scenario: Scenario | string): FakeAdb {
  fake = createFakeAdb(scenario);
  return fake;
}

/** Run `devices` in both formats and check they carry the same data, field for field. */
async function both(f: FakeAdb, args: string[] = []) {
  const toon = await runCli(["devices", ...args], f.env);
  const json = await runCli(["devices", ...args, "--json"], f.env);
  expect(json.exitCode).toBe(toon.exitCode);
  expect(JSON.parse(json.stdout)).toEqual(decode(toon.stdout.trimEnd()));
  return { toon, json: JSON.parse(json.stdout) as Record<string, unknown> };
}

describe("devices", () => {
  it("includes devices in unusual states with --all", async () => {
    const f = withFake("devices-mixed.json");
    const { toon, json } = await both(f, ["--all"]);
    expect(toon.stdout).toContain('0123456789ABCDEF,"-",recovery,"-","-"');
    expect(json.count).toBe("5 attached, 2 online");
    expect(json).not.toHaveProperty("other_states");
    // Only the AVD-name hint and the doctor hint for the offline device; nothing about --all.
    expect(json.help).toHaveLength(2);
    expect(f.unmatched()).toEqual([]);
  });

  it("does not ask to connect a device when only devices in other states are attached", async () => {
    const f = withFake({
      rules: [
        {
          match: ["devices", "-l"],
          respond: {
            stdout: "List of devices attached\n0123456789ABCDEF       recovery transport_id:4\n\n",
          },
        },
      ],
    });
    const { toon, json } = await both(f);
    expect(toon.stdout).toBe(
      'count: "0 attached, 0 online (1 in other states, use --all)"\nother_states: 1\ndevices: []\n',
    );
    expect(json).toEqual({
      count: "0 attached, 0 online (1 in other states, use --all)",
      other_states: 1,
      devices: [],
    });
  });

  it("keeps the facts it read when the AVD name or an extra column does not answer in time", async () => {
    const f = withFake({
      rules: [
        {
          match: ["devices", "-l"],
          respond: {
            stdout: "List of devices attached\nemulator-5554          device transport_id:1\n\n",
          },
        },
        {
          match: ["-s", "emulator-5554", "shell", { re: "echo @sdk; .*" }],
          respond: {
            stdout:
              "@sdk\n37\n@boot_completed\n1\n@boot_id\n3f1c8a52-0d7e-4c1b-9b1e-5a3f2d6c7e81\n@size\nPhysical size: 1344x2992\n@density\nPhysical density: 480\n",
          },
        },
        { match: ["-s", "emulator-5554", "emu", "avd", "name"], respond: { hang: true } },
        {
          match: ["-s", "emulator-5554", "shell", { re: "echo @data_free; .*" }],
          respond: { hang: true },
        },
      ],
    });
    const { toon, json } = await both(f, ["--timeout", "1s", "--fields", "boot,data_free"]);
    expect(toon.exitCode).toBe(0);
    expect(json.devices).toEqual([
      {
        serial: "emulator-5554",
        avd: "-",
        state: "device",
        api: 37,
        form: "phone",
        boot: "completed",
        data_free: "-",
      },
    ]);
    expect(json.help).toContain(
      "A device that could not be read shows `-` for what it could not tell",
    );
    for (const call of f.calls()) expect(isProcessAlive(call.pid)).toBe(false);
  });

  it("suggests only an AVD name that one attached device uses", async () => {
    const facts = (sdk: number, bootId: string) => ({
      stdout: `@sdk\n${sdk}\n@boot_completed\n1\n@boot_id\n${bootId}\n@size\nPhysical size: 1344x2992\n@density\nPhysical density: 480\n`,
    });
    const emulator = (serial: string, sdk: number, bootId: string, avd: string) => [
      { match: ["-s", serial, "shell", { re: "echo @sdk; .*" }], respond: facts(sdk, bootId) },
      { match: ["-s", serial, "emu", "avd", "name"], respond: { stdout: `${avd}\r\nOK\r\n` } },
    ];
    const listing = (serials: string[]) => ({
      match: ["devices", "-l"],
      respond: {
        stdout: `List of devices attached\n${serials
          .map((serial, i) => `${serial}          device transport_id:${i + 1}\n`)
          .join("")}\n`,
      },
    });
    const shared = [
      ...emulator("emulator-5554", 37, "3f1c8a52-0d7e-4c1b-9b1e-5a3f2d6c7e81", "Pixel_10_Pro_XL"),
      ...emulator("emulator-5556", 37, "4a2d9b63-1e8f-4d2c-8c2f-6b4e3e7d8f92", "Pixel_10_Pro_XL"),
    ];

    const mixed = withFake({
      rules: [
        listing(["emulator-5554", "emulator-5556", "emulator-5558"]),
        ...shared,
        ...emulator("emulator-5558", 35, "5b3eac74-2f90-4e3d-9d30-7c5f4f8e9fa3", "medium_tablet"),
      ],
    });
    const { json: withUnique } = await both(mixed);
    expect(withUnique.help).toEqual([
      "Run `adb-axi <command> --device medium_tablet` to target one by AVD name",
    ]);
    mixed.cleanup();

    const onlyShared = withFake({
      rules: [listing(["emulator-5554", "emulator-5556"]), ...shared],
    });
    const { json: noUnique } = await both(onlyShared);
    expect(noUnique).not.toHaveProperty("help");
  });

  it("shows - for the AVD of a physical device without asking its console", async () => {
    const f = withFake({
      rules: [
        {
          match: ["devices", "-l"],
          respond: {
            stdout:
              "List of devices attached\nR5CT10ABCDE          device usb:1-1 product:b0qxxx model:SM_S906B device:b0q transport_id:7\n\n",
          },
        },
        {
          match: ["-s", "R5CT10ABCDE", "shell", { re: "echo @sdk; .*" }],
          respond: {
            stdout:
              "@sdk\n34\n@boot_completed\n1\n@boot_id\n5d7a0f3e-1111-4222-8333-444455556666\n@size\nPhysical size: 1080x2340\n@density\nPhysical density: 450\n",
          },
        },
      ],
    });
    const { json } = await both(f);
    expect(json.devices).toEqual([
      { serial: "R5CT10ABCDE", avd: "-", state: "device", api: 34, form: "phone" },
    ]);
    expect(f.calls().some((call) => call.argv.includes("emu"))).toBe(false);
  });

  it("keeps listing when one device does not answer, and says which facts are unknown", async () => {
    const f = withFake({
      rules: [
        {
          match: ["devices", "-l"],
          respond: {
            stdout:
              "List of devices attached\nemulator-5554          device transport_id:1\nemulator-5556          device transport_id:2\n\n",
          },
        },
        {
          match: ["-s", "emulator-5554", "shell", { re: "echo @sdk; .*" }],
          respond: {
            stdout:
              "@sdk\n37\n@boot_completed\n1\n@boot_id\n3f1c8a52-0d7e-4c1b-9b1e-5a3f2d6c7e81\n@size\nPhysical size: 1344x2992\n@density\nPhysical density: 480\n",
          },
        },
        {
          match: ["-s", "emulator-5554", "emu", "avd", "name"],
          respond: { stdout: "Phone\r\nOK\r\n" },
        },
        { match: ["-s", "emulator-5556", { rest: true }], respond: { hang: true } },
      ],
    });
    const started = Date.now();
    const { toon, json } = await both(f, ["--timeout", "1s"]);
    expect(Date.now() - started).toBeLessThan(6000);
    expect(toon.exitCode).toBe(0);
    expect(json.devices).toEqual([
      { serial: "emulator-5554", avd: "Phone", state: "device", api: 37, form: "phone" },
      { serial: "emulator-5556", avd: "-", state: "device", api: "-", form: "-" },
    ]);
    expect(json.help).toContain(
      "A device that could not be read shows `-` for what it could not tell",
    );
    for (const call of f.calls()) expect(isProcessAlive(call.pid)).toBe(false);
  });

  it("keeps listing a device that goes offline before its facts are read", async () => {
    const f = withFake({
      rules: [
        {
          match: ["devices", "-l"],
          respond: {
            stdout: "List of devices attached\nemulator-5554          device transport_id:1\n\n",
          },
        },
        {
          match: ["-s", "emulator-5554", "shell", { re: "echo @sdk; .*" }],
          respond: { stderr: "adb: device offline\n", exit: 1 },
        },
      ],
    });
    const { toon, json } = await both(f);
    expect(toon.exitCode).toBe(0);
    expect(json.devices).toEqual([
      { serial: "emulator-5554", avd: "-", state: "device", api: "-", form: "-" },
    ]);
    expect(json.help).toEqual([
      "emulator-5554: AVD name unavailable; name lookup was not attempted because device facts could not be read",
      "Run `adb-axi doctor --device emulator-5554` to diagnose name availability",
      "A device that could not be read shows `-` for what it could not tell",
    ]);
  });
});
