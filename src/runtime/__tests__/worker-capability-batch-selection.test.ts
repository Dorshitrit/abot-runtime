import { describe, expect, test } from "vitest";

import { canOfferWorkerCapabilityBatchSelection } from "../orchestration/worker-capabilities/index.js";

describe("capability batch selection offering", () => {
  test.each([
    { capabilities: [], expected: false },
    {
      capabilities: [{ capabilityId: "inspect_project" }],
      expected: true,
    },
    {
      capabilities: [
        { capabilityId: "inspect_project" },
        { capabilityId: "inspect_file" },
      ],
      expected: true,
    },
    {
      capabilities: [
        {
          capabilityId: "inspect_file",
          selectionSchema: {
            type: "object" as const,
            additionalProperties: false as const,
            properties: {
              path: { type: "string" as const, minLength: 1, maxLength: 64 },
            },
            required: ["path"],
          },
        },
      ],
      expected: true,
    },
  ])(
    "defers exact identity until prepared execution admission",
    ({ capabilities, expected }) => {
      expect(canOfferWorkerCapabilityBatchSelection(capabilities)).toBe(
        expected,
      );
    },
  );
});
