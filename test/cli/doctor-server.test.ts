import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { connect, createServer } from "node:net";
import { resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { locateAdb } from "../../src/adb/locate.js";

const run = promisify(execFile);
const cli = resolve(import.meta.dirname, "../../dist/bin/adb-axi.js");

// Native server trace markers identify the answering server independently of doctor's
// endpoint text; discovery is disabled so this host check cannot attach other devices.
test("doctor-reports-socket-not-ignored-port", async () => {
  const env: NodeJS.ProcessEnv = { ...process.env, ADB_USB: "0", ADB_EMU: "0", ADB_MDNS: "0" };
  delete env.ADB_SERVER_SOCKET;
  delete env.ANDROID_ADB_SERVER_ADDRESS;
  delete env.ANDROID_ADB_SERVER_PORT;
  delete env.ANDROID_SERIAL;
  const adb = locateAdb(env);
  const children: ChildProcess[] = [];
  const exited: Promise<unknown>[] = [];
  try {
    const ports: number[] = [];
    for (const marker of ["auth", "jdwp"]) {
      const reservation = createServer();
      reservation.listen(0, "127.0.0.1");
      await once(reservation, "listening");
      const address = reservation.address();
      if (address === null || typeof address === "string") throw new Error("no reserved port");
      const port = address.port;
      expect(port).not.toBe(5037);
      expect(ports).not.toContain(port);
      const closed = once(reservation, "close");
      reservation.close();
      await closed;
      const child = spawn(adb, ["-L", `tcp:${port}`, "server", "nodaemon"], {
        env: { ...env, ADB_TRACE: marker },
        stdio: "ignore",
      });
      children.push(child);
      exited.push(once(child, "exit"));
      ports.push(port);
      const deadline = Date.now() + 5_000;
      for (let attempt = 0; attempt < 200; attempt++) {
        const ready = await new Promise<boolean>((accept) => {
          const socket = connect({ host: "127.0.0.1", port });
          socket.once("connect", () => {
            socket.destroy();
            accept(true);
          });
          socket.once("error", () => {
            accept(false);
          });
        });
        if (ready) break;
        if (child.exitCode !== null || Date.now() >= deadline || attempt === 199) {
          throw new Error(`owned server failed to listen at tcp:${port}`);
        }
        await setTimeout(25);
      }
      const status = await run(adb, ["-L", `tcp:${port}`, "server-status"], {
        env,
        timeout: 5_000,
      });
      expect(status.stdout).toContain(`trace_level: "${marker}"`);
      expect(status.stdout).toContain("USB_DISABLED");
      expect(status.stdout).toContain("MDNS_DISABLED");
    }
    const [a, b] = ports;
    const selected = {
      ...env,
      ADB_SERVER_SOCKET: `tcp:localhost:${a}`,
      ANDROID_ADB_SERVER_PORT: String(b),
    };
    const status = await run(adb, ["server-status"], { env: selected, timeout: 5_000 });
    expect(status.stdout).toContain('trace_level: "auth"');
    // With discovery disabled, doctor exits 1 for no device, not for its server check.
    const doctor = await run(process.execPath, [cli, "doctor", "--json", "--timeout", "8s"], {
      env: selected,
      timeout: 10_000,
    }).catch((error: unknown) => {
      const failure = error as { code: number; stdout: string; stderr: string };
      expect(failure.code).toBe(1);
      return failure;
    });
    const report = JSON.parse(doctor.stdout) as {
      checks: { check: string; status: string; detail: string }[];
    };
    const server = report.checks.find((check) => check.check === "server");
    expect(server?.status).toBe("ok");
    expect(server?.detail).toBe(
      `tcp:localhost:${a} (ADB_SERVER_SOCKET overrides ignored ANDROID_ADB_SERVER_PORT=${b})`,
    );
    expect(server?.detail).not.toContain(`tcp:${b}`);
    expect(server?.detail).not.toContain("5037");
    const baseline = await run(adb, ["-L", `tcp:${b}`, "server-status"], { env, timeout: 5_000 });
    expect(baseline.stdout).toContain('trace_level: "jdwp"');
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    }
    await Promise.all(exited);
  }
}, 30_000);
