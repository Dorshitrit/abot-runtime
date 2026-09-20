import { expect, test, vi } from "vitest";
// @ts-expect-error Browser-only module.
import { downloadHostSetup } from "../../web-ui/app/components/system-host/download.js";
test("creates a transient download and releases its object URL without a persisted token", () => {
  const link = {
    click: vi.fn(),
    remove: vi.fn(),
    href: "",
    download: "",
    hidden: false,
  };
  const documentRoot = { createElement: () => link, body: { append: vi.fn() } };
  const urlApi = {
    createObjectURL: vi.fn(() => "blob:fixture"),
    revokeObjectURL: vi.fn(),
  };
  const createBlob = vi.fn(() => ({}));
  downloadHostSetup(
    {
      filename: "abot-setup.command",
      mimeType: "text/plain",
      contentBase64: "aGk=",
    },
    {
      documentRoot,
      urlApi,
      createBlob,
      defer: (callback: () => void) => callback(),
    },
  );
  expect(link.download).toBe("abot-setup.command");
  expect(link.click).toHaveBeenCalledOnce();
  expect(link.remove).toHaveBeenCalledOnce();
  expect(urlApi.revokeObjectURL).toHaveBeenCalledWith("blob:fixture");
  expect(createBlob).toHaveBeenCalledWith([new Uint8Array([104, 105])], {
    type: "text/plain",
  });
});
test("rejects invalid downloaded filenames before creating browser artifacts", () => {
  expect(() =>
    downloadHostSetup({
      filename: "../../bad.cmd",
      mimeType: "text/plain",
      contentBase64: "aGk=",
    }),
  ).toThrow("Invalid setup download");
});
