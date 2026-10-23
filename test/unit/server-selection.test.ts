import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  parseTcpEndpoint,
  resolveServerSelection,
  serverStateEnv,
} from "../../src/adb/server-selection.js";
import { serverEndpoint } from "../../src/adb/server-endpoint.js";
import { deviceStateDir, readJson, writeJsonAtomic } from "../../src/core/state.js";

const dirs: string[] = [];
function home(): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), "adb-axi-selection-"));
  dirs.push(dir);
  return { ADB_AXI_HOME: dir };
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// A03: native precedence is independently established by marked real servers in the
// doctor regression; selected mode instead checks all assertions, even ignored ones.
test("native-precedence-and-loopback-aliases", () => {
  const env = home();
  const native = {
    ...env,
    ADB_SERVER_SOCKET: "tcp:localhost:6137",
    ANDROID_ADB_SERVER_ADDRESS: "elsewhere",
    ANDROID_ADB_SERVER_PORT: "bad",
  };
  expect(serverEndpoint(native)).toBe("tcp:localhost:6137");
  expect(resolveServerSelection(native)).toBeUndefined();
  expect(
    serverEndpoint({ ANDROID_ADB_SERVER_ADDRESS: "example.test", ANDROID_ADB_SERVER_PORT: "6138" }),
  ).toBe("tcp:example.test:6138");
  for (const endpoint of [
    "tcp:6137",
    "tcp:localhost:6137",
    "tcp:127.0.0.1:6137",
    "tcp:[::1]:6137",
    "tcp:[0:0:0:0:0:0:0:1]:6137",
  ]) {
    const selected = resolveServerSelection(
      {
        ...env,
        ADB_SERVER_SOCKET: endpoint,
        ANDROID_ADB_SERVER_PORT: "6137",
        ANDROID_ADB_SERVER_ADDRESS: "localhost",
      },
      "tcp:6137",
    );
    expect(selected?.identity).toBe("loopback:6137");
    expect(selected?.start).toBe("never");
    expect(Object.isFrozen(selected)).toBe(true);
  }
  expect(
    resolveServerSelection(
      { ...env, ANDROID_ADB_SERVER_ADDRESS: "::1", ANDROID_ADB_SERVER_PORT: "6137" },
      "tcp:6137",
    )?.identity,
  ).toBe("loopback:6137");
  expect(
    resolveServerSelection({ ...env, ANDROID_ADB_SERVER_PORT: "6137" }, undefined, "never")?.source,
  ).toBe("env");
  expect(
    resolveServerSelection(
      { ...env, ADB_SERVER_SOCKET: "", ANDROID_ADB_SERVER_PORT: "" },
      "tcp:6137",
    )?.start,
  ).toBe("never");
  expect(() => resolveServerSelection(native, "tcp:6137")).toThrow(/disagrees/);
  expect(() => resolveServerSelection(env, undefined, "auto")).toThrow(/requires/);
  for (const value of [
    "tcp:0",
    "tcp:65536",
    "tcp:bad",
    "tcp:localhost",
    "localfilesystem:x",
    "tcp:0.0.0.0:6137",
    "tcp:[::]:6137",
    "tcp:127.bad:6137x",
  ])
    expect(() => parseTcpEndpoint(value)).toThrow();
  expect(() => resolveServerSelection(env, "tcp:remote.example:6137", "auto")).toThrow(
    /local loopback/,
  );
  expect(() =>
    resolveServerSelection({ ...env, ANDROID_ADB_SERVER_PORT: "bad" }, "tcp:6137"),
  ).toThrow(/disagrees/);
  expect(() =>
    resolveServerSelection({ ...env, ANDROID_ADB_SERVER_ADDRESS: "other.test" }, "tcp:6137"),
  ).toThrow(/disagrees/);
});

// A12: serial-scoped records must not become authority for the same serial on a
// different server; legacy storage remains independently readable and unchanged.
test("state-does-not-cross-servers", () => {
  const env = home();
  const a = resolveServerSelection(env, "tcp:6137");
  const alias = resolveServerSelection(env, "tcp:127.0.0.1:6137");
  const b = resolveServerSelection(env, "tcp:6138");
  if (a === undefined || alias === undefined || b === undefined)
    throw new Error("missing explicit selection");
  const serial = "emulator-5600";
  const legacy = deviceStateDir(serial, env);
  const first = deviceStateDir(serial, serverStateEnv(env, a));
  const second = deviceStateDir(serial, serverStateEnv(env, b));
  expect(first).toBe(deviceStateDir(serial, serverStateEnv(env, alias)));
  expect(first).not.toBe(second);
  expect(first).not.toBe(legacy);
  for (const file of ["marks.json", "avd.json", "last-install.json"]) {
    writeJsonAtomic(join(legacy, file), { legacy: true });
    writeJsonAtomic(join(first, file), { server: "a" });
    expect(readJson(join(second, file))).toBeUndefined();
    writeJsonAtomic(join(second, file), { server: "b" });
    expect(readJson(join(first, file))).toEqual({ server: "a" });
    expect(readJson(join(legacy, file))).toEqual({ legacy: true });
  }
});
