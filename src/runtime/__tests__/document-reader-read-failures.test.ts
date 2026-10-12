import { afterEach, expect, test, vi } from "vitest";
import createPlugin from "../../../plugins/document-reader/source/index.js";
import {
  readBoundedRegularFile,
  type BoundedRegularFileReadFailure,
} from "../../plugin-sdk/index.js";
import {
  createPortablePluginFixture,
  removePortablePluginFixtures,
} from "./windows-portable-plugins-fixture.js";

vi.mock("../../plugin-sdk/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugin-sdk/index.js")>()),
  readBoundedRegularFile: vi.fn(),
}));
afterEach(async () => {
  vi.resetAllMocks();
  await removePortablePluginFixtures();
});

test.each([
  ["safe_open_unsupported", "document_safe_read_unavailable"],
  ["outside_root", "document_outside_root"],
  ["changed_during_read", "document_changed_during_read"],
  ["not_regular_file", "document_target_not_file"],
  ["too_large", "document_file_too_large"],
] satisfies Array<[BoundedRegularFileReadFailure["reason"], string]>)(
  "reports %s without extraction or a second read",
  async (reason, errorCode) => {
    const context = await createPortablePluginFixture("document-reader");
    vi.mocked(readBoundedRegularFile).mockResolvedValue({ ok: false, reason });
    const controller = new AbortController();
    const result = await createPlugin(context).handlers.document_reader!(
      { source: "app.txt" },
      { abortSignal: controller.signal },
    );
    expect(result).toMatchObject({
      ok: false,
      errorCode,
      producedNewInformation: false,
    });
    expect(result.data).toBeUndefined();
    expect(readBoundedRegularFile).toHaveBeenCalledTimes(1);
    expect(readBoundedRegularFile).toHaveBeenCalledWith(expect.any(String), {
      maxBytes: 10 * 1024 * 1024,
      rootPath: context.runtimePaths.agentWorkDir,
      signal: controller.signal,
    });
  },
);
