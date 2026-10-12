import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { RequestComputers } from "../../../plugins/system/source/computer/request-computers.js";
import { createComputerHandlers } from "../../../plugins/system/source/computer/handlers.js";
import {
  companionHarness,
  acceptedDispatch,
} from "./computer-companion-fixtures.js";
import { computerRoute, desktopFixture } from "./computer-plugin-fixtures.js";

const secret = "api_key=synthetic-secret";
const fullMessage = "Diagnostic context ".repeat(300) + secret;

describe("desktop exception protection", () => {
  it("protects a complete Companion backend exception before transport", async () => {
    const harness = companionHarness();
    vi.mocked(harness.native.execute).mockRejectedValue(new Error(fullMessage));
    try {
      const response = await harness.handlers.computer_execute!({
        sessionId: randomUUID(),
        target: "windows",
        request: { operation: "observe" },
      });
      expect(response.ok).toBe(false);
      expect(response.errorCode).toBe("computer_native_operation_failed");
      expect(response.output).toContain("[REDACTED]");
      expect(JSON.stringify(response)).not.toContain(secret);
      expect(JSON.stringify(response)).not.toContain("Diagnostic context");
    } finally {
      await harness.sessions.close();
    }
  });

  it.each(["computer_desktops", "computer_observe"] as const)(
    "protects a local SYSTEM backend exception for %s",
    async (operation) => {
      const harness = companionHarness();
      vi.mocked(harness.native.execute).mockRejectedValue(
        new Error(fullMessage),
      );
      const computers = new RequestComputers(
        "/tmp",
        [computerRoute],
        harness.connection,
        () => harness.native,
      );
      try {
        const response = await createComputerHandlers(computers)[operation]!(
          {
            ...(operation === "computer_observe"
              ? { desktop_ref: computers.entries[0]!.ref }
              : {}),
          },
          { onRequestDispose: () => {}, media: { writeImage: vi.fn() } },
        );
        expect(response.output).toContain("[REDACTED]");
        expect(JSON.stringify(response)).not.toContain(secret);
        expect(JSON.stringify(response)).not.toContain("Diagnostic context");
      } finally {
        await computers.close();
      }
    },
  );

  it("protects a media writer exception while retaining accepted dispatch evidence", async () => {
    const original = desktopFixture();
    const harness = companionHarness({
      ...original,
      dispatch: acceptedDispatch,
    });
    const computers = new RequestComputers(
      "/tmp",
      [computerRoute],
      harness.connection,
      () => harness.native,
    );
    try {
      const response = await createComputerHandlers(computers)
        .computer_observe!(
        {
          desktop_ref: computers.entries[0]!.ref,
        },
        {
          onRequestDispose: () => {},
          media: {
            writeImage: async () => {
              throw new Error(fullMessage);
            },
          },
        },
      );
      expect(response.ok).toBe(false);
      expect(response.errorCode).toBe("computer_image_unavailable");
      expect(response.data?.imageError).toBe("[REDACTED]");
      expect(response.data?.dispatch).toEqual(acceptedDispatch);
      expect(response.data?.mutationEvidence).toBe(true);
      expect(JSON.stringify(response)).not.toContain(secret);
      expect(JSON.stringify(response)).not.toContain("Diagnostic context");
      expect([...original.image!.bytes]).toEqual([0, 0, 0]);
    } finally {
      await computers.close();
    }
  });

  it("preserves ordinary exception messages", async () => {
    const harness = companionHarness();
    vi.mocked(harness.native.execute).mockRejectedValue(
      new Error("Desktop disconnected."),
    );
    try {
      const response = await harness.handlers.computer_execute!({
        sessionId: randomUUID(),
        target: "windows",
        request: { operation: "inspect" },
      });
      expect(response.output).toContain("Desktop disconnected.");
    } finally {
      await harness.sessions.close();
    }
  });
});
