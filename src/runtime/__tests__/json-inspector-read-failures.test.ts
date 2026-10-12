import { afterEach, expect, test, vi } from "vitest";
import createPlugin from "../../../plugins/json-inspector/source/index.js";
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
    "json_safe_read_unavailable",
    "Do not retry or bypass",
  ],
  ["outside_root", "json_outside_root", "Do not retry this target"],
  ["changed_during_read", "json_file_changed", "changed while it was read"],
  ["not_regular_file", "json_target_not_file", "not a regular file"],
  ["too_large", "json_file_too_large", "2097152-byte"],
] satisfies Array<[BoundedRegularFileReadFailure["reason"], string, string]>)(
  "reports %s without re-reading or misclassifying it",
  async (reason, errorCode, message) => {
    const context = await createPortablePluginFixture("json-inspector");
    vi.mocked(readBoundedRegularFile).mockResolvedValue({ ok: false, reason });
    const controller = new AbortController();
    const result = await createPlugin(context).handlers.inspect_json!(
      { path: "app.json" },
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
      maxBytes: 2 * 1024 * 1024,
      rootPath: context.runtimePaths.agentWorkDir,
      signal: controller.signal,
    });
  },
);

test("does not send path-policy failures to the reader", async () => {
  const context = await createPortablePluginFixture("json-inspector");
  const result = await createPlugin(context).handlers.inspect_json!({
    path: "../private.json",
  });
  expect(result).toMatchObject({
    ok: false,
    errorCode: "runtime_tool_path_outside_configured_roots",
  });
  expect(readBoundedRegularFile).not.toHaveBeenCalled();
});
