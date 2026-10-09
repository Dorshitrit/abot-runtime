import { execFileSync } from "node:child_process";
import { expect, test } from "vitest";
import {
  installLinkRegistryProbe,
  windowsLinkTestOwner,
} from "./support/install-link-windows-registry-fixture.js";

const powershell =
  process.platform === "win32"
    ? "powershell.exe"
    : process.env.ABOT_TEST_WINDOWS_POWERSHELL;

const cases = [
  {
    action: "install",
    user: null,
    merged: "another application",
    rejected: true,
    writes: 0,
  },
  { action: "install", user: null, merged: "", rejected: true, writes: 0 },
  {
    action: "install",
    user: "another application",
    merged: "another application",
    rejected: true,
    writes: 0,
  },
  { action: "install", user: null, merged: null, rejected: false, writes: 6 },
  {
    action: "install",
    user: windowsLinkTestOwner,
    merged: windowsLinkTestOwner,
    rejected: false,
    writes: 6,
  },
  {
    action: "remove",
    user: null,
    merged: "another application",
    rejected: false,
    writes: 0,
  },
  {
    action: "remove",
    user: windowsLinkTestOwner,
    merged: windowsLinkTestOwner,
    rejected: false,
    writes: 1,
  },
  {
    action: "remove",
    user: "another application",
    merged: "another application",
    rejected: true,
    writes: 0,
  },
] as const;

test.skipIf(!powershell).each(cases)(
  "Windows $action preserves registry ownership for user=$user and merged=$merged",
  ({ action, user, merged, rejected, writes }) => {
    const script = installLinkRegistryProbe(action, user, merged);
    const output = execFileSync(
      powershell!,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { encoding: "utf8", timeout: 15_000, windowsHide: true },
    );
    const result = JSON.parse(output.trim());
    expect(result.Rejected, result.Failure).toBe(rejected);
    expect(result.Writes).toHaveLength(writes);
    for (const write of result.Writes)
      expect(write.split(":").slice(1).join(":")).toMatch(
        /^HKCU:\\Software\\Classes\\abot(?:\\|$)/u,
      );
    if (rejected)
      expect(result.Failure).toContain("belongs to another application");
  },
);
