import { describe, expect, it } from "vitest";
import { parsePmFailure } from "../../src/android/pm-result.js";
import {
  installFailureError,
  type InstallFailureContext,
} from "../../src/commands/app/install-errors.js";
import { errorObject } from "../../src/core/errors.js";

describe("parsePmFailure", () => {
  it.each([
    ["Failure [INSTALL_FAILED_VERSION_DOWNGRADE]\n", "INSTALL_FAILED_VERSION_DOWNGRADE", null],
    [
      "Performing Streamed Install\nadb: failed to install a.apk: Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: Package a.b signatures do not match previously installed version; ignoring!]",
      "INSTALL_FAILED_UPDATE_INCOMPATIBLE",
      "Package a.b signatures do not match previously installed version; ignoring!",
    ],
    ["Failure [DELETE_FAILED_INTERNAL_ERROR]\n", "DELETE_FAILED_INTERNAL_ERROR", null],
    [
      "Exception: INSTALL_FAILED_NO_MATCHING_ABIS happened",
      "INSTALL_FAILED_NO_MATCHING_ABIS",
      null,
    ],
  ])("reads the code and message of %j", (output, code, message) => {
    expect(parsePmFailure(output)).toEqual({ code, message });
  });

  it("finds no failure in a success or in unrelated output", () => {
    expect(parsePmFailure("Performing Streamed Install\nSuccess\n")).toBeNull();
    expect(parsePmFailure("adb: error: something else\n")).toBeNull();
    expect(parsePmFailure("")).toBeNull();
  });
});

describe("installFailureError", () => {
  const context: InstallFailureContext = {
    pkg: "com.example.notes",
    apk: "app-debug.apk",
    installed: "1.4.0 (56)",
    apkVersion: "1.3.0 (50)",
    doctorShips: false,
  };

  it("points INSUFFICIENT_STORAGE at doctor only when doctor ships", () => {
    const failure = { code: "INSTALL_FAILED_INSUFFICIENT_STORAGE", message: null };
    const before = errorObject(installFailureError(failure, context, ""));
    expect(JSON.stringify(before.help)).not.toContain("doctor");
    const after = errorObject(installFailureError(failure, { ...context, doctorShips: true }, ""));
    expect(after.help).toEqual([
      expect.stringContaining("Run `adb-axi doctor`") as string,
      expect.stringContaining("Free space") as string,
    ]);
  });

  it("names the APK when its package is unknown, and carries a fix for every code", () => {
    const error = installFailureError(
      { code: "INSTALL_FAILED_OLDER_SDK", message: null },
      { ...context, pkg: undefined },
      "",
    );
    expect(errorObject(error)).toMatchObject({
      error:
        "app-debug.apk was not installed because the APK needs a newer Android version than the device runs",
      code: "INSTALL_FAILED_OLDER_SDK",
      apk: "app-debug.apk",
    });
    expect((errorObject(error).help as string[]).length).toBeGreaterThan(0);
  });

  it("falls back to UNKNOWN for a code outside the INSTALL_FAILED family", () => {
    const error = installFailureError({ code: "SOMETHING_ELSE", message: "x" }, context, "");
    expect(errorObject(error)).toMatchObject({
      code: "INSTALL_FAILED_UNKNOWN",
      pm_code: "SOMETHING_ELSE",
      detail: "x",
    });
  });
});
