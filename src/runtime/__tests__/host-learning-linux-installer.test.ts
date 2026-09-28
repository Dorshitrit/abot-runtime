import { execFileSync } from "node:child_process";
import { expect, test } from "vitest";
import { renderCompanionInstaller } from "../../web-ui/system-host-setup/installers.js";

test.skipIf(process.platform === "win32")(
  "Linux installer is valid shell with pinned bundle integrity and existing Node prerequisite",
  async () => {
    const result = await renderCompanionInstaller({
      platform: "linux",
      url: "http://localhost:5177",
      code: "a".repeat(43),
      bundleSha256: "b".repeat(64),
      expiresAt: "2030-01-01T00:00:00Z",
    });
    expect(result.filename).toBe("ABot-Connect-Computer-Linux.sh");
    const script = Buffer.from(result.contentBase64, "base64").toString();
    expect(() => execFileSync("bash", ["-n"], { input: script })).not.toThrow();
    expect(script).toContain("command -v node");
    expect(script).toContain("--max-redirs 0");
    expect(script).toContain("b".repeat(64));
    expect(script).not.toMatch(/sudo|apt install|brew install|npm install/u);
  },
);
