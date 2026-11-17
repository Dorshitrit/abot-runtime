import { expect, test } from "vitest";
import { mergeModelGenerationConfig } from "./model-generation-merge.js";

test("a higher legacy scalar replaces a lower canonical control", () => {
  const merged = mergeModelGenerationConfig({ parameters: { top_p: { mode: "value", value: 0.7 } } }, { topP: 0.4 });
  expect(merged).toEqual({ topP: 0.4 });
});

test("new same-layer control wins and records the shadowed legacy alias", () => {
  const merged = mergeModelGenerationConfig({ topP: 0.9, parameters: { top_p: { mode: "omit" } } });
  expect(merged).not.toHaveProperty("topP");
  expect(merged.parameters?.top_p).toEqual({ mode: "omit" });
  expect(merged.parameterDiagnostics).toMatchObject([{ key: "top_p", code: "model_parameter_alias_shadowed" }]);
});

test("inherit continues into the lower layer without restoring its own alias", () => {
  expect(mergeModelGenerationConfig({ topP: 0.2 }, { topP: 0.9, parameters: { top_p: { mode: "inherit" } } }))
    .toMatchObject({ topP: 0.2, parameters: { top_p: { mode: "inherit" } } });
});

test("parameter maps merge by key and zero remains explicit", () => {
  expect(mergeModelGenerationConfig({ parameters: { temperature: { mode: "value", value: 1 } } },
    { parameters: { top_k: { mode: "value", value: 0 } } })).toMatchObject({ parameters: {
    temperature: { mode: "value", value: 1 }, top_k: { mode: "value", value: 0 },
  } });
});

test("higher canonical control suppresses lower legacy scalar without misreporting same-layer collision", () => {
  expect(mergeModelGenerationConfig({ temperature: 0.6 }, { parameters: { temperature: { mode: "omit" } } }))
    .toEqual({ parameters: { temperature: { mode: "omit" } } });
});
