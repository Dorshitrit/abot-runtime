import { afterEach, expect, test, vi } from "vitest";
import createPlugin from "../../../plugins/code-outline/source/index.js";
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
  [
    "safe_open_unsupported",
    "code_outline_safe_read_unavailable",
    "Do not retry or bypass",
  ],
  ["outside_root", "code_outline_outside_root", "Do not retry this target"],
  [
    "changed_during_read",
    "code_outline_file_changed",
    "changed while it was being read",
  ],
  ["not_regular_file", "code_outline_target_not_file", "not a regular file"],
  ["too_large", "code_outline_file_too_large", "524288-byte"],
] satisfies Array<[BoundedRegularFileReadFailure["reason"], string, string]>)(
  "reports %s without re-reading or misclassifying it",
  async (reason, errorCode, message) => {
    const context = await createPortablePluginFixture("code-outline");
    vi.mocked(readBoundedRegularFile).mockResolvedValue({ ok: false, reason });
    const controller = new AbortController();
    const result = await createPlugin(context).handlers.inspect_code_outline!(
      { path: "app.ts" },
      { abortSignal: controller.signal },
    );
    expect(result).toMatchObject({
      ok: false,
      errorCode,
      producedNewInformation: false,
    });
    expect(result.output).toContain(message);
    expect(result.data).toBeUndefined();
    expect(readBoundedRegularFile).toHaveBeenCalledTimes(1);
    expect(readBoundedRegularFile).toHaveBeenCalledWith(expect.any(String), {
      maxBytes: 512 * 1024,
      rootPath: context.runtimePaths.agentWorkDir,
      signal: controller.signal,
    });
  },
);

test("does not send path-policy failures to the reader", async () => {
  const context = await createPortablePluginFixture("code-outline");
  const result = await createPlugin(context).handlers.inspect_code_outline!({
    path: "../private.ts",
  });
  expect(result).toMatchObject({
    ok: false,
    errorCode: "runtime_tool_path_outside_configured_roots",
  });
  expect(readBoundedRegularFile).not.toHaveBeenCalled();
});
