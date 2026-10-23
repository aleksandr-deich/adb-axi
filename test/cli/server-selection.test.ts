import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { locateAdb } from "../../src/adb/locate.js";

const exec = promisify(execFile);
const cli = resolve(import.meta.dirname, "../../dist/bin/adb-axi.js");
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function environment(): NodeJS.ProcessEnv & { ADB_AXI_HOME: string } {
  const dir = mkdtempSync(join(tmpdir(), "adb-axi-server-cli-"));
  cleanups.push(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const env: NodeJS.ProcessEnv & { ADB_AXI_HOME: string } = {
    ...process.env,
    ADB_AXI_HOME: dir,
    ADB_USB: "0",
    ADB_EMU: "0",
    ADB_MDNS: "0",
  };
  delete env.ADB_SERVER_SOCKET;
  delete env.ANDROID_ADB_SERVER_ADDRESS;
  delete env.ANDROID_ADB_SERVER_PORT;
  delete env.ANDROID_SERIAL;
  return env;
}

async function port(): Promise<number> {
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const address = reservation.address();
  if (address === null || typeof address === "string") throw new Error("no reserved port");
  expect(address.port).not.toBe(5037);
  const closed = once(reservation, "close");
  reservation.close();
  await closed;
  return address.port;
}

function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.setTimeout(500);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      resolve(false);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function server(
  env: NodeJS.ProcessEnv,
  marker: string,
): Promise<{ port: number; trace: () => string }> {
  const ownedPort = await port();
  let trace = "";
  const child: ChildProcess = spawn(
    locateAdb(env),
    ["-L", `tcp:${ownedPort}`, "server", "nodaemon"],
    {
      env: { ...env, ADB_TRACE: `sockets,${marker}` },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  const exited = once(child, "exit");
  child.stderr?.on("data", (chunk: Buffer) => {
    trace += chunk.toString();
  });
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await exited;
    expect(await listening(ownedPort)).toBe(false);
  });
  const deadline = Date.now() + 5_000;
  while (!(await listening(ownedPort))) {
    if (child.exitCode !== null || Date.now() >= deadline)
      throw new Error("owned server failed to listen");
    await delay(25);
  }
  const status = await exec(locateAdb(env), ["-L", `tcp:${ownedPort}`, "server-status"], {
    env,
    timeout: 5_000,
  });
  expect(status.stdout).toContain(`trace_level: "sockets,${marker}"`);
  expect(status.stdout).toContain("USB_DISABLED");
  expect(status.stdout).toContain("MDNS_DISABLED");
  return { port: ownedPort, trace: () => trace };
}

async function invoke(
  env: NodeJS.ProcessEnv,
  args: string[],
): Promise<{ exit: number; data: Record<string, unknown>; stdout: string }> {
  let exit = 0;
  const result = await exec(process.execPath, [cli, ...args, "--json"], {
    env,
    timeout: 12_000,
  }).catch((error: unknown) => {
    const failure = error as { code: number; stdout: string; stderr: string };
    exit = failure.code;
    return failure;
  });
  expect(result.stderr).toBe("");
  return {
    exit,
    data: JSON.parse(result.stdout) as Record<string, unknown>,
    stdout: result.stdout,
  };
}

test("selected-conflict-refuses-before-connect", async () => {
  const env = environment();
  const a = await server(env, "auth");
  const b = await server(env, "jdwp");
  const endpoint = `tcp:localhost:${a.port}`;
  writeFileSync(
    join(env.ADB_AXI_HOME, "server.json"),
    JSON.stringify({ version: 1, endpoint, start: "never" }),
  );
  for (const [selectors, args] of [
    [
      { ADB_SERVER_SOCKET: endpoint, ANDROID_ADB_SERVER_PORT: String(b.port) },
      ["devices", "--server", endpoint],
    ],
    [{ ADB_SERVER_SOCKET: `tcp:localhost:${b.port}` }, ["devices"]],
    [
      { ANDROID_ADB_SERVER_ADDRESS: "other.example", ANDROID_ADB_SERVER_PORT: String(a.port) },
      ["devices", "--server", endpoint],
    ],
  ] as const) {
    const result = await invoke({ ...env, ...selectors }, [...args]);
    expect(result.exit).toBe(2);
    expect(result.data.code).toBe("ADB_SERVER_CONFLICT");
    expect(result.data.server).toMatchObject({ answered: false });
  }
  expect(a.trace()).toContain("host:server-status");
  expect(b.trace()).toContain("host:server-status");
  expect(a.trace()).not.toMatch(/host:devices|host:kill/);
  expect(b.trace()).not.toMatch(/host:devices|host:kill/);
}, 20_000);

test("selection-persists-across-fresh-shells", async () => {
  const env = environment();
  const a = await server(env, "auth");
  const b = await server(env, "jdwp");
  const path = join(env.ADB_AXI_HOME, "server.json");
  const saved = JSON.stringify({ version: 1, endpoint: `tcp:localhost:${a.port}`, start: "auto" });
  writeFileSync(path, saved);
  for (let shell = 0; shell < 2; shell++) {
    const result = await invoke(env, ["devices"]);
    expect(result.exit).toBe(0);
    expect(result.data.server).toMatchObject({
      source: "config",
      peer: `127.0.0.1:${a.port}`,
      start: "auto",
      answered: true,
    });
  }
  const home = await invoke(env, []);
  expect(home.exit).toBe(0);
  expect(home.data.server).toMatchObject({
    source: "config",
    peer: `127.0.0.1:${a.port}`,
    answered: true,
  });
  expect(home.data.help).toContainEqual(
    expect.stringContaining(`--server tcp:localhost:${a.port} --server-start auto`),
  );
  const override = await invoke(env, ["devices", "--server", `tcp:localhost:${b.port}`]);
  expect(override.data.server).toMatchObject({
    source: "flag",
    peer: `127.0.0.1:${b.port}`,
    start: "never",
  });
  const missing = await port();
  const refused = await invoke(env, ["devices", "--server", `tcp:localhost:${missing}`]);
  expect(refused.exit).toBe(1);
  expect(refused.data.code).toBe("ADB_SERVER_UNREACHABLE");
  expect(await listening(missing)).toBe(false);
  const back = await invoke(env, ["devices"]);
  expect(back.data.server).toMatchObject({ peer: `127.0.0.1:${a.port}`, source: "config" });
  expect(readFileSync(path, "utf8")).toBe(saved);
}, 25_000);

test("never-missing-does-not-bootstrap", async () => {
  const env = environment();
  const missing = await port();
  const result = await invoke(env, [
    "devices",
    "--server",
    `tcp:localhost:${missing}`,
    "--server-start",
    "never",
  ]);
  expect(result.exit).toBe(1);
  expect(result.data.code).toBe("ADB_SERVER_UNREACHABLE");
  expect(result.data.server).toMatchObject({ answered: false, startup: "not_observed" });
  expect(result.data.server).not.toHaveProperty("peer");
  expect(await listening(missing)).toBe(false);
});

test("auto-start-is-explicit-and-attributed-honestly", async () => {
  const env = environment();
  const ownedPort = await port();
  // Native auto-start detaches; identify only the daemon carrying this reserved endpoint,
  // and terminate that process rather than sending a lifecycle request through adb.
  cleanups.push(async () => {
    const processes = await exec("ps", ["-axo", "pid=,args="], { timeout: 5_000 });
    const owned = processes.stdout
      .split("\n")
      .filter((line) => line.includes(`adb -L tcp:${ownedPort} fork-server server --reply-fd`));
    expect(owned).toHaveLength(1);
    const pid = Number(owned[0]?.trim().split(/\s+/, 1)[0]);
    process.kill(pid, "SIGTERM");
    const deadline = Date.now() + 5_000;
    while (await listening(ownedPort)) {
      if (Date.now() >= deadline) throw new Error("owned daemon did not stop");
      await delay(25);
    }
  });
  const args = ["devices", "--server", `tcp:localhost:${ownedPort}`, "--server-start", "auto"];
  const first = await invoke(env, args);
  expect(first.exit).toBe(0);
  expect(first.data.server).toMatchObject({
    answered: true,
    peer: `127.0.0.1:${ownedPort}`,
    startup: "observed",
  });
  const second = await invoke(env, args);
  expect(second.exit).toBe(0);
  expect(second.data.server).toMatchObject({ startup: "not_observed" });
});

test("help-and-legacy-default-remain-compatible", async () => {
  const env = environment();
  writeFileSync(join(env.ADB_AXI_HOME, "server.json"), "not json");
  const help = await invoke(env, ["doctor", "--help"]);
  expect(help.exit).toBe(0);
  expect(help.data).not.toHaveProperty("server");
  expect(help.data.help).toContainEqual(expect.stringContaining("not airtight"));
  const version = await exec(process.execPath, [cli, "--version"], { env, timeout: 5_000 });
  expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  rmSync(join(env.ADB_AXI_HOME, "server.json"));
  const a = await server(env, "auth");
  const legacy = await invoke({ ...env, ADB_SERVER_SOCKET: `tcp:localhost:${a.port}` }, [
    "devices",
  ]);
  expect(legacy.exit).toBe(0);
  expect(Object.keys(legacy.data)).toEqual(["count", "devices", "help"]);
});
