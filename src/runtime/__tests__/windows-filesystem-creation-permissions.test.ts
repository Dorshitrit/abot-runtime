import { execFile } from "node:child_process";
import { mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { WINDOWS_FILESYSTEM_SOURCE } from "../../../plugins/filesystem/source/windows/source.js";
import {
  createPortablePluginFixture,
  removePortablePluginFixtures,
} from "./windows-portable-plugins-fixture.js";

afterEach(removePortablePluginFixtures);

// Observe the native handle before control returns to CommitWrite. A later ACL
// change cannot revoke a handle another account opened during file creation.
const ASSERT_PRIVATE_AT_CREATION = String.raw`
public static partial class AbotFilesystem {
  [DllImport("advapi32.dll")] static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
  static void AssertPrivateAtCreation(SafeFileHandle file) {
    IntPtr owner, group, dacl, sacl, descriptor;
    uint error=GetSecurityInfo(file, 1, 4, out owner, out group, out dacl, out sacl, out descriptor);
    if (error != 0) NativeFailure(error);
    try {
      byte[] bytes=new byte[GetSecurityDescriptorLength(descriptor)];
      Marshal.Copy(descriptor, bytes, 0, bytes.Length);
      var security=new RawSecurityDescriptor(bytes, 0);
      if ((security.ControlFlags & ControlFlags.DiscretionaryAclProtected) == 0 ||
          security.DiscretionaryAcl == null || security.DiscretionaryAcl.Count != 1)
        throw new FsFault("creation_acl_is_not_private");
      var rule=security.DiscretionaryAcl[0] as CommonAce;
      if (rule == null || rule.AceType != AceType.AccessAllowed ||
          rule.SecurityIdentifier != WindowsIdentity.GetCurrent().User ||
          (rule.AccessMask & (int)FileSystemRights.FullControl) != (int)FileSystemRights.FullControl)
        throw new FsFault("creation_acl_is_not_private");
    } finally { LocalFree(descriptor); }
  }
}
`;

describe.skipIf(process.platform !== "win32")(
  "Windows filesystem creation permissions",
  () => {
    test("the temporary file is private at creation before any content is written", async () => {
      const context = await createPortablePluginFixture("filesystem");
      const root = context.runtimePaths.agentWorkDir;
      await mkdir(root, { recursive: true });
      const identity = await stat(root, { bigint: true });
      const source =
        WINDOWS_FILESYSTEM_SOURCE.replace(
          "return file;",
          "if (disposition == 2) AssertPrivateAtCreation(file); return file;",
        ) + ASSERT_PRIVATE_AT_CREATION;
      const request = {
        operation: "write",
        rootPath: root,
        relativePath: "private.txt",
        rootIdentity: {
          device: String(identity.dev),
          inode: String(identity.ino),
          birthtimeNs: String(identity.birthtimeNs),
        },
        expected: { kind: "absent" },
        content: Buffer.from("private content").toString("base64"),
      };
      const bootstrap = [
        "$ErrorActionPreference='Stop'",
        "$env:PSModulePath=[IO.Path]::Combine($PSHOME,'Modules')",
        "[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)",
        "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)",
        "$inputData=[Console]::In.ReadToEnd() | ConvertFrom-Json",
        "Add-Type -ReferencedAssemblies @('System.Web.Extensions') -TypeDefinition $inputData.source",
        "[Console]::Write([AbotFilesystem]::Run($inputData.request))",
      ].join(";");
      const stdout = await new Promise<string>((resolve, reject) => {
        const child = execFile(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-Command", bootstrap],
          { windowsHide: true, timeout: 15_000, maxBuffer: 16_384 },
          (error, output) => (error ? reject(error) : resolve(output)),
        );
        child.stdin!.end(
          JSON.stringify({ source, request: JSON.stringify(request) }),
        );
      });
      expect(JSON.parse(stdout)).toEqual({
        ok: true,
        result: { committed: true },
      });
      expect(await readFile(join(root, "private.txt"), "utf8")).toBe(
        "private content",
      );
    }, 20_000);
  },
);
