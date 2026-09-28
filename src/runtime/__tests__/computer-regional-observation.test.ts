import { describe, expect, it, vi } from "vitest";
import { createComputerHandlers } from "../../../plugins/system/source/computer/handlers.js";
import { RequestComputers } from "../../../plugins/system/source/computer/request-computers.js";
import { readNativeComputerRequest } from "../../computer-access/computer/native-validation.js";
import {
  backendFixture,
  computerRoute,
  desktopFixture,
} from "./computer-plugin-fixtures.js";

describe("regional observation source binding", () => {
  it("carries the source desktop identity and geometry after image-coordinate conversion", async () => {
    const backend = backendFixture();
    const computers = new RequestComputers(
      "/tmp",
      [computerRoute],
      { readHostStatus: vi.fn(), executeHostOperation: vi.fn() },
      () => backend,
    );
    const entry = computers.entries[0]!;
    const observed = entry.bindings.observe(desktopFixture());
    await createComputerHandlers(computers).computer_observe!(
      {
        desktop_ref: entry.ref,
        observation_ref: observed.observation_ref,
        x: 10,
        y: 20,
        width: 50,
        height: 30,
      },
      {
        onRequestDispose: () => undefined,
        media: {
          writeImage: vi.fn(async () => ({
            kind: "tool_image_v1" as const,
            id: "image",
            mimeType: "image/png" as const,
            size: 3,
            width: 1920,
            height: 1080,
            sha256: "0".repeat(64),
          })),
        },
      },
    );
    const native = vi.mocked(backend.execute).mock.calls[0]![0];
    expect(native).toEqual({
      operation: "observe",
      desktopBinding: "session:10",
      expectedGeometry: desktopFixture().desktop.bounds,
      region: { x: -1900, y: 40, width: 100, height: 60 },
    });
    expect(readNativeComputerRequest(native)).toEqual(native);
    await computers.close();
  });

  it("rejects a private regional request with no source identity or geometry", () => {
    expect(() =>
      readNativeComputerRequest({
        operation: "observe",
        region: { x: 0, y: 0, width: 20, height: 20 },
      }),
    ).toThrow();
    expect(readNativeComputerRequest({ operation: "observe" })).toEqual({
      operation: "observe",
    });
  });
});
