import { expect, test, vi } from "vitest";
import { readInstallerCompanionBundle } from "../../web-ui/system-host-setup/companion-bundle.js";

test("packaged Web service serves its adjacent bundled CLI", async () => {
  const bytes = Buffer.from("bundle");
  const read = vi.fn(async () => bytes);
  expect(await readInstallerCompanionBundle("file:///package/dist/src/web-ui/system-host-setup/companion-bundle.js", read)).toBe(bytes);
  expect(read).toHaveBeenCalledExactlyOnceWith(new URL("file:///package/dist/src/cli/host-companion-bundle.mjs"));
});

test("source Web service serves the generated build when its source has no bundle", async () => {
  const bytes = Buffer.from("bundle");
  const read = vi.fn<(_: URL) => Promise<Buffer>>()
    .mockRejectedValueOnce(Object.assign(new Error("missing"), { code: "ENOENT" }))
    .mockResolvedValueOnce(bytes);
  expect(await readInstallerCompanionBundle("file:///source/src/web-ui/system-host-setup/companion-bundle.ts", read)).toBe(bytes);
  expect(read.mock.calls[1]![0]).toEqual(new URL("file:///source/dist/src/cli/host-companion-bundle.mjs"));
});

test("permission failures do not fall back to another bundle", async () => {
  const denied = Object.assign(new Error("denied"), { code: "EACCES" });
  const read = vi.fn(async () => { throw denied; });
  await expect(readInstallerCompanionBundle(undefined, read)).rejects.toBe(denied);
  expect(read).toHaveBeenCalledOnce();
});
