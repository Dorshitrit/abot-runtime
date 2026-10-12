import { describe, expect, test } from "vitest";
import { redactSecretText as redactNativeText } from "../../computer-access/security/secret-text.js";
import { redactSecretText as redactSystemText } from "../../../plugins/system/source/security/secret-text.js";
import { redactObservationText } from "../../computer-access/companion/observation-redaction.js";
import { secretProtectionCases } from "./support/secret-protection-cases.js";

describe.each([
  { owner: "native internal detector", redact: redactNativeText },
  { owner: "SYSTEM independent detector", redact: redactSystemText },
  { owner: "SPARK compatibility facade", redact: redactObservationText },
])("$owner secret-text conformance", ({ redact }) => {
  test.each(secretProtectionCases)("$name", ({ input, expected }) => {
    expect(redact(input)).toBe(expected);
  });

  test("sanitizing an already protected field is idempotent", () => {
    for (const { input } of secretProtectionCases) {
      const protectedText = redact(input);
      expect(redact(protectedText)).toBe(protectedText);
    }
  });
});
