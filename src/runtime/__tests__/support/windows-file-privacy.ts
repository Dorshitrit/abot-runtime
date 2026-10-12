import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
const inspectFileAcl = `
$env:PSModulePath = "$PSHOME\\Modules"
$ErrorActionPreference = 'Stop'
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$item = Get-Item -LiteralPath $env:ABOT_TEST_PRIVATE_FILE -Force
$acl = Get-Acl -LiteralPath $env:ABOT_TEST_PRIVATE_FILE
$rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object {
  @{ sid=$_.IdentityReference.Value; type=$_.AccessControlType.ToString(); inherited=$_.IsInherited; rights=$_.FileSystemRights.ToString() }
})
@{
  owner=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
  tokenOwner=$identity.Owner.Value
  currentUser=$identity.User.Value
  isDirectory=$item.PSIsContainer
  reparsePoint=(($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)
  rules=$rules
} | ConvertTo-Json -Depth 4 -Compress
`;

/** New files inherit the directory DACL but receive the creating token's default owner. */
export async function assertWindowsPrivateFile(path: string): Promise<void> {
  let stdout: string;
  try {
    ({ stdout } = await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand",
      Buffer.from(inspectFileAcl, "utf16le").toString("base64")], {
      env: { ...process.env, ABOT_TEST_PRIVATE_FILE: path },
      windowsHide: true, timeout: 10_000, maxBuffer: 16_384,
    }));
  } catch (error) {
    const failure = error as Error & { code?: unknown; killed?: boolean; signal?: string; stderr?: string };
    throw new Error("windows_file_privacy_probe_failed: " + JSON.stringify({
      code: failure.code, killed: failure.killed, signal: failure.signal, stderr: failure.stderr,
    }), { cause: error });
  }
  const acl = JSON.parse(stdout) as {
    owner: string; tokenOwner: string; currentUser: string; isDirectory: boolean; reparsePoint: boolean;
    rules: Array<{ sid: string; type: string; inherited: boolean; rights: string }>;
  };
  const diagnostic = "Windows file ACL: " + JSON.stringify(acl);
  assert.match(acl.currentUser, /^S-1-/, diagnostic);
  assert.match(acl.tokenOwner, /^S-1-/, diagnostic);
  assert.equal(acl.owner, acl.tokenOwner, diagnostic);
  assert.equal(acl.isDirectory, false, diagnostic);
  assert.equal(acl.reparsePoint, false, diagnostic);
  assert.deepEqual(acl.rules, [{ sid: acl.currentUser, type: "Allow", inherited: true, rights: "FullControl" }], diagnostic);
}
