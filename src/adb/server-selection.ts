import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { join } from "node:path";
import { AdbAxiError } from "../core/errors.js";
import { adbAxiHome, readJson } from "../core/state.js";

export interface TcpEndpoint {
  readonly endpoint: string;
  readonly host: string;
  readonly port: number;
  readonly identity: string;
  readonly local: boolean;
}

export interface ServerSelection extends TcpEndpoint {
  readonly source: "flag" | "config" | "env";
  readonly start: "never" | "auto";
}

function invalid(message: string): never {
  throw new AdbAxiError("VALIDATION_ERROR", message);
}

function hostIdentity(host: string): string {
  return host === "localhost" ? "127.0.0.1" : host;
}

export function parseTcpEndpoint(value: string): TcpEndpoint {
  const match = /^tcp:(?:(\[[^\]]+\]|[^:]+):)?([0-9]+)$/.exec(value);
  if (match === null) invalid(`Invalid TCP server endpoint ${value}; use tcp:<host>:<port>`);
  const rawHost = match[1] ?? "localhost";
  let host = rawHost.replace(/^\[|\]$/g, "").toLowerCase();
  if (isIP(host) === 6) host = new URL(`http://[${host}]`).hostname.slice(1, -1);
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    invalid(`Invalid server port in ${value}; use 1-65535`);
  if (
    host === "0.0.0.0" ||
    host === "::" ||
    host === "*" ||
    (rawHost.startsWith("[")
      ? isIP(host) !== 6
      : !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host)) ||
    (/^[0-9.]+$/.test(host) && isIP(host) !== 4)
  )
    invalid(`Invalid server destination in ${value}`);
  const identity = hostIdentity(host);
  return Object.freeze({
    endpoint: `tcp:${isIP(host) === 6 ? `[${host}]` : host}:${port}`,
    host,
    port,
    identity: `${identity}:${port}`,
    local: host === "localhost" || host === "::1" || (isIP(host) === 4 && /^127\./.test(host)),
  });
}

export function resolveServerSelection(
  env: NodeJS.ProcessEnv,
  endpointFlag?: string,
  startFlag?: string,
): ServerSelection | undefined {
  const path = join(adbAxiHome(env), "server.json");
  let saved: unknown;
  try {
    saved = readJson(path);
  } catch {
    invalid(`Cannot read server configuration ${path}`);
  }
  let config: { endpoint: TcpEndpoint; start: "never" | "auto" } | undefined;
  if (saved !== undefined) {
    if (saved === null || typeof saved !== "object" || Array.isArray(saved))
      invalid(`Invalid server configuration ${path}; expected version, endpoint and start`);
    const data = saved as Record<string, unknown>;
    if (
      data.version !== 1 ||
      typeof data.endpoint !== "string" ||
      (data.start !== "never" && data.start !== "auto")
    )
      invalid(
        `Invalid server configuration ${path}; expected version 1, TCP endpoint and start never|auto`,
      );
    try {
      config = { endpoint: parseTcpEndpoint(data.endpoint), start: data.start };
    } catch {
      invalid(`Invalid endpoint in server configuration ${path}`);
    }
  }
  const socket = env.ADB_SERVER_SOCKET || undefined;
  const address = env.ANDROID_ADB_SERVER_ADDRESS || undefined;
  const port = env.ANDROID_ADB_SERVER_PORT || undefined;
  if (endpointFlag === undefined && config === undefined && startFlag === undefined)
    return undefined;
  if (startFlag !== undefined && startFlag !== "never" && startFlag !== "auto")
    invalid("--server-start must be never or auto");
  if (
    endpointFlag === undefined &&
    config === undefined &&
    socket === undefined &&
    address === undefined &&
    port === undefined
  )
    invalid("--server-start requires --server, saved selection, or a native server selector");
  const endpoint =
    endpointFlag !== undefined
      ? parseTcpEndpoint(endpointFlag)
      : (config?.endpoint ??
        parseTcpEndpoint(socket ?? nativeTcpEndpoint(address ?? "localhost", port ?? "5037")));
  const start =
    startFlag ?? (config?.endpoint.identity === endpoint.identity ? config.start : "never");
  const selection: ServerSelection = Object.freeze({
    ...endpoint,
    start,
    source: endpointFlag !== undefined ? "flag" : config !== undefined ? "config" : "env",
  });
  const conflict = (name: string, value: string): never => {
    throw new AdbAxiError(
      "ADB_SERVER_CONFLICT",
      `${name}=${value} disagrees with selected server ${endpoint.endpoint}`,
      {
        fields: {
          server: {
            endpoint: endpoint.endpoint,
            source: selection.source,
            start,
            answered: false,
            startup: "not_observed",
          },
        },
        help: [`Unset or correct ${name}; selected mode refuses every conflicting native selector`],
      },
    );
  };
  if (socket !== undefined) {
    const native = (() => {
      try {
        return parseTcpEndpoint(socket);
      } catch {
        return conflict("ADB_SERVER_SOCKET", socket);
      }
    })();
    if (native.identity !== endpoint.identity) conflict("ADB_SERVER_SOCKET", socket);
  }
  if (port !== undefined && (!/^\d+$/.test(port) || Number(port) !== endpoint.port))
    conflict("ANDROID_ADB_SERVER_PORT", port);
  if (address !== undefined) {
    const assertion = (() => {
      try {
        return parseTcpEndpoint(nativeTcpEndpoint(address, String(endpoint.port)));
      } catch {
        return conflict("ANDROID_ADB_SERVER_ADDRESS", address);
      }
    })();
    if (hostIdentity(assertion.host) !== hostIdentity(endpoint.host))
      conflict("ANDROID_ADB_SERVER_ADDRESS", address);
  }
  if (start === "auto" && !endpoint.local)
    invalid("--server-start auto requires a local loopback endpoint");
  return selection;
}

function nativeTcpEndpoint(address: string, port: string): string {
  return `tcp:${isIP(address) === 6 ? `[${address}]` : address}:${port}`;
}

export function selectedChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const child = { ...env };
  delete child.ADB_SERVER_SOCKET;
  delete child.ANDROID_ADB_SERVER_ADDRESS;
  delete child.ANDROID_ADB_SERVER_PORT;
  return child;
}

export function serverStateEnv(
  env: NodeJS.ProcessEnv,
  selection: ServerSelection,
): NodeJS.ProcessEnv {
  const key = createHash("sha256").update(selection.identity).digest("hex");
  return { ...env, ADB_AXI_HOME: join(adbAxiHome(env), "servers", key) };
}
