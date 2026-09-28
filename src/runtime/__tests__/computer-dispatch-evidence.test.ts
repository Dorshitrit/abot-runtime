import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import type { NativeComputerResult } from "../../computer-access/computer/native-protocol.js";
import { DesktopBindings } from "../../../plugins/system/source/computer/desktop-bindings.js";
import { projectComputerResult } from "../../../plugins/system/source/computer/observation-result.js";
import { observeExternalResult } from "../adapters/registered-tool-worker-capabilities/result-observer.js";
import { computerRoute, desktopFixture } from "./computer-plugin-fixtures.js";

async function project(
  dispatch?: NativeComputerResult["dispatch"],
  imageFails = false,
  error?: NativeComputerResult["error"],
) {
  const native = { ...desktopFixture(), ...(dispatch ? { dispatch } : {}), ...(error ? { error } : {}) };
  const receipt = await projectComputerResult(
    {
      ref: "desktop-of-this-request",
      route: computerRoute,
      bindings: new DesktopBindings(),
    },
    native,
    {
      media: {
        writeImage: async () => {
          if (imageFails) throw new Error("Image admission failed");
          return {
            kind: "tool_image_v1",
            id: `image-${randomUUID()}`,
            mimeType: "image/png",
            size: 3,
            width: 1920,
            height: 1080,
            sha256: "0".repeat(64),
          };
        },
      },
    },
  );
  const effect = dispatch ? "mutating" : "read_only";
  return {
    receipt,
    observed: observeExternalResult(
      {
        status: "executed",
        effect,
        completionActions: [],
        result: {
          tool: dispatch ? "computer_act" : "computer_observe",
          ...receipt,
        },
      },
      effect,
      true,
    ),
  };
}

test("an accepted native input reaches the Supervisor as dispatch evidence, not mutation_evidence_missing", async () => {
  const { receipt, observed } = await project({
    status: "accepted",
    requestedInputCount: 2,
    acceptedInputCount: 2,
  });
  expect(observed.sourceIssueCode).toBeUndefined();
  expect(observed.result).toMatchObject({
    outcome: "succeeded",
    observedEffect: "mutation",
  });
  expect(receipt.data?.requestedEffectVerified).toBe(false);
  const grounding = JSON.parse(observed.result.referenceData!);
  expect(grounding).toMatchObject({
    desktop_ref: "desktop-of-this-request",
    requestedEffectVerified: false,
  });
  expect(observed.result.exactResult).toMatchObject({
    result: { data: { dispatch: { acceptedInputCount: 2 } } },
  });
});

test("image failure retains the input effect without claiming overall success", async () => {
  const { observed } = await project(
    { status: "accepted", requestedInputCount: 2, acceptedInputCount: 2 },
    true,
  );
  expect(observed.result).toMatchObject({
    outcome: "failed",
    observedEffect: "mutation",
  });
  expect(observed.sourceIssueCode).toBe("computer_image_unavailable");
});

test.each([
  undefined,
  { code: "computer_input_partial", message: "Only part of the input was accepted." },
])("partial native input remains a failure with optional native error: %j", async (error) => {
  const { receipt, observed } = await project(
    { status: "partial", requestedInputCount: 4, acceptedInputCount: 2 },
    false,
    error,
  );
  expect(receipt.ok).toBe(false);
  expect(receipt.data).toMatchObject({
    dispatch: { status: "partial", requestedInputCount: 4, acceptedInputCount: 2 },
    mutationEvidence: true,
    error: { code: "computer_input_partial" },
  });
  expect(observed.result).toMatchObject({ outcome: "failed", observedEffect: "mutation" });
  expect(observed.sourceIssueCode).toBe("computer_input_partial");
});

test.each([
  undefined,
  { status: "not_dispatched", requestedInputCount: 2, acceptedInputCount: 0 },
  { status: "unknown", requestedInputCount: 2 },
  { status: "accepted", requestedInputCount: 0, acceptedInputCount: 0 },
] as const)(
  "observation or unconfirmed dispatch does not invent a mutation: %j",
  async (dispatch) => {
    const { receipt, observed } = await project(dispatch);
    expect(receipt.data?.mutationEvidence).not.toBe(true);
    expect(observed.result.observedEffect).not.toBe("mutation");
    if (!dispatch) expect(observed.result.outcome).toBe("succeeded");
  },
);
