import { afterEach, describe, expect, test, vi } from "vitest";
import type { ToolModuleDeclaration } from "../../plugin-sdk/index.js";
import { FilesystemToolError } from "../../../plugins/filesystem/source/errors.js";
import { prepareRequestToolModules } from "../capabilities/request-module-preparation.js";
import {
  executeWindowsFilesystem,
  prepareFilesystemRequest,
} from "../../../plugins/filesystem/source/windows/request-availability.js";

const { run } = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock(
  "../../../plugins/filesystem/source/windows/process.js",
  async (original) => ({
    ...(await original<
      typeof import("../../../plugins/filesystem/source/windows/process.js")
    >()),
    runWindowsFilesystem: run,
  }),
);
const platform = process.platform;
afterEach(() => {
  Object.defineProperty(process, "platform", { value: platform });
  run.mockReset();
});

function module(
  name = "filesystem_read",
  prepared = true,
): ToolModuleDeclaration {
  return {
    definition: { name, routingCapability: "semantic_lookup" },
    ...(prepared ? { prepareRequest: prepareFilesystemRequest } : {}),
    implementation: async () => {
      try {
        await executeWindowsFilesystem({ operation: "read" });
        return { ok: true, output: "read", producedNewInformation: true };
      } catch (error) {
        const failure = error as FilesystemToolError;
        return {
          ok: false,
          output: failure.message,
          errorCode: failure.code,
          producedNewInformation: false,
        };
      }
    },
    normalInvocation: {
      version: 1,
      operations: [
        {
          operationId: name,
          summary: "Read the selected file.",
          effect: "read_only",
          approval: "request_policy",
          input: {
            type: "object",
            additionalProperties: false,
            required: [],
            properties: {},
          },
        },
      ],
    },
  };
}
function windows() {
  Object.defineProperty(process, "platform", { value: "win32" });
}
function blocked() {
  return new FilesystemToolError(
    "filesystem_windows_policy_blocked",
    "Windows policy blocks the helper.",
  );
}

describe("filesystem request availability without runtime policy changes", () => {
  test.each(["linux", "darwin"])(
    "does not probe or alter %s tools",
    async (value) => {
      Object.defineProperty(process, "platform", { value });
      const modules = [module()];
      expect(await prepareFilesystemRequest(modules)).toBe(modules);
      expect(run).not.toHaveBeenCalled();
    },
  );
  test("omits blocked file tools before catalog assembly and preserves unrelated tools", async () => {
    windows();
    run.mockRejectedValue(blocked());
    const result = await prepareRequestToolModules([
      module(),
      module("unrelated", false),
    ]);
    expect(result.map((entry) => entry.definition.name)).toEqual(["unrelated"]);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith({ operation: "probe" });
  });
  test.each([undefined, {}, { available: false }])(
    "requires a positive availability receipt: %j",
    async (result) => {
      windows();
      run.mockResolvedValue(result);
      expect(await prepareFilesystemRequest([module()])).toEqual([]);
    },
  );
  test("a block in one request does not disable another prepared request", async () => {
    windows();
    run.mockResolvedValue({ available: true });
    const first = await prepareFilesystemRequest([module()]);
    const second = await prepareFilesystemRequest([module()]);
    run.mockRejectedValueOnce(blocked()).mockResolvedValue({});
    expect(await first[0]!.implementation({})).toMatchObject({ ok: false });
    expect(await second[0]!.implementation({})).toMatchObject({ ok: true });
    expect(await first[0]!.implementation({})).toMatchObject({ ok: false });
    expect(run).toHaveBeenCalledTimes(4);
  });
  test("does not probe a disabled plugin with no selected tools", async () => {
    windows();
    expect(await prepareFilesystemRequest([])).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });
  test("a late policy block prevents more helper dispatches in the same request", async () => {
    windows();
    run.mockResolvedValueOnce({ available: true }).mockRejectedValue(blocked());
    const prepared = await prepareFilesystemRequest([
      module("read_a"),
      module("read_b"),
    ]);
    expect(await prepared[0]!.implementation({})).toMatchObject({
      ok: false,
      errorCode: "filesystem_windows_policy_blocked",
    });
    expect(await prepared[1]!.implementation({})).toMatchObject({
      ok: false,
      errorCode: "filesystem_windows_policy_blocked",
    });
    expect(run).toHaveBeenCalledTimes(2);
  });
  test("a later request probes again and can recover after the user resolves policy", async () => {
    windows();
    run.mockRejectedValueOnce(blocked()).mockResolvedValue({ available: true });
    expect(await prepareFilesystemRequest([module()])).toEqual([]);
    const prepared = await prepareFilesystemRequest([module()]);
    expect(prepared).toHaveLength(1);
    expect(await prepared[0]!.implementation({})).toMatchObject({ ok: true });
    expect(run).toHaveBeenCalledTimes(3);
  });
  test.each([
    "filesystem_access_denied",
    "filesystem_storage_attributes_unsupported",
    "filesystem_named_streams_unsupported",
    "filesystem_windows_publication_unsupported",
  ])(
    "file-specific %s never disables the other filesystem tools",
    async (code) => {
      windows();
      run
        .mockResolvedValueOnce({ available: true })
        .mockRejectedValueOnce(new FilesystemToolError(code))
        .mockResolvedValue({});
      const prepared = await prepareFilesystemRequest([module()]);
      expect(await prepared[0]!.implementation({})).toMatchObject({
        ok: false,
        errorCode: code,
      });
      expect(await prepared[0]!.implementation({})).toMatchObject({ ok: true });
      expect(run).toHaveBeenCalledTimes(3);
    },
  );
});
