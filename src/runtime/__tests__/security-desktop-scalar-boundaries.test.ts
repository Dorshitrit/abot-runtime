import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { NativeComputerResult } from "../../computer-access/computer/native-protocol.js";
import { readNativeComputerResult } from "../../computer-access/computer/native-validation.js";
import { RequestComputers } from "../../../plugins/system/source/computer/request-computers.js";
import { createComputerHandlers } from "../../../plugins/system/source/computer/handlers.js";
import { computerRoute, desktopFixture } from "./computer-plugin-fixtures.js";
import {
  acceptedDispatch,
  companionHarness,
  companionObservation,
} from "./computer-companion-fixtures.js";

const secret = "api_key=synthetic-secret";
const fields = ["error code", "capture timestamp"] as const;
function observedScalar(
  original: NativeComputerResult,
  field: (typeof fields)[number],
): NativeComputerResult {
  const result: NativeComputerResult = {
    ...original,
    dispatch: acceptedDispatch,
    error: {
      code: field === "error code" ? secret : "native_failure",
      message: "Native diagnostic.",
    },
    observation: {
      ...original.observation!,
      capturedAt:
        field === "capture timestamp"
          ? secret
          : original.observation!.capturedAt,
    },
  };
  const { image: _image, ...metadata } = result;
  expect(readNativeComputerResult(metadata)).toEqual(metadata);
  return result;
}

describe.each(fields)("validated desktop %s protection", (field) => {
  it("withholds the Companion frame and raw scalar before transport", async () => {
    const image = Buffer.from([1, 2, 3]);
    const original = observedScalar(companionObservation(image), field);
    const harness = companionHarness(original);
    const params = { sessionId: randomUUID(), target: "windows" };
    try {
      const response = await harness.handlers.computer_execute!({
        ...params,
        request: { operation: "observe" },
      });
      expect(response.ok).toBe(true);
      expect(response.data).not.toHaveProperty("frame");
      expect(response.data?.result).toMatchObject({
        dispatch: acceptedDispatch,
        error: {
          code: field === "error code" ? "[REDACTED]" : "native_failure",
        },
        observation: {
          capturedAt:
            field === "capture timestamp"
              ? "[REDACTED]"
              : original.observation!.capturedAt,
        },
      });
      expect(JSON.stringify(response)).not.toContain(secret);
      expect([...image]).toEqual([0, 0, 0]);
      const frame = await harness.handlers.computer_frame!({
        ...params,
        frameId: randomUUID(),
        offset: 0,
      });
      expect(frame.ok).toBe(false);
      expect(frame.output).toContain("computer_frame_expired");
    } finally {
      await harness.sessions.close();
    }
  });

  it("withholds local media and raw scalar from output, errorCode and snapshots", async () => {
    const original = observedScalar(desktopFixture(), field);
    const harness = companionHarness(original);
    const computers = new RequestComputers(
      "/tmp",
      [computerRoute],
      harness.connection,
      () => harness.native,
    );
    const writer = vi.fn();
    try {
      const response = await createComputerHandlers(computers)
        .computer_observe!(
        {
          desktop_ref: computers.entries[0]!.ref,
        },
        { onRequestDispose: () => {}, media: { writeImage: writer } },
      );
      expect(response.errorCode).toBe(
        field === "error code" ? "[REDACTED]" : "native_failure",
      );
      expect(response.data?.dispatch).toEqual(acceptedDispatch);
      expect(response.data?.mutationEvidence).toBe(true);
      expect(response.data?.imageAvailable).toBe(false);
      expect(writer).not.toHaveBeenCalled();
      expect(JSON.stringify(response)).not.toContain(secret);
      expect(JSON.stringify(computers.snapshot())).not.toContain(secret);
      expect([...original.image!.bytes]).toEqual([0, 0, 0]);
    } finally {
      await computers.close();
    }
  });
});
