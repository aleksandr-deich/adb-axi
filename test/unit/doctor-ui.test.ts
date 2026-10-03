import { describe, expect, it } from "vitest";
import {
  parseAppProcessServers,
  parseForwards,
  parseInstrumentations,
  parseWedgedPids,
  type AppProcessServer,
  type Holder,
} from "../../src/android/holders.js";
import { classifyHolders, type Evidence } from "../../src/commands/doctor/ui-holders.js";
import { parseHostPs, type HostProcess } from "../../src/host/processes.js";

const SERIAL = "emulator-5554";

describe("parseInstrumentations pids", () => {
  it("reads the pid of every running process of an instrumentation", () => {
    const dump = [
      "  Active instrumentation:",
      "    Instrumentation #0: ActiveInstrumentation{4be1f09 {a.one/.Runner} 2 procs}",
      "      mClass=ComponentInfo{a.one/.Runner} mFinished=false",
      "      mRunningProcesses:",
      "        #0: ProcessRecord{9d1c2aa 9021:a.one/u0a214}",
      "        #1: ProcessRecord{9d1c2ab 9033:a.one:remote/u0a214}",
      "      mTargetProcesses=[ProcessRecord{9d1c2aa 9021:a.one/u0a214}]",
      "      mUiAutomationConnection=android.app.UiAutomationConnection@1",
      "  OOM levels:",
    ].join("\n");
    expect(parseInstrumentations(dump)).toEqual([
      {
        kind: "instrumentation",
        package: "a.one",
        component: "a.one/.Runner",
        uiAutomation: true,
        processes: [
          { pid: 9021, package: "a.one" },
          { pid: 9033, package: "a.one" },
        ],
      },
    ]);
  });
});

describe("parseAppProcessServers", () => {
  it("reads the class of each app_process server and skips everything else", () => {
    const ps = [
      "  PID ARGS",
      "    1 init second_stage",
      "  598 system_server",
      " 5443 app_process / com.mobilenext.mobilecli.DeviceServer",
      " 5501 app_process64 -Xmx64m /system/bin com.android.commands.uiautomator.Launcher dump",
      " 5600 /system/bin/app_process32 /data/local/tmp com.genymobile.scrcpy.Server 2.4",
      " 5700 app_process",
      " 5800 sh -c app_process / com.not.Me",
    ].join("\n");
    expect(parseAppProcessServers(ps)).toEqual<AppProcessServer[]>([
      { kind: "server", pid: 5443, className: "com.mobilenext.mobilecli.DeviceServer" },
      { kind: "server", pid: 5501, className: "com.android.commands.uiautomator.Launcher" },
      { kind: "server", pid: 5600, className: "com.genymobile.scrcpy.Server" },
    ]);
  });

  it("refuses output without the ps header", () => {
    expect(parseAppProcessServers("")).toBeNull();
    expect(parseAppProcessServers("bad option -o ARGS\n")).toBeNull();
    expect(parseAppProcessServers("  PID ARGS\n")).toEqual([]);
  });
});

describe("parseWedgedPids", () => {
  it("collects the pids whose log line carries the wedge signature", () => {
    const log = [
      "--------- beginning of main",
      "1790834111.087  5673  5690 E InstrumentationServer: java.lang.IllegalStateException: Cannot call disconnect() while connecting UiAutomation@4f2a9c1",
      "1790834112.001  5800  5800 I Other   : Cannot call disconnect later",
      "not a log line",
    ].join("\n");
    expect([...parseWedgedPids(log)]).toEqual([5673]);
  });
});

describe("parseForwards", () => {
  it("reads serial, local and remote of each forward", () => {
    expect(
      parseForwards(
        `${SERIAL} tcp:12000 localabstract:mobilecli-server\nemulator-5556 tcp:7001 tcp:7001\n\n`,
      ),
    ).toEqual([
      { serial: SERIAL, local: "tcp:12000", remote: "localabstract:mobilecli-server" },
      { serial: "emulator-5556", local: "tcp:7001", remote: "tcp:7001" },
    ]);
  });
});

describe("parseHostPs", () => {
  it("reads the pid and the whole command line, spaces included", () => {
    expect(parseHostPs("    1 /sbin/launchd\n 4242 node /a b/agent-device daemon \n\n")).toEqual([
      { pid: 1, args: "/sbin/launchd" },
      { pid: 4242, args: "node /a b/agent-device daemon" },
    ]);
  });
});

describe("classifyHolders", () => {
  const instrumentation = (component: string, pid: number): Holder => ({
    kind: "instrumentation",
    package: component.split("/")[0] ?? "",
    component,
    uiAutomation: true,
    processes: [{ pid, package: component.split("/")[0] ?? "" }],
  });
  const evidence = (overrides: Partial<Evidence>): Evidence => ({
    serial: SERIAL,
    instrumentations: [],
    servers: [],
    wedgedPids: new Set(),
    host: [],
    forwards: [],
    serials: new Set([SERIAL, "USB-A", "USB-B"]),
    avd: "Pixel_10_Pro_XL",
    selfPid: 99_999,
    ...overrides,
  });
  const one = (overrides: Partial<Evidence>) => {
    const [holder] = classifyHolders(evidence(overrides));
    return { state: holder?.state, why: holder?.why };
  };
  const ANDROID_CLI = instrumentation(
    "com.android.cli.interact.instrumentation/.InstrumentationServer",
    5673,
  );
  const RUNNER = instrumentation(
    "com.example.notes.test/androidx.test.runner.AndroidJUnitRunner",
    9021,
  );
  const host = (...processes: HostProcess[]): HostProcess[] => [
    { pid: 1, args: "/sbin/launchd" },
    ...processes,
  ];

  it("keeps a live holder live even when it logged the wedge", () => {
    expect(
      one({
        instrumentations: [ANDROID_CLI],
        host: host({ pid: 300, args: "/usr/local/bin/android layout --flat" }),
        wedgedPids: new Set([5673]),
      }),
    ).toEqual({ state: "live", why: "android pid 300 on the host" });
  });

  it("never counts adb-axi itself as a client", () => {
    expect(
      one({
        instrumentations: [RUNNER],
        host: host({ pid: 4000, args: `adb -s ${SERIAL} shell am instrument -w x/.R` }),
        selfPid: 4000,
      }),
    ).toEqual({ state: "leaked", why: "no host client" });
  });

  it.each([
    ["an AVD name", `adb -s Pixel_10_Pro_XL shell am instrument -w ${RUNNER.component}`],
    ["no device at all", `adb shell am instrument -w ${RUNNER.component}`],
    [
      "this serial with --serial=",
      `adb --serial=${SERIAL} shell am instrument -w ${RUNNER.component}`,
    ],
  ])("counts a client that names %s as targeting this device", (_name, args) => {
    expect(one({ instrumentations: [RUNNER], host: host({ pid: 4100, args }) }).state).toBe("live");
  });

  it.each([
    "adb --device emulator-5556 shell am instrument -w x/.R",
    "adb -s USB-B shell am instrument -w x/.R",
    "adb --serial=USB-B shell am instrument -w x/.R",
    "adb --device USB-B shell am instrument -w x/.R",
    "adb --device unattached-physical-serial shell am instrument -w x/.R",
  ])("does not count a client explicitly targeting another serial: %s", (args) => {
    expect(
      one({
        serial: "USB-A",
        avd: null,
        instrumentations: [RUNNER],
        host: host({ pid: 4100, args }),
      }).state,
    ).toBe("leaked");
  });

  it("keeps the target AVD name but excludes other explicit serials", () => {
    const client = (named: string) =>
      host({
        pid: 4100,
        args: `adb --device ${named} shell am instrument -w ${RUNNER.component}`,
      });
    expect(one({ instrumentations: [RUNNER], host: client("Pixel_10_Pro_XL") }).state).toBe("live");
    expect(one({ instrumentations: [RUNNER], host: client("other-serial") }).state).toBe("leaked");
  });

  it("binds a named adb instrumentation client to its component, including relative classes", () => {
    const live = instrumentation("a.one/.Runner", 100);
    const leaked = instrumentation("b.two/.Runner", 200);
    const holders = classifyHolders(
      evidence({
        instrumentations: [live, leaked],
        host: host({
          pid: 4100,
          args: `adb -s ${SERIAL} shell am instrument -w a.one/a.one.Runner`,
        }),
      }),
    );
    expect(holders.map((holder) => holder.state)).toEqual(["live", "leaked"]);
    const disguised = classifyHolders(
      evidence({
        instrumentations: [live, leaked],
        host: host({
          pid: 4101,
          args: `adb shell am instrument -w b.two/.Runner gradlew connectedDebugAndroidTest`,
        }),
      }),
    );
    expect(disguised.map((holder) => holder.state)).toEqual(["leaked", "live"]);
    expect(
      one({
        instrumentations: [leaked],
        host: host({ pid: 4100, args: `adb shell am instrument -w` }),
      }).state,
    ).toBe("live");
  });

  it("does not take a Gradle daemon or a non-device task for a running device test", () => {
    for (const args of [
      "/usr/bin/java -cp gradle-launcher.jar org.gradle.launcher.daemon.bootstrap.GradleDaemon 8.10",
      "/usr/bin/java -cp gradle-wrapper.jar org.gradle.wrapper.GradleWrapperMain assembleDebug",
    ]) {
      expect(one({ instrumentations: [RUNNER], host: host({ pid: 4200, args }) }).state).toBe(
        "leaked",
      );
    }
    expect(
      one({
        instrumentations: [RUNNER],
        host: host({ pid: 4201, args: "./gradlew :app:connectedDebugAndroidTest" }),
      }),
    ).toEqual({ state: "live", why: "a Gradle connected* task pid 4201 on the host" });
  });

  it("recognizes mobilecli and agent-device only by executable or node/npx script identity", () => {
    const mobile: AppProcessServer = {
      kind: "server",
      pid: 5443,
      className: "com.mobilenext.mobilecli.DeviceServer",
    };
    const agent = instrumentation("com.callstack.agentdevice.test/.SnapshotInstrumentation", 8120);
    const classify = (found: AppProcessServer | Holder, args: string) =>
      one({
        instrumentations: found.kind === "instrumentation" ? [found] : [],
        servers: found.kind === "server" ? [found] : [],
        forwards: [
          { serial: SERIAL, local: "tcp:12000", remote: "localabstract:mobilecli-server" },
        ],
        host: host({ pid: 4300, args }),
      }).state;
    for (const [found, name] of [[mobile, "mobile-mcp"], [agent, "agent-device"]] as const) {
      expect(classify(found, `rg ${name} README.md`)).toBe("leaked");
      expect(classify(found, `node ./scripts/run.js ${name}`)).toBe("leaked");
      expect(classify(found, `/usr/local/bin/${name} serve`)).toBe("live");
      expect(classify(found, `node /repo/node_modules/${name}/dist/daemon.js`)).toBe("live");
      expect(classify(found, `npx -y ${name}`)).toBe("live");
    }
    expect(classify(mobile, "node /repo/node_modules/mobilecli/dist/server.js")).toBe("live");
  });

  it("recognises a uiautomator run started from the host", () => {
    const server: AppProcessServer = {
      kind: "server",
      pid: 5501,
      className: "com.android.commands.uiautomator.Launcher",
    };
    expect(one({ servers: [server] })).toEqual({ state: "leaked", why: "no host client" });
    expect(
      one({
        servers: [server],
        host: host({ pid: 4300, args: `adb -s ${SERIAL} shell uiautomator dump` }),
      }),
    ).toEqual({ state: "live", why: "adb shell uiautomator pid 4300 on the host" });
  });

  it("leaves out servers and instrumentations that do not hold UiAutomation", () => {
    expect(
      classifyHolders(
        evidence({
          servers: [{ kind: "server", pid: 5600, className: "com.genymobile.scrcpy.Server" }],
          instrumentations: [{ ...RUNNER, uiAutomation: false }],
        }),
      ),
    ).toEqual([]);
  });
});
