import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AdbClient } from "../../src/adb/run.js";
import { Deadline } from "../../src/core/deadline.js";
import { AdbAxiError, errorObject } from "../../src/core/errors.js";
import { isProcessAlive } from "../../src/core/exec.js";
import { deviceStateDir } from "../../src/core/state.js";
import { avdName, formFor, parseAvdName, parseFacts, readFacts } from "../../src/device/facts.js";
import { listDevices, parseDeviceList } from "../../src/device/list.js";
import { resolveTarget, type ResolveOptions } from "../../src/device/resolve.js";
import { createFakeAdb, type FakeAdb } from "../fake-adb/harness.js";
import type { Scenario } from "../fake-adb/scenario.js";

let fake: FakeAdb | undefined;
afterEach(() => {
  fake?.cleanup();
  fake = undefined;
});

function setup(scenario: Scenario | string): { f: FakeAdb; adb: AdbClient } {
  fake = createFakeAdb(scenario);
  return { f: fake, adb: new AdbClient(join(fake.binDir, "adb"), { env: fake.env }) };
}

async function resolveError(options: ResolveOptions): Promise<Record<string, unknown>> {
  try {
    await resolveTarget(options);
  } catch (error) {
    expect(error).toBeInstanceOf(AdbAxiError);
    return errorObject(error);
  }
  throw new Error("expected resolution to fail");
}

function options(
  f: FakeAdb,
  adb: AdbClient,
  overrides: Partial<ResolveOptions> = {},
): ResolveOptions {
  return {
    adb,
    deadline: new Deadline(10_000),
    env: f.env,
    requested: undefined,
    commandArgs: ["logs", "--pkg", "com.example"],
    isShipped: () => false,
    ...overrides,
  };
}

describe("parseDeviceList", () => {
  it("reads serial, state and properties, ignoring daemon chatter", () => {
    const text = [
      "* daemon not running; starting now at tcp:5037",
      "* daemon started successfully",
      "List of devices attached",
      "emulator-5554          device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:1",
      "emulator-5558          offline transport_id:3",
      "R58M123ABC             unauthorized usb:1-1 transport_id:4",
      "0123456789ABCDEF       no permissions (missing udev rules? user is in the plugdev group); see [http://developer.android.com/tools/device.html] usb:1-2 transport_id:5",
      "192.168.1.20:5555      device product:x model:Pixel_8 device:shiba transport_id:6",
      "",
    ].join("\n");
    expect(parseDeviceList(text)).toEqual([
      {
        serial: "emulator-5554",
        state: "device",
        props: {
          product: "sdk_gphone64_arm64",
          model: "sdk_gphone64_arm64",
          device: "emu64a",
          transport_id: "1",
        },
      },
      { serial: "emulator-5558", state: "offline", props: { transport_id: "3" } },
      { serial: "R58M123ABC", state: "unauthorized", props: { usb: "1-1", transport_id: "4" } },
      {
        serial: "0123456789ABCDEF",
        state: "no permissions",
        props: { usb: "1-2", transport_id: "5" },
      },
      {
        serial: "192.168.1.20:5555",
        state: "device",
        props: { product: "x", model: "Pixel_8", device: "shiba", transport_id: "6" },
      },
    ]);
  });

  it("reads an empty list as zero devices", () => {
    expect(parseDeviceList("List of devices attached\n\n")).toEqual([]);
  });
});

describe("listDevices", () => {
  it("reports a server that never answers as ADB_SERVER_UNREACHABLE within the deadline", async () => {
    const { adb } = setup({ rules: [{ match: ["devices", "-l"], respond: { hang: true } }] });
    const started = performance.now();
    await expect(listDevices(adb, new Deadline(500))).rejects.toMatchObject({
      code: "ADB_SERVER_UNREACHABLE",
    });
    expect(performance.now() - started).toBeLessThan(500 + 750);
  });

  it("reports a server that cannot be reached as ADB_SERVER_UNREACHABLE", async () => {
    const { adb } = setup({
      rules: [
        {
          match: ["devices", "-l"],
          respond: {
            stderr: "* cannot connect to daemon at tcp:5037: Connection refused\n",
            exit: 1,
          },
        },
      ],
    });
    const error = await listDevices(adb, new Deadline(5000)).catch((e: unknown) => errorObject(e));
    expect(error).toMatchObject({
      error: "the adb server did not answer",
      code: "ADB_SERVER_UNREACHABLE",
      detail: "* cannot connect to daemon at tcp:5037: Connection refused",
    });
  });
});

describe("facts", () => {
  it("reads API level, boot state, boot id and form from one shell call", () => {
    const facts = parseFacts(
      [
        "@sdk",
        "37",
        "@boot_completed",
        "1",
        "@boot_id",
        "3f1c8a52-0d7e-4c1b-9b1e-5a3f2d6c7e81",
        "@size",
        "Physical size: 1344x2992",
        "@density",
        "Physical density: 480",
      ].join("\n"),
    );
    expect(facts).toEqual({
      api: 37,
      bootCompleted: true,
      bootId: "3f1c8a52-0d7e-4c1b-9b1e-5a3f2d6c7e81",
      smallestWidthDp: 448,
      form: "phone",
    });
  });

  it("uses override size and density over the physical values", () => {
    const facts = parseFacts(
      [
        "@size",
        "Physical size: 1080x2400",
        "Override size: 1600x2560",
        "@density",
        "Physical density: 420",
        "Override density: 320",
      ].join("\n"),
    );
    expect(facts.smallestWidthDp).toBe(800);
    expect(facts.form).toBe("tablet");
  });

  it("reads unknowns as null when the device cannot answer yet", () => {
    const facts = parseFacts(
      "@sdk\n\n@boot_completed\n\n@boot_id\n@size\nCan't find service: window\n@density\n",
    );
    expect(facts).toEqual({
      api: null,
      bootCompleted: null,
      bootId: null,
      smallestWidthDp: null,
      form: null,
    });
  });

  it("draws the phone and tablet line at 600 dp", () => {
    expect(formFor(599)).toBe("phone");
    expect(formFor(600)).toBe("tablet");
    expect(formFor(null)).toBeNull();
  });

  it("parses the emulator console's AVD name", () => {
    expect(parseAvdName("Pixel_10_Pro_XL\r\nOK\r\n")).toBe("Pixel_10_Pro_XL");
    expect(parseAvdName("")).toBeNull();
    expect(parseAvdName("KO: unknown command\r\n")).toBeNull();
  });

  it("treats a silent emu failure as an unknown AVD name, not an error (H6)", async () => {
    const { adb, f } = setup("silent-emu-failure.json");
    const facts = await readFacts(
      adb,
      { serial: "emulator-5554", state: "device", props: {} },
      { deadline: new Deadline(10_000), env: f.env },
    );
    expect(facts).toMatchObject({ serial: "emulator-5554", avd: null, api: 37, form: "phone" });
  });

  it("caches the AVD name per serial and emulator boot", async () => {
    const { adb, f } = setup("multi-device.json");
    const factsOptions = { deadline: new Deadline(10_000), env: f.env };
    const emuCalls = (): number => f.calls().filter((call) => call.argv[2] === "emu").length;

    expect(await avdName(adb, "emulator-5554", "boot-a", factsOptions)).toBe("Pixel_10_Pro_XL");
    expect(await avdName(adb, "emulator-5554", "boot-a", factsOptions)).toBe("Pixel_10_Pro_XL");
    expect(emuCalls()).toBe(1);
    const cache = JSON.parse(
      readFileSync(join(deviceStateDir("emulator-5554", f.env), "avd.json"), "utf8"),
    ) as unknown;
    expect(cache).toEqual({ boot_id: "boot-a", avd: "Pixel_10_Pro_XL" });

    // A new boot on the same port is read again.
    await avdName(adb, "emulator-5554", "boot-b", factsOptions);
    expect(emuCalls()).toBe(2);
    // Without a boot id nothing is cached or trusted.
    await avdName(adb, "emulator-5554", null, factsOptions);
    expect(emuCalls()).toBe(3);
  });

  it("never asks a physical device for an AVD name", async () => {
    const { adb, f } = setup({ rules: [] });
    expect(
      await avdName(adb, "R58M123ABC", "x", { deadline: new Deadline(1000), env: f.env }),
    ).toBeNull();
    expect(f.calls()).toEqual([]);
  });
});

describe("resolveTarget", () => {
  it("picks the only online device without any selection", async () => {
    const { adb, f } = setup("one-online.json");
    await expect(resolveTarget(options(f, adb))).resolves.toMatchObject({
      serial: "emulator-5554",
      selectedBy: "only-online",
    });
    expect(f.calls()).toHaveLength(1);
  });

  it("fails DEVICE_AMBIGUOUS with the online candidates when two are online", async () => {
    const { adb, f } = setup("multi-device.json");
    const error = await resolveError(options(f, adb));
    expect(error).toEqual({
      error: "2 devices are online and none is selected",
      code: "DEVICE_AMBIGUOUS",
      devices: [
        { serial: "emulator-5554", avd: "Pixel_10_Pro_XL", form: "phone" },
        { serial: "emulator-5556", avd: "Pixel_Tablet", form: "tablet" },
      ],
      help: [
        "Run `adb-axi logs --pkg com.example --device <serial or avd>`",
        "Or export ANDROID_SERIAL=<serial> in this shell",
      ],
    });
    expect(f.unmatched()).toEqual([]);
  });

  it("resolves --device by serial without reading any facts", async () => {
    const { adb, f } = setup("multi-device.json");
    await expect(
      resolveTarget(options(f, adb, { requested: "emulator-5556" })),
    ).resolves.toMatchObject({ serial: "emulator-5556", selectedBy: "flag" });
    expect(f.calls().map((call) => call.argv)).toEqual([["devices", "-l"]]);
  });

  it("resolves --device by AVD name", async () => {
    const { adb, f } = setup("multi-device.json");
    await expect(
      resolveTarget(options(f, adb, { requested: "Pixel_Tablet" })),
    ).resolves.toMatchObject({ serial: "emulator-5556" });
  });

  it("honours ANDROID_SERIAL, and --device wins over it", async () => {
    const { adb, f } = setup("multi-device.json");
    const env = { ...f.env, ANDROID_SERIAL: "emulator-5556" };
    await expect(resolveTarget(options(f, adb, { env }))).resolves.toMatchObject({
      serial: "emulator-5556",
      selectedBy: "env",
    });
    await expect(
      resolveTarget(options(f, adb, { env, requested: "emulator-5554" })),
    ).resolves.toMatchObject({ serial: "emulator-5554", selectedBy: "flag" });
    await expect(
      resolveTarget(options(f, adb, { env: { ...f.env, ANDROID_SERIAL: "" } })),
    ).rejects.toMatchObject({ code: "DEVICE_AMBIGUOUS" });
  });

  it("fails DEVICE_AMBIGUOUS when one AVD name matches two running emulators", async () => {
    const { adb, f } = setup("same-avd-twice.json");
    const error = await resolveError(options(f, adb, { requested: "Pixel_10_Pro_XL" }));
    expect(error).toMatchObject({
      error: "2 running emulators use the AVD name Pixel_10_Pro_XL",
      code: "DEVICE_AMBIGUOUS",
      devices: [
        { serial: "emulator-5554", avd: "Pixel_10_Pro_XL", form: "phone" },
        { serial: "emulator-5556", avd: "Pixel_10_Pro_XL", form: "phone" },
      ],
    });
    await expect(
      resolveTarget(options(f, adb, { requested: "emulator-5556" })),
    ).resolves.toMatchObject({ serial: "emulator-5556" });
  });

  it("fails an offline target at once, before any device call (H1-H4)", async () => {
    const { adb, f } = setup("hang-missing-offline.json");
    const started = performance.now();
    const error = await resolveError(options(f, adb, { requested: "emulator-5556" }));
    expect(error).toEqual({
      error: "emulator-5556 is offline",
      code: "DEVICE_OFFLINE",
      state: "offline",
    });
    expect(performance.now() - started).toBeLessThan(2000);
    expect(f.calls().map((call) => call.argv)).toEqual([["devices", "-l"]]);
  });

  it("points an offline target at doctor only once doctor ships (6.3)", async () => {
    const { adb, f } = setup("hang-missing-offline.json");
    const error = await resolveError(
      options(f, adb, {
        requested: "emulator-5556",
        isShipped: (path) => path.join(" ") === "doctor",
      }),
    );
    expect(error.help).toEqual(["Run `adb-axi doctor --device emulator-5556` to see why"]);
  });

  it("fails a missing target with DEVICE_NOT_FOUND and the attached devices", async () => {
    const { adb, f } = setup("multi-device.json");
    const error = await resolveError(options(f, adb, { requested: "bogus-9999" }));
    expect(error).toEqual({
      error: "no attached device has the serial or AVD name bogus-9999",
      code: "DEVICE_NOT_FOUND",
      devices: [
        { serial: "emulator-5554", avd: "Pixel_10_Pro_XL", state: "device" },
        { serial: "emulator-5556", avd: "Pixel_Tablet", state: "device" },
        { serial: "emulator-5558", avd: "Pixel_Fold", state: "offline" },
      ],
      help: [
        "Run `adb-axi logs --pkg com.example --device <serial or avd>` with one of the devices above",
      ],
    });
  });

  it("resolves an offline emulator by AVD name and then fails its state check", async () => {
    const { adb, f } = setup("multi-device.json");
    const error = await resolveError(options(f, adb, { requested: "Pixel_Fold" }));
    expect(error).toMatchObject({ code: "DEVICE_OFFLINE", error: "emulator-5558 is offline" });
  });

  it("never matches an unknown AVD name (H6)", async () => {
    const { adb, f } = setup("silent-emu-failure.json");
    const error = await resolveError(options(f, adb, { requested: "Pixel_10_Pro_XL" }));
    expect(error.code).toBe("DEVICE_NOT_FOUND");
    expect(error.devices).toEqual([
      { serial: "emulator-5554", avd: "-", state: "device" },
      { serial: "emulator-5556", avd: "Pixel_Tablet", state: "device" },
    ]);
    const ambiguous = await resolveError(options(f, adb));
    expect(ambiguous.devices).toEqual([
      { serial: "emulator-5554", avd: "-", form: "phone" },
      { serial: "emulator-5556", avd: "Pixel_Tablet", form: "tablet" },
    ]);
  });

  it("reports unauthorized devices, and zero devices, definitively", async () => {
    const { adb, f } = setup({
      rules: [
        {
          match: ["devices", "-l"],
          respond: {
            stdout:
              "List of devices attached\nR58M123ABC     unauthorized usb:1-1 transport_id:4\n\n",
          },
        },
      ],
    });
    expect(await resolveError(options(f, adb))).toMatchObject({
      code: "DEVICE_UNAUTHORIZED",
      error: "R58M123ABC has not authorized USB debugging from this computer",
    });
    fake?.cleanup();
    const empty = setup({
      rules: [{ match: ["devices", "-l"], respond: { stdout: "List of devices attached\n\n" } }],
    });
    expect(await resolveError(options(empty.f, empty.adb))).toEqual({
      error: "no device is attached",
      code: "DEVICE_NOT_FOUND",
      help: ["Start an emulator or connect a device, then run the command again"],
    });
  });

  it("reports a console that hangs during AVD resolution as TIMEOUT, killing the child", async () => {
    const { adb, f } = setup("hang-missing-offline.json");
    const started = performance.now();
    const error = await resolveError(
      options(f, adb, { requested: "Pixel_10_Pro_XL", deadline: new Deadline(800) }),
    );
    expect(error).toMatchObject({
      code: "TIMEOUT",
      step: "reading the AVD name of emulator-5556",
    });
    expect(performance.now() - started).toBeLessThan(800 + 750);
    const hung = f.calls().find((call) => call.argv[1] === "emulator-5556");
    expect(hung?.end).toBeNull();
    expect(isProcessAlive(hung?.pid ?? 0)).toBe(false);
  });
});
