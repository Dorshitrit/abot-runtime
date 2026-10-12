import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import createPlugin from "../../../plugins/project-orientation/source/index.js";
import {
  readBoundedRegularFile,
  type BoundedRegularFileReadFailure,
} from "../../plugin-sdk/index.js";
import {
  createPortablePluginFixture,
  removePortablePluginFixtures,
} from "./windows-portable-plugins-fixture.js";

vi.mock("../../plugin-sdk/index.js", async (original) => ({
  ...(await original<typeof import("../../plugin-sdk/index.js")>()),
  readBoundedRegularFile: vi.fn(),
}));
afterEach(async () => {
  vi.resetAllMocks();
  await removePortablePluginFixtures();
});
async function fixture() {
  const context = await createPortablePluginFixture("project-orientation");
  await mkdir(context.runtimePaths.agentWorkDir);
  await writeFile(
    join(context.runtimePaths.agentWorkDir, "package.json"),
    "{}",
  );
  return { context, inspect: createPlugin(context).handlers.inspect_project! };
}

test.each([
  ["safe_open_unsupported", "project_safe_read_unavailable"],
  ["outside_root", "project_outside_root"],
  ["changed_during_read", "project_orientation_failed"],
  ["not_regular_file", "project_orientation_failed"],
] satisfies Array<[BoundedRegularFileReadFailure["reason"], string]>)(
  "returns %s without a partial project or a second read",
  async (reason, errorCode) => {
    const { context, inspect } = await fixture();
    vi.mocked(readBoundedRegularFile).mockResolvedValue({ ok: false, reason });
    const controller = new AbortController();
    const result = await inspect({}, { abortSignal: controller.signal });
    expect(result).toMatchObject({
      ok: false,
      errorCode,
      producedNewInformation: false,
    });
    expect(result.data).toBeUndefined();
    expect(readBoundedRegularFile).toHaveBeenCalledTimes(1);
    expect(readBoundedRegularFile).toHaveBeenCalledWith(expect.any(String), {
      rootPath: context.runtimePaths.agentWorkDir,
      maxBytes: 256 * 1024,
      signal: controller.signal,
    });
  },
);

test("forwards cancellation to the manifest reader", async () => {
  const { inspect } = await fixture();
  const controller = new AbortController();
  let notifyRead!: () => void;
  const reading = new Promise<void>((resolve) => {
    notifyRead = resolve;
  });
  vi.mocked(readBoundedRegularFile).mockImplementation(
    async (_, { signal }) =>
      new Promise((_, reject) => {
        signal!.addEventListener(
          "abort",
          () => reject(new DOMException("Cancelled", "AbortError")),
          { once: true },
        );
        notifyRead();
      }),
  );
  const result = inspect({}, { abortSignal: controller.signal });
  await reading;
  controller.abort();
  expect(await result).toMatchObject({
    ok: false,
    errorCode: "project_inspection_cancelled",
    interruption: "aborted",
  });
  expect(readBoundedRegularFile).toHaveBeenCalledTimes(1);
});

test("does not read package bytes for a project with no package manifest", async () => {
  const context = await createPortablePluginFixture("project-orientation");
  await mkdir(context.runtimePaths.agentWorkDir);
  await writeFile(
    join(context.runtimePaths.agentWorkDir, "Cargo.toml"),
    "PRIVATE_BODY",
  );
  const result = await createPlugin(context).handlers.inspect_project!({});
  expect(result).toMatchObject({
    ok: true,
    data: { manifests: [{ file: "Cargo.toml" }] },
  });
  expect(readBoundedRegularFile).not.toHaveBeenCalled();
});
