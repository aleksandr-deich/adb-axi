import { createConnection } from "node:net";
import type { Deadline } from "../core/deadline.js";
import { AdbAxiError } from "../core/errors.js";
import { runHint } from "../core/output.js";
import type { ServerSelection } from "./server-selection.js";

interface ProbeResult {
  version: number;
  address: string;
  peer: string;
}
class ProbeFailure extends Error {
  constructor(
    message: string,
    readonly unavailable: boolean,
  ) {
    super(message);
  }
}

function probe(
  selection: Pick<ServerSelection, "host" | "port">,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    if (timeoutMs <= 0) {
      reject(new ProbeFailure("server check deadline expired", false));
      return;
    }
    const timeout = AbortSignal.timeout(timeoutMs);
    const abort = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    const socket = createConnection({
      host: selection.host === "localhost" ? "127.0.0.1" : selection.host,
      port: selection.port,
    });
    let bytes = Buffer.alloc(0);
    let connected = false;
    const finish = (error?: Error, result?: ProbeResult): void => {
      abort.removeEventListener("abort", aborted);
      socket.destroy();
      if (error !== undefined) reject(error);
      else if (result !== undefined) resolve(result);
    };
    const aborted = (): void => {
      finish(
        new ProbeFailure(
          timeout.aborted ? "server check timed out" : "server check was aborted",
          false,
        ),
      );
    };
    abort.addEventListener("abort", aborted, { once: true });
    if (abort.aborted) {
      aborted();
      return;
    }
    socket.on("connect", () => {
      connected = true;
      socket.write("000chost:version");
    });
    socket.on("error", (error: NodeJS.ErrnoException) => {
      finish(new ProbeFailure(error.message, !connected && error.code === "ECONNREFUSED"));
    });
    socket.on("end", () => {
      finish(new ProbeFailure("endpoint closed without an adb version response", false));
    });
    socket.on("data", (chunk: Buffer) => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length >= 4 && bytes.subarray(0, 4).toString() !== "OKAY") {
        finish(new ProbeFailure("endpoint did not return adb OKAY", false));
        return;
      }
      if (bytes.length < 8) return;
      const length = bytes.subarray(4, 8).toString();
      if (
        !/^[0-9a-fA-F]{4}$/.test(length) ||
        Number.parseInt(length, 16) !== 4 ||
        bytes.length > 12
      ) {
        finish(new ProbeFailure("endpoint returned an invalid adb version frame", false));
        return;
      }
      if (bytes.length < 12) return;
      const version = bytes.subarray(8, 12).toString();
      if (!/^[0-9a-fA-F]{4}$/.test(version)) {
        finish(new ProbeFailure("endpoint returned an invalid adb protocol version", false));
        return;
      }
      const address = socket.remoteAddress;
      if (address === undefined || socket.remotePort === undefined) {
        finish(new ProbeFailure("endpoint did not provide an observed peer", false));
        return;
      }
      finish(undefined, {
        version: Number.parseInt(version, 16),
        address,
        peer: `${address.includes(":") ? `[${address}]` : address}:${socket.remotePort}`,
      });
    });
  });
}

interface PreflightOptions {
  protocol: number | undefined;
  deadline: Deadline;
  capMs: number | undefined;
  signal: AbortSignal | undefined;
  start: () => Promise<void>;
}

export class ServerSession {
  private peer: string | undefined;
  private resolvedHost: string | undefined;
  private answered = false;
  private startup: "observed" | "not_observed" | "unknown" = "not_observed";
  private attemptedStart = false;
  private checking: Promise<void> = Promise.resolve();

  constructor(readonly selection: ServerSelection) {}

  get nativeEndpoint(): string {
    const host = this.resolvedHost;
    return host === undefined
      ? this.selection.endpoint
      : `tcp:${host.includes(":") ? `[${host}]` : host}:${this.selection.port}`;
  }

  evidence(): Record<string, unknown> {
    return {
      endpoint: this.selection.endpoint,
      source: this.selection.source,
      ...(this.peer === undefined ? {} : { peer: this.peer }),
      start: this.selection.start,
      answered: this.answered,
      startup: this.startup,
    };
  }

  observe(stderr: Buffer, nativeOnly: boolean): void {
    if (
      /^\* daemon (?:not running; starting now at |started successfully\r?$)/m.test(
        stderr.toString(),
      )
    ) {
      // Remote stderr can imitate startup chatter, so it cannot establish attribution.
      if (nativeOnly) this.startup = "observed";
      else if (this.startup !== "observed") this.startup = "unknown";
    }
  }

  preflight(options: PreflightOptions): Promise<void> {
    // Parallel fact reads must share one resolved peer, not race separate DNS answers.
    const next = this.checking.then(() => this.check(options));
    this.checking = next.catch(() => {});
    return next;
  }

  private async check({
    protocol,
    deadline,
    capMs,
    signal,
    start,
  }: PreflightOptions): Promise<void> {
    if (protocol === undefined)
      throw this.incompatible("Could not determine the selected adb client's protocol version");
    const check = async (): Promise<void> => {
      this.answered = false;
      this.peer = undefined;
      const result = await probe(
        { host: this.resolvedHost ?? this.selection.host, port: this.selection.port },
        Math.min(deadline.remainingMs(), capMs ?? 5_000, 5_000),
        signal,
      );
      this.answered = true;
      this.peer = result.peer;
      this.resolvedHost = result.address;
      if (result.version !== protocol)
        throw this.incompatible(
          `Selected server protocol ${result.version} does not match client protocol ${protocol}`,
        );
    };
    try {
      await check();
    } catch (error) {
      if (!(error instanceof ProbeFailure)) throw error;
      if (
        error.unavailable &&
        this.selection.start === "auto" &&
        !this.attemptedStart &&
        deadline.remainingMs() > 0
      ) {
        this.attemptedStart = true;
        this.startup = "unknown";
        await start();
        try {
          await check();
        } catch (retryError) {
          if (!(retryError instanceof ProbeFailure)) throw retryError;
          throw this.unreachable(retryError.message);
        }
      } else throw this.unreachable(error.message);
    }
  }

  private unreachable(detail: string): AdbAxiError {
    return new AdbAxiError(
      "ADB_SERVER_UNREACHABLE",
      `Selected adb server ${this.selection.endpoint} is unavailable or did not answer as adb`,
      {
        fields: { detail },
        help: [
          "Reconnect or explicitly start this owned endpoint; no other server is selected",
          runHint(
            ["doctor", "--server", this.selection.endpoint, "--server-start", this.selection.start],
            "to check it again",
          ),
        ],
      },
    );
  }

  private incompatible(message: string): AdbAxiError {
    return new AdbAxiError("ADB_SERVER_INCOMPATIBLE", message, {
      help: [
        "Use a matching adb client or ask the server owner; adb-axi will not kill or replace the incompatible server",
      ],
    });
  }
}
