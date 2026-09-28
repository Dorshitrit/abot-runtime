import { expect, test } from "vitest";
import { isNarrowedInputProperty } from "../capabilities/request-property-narrowing.js";

test("request references may narrow bounded text only when every value satisfies original limits", () => {
  const original = { type: "string", minLength: 2, maxLength: 4 } as const;
  expect(
    isNarrowedInputProperty(original, { type: "string", enum: ["ab", "abcd"] }),
  ).toBe(true);
  expect(
    isNarrowedInputProperty(original, { type: "string", enum: ["a"] }),
  ).toBe(false);
  expect(
    isNarrowedInputProperty(original, { type: "string", enum: ["abcde"] }),
  ).toBe(false);
  expect(isNarrowedInputProperty(original, { ...original, maxLength: 5 })).toBe(
    false,
  );
});
test("existing enum authority and non-string inputs cannot be widened", () => {
  const original = { type: "string", enum: ["one", "two"] } as const;
  expect(
    isNarrowedInputProperty(original, { type: "string", enum: ["one"] }),
  ).toBe(true);
  expect(
    isNarrowedInputProperty(original, { type: "string", enum: ["three"] }),
  ).toBe(false);
  expect(
    isNarrowedInputProperty(original, {
      type: "string",
      minLength: 1,
      maxLength: 3,
    }),
  ).toBe(false);
  expect(
    isNarrowedInputProperty(
      { type: "integer", minimum: 1, maximum: 2 },
      { type: "string", enum: ["1"] },
    ),
  ).toBe(false);
  expect(
    isNarrowedInputProperty({ type: "boolean" }, { type: "boolean" }),
  ).toBe(true);
});
