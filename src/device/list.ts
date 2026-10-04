import type { AdbClient } from "../adb/run.js";
import { serverUnreachable } from "../adb/variants.js";
import type { Deadline } from "../core/deadline.js";
import { AdbAxiError } from "../core/errors.js";

/** One line of `adb devices -l`. */
export interface AttachedDevice {
  serial: string;
  /** adb's state word: `device`, `offline`, `unauthorized`, `recovery`, `no permissions`, ... */
  state: string;
  /** Trailing `key:value` properties: `product`, `model`, `device`, `transport_id`, `usb`. */
  props: Record<string, string>;
}

/** The state in which a device accepts commands. */
export const ONLINE = "device";

/** Cap for listing devices: a server that does not answer within it is unreachable. */
export const LIST_CAP_MS = 15_000;

/**
 * Read attached devices with `adb devices -l` under a deadline. A server that cannot be
 * reached, or that does not answer within `LIST_CAP_MS`, is `ADB_SERVER_UNREACHABLE`. The
 * command's own deadline running out first is `TIMEOUT` naming this step: a short
 * `--timeout` says nothing about the server.
 */
export async function listDevices(
  adb: AdbClient,
  deadline: Deadline,
  capMs: number = LIST_CAP_MS,
): Promise<AttachedDevice[]> {
  let result;
  try {
    result = await adb.host(["devices", "-l"], { deadline, step: "listing devices", capMs });
  } catch (error) {
    if (!(error instanceof AdbAxiError) || error.code !== "TIMEOUT") throw error;
    if (deadline.remainingMs() > 0) throw serverUnreachable();
    throw new AdbAxiError("TIMEOUT", error.message, {
      fields: error.fields,
      help: [
        ...error.help,
        "If a longer deadline times out too, the adb server is not answering: check that nothing else holds tcp:5037",
      ],
      cause: error,
    });
  }
  const stdout = result.stdout.toString("utf8");
  if (result.exitCode !== 0 || !/^List of devices attached/m.test(stdout)) {
    throw serverUnreachable(`${result.stderr.toString("utf8")}${stdout}`);
  }
  return parseDeviceList(stdout);
}

const PROP = /^([a-z_]+):(\S*)$/;

/** Parse `adb devices -l` output. Daemon start-up chatter (`* daemon ...`) is ignored. */
export function parseDeviceList(text: string): AttachedDevice[] {
  const devices: AttachedDevice[] = [];
  let inList = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("List of devices attached")) {
      inList = true;
      continue;
    }
    if (!inList || line === "" || line.startsWith("*")) continue;

    const [serial = "", ...rest] = line.split(/\s+/);
    const props: Record<string, string> = {};
    while (rest.length > 1) {
      const match = PROP.exec(rest.at(-1) ?? "");
      if (!match?.[1]) break;
      props[match[1]] = match[2] ?? "";
      rest.pop();
    }
    const stateText = rest.join(" ");
    // `no permissions (<reason>); see [<url>]` is one state with an explanation.
    const state = stateText.startsWith("no permissions") ? "no permissions" : stateText;
    devices.push({ serial, state, props });
  }
  return devices;
}
