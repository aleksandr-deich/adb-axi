/** Native adb's environment selection, without changing its startup or validation policy. */
export function serverEndpoint(env: NodeJS.ProcessEnv): string {
  // Even an empty socket setting is passed to adb, not a request to use the default port.
  if (env.ADB_SERVER_SOCKET !== undefined) return env.ADB_SERVER_SOCKET;
  const port = env.ANDROID_ADB_SERVER_PORT || "5037";
  const host = env.ANDROID_ADB_SERVER_ADDRESS;
  return host === undefined ? `tcp:${port}` : `tcp:${host}:${port}`;
}

/** Only contradictory lower-priority selectors need a diagnostic in legacy mode. */
export function ignoredServerSelectors(env: NodeJS.ProcessEnv): string[] {
  if (env.ADB_SERVER_SOCKET === undefined) return [];
  const socket = /^tcp:(?:(\[[^\]]+\]|[^:]*):)?(\d+)$/.exec(env.ADB_SERVER_SOCKET);
  const host = socket?.[1] ?? "";
  const port = socket?.[2];
  const ignored: string[] = [];
  const address = env.ANDROID_ADB_SERVER_ADDRESS;
  const selectedPort = env.ANDROID_ADB_SERVER_PORT;
  if (address !== undefined && (socket === null || localHost(address) !== localHost(host))) {
    ignored.push(`ANDROID_ADB_SERVER_ADDRESS=${address}`);
  }
  if (
    selectedPort !== undefined &&
    selectedPort !== "" &&
    (port === undefined || !/^\d+$/.test(selectedPort) || Number(selectedPort) !== Number(port))
  ) {
    ignored.push(`ANDROID_ADB_SERVER_PORT=${selectedPort}`);
  }
  return ignored;
}

function localHost(host: string): string {
  return ["", "localhost", "127.0.0.1", "[::1]"].includes(host) ? "localhost" : host;
}
