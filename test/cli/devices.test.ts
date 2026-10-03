import { decode } from "@toon-format/toon";
import { afterEach, describe, expect, it } from "vitest";
import { REGISTRY, isShippedPath } from "../../src/commands/registry.js";
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
  it("lists every attached device with its AVD name, API level and form", async () => {
    const f = withFake("devices-mixed.json");
    const { toon, json } = await both(f);
    expect(toon.exitCode).toBe(0);
    expect(toon.stdout).toMatchInlineSnapshot(`
      "count: "4 attached, 2 online (1 in other states, use --all)"
      other_states: 1
      devices[4]{serial,avd,state,api,form}:
        emulator-5554,Pixel_10_Pro_XL,device,37,phone
        emulator-5556,Pixel_Tablet,device,36,tablet
        emulator-5558,Pixel_Fold,offline,"-","-"
        ZY22ABCDEFG,"-",unauthorized,"-","-"
      help[2]: Run \`adb-axi <command> --device Pixel_10_Pro_XL\` to target one by AVD name,Run \`adb-axi doctor --device emulator-5558\` to see why it is offline
      "
    `);
    expect(json.devices).toEqual([
      { serial: "emulator-5554", avd: "Pixel_10_Pro_XL", state: "device", api: 37, form: "phone" },
      { serial: "emulator-5556", avd: "Pixel_Tablet", state: "device", api: 36, form: "tablet" },
      { serial: "emulator-5558", avd: "Pixel_Fold", state: "offline", api: "-", form: "-" },
      { serial: "ZY22ABCDEFG", avd: "-", state: "unauthorized", api: "-", form: "-" },
    ]);
    expect(f.unmatched()).toEqual([]);
  });

  it("calls only the devices that are online for facts, and always with -s", async () => {
    const f = withFake("devices-mixed.json");
    await runCli(["devices"], f.env);
    const calls = f.calls().map((call) => call.argv);
    expect(calls[0]).toEqual(["devices", "-l"]);
    for (const argv of calls.slice(1)) expect(argv[0]).toBe("-s");
    // The unauthorized physical device is never asked anything.
    expect(calls.some((argv) => argv[1] === "ZY22ABCDEFG")).toBe(false);
  });

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

  it("adds the requested columns with --fields, in column order", async () => {
    const f = withFake("devices-mixed.json");
    const { toon, json } = await both(f, ["--all", "--fields", "uptime,model,abi,data_free,boot"]);
    expect(toon.stdout).toContain(
      "devices[5]{serial,avd,state,api,form,boot,data_free,model,abi,uptime}:",
    );
    expect((json.devices as Record<string, unknown>[])[0]).toEqual({
      serial: "emulator-5554",
      avd: "Pixel_10_Pro_XL",
      state: "device",
      api: 37,
      form: "phone",
      boot: "completed",
      data_free: "3.8G",
      model: "sdk_gphone16k_arm64",
      abi: "arm64-v8a",
      uptime: "9h13m",
    });
    expect((json.devices as Record<string, unknown>[])[1]).toMatchObject({
      model: "Pixel Tablet",
      data_free: "24.0G",
      uptime: "1h07m",
    });
    // Devices that cannot answer show `-` in every extra column.
    expect((json.devices as Record<string, unknown>[])[2]).toMatchObject({
      boot: "-",
      data_free: "-",
      model: "-",
      abi: "-",
      uptime: "-",
    });
    expect(f.unmatched()).toEqual([]);
  });

  it("asks the device only for the columns requested", async () => {
    const f = withFake("devices-mixed.json");
    const { toon } = await both(f, ["--fields", "model"]);
    expect(toon.stdout).toContain("emulator-5556,Pixel_Tablet,device,36,tablet,Pixel Tablet");
    const shellCalls = f.calls().filter((call) => call.argv[2] === "shell");
    expect(
      shellCalls.map((call) => call.argv[3]).filter((s) => !s?.startsWith("echo @sdk")),
    ).toEqual(Array<string>(4).fill("echo @model; getprop ro.product.model"));
  });

  it("says so when nothing is attached, and exits 0", async () => {
    const f = withFake("devices-empty.json");
    const { toon, json } = await both(f);
    expect(toon.exitCode).toBe(0);
    expect(toon.stdout).toMatchInlineSnapshot(`
      "count: "0 attached, 0 online"
      devices: []
      help[1]: "Start an emulator or connect a device, then run \`adb-axi devices\` again"
      "
    `);
    expect(json.devices).toEqual([]);
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

  it("reads an unknown AVD name as - when emu avd name stays silent (H6)", async () => {
    const f = withFake("silent-emu-failure.json");
    const { json } = await both(f);
    // The first emulator's console prints nothing and exits 1; the second answers.
    expect((json.devices as { avd: string }[]).map((row) => row.avd)).toEqual([
      "-",
      "Pixel_Tablet",
    ]);
    expect(json.count).toBe("2 attached, 2 online");
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
      "A device that could not be read shows `-` for what it could not tell",
    ]);
  });

  it("fails with ADB_SERVER_UNREACHABLE when the adb server does not answer", async () => {
    const f = withFake("devices-server-down.json");
    const toon = await runCli(["devices"], f.env);
    expect(toon.exitCode).toBe(1);
    expect(decode(toon.stdout.trimEnd())).toMatchObject({
      error: "the adb server did not answer",
      code: "ADB_SERVER_UNREACHABLE",
    });
    const json = await runCli(["devices", "--json"], f.env);
    expect(JSON.parse(json.stdout)).toEqual(decode(toon.stdout.trimEnd()));
    expect(json.exitCode).toBe(1);
  });

  it("fails with ADB_SERVER_UNREACHABLE when devices -l hangs past the deadline", async () => {
    const f = withFake({ rules: [{ match: ["devices", "-l"], respond: { hang: true } }] });
    const { stdout, exitCode, durationMs } = await runCli(["devices", "--timeout", "1s"], f.env);
    expect(exitCode).toBe(1);
    expect(decode(stdout.trimEnd())).toMatchObject({ code: "ADB_SERVER_UNREACHABLE" });
    expect(durationMs).toBeLessThan(1000 + 750 + 500);
    for (const call of f.calls()) expect(isProcessAlive(call.pid)).toBe(false);
  });

  it("fails with ADB_NOT_FOUND when there is no adb", async () => {
    const f = withFake("devices-mixed.json");
    const toon = await runCli(["devices"], { ...f.env, PATH: "/nonexistent-bin", HOME: f.dir });
    expect(toon.exitCode).toBe(1);
    expect(decode(toon.stdout.trimEnd())).toMatchObject({ code: "ADB_NOT_FOUND" });
    const json = await runCli(["devices", "--json"], {
      ...f.env,
      PATH: "/nonexistent-bin",
      HOME: f.dir,
    });
    expect(JSON.parse(json.stdout)).toEqual(decode(toon.stdout.trimEnd()));
  });

  it("rejects an unknown --fields column with exit 2 before touching adb", async () => {
    const f = withFake("devices-mixed.json");
    const toon = await runCli(["devices", "--fields", "model,color"], f.env);
    expect(toon.exitCode).toBe(2);
    expect(decode(toon.stdout.trimEnd())).toEqual({
      error: '--fields has unknown column "color"',
      code: "VALIDATION_ERROR",
      valid_values: ["boot", "data_free", "model", "abi", "uptime"],
      help: ["Run `adb-axi devices --fields boot,data_free`"],
    });
    const json = await runCli(["devices", "--fields", "model,color", "--json"], f.env);
    expect(JSON.parse(json.stdout)).toEqual(decode(toon.stdout.trimEnd()));
    expect(f.calls()).toEqual([]);
  });

  it("only points at doctor once doctor ships", async () => {
    const f = withFake("devices-mixed.json");
    const { stdout } = await runCli(["devices"], f.env);
    expect(stdout.includes("adb-axi doctor")).toBe(isShippedPath(REGISTRY, ["doctor"]));
  });

  it("is listed in help with its flags", async () => {
    const f = withFake("devices-mixed.json");
    const top = await runCli(["--help"], f.env);
    expect(top.stdout).toContain("adb-axi devices");
    const help = await runCli(["devices", "--help"], f.env);
    expect(help.stdout).toContain("--all");
    expect(help.stdout).toContain("--fields <list>");
    expect(f.calls()).toEqual([]);
  });
});
