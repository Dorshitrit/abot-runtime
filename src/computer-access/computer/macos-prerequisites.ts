import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { promisify } from "node:util";

const executeFile = promisify(execFile);

/** Do not launch Apple's developer-tools installer as a side effect of inspection. */
export async function missingMacosComputerPrerequisite(): Promise<
  string | undefined
> {
  try {
    const version = await executeFile("/usr/bin/sw_vers", ["-productVersion"], {
      timeout: 1000,
      maxBuffer: 1024,
    });
    const major = Number(version.stdout.trim().split(".")[0]);
    if (!Number.isInteger(major) || major < 14)
      return "macos14_computer_backend_required";
    const directory = await executeFile("/usr/bin/xcode-select", ["-p"], {
      timeout: 1000,
      maxBuffer: 4096,
    });
    await access(directory.stdout.trim());
    return undefined;
  } catch {
    return "macos_swift_developer_tools_required";
  }
}
