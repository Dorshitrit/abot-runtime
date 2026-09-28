import { afterEach, describe, expect, test, vi } from "vitest";
import { createSystemHandlers } from "../../computer-access/handlers.js";
import { executeSystemCommand } from "../../computer-access/commands.js";
import { elevatedSystemCommand } from "../../computer-access/elevation.js";
import { systemProcessResult } from "../../computer-access/process-result.js";
import { parseDesktopApplication } from "../../computer-access/application-catalog.js";
import { powershellArguments } from "../../computer-access/targets.js";
import type {
  SystemProcessInput,
  SystemProcessResult,
  SystemProcessRunner,
  SystemTarget,
} from "../../computer-access/contracts.js";
import type { ToolExecutionContext } from "../../capabilities/tool-types.js";

const windowsTarget: SystemTarget = {
  id: "windows",
  transport: "wsl_interop",
  shell: "/observed/windows/powershell.exe",
};
const macTarget: SystemTarget = {
  id: "macos",
  transport: "native",
  shell: "/bin/bash",
};
const completed: SystemProcessResult = {
  exitCode: 0,
  stdout: "observed output",
  stderr: "",
  status: "completed",
  outputTruncated: false,
};

function runner(result: SystemProcessResult = completed) {
  return vi.fn<SystemProcessRunner>(async () => result);
}

function decodedPowerShell(input: SystemProcessInput): string {
  const marker = input.args.indexOf("-EncodedCommand");
  expect(marker).toBeGreaterThanOrEqual(0);
  return Buffer.from(input.args[marker + 1]!, "base64").toString("utf16le");
}

function requestContext(
  mode: "ask" | "full_access" | "full_plus",
): ToolExecutionContext {
  return {
    sharedState: {
      requestContext: { agentMode: "reasoning", toolPermissionMode: mode },
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("system adapter target validation", () => {
  test.each(["ask", "full_access", "full_plus"] as const)(
    "trusted host dispatch in %s still requires an explicit OS target",
    async (mode) => {
      const run = runner();
      const result = await createSystemHandlers(run).system_command!(
        { command: "whoami", cwd: "C:\\" },
        requestContext(mode),
      );
      expect(result).toMatchObject({
        ok: false,
        errorCode: "system_target_required",
      });
      expect(run).not.toHaveBeenCalled();
    },
  );
});

describe("explicit native command plans with an injected runner", () => {
  test("Windows uses encoded PowerShell and treats an absolute cwd as literal data", async () => {
    const run = runner();
    const cwd = "C:\\Owner's $(not-a-command)\\Desktop";
    const command = "Write-Output 'observed outcome'";
    const abortSignal = new AbortController().signal;
    const result = await executeSystemCommand({
      target: windowsTarget,
      params: { command, cwd, timeout_ms: 12_000 },
      run,
      abortSignal,
    });
    expect(run).toHaveBeenCalledOnce();
    const input = run.mock.calls[0]![0];
    expect(input).toMatchObject({
      executable: windowsTarget.shell,
      timeoutMs: 12_000,
      abortSignal,
    });
    expect(input.cwd).toBeUndefined();
    expect(input.args).toEqual(
      expect.arrayContaining([
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
      ]),
    );
    const script = decodedPowerShell(input);
    expect(script).toContain(
      "Set-Location -LiteralPath 'C:\\Owner''s $(not-a-command)\\Desktop'",
    );
    expect(script).toContain(command);
    const receipt = systemProcessResult(
      windowsTarget,
      result,
      "command_process_completion",
    );
    expect(receipt).toMatchObject({
      ok: true,
      exitCode: 0,
      data: { target: "windows", transport: "wsl_interop" },
    });
    expect(receipt).not.toMatchObject({ observedStateChange: true });
  });

  test.each(["relative", "C:relative", "/tmp", "\\current-drive"])(
    "Windows rejects ambiguous or relative cwd %s before execution",
    async (cwd) => {
      const run = runner();
      await expect(
        executeSystemCommand({
          target: windowsTarget,
          params: { command: "Get-Location", cwd },
          run,
        }),
      ).rejects.toMatchObject({ code: "system_cwd_invalid" });
      expect(run).not.toHaveBeenCalled();
    },
  );

  test("PowerShell transport retains Unicode and quoting without a raw command argument", () => {
    const script = "Write-Output 'café'; $value = 'C:\\one two\\file'";
    const args = powershellArguments(script);
    expect(args).not.toContain(script);
    expect(
      decodedPowerShell({ executable: windowsTarget.shell, args }),
    ).toContain(script);
  });

  test("nonzero command completion stays failure and preserves the observed OS target", () => {
    const receipt = systemProcessResult(
      windowsTarget,
      {
        ...completed,
        exitCode: 7,
        stdout: "partial output",
        stderr: "native failure",
      },
      "command_process_completion",
    );
    expect(receipt).toMatchObject({
      ok: false,
      errorCode: "system_command_failed",
      exitCode: 7,
      stdout: "partial output",
      stderr: "native failure",
      data: {
        target: "windows",
        transport: "wsl_interop",
        processStatus: "completed",
      },
    });
    expect(receipt).not.toMatchObject({ observedStateChange: true });
  });

  test.each(["timeout", "aborted", "spawn_failed"] as const)(
    "%s cannot become successful completion despite partial stdout",
    (status) => {
      const receipt = systemProcessResult(
        macTarget,
        { ...completed, status, exitCode: null },
        "command_process_completion",
      );
      expect(receipt).toMatchObject({
        ok: false,
        errorCode: `system_${status}`,
        data: { target: "macos", processStatus: status },
      });
      expect(receipt).not.toMatchObject({ observedStateChange: true });
    },
  );
});

describe("native elevation planning without an OS action", () => {
  test.each([
    { ...completed, stdout: "False" },
    { ...completed, stdout: "True", exitCode: 1 },
  ])(
    "missing Windows administrator authority stops after the observation probe",
    async (probe) => {
      const run = runner(probe);
      const command = "Write-Output 'must not execute'";
      await expect(
        executeSystemCommand({
          target: windowsTarget,
          params: { command, cwd: "C:\\Windows", elevated: true },
          run,
        }),
      ).rejects.toMatchObject({ code: "system_authorization_required" });
      expect(run).toHaveBeenCalledOnce();
      const script = decodedPowerShell(run.mock.calls[0]![0]);
      expect(script).toContain("IsInRole");
      expect(script).not.toContain(command);
    },
  );

  test("an observed Windows administrator receives a plan, not a fabricated execution result", async () => {
    const run = runner({ ...completed, stdout: "True\r\n" });
    const plan = await elevatedSystemCommand({
      target: windowsTarget,
      cwd: "C:\\Windows",
      command: "Write-Output 'planned'",
      run,
    });
    expect(run).toHaveBeenCalledOnce();
    expect(plan.executable).toBe(windowsTarget.shell);
    expect(decodedPowerShell(plan)).toContain("Write-Output 'planned'");
  });

  test("macOS non-root elevation produces an osascript authorization plan without invoking it", async () => {
    vi.stubGlobal("process", { ...process, getuid: () => 501 });
    const run = runner();
    const plan = await elevatedSystemCommand({
      target: macTarget,
      cwd: "/Volumes/QA/My folder",
      command: "printf '%s' 'quoted value'",
      run,
    });
    expect(run).not.toHaveBeenCalled();
    expect(plan.executable).toBe("/usr/bin/osascript");
    expect(plan.args[0]).toBe("-e");
    expect(plan.args[1]).toMatch(
      /^do shell script .+ with administrator privileges$/u,
    );
    const encodedScript = plan.args[1]!.slice(
      "do shell script ".length,
      -" with administrator privileges".length,
    );
    const shellScript = JSON.parse(encodedScript) as string;
    expect(shellScript).toContain("cd '/Volumes/QA/My folder'");
    expect(shellScript).toContain("'/bin/bash' -lc");
  });
});

describe("observed Linux desktop application entries", () => {
  test("returns the Desktop Entry identity rather than a later desktop action name", () => {
    const application = parseDesktopApplication(
      [
        "[Desktop Entry]",
        "Type=Application",
        "Name=Observed application",
        "Exec=example --open %U",
        "[Desktop Action Secondary]",
        "Name=Different action",
        "Exec=example --secondary",
      ].join("\n"),
      "/applications/observed.desktop",
    );
    expect(application).toEqual({
      id: "/applications/observed.desktop",
      name: "Observed application",
      target: "linux",
    });
  });

  test.each([
    "[Desktop Entry]\nType=Application\nName=Hidden\nHidden=true",
    "[Desktop Entry]\nType=Link\nName=Not an app",
    "[Desktop Entry]\nType=Application\nExec=missing-name",
    "[Unrelated]\nType=Application\nName=Wrong section",
  ])(
    "does not turn non-launchable desktop metadata into an application",
    (content) => {
      expect(
        parseDesktopApplication(content, "/applications/ignored.desktop"),
      ).toBeUndefined();
    },
  );
});
