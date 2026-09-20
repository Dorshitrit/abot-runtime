import { execFileSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import { renderWslInteropShell, WSL_INTEROP_AWK_PROGRAM } from "../../web-ui/system-host-setup/wsl-interop-config.js";

function transformed(input: string) {
  return execFileSync("awk", [WSL_INTEROP_AWK_PROGRAM], { input, encoding: "utf8" });
}

describe("WSL setup changes only interoperability enablement", () => {
  test("preserves unrelated sections, keys, comments and appendWindowsPath", () => {
    const before = "# user-owned settings\n[boot]\nsystemd=true\n[interop]\nenabled=false\nappendWindowsPath=false\n[automount]\nroot=/windows/\noptions=metadata\n";
    expect(transformed(before)).toBe(before.replace("enabled=false", "enabled=true"));
  });

  test("an already enabled configuration remains byte-for-byte unchanged", () => {
    const before = "[interop]\n  enabled = true ; retain comment\nappendWindowsPath=false\n[boot]\nsystemd=true\n";
    expect(transformed(before)).toBe(before);
  });

  test("inserts one enablement entry into an existing section without duplicating it", () => {
    const before = "[interop]\nappendWindowsPath=false\n# keep this\n[boot]\nsystemd=true\n";
    const after = transformed(before);
    expect(after).toBe("[interop]\nappendWindowsPath=false\n# keep this\nenabled=true\n[boot]\nsystemd=true\n");
    expect(transformed(after)).toBe(after);
  });

  test("adds a missing section while leaving commented examples alone", () => {
    const before = "# [interop]\n# enabled=false\n[boot]\nsystemd=true\n";
    expect(transformed(before)).toBe(before + "[interop]\nenabled=true\n");
  });

  test("all active duplicate enablement keys are enabled without rewriting other keys", () => {
    const before = "[interop]\nenabled=false\nappendWindowsPath=false\n[interop]\nEnabled = false # local comment\n";
    expect(transformed(before)).toBe("[interop]\nenabled=true\nappendWindowsPath=false\n[interop]\nEnabled =true # local comment\n");
  });

  test("generated privileged shell parses but is never executed by this test", () => {
    execFileSync("/bin/sh", ["-n"], { input: renderWslInteropShell() });
  });

  test("Windows CRLF in the encoded stdin cannot change the decoded script", () => {
    const encoded = Buffer.from(renderWslInteropShell(), "utf8").toString("base64") + "\r\n";
    const decoded = execFileSync("/bin/sh", ["-c", 'tr -d "\\r\\n" | base64 -d'], { input: encoded, encoding: "utf8" });
    expect(decoded).toBe(renderWslInteropShell());
  });
});
