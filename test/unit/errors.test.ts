import { decode } from "@toon-format/toon";
import { AxiError } from "axi-sdk-js";
import { describe, expect, it } from "vitest";
import {
  AdbAxiError,
  ERROR_CATALOGUE,
  errorObject,
  exitCodeForError,
  isErrorCode,
} from "../../src/core/errors.js";
import { renderError } from "../../src/core/output.js";

const V01_CODES = [
  "VALIDATION_ERROR",
  "ADB_NOT_FOUND",
  "ADB_SERVER_UNREACHABLE",
  "DEVICE_AMBIGUOUS",
  "DEVICE_OFFLINE",
  "DEVICE_UNAUTHORIZED",
  "DEVICE_NOT_FOUND",
  "WAIT_TIMEOUT",
  "TIMEOUT",
  "REMOTE_EXIT",
  "HOLDER_PROTECTED",
  "APP_NOT_INSTALLED",
  "ACTIVITY_NOT_FOUND",
  "APP_DIED_ON_START",
  "STOP_FAILED",
  "KILL_TIMEOUT",
  "TASK_NOT_IN_RECENTS",
  "COMPARE_UNAVAILABLE",
  "MARK_NOT_FOUND",
  "APP_NOT_DEBUGGABLE",
  "DB_NOT_FOUND",
  "INVALID_OUTPUT",
  "SQL_ERROR",
];
const V02_CODES = [
  "DEVICE_IN_USE",
  "LEASE_STALE",
  "PREFS_NOT_FOUND",
  "CONFIG_NOT_APPLIED",
  "PORT_IN_USE",
];

describe("error catalogue", () => {
  it("has every v0.1 code and no v0.2 code", () => {
    for (const code of V01_CODES) expect(Object.keys(ERROR_CATALOGUE)).toContain(code);
    for (const code of V02_CODES) expect(isErrorCode(code)).toBe(false);
  });

  it("accepts package-manager install codes", () => {
    expect(isErrorCode("INSTALL_FAILED_UPDATE_INCOMPATIBLE")).toBe(true);
    expect(isErrorCode("INSTALL_FAILED_")).toBe(false);
    expect(() => new AdbAxiError("INSTALL_FAILED_VERSION_DOWNGRADE", "x")).not.toThrow();
  });

  it("refuses unknown codes and fields that collide with the shape", () => {
    expect(() => new AdbAxiError("NOPE" as "TIMEOUT", "x")).toThrow(/Unknown adb-axi error code/);
    expect(() => new AdbAxiError("TIMEOUT", "x", { fields: { help: 1 } })).toThrow(/collides/);
  });
});

describe("error shape", () => {
  const error = new AdbAxiError("DEVICE_AMBIGUOUS", "2 devices are online and none is selected", {
    fields: {
      devices: [
        { serial: "emulator-5554", avd: "Pixel_10_Pro_XL", form: "phone" },
        { serial: "emulator-5556", avd: "Pixel_Tablet", form: "tablet" },
      ],
      skipped: undefined,
    },
    help: ["Run `adb-axi logs --device <serial or avd>`", "Or export ANDROID_SERIAL=<serial>"],
  });

  it("orders keys as error, code, fields, help", () => {
    expect(Object.keys(errorObject(error))).toEqual(["error", "code", "devices", "help"]);
  });

  it("renders the same keys and values in TOON and JSON", () => {
    const toon = renderError(error, "toon");
    const json = renderError(error, "json");
    expect(toon.exitCode).toBe(1);
    expect(json.exitCode).toBe(1);
    const fromToon = decode(toon.output.trimEnd()) as Record<string, unknown>;
    const fromJson = JSON.parse(json.output) as Record<string, unknown>;
    expect(Object.keys(fromToon)).toEqual(["error", "code", "devices", "help"]);
    expect(Object.keys(fromJson)).toEqual(["error", "code", "devices", "help"]);
    expect(fromToon).toEqual(fromJson);
    expect(toon.output).toMatchInlineSnapshot(`
      "error: 2 devices are online and none is selected
      code: DEVICE_AMBIGUOUS
      devices[2]{serial,avd,form}:
        emulator-5554,Pixel_10_Pro_XL,phone
        emulator-5556,Pixel_Tablet,tablet
      help[2]: Run \`adb-axi logs --device <serial or avd>\`,Or export ANDROID_SERIAL=<serial>
      "
    `);
  });

  it("maps usage errors to exit 2 and everything else to 1", () => {
    expect(exitCodeForError(new AdbAxiError("VALIDATION_ERROR", "x"))).toBe(2);
    expect(exitCodeForError(new AdbAxiError("DEVICE_OFFLINE", "x"))).toBe(1);
    expect(exitCodeForError(new AxiError("x", "VALIDATION_ERROR"))).toBe(2);
    expect(exitCodeForError(new Error("boom"))).toBe(1);
  });

  it("never passes raw failure text off as the message", () => {
    expect(errorObject(new Error("adb: device 'x' not found"))).toEqual({
      error: "adb-axi hit an internal error",
      code: "INTERNAL_ERROR",
      detail: "adb: device 'x' not found",
    });
  });

  it("omits help when there is none", () => {
    expect(errorObject(new AdbAxiError("TIMEOUT", "x"))).toEqual({ error: "x", code: "TIMEOUT" });
  });
});
