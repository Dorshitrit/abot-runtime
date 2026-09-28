import { expect, test, vi } from "vitest";
import {
  createProcessOwnerIdentityProbe,
  hasSameProcessOwnerIdentity,
  type ProcessOwnerIdentityDependencies,
} from "../../computer-access/companion/process-owner-identity.js";

const boot = "741b95bb-7389-4726-a6d7-3ced1c6fb310";
function dependencies(
  platform: NodeJS.Platform,
): ProcessOwnerIdentityDependencies {
  return {
    platform,
    currentPid: 123,
    readText: vi.fn(async () => ""),
    execute: vi.fn(async () => ""),
    processIsAlive: vi.fn(() => true),
  };
}
function processStat(pid: number, startTicks: string): string {
  return `${pid} (a name with ) nested (parentheses)) ${["S", ...Array(18).fill("1"), startTicks, "2"].join(" ")}\n`;
}

test("Linux binds the boot UUID and exact starttime field despite command-name parentheses", async () => {
  const configuration = {
    ...dependencies("linux"),
    readText: vi.fn(async (path: string) =>
      path.endsWith("boot_id") ? boot + "\n" : processStat(123, "987654321"),
    ),
  };
  const probe = createProcessOwnerIdentityProbe(configuration);
  expect(await probe.readProcessOwnerIdentity(123)).toBe(
    `linux:${boot}:987654321`,
  );
  expect(await probe.isProcessOwnerAlive(123, `linux:${boot}:987654321`)).toBe(
    true,
  );
  expect(await probe.isProcessOwnerAlive(123, `linux:${boot}:456789`)).toBe(
    false,
  );
  expect(
    await probe.isProcessOwnerAlive(123, "linux:another-boot:987654321"),
  ).toBe(false);
});

test("a missing PID is dead without consulting a recycled process record", async () => {
  const configuration = {
    ...dependencies("linux"),
    processIsAlive: vi.fn(() => false),
  };
  const probe = createProcessOwnerIdentityProbe(configuration);
  expect(await probe.isProcessOwnerAlive(123, "prior-owner")).toBe(false);
  expect(configuration.readText).not.toHaveBeenCalled();
});

test("a live legacy owner with no incarnation metadata remains owned", async () => {
  const configuration = dependencies("linux");
  const probe = createProcessOwnerIdentityProbe(configuration);
  expect(await probe.isProcessOwnerAlive(123)).toBe(true);
  expect(configuration.readText).not.toHaveBeenCalled();
});

test.each(["linux", "darwin", "win32"] as const)(
  "%s identity probe errors never permit reclaiming a live process",
  async (platform) => {
    const configuration = {
      ...dependencies(platform),
      readText: vi.fn(async () => {
        throw new Error("unreadable");
      }),
      execute: vi.fn(async () => {
        throw new Error("unauthorized");
      }),
    };
    const probe = createProcessOwnerIdentityProbe(configuration);
    expect(await probe.readProcessOwnerIdentity(123)).toBeUndefined();
    expect(await probe.isProcessOwnerAlive(123, "prior-owner")).toBe(true);
    await expect(probe.requireCurrentProcessOwnerIdentity()).rejects.toThrow(
      "ownership lock was not acquired",
    );
  },
);

test("Windows uses a fixed encoded native probe with hidden execution and PID as data", async () => {
  const execute = vi.fn(async () => "638938000000000000\r\n");
  const probe = createProcessOwnerIdentityProbe({
    ...dependencies("win32"),
    execute,
  });
  expect(await probe.readProcessOwnerIdentity(123)).toBe(
    "windows:638938000000000000",
  );
  const call = execute.mock.calls[0] as unknown as [
    string,
    string[],
    { env: NodeJS.ProcessEnv; windowsHide: boolean; timeout: number },
  ];
  expect(call[0]).toBe("powershell.exe");
  expect(call[1].slice(0, 3)).toEqual([
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
  ]);
  const script = Buffer.from(call[1][3]!, "base64").toString("utf16le");
  expect(script).toContain("$env:ABOT_HOST_OWNER_PID");
  expect(script).toContain("StartTime.ToUniversalTime().Ticks");
  expect(call[1]).not.toContain("-ExecutionPolicy");
  expect(call[2]).toMatchObject({
    windowsHide: true,
    timeout: 5_000,
    env: { ABOT_HOST_OWNER_PID: "123" },
  });
});

test("Windows liveness preserves legacy ownership when the reported boot time drifts", async () => {
  const execute = vi.fn(async () => "639258367054633809");
  const probe = createProcessOwnerIdentityProbe({
    ...dependencies("win32"),
    execute,
  });
  const legacy = "windows:639234943810385860|639258367054633809";
  expect(await probe.isProcessOwnerAlive(123, legacy)).toBe(true);
  expect(
    await probe.isProcessOwnerAlive(123, "windows:639258367054633809"),
  ).toBe(true);
  expect(
    hasSameProcessOwnerIdentity(
      legacy,
      "windows:639234943798338700|639258367054633809",
    ),
  ).toBe(true);
  execute.mockResolvedValue("639258367054633810");
  expect(await probe.isProcessOwnerAlive(123, legacy)).toBe(false);
});

test.each([
  "windows:bad|639258367054633809",
  "windows:639258367054633809|extra",
  "linux:639258367054633809",
  "macos:639258367054633809",
])(
  "Windows identity compatibility rejects unrelated formats: %s",
  (observed) => {
    expect(
      hasSameProcessOwnerIdentity("windows:639258367054633809", observed),
    ).toBe(false);
  },
);

test("macOS uses boot-session identity and stable UTC/C-locale process start time", async () => {
  const execute = vi.fn(async (file: string) =>
    file.endsWith("sysctl") ? `${boot}\n` : "Fri Sep  18 19:12:34 2026\n",
  );
  const probe = createProcessOwnerIdentityProbe({
    ...dependencies("darwin"),
    execute,
  });
  expect(await probe.readProcessOwnerIdentity(123)).toBe(
    `macos:${boot}:Fri Sep 18 19:12:34 2026`,
  );
  expect(execute).toHaveBeenCalledWith(
    "/usr/sbin/sysctl",
    ["-n", "kern.bootsessionuuid"],
    expect.objectContaining({
      env: expect.objectContaining({ LC_ALL: "C", TZ: "UTC" }),
    }),
  );
  expect(execute).toHaveBeenCalledWith(
    "/bin/ps",
    ["-p", "123", "-o", "lstart="],
    expect.objectContaining({ windowsHide: true }),
  );
});

test.each([0, -1, 12.5, Number.NaN, Number.POSITIVE_INFINITY])(
  "rejects invalid PID %s before any OS access",
  async (pid) => {
    const configuration = dependencies("win32");
    const probe = createProcessOwnerIdentityProbe(configuration);
    expect(await probe.readProcessOwnerIdentity(pid)).toBeUndefined();
    expect(await probe.isProcessOwnerAlive(pid, "owner")).toBe(false);
    expect(configuration.execute).not.toHaveBeenCalled();
    expect(configuration.processIsAlive).not.toHaveBeenCalled();
  },
);
