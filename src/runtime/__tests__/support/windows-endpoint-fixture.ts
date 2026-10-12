import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  localRuntimeEndpointPath,
  readLocalRuntimeEndpoint,
} from "../../local-host/endpoint.js";
import { assertWindowsPrivateFile } from "./windows-file-privacy.js";

const execute = promisify(execFile);
const setFixtureOwner = `
$env:PSModulePath = "$PSHOME\\Modules"
$ErrorActionPreference = 'Stop'
$target = $env:ABOT_TEST_ENDPOINT_FILE
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$acl = Get-Acl -LiteralPath $target
$owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
if ($owner -eq $identity.User.Value) { Write-Output 'current_user'; exit 0 }
if ($owner -ne $identity.Owner.Value -or $owner -ne 'S-1-5-32-544') {
  throw 'unexpected_endpoint_fixture_owner'
}
$access = [System.Security.AccessControl.AccessControlSections]::Access
$before = $acl.GetSecurityDescriptorSddlForm($access)
& icacls.exe $target /setowner (('*' + $identity.User.Value)) /Q | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'endpoint_fixture_setowner_failed' }
$after = Get-Acl -LiteralPath $target
if ($after.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $identity.User.Value) {
  throw 'endpoint_fixture_owner_not_applied'
}
if ($after.GetSecurityDescriptorSddlForm($access) -ne $before) {
  throw 'endpoint_fixture_dacl_changed'
}
Write-Output 'administrators_default_owner_normalized'
`;

/** Prepare this disposable endpoint for a routing test, keeping real ACL validation. */
export async function prepareWindowsEndpointFixture(
  directory: string,
): Promise<void> {
  if (process.platform !== "win32") return;
  const path = localRuntimeEndpointPath(directory);
  // The private DACL and token-default owner must already match the actual
  // creation contract. An unexpected owner, reparse point or broad ACL fails.
  await assertWindowsPrivateFile(path);
  const { stdout } = await execute(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(setFixtureOwner, "utf16le").toString("base64"),
    ],
    {
      env: { ...process.env, ABOT_TEST_ENDPOINT_FILE: path },
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 16_384,
    },
  );
  // The real reader must accept the endpoint; no ownership or DACL check is mocked.
  assert.ok(await readLocalRuntimeEndpoint(directory));
  console.info("endpoint_fixture_owner:" + stdout.trim());
}
