import { constants } from "node:fs";
import { access } from "node:fs/promises";

import { beforeEach, describe, expect, test, vi } from "vitest";

import { assertSupportedShell } from "../../../plugins/exec/source/shell-platform.js";

vi.mock("node:fs/promises", () => ({ access: vi.fn() }));

beforeEach(() => {
  vi.mocked(access).mockReset().mockResolvedValue(undefined);
});

describe("exec shell platform admission", () => {
  test.each(["linux", "darwin"] as const)(
    "accepts %s only after executable Bash is available",
    async (platform) => {
      await expect(assertSupportedShell(platform)).resolves.toBeUndefined();
      expect(access).toHaveBeenCalledExactlyOnceWith("/bin/bash", constants.X_OK);
    },
  );

  test.each(["win32", "freebsd"] as const)(
    "rejects unsupported %s without selecting another shell",
    async (platform) => {
      await expect(assertSupportedShell(platform)).rejects.toMatchObject({
        code: "exec_platform_unsupported",
      });
      expect(access).not.toHaveBeenCalled();
    },
  );

  test.each(["linux", "darwin"] as const)(
    "fails explicitly when Bash is unavailable on %s",
    async (platform) => {
      vi.mocked(access).mockRejectedValueOnce(new Error("not executable"));
      await expect(assertSupportedShell(platform)).rejects.toMatchObject({
        code: "exec_shell_unavailable",
      });
    },
  );
});
