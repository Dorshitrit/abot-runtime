import { expect, test } from "vitest";
import { resolveModelInvocation } from "../../model-gateway/policy/invocation-policy.js";
import { configReasoningHarness } from "./support/config-reasoning-consistency-harness.js";

const root = ["generation"];
const calibration = ["calibration", "response", "generation"];
const budget32 = { mode: "tokens", tokens: 32 };

test.each(["none", undefined])(
  "an explicit root token budget enables thinking over %s and Fast",
  (effort) => {
    const h = configReasoningHarness({ effort });
    h.field([...root, "reasoningBudget"], "tokens", "reasoning-budget-mode");
    h.field([...root, "reasoningBudget", "tokens"], "32", "number");
    expect(h.file.config.generation).toEqual({
      reasoningEffort: "medium",
      reasoningBudget: budget32,
    });
    expect(h.resolve()).toMatchObject({
      think: "medium",
      reasoningBudget: budget32,
    });
  },
);

test("editing an existing token count enables thinking without rerendering the active numeric input", () => {
  const h = configReasoningHarness({
    effort: "none",
    budget: { mode: "tokens", tokens: 64 },
  });
  const effortControl = {
    dataset: {
      kind: "model",
      id: "local",
      path: JSON.stringify([...root, "reasoningEffort"]),
    },
    value: "none",
    textContent: "",
  };
  const status = {
    dataset: {
      kind: "model",
      id: "local",
      reasoningGenerationPath: JSON.stringify(root),
    },
    value: "",
    textContent: "Inactive",
  };
  h.controls.push(effortControl, status);
  h.field([...root, "reasoningBudget", "tokens"], "32", "number");
  expect(h.resolve()).toMatchObject({
    think: "medium",
    reasoningBudget: budget32,
  });
  expect(h.renderConfigDashboard).not.toHaveBeenCalled();
  expect(effortControl.value).toBe("medium");
  expect(status.textContent).not.toContain("Inactive");
});

test.each([
  { generation: { reasoningEffort: "none" } },
  {},
  { profileId: "target" },
])(
  "a calibrated budget overrides local or inherited None in its own scope: %j",
  (entry) => {
    const h = configReasoningHarness({
      effort: "none",
      targetEffort: "none",
      calibration: { response: entry },
    });
    h.field(
      [...calibration, "reasoningBudget"],
      "tokens",
      "reasoning-budget-mode",
    );
    h.field([...calibration, "reasoningBudget", "tokens"], "32", "number");
    expect(h.file.config.generation.reasoningEffort).toBe("none");
    expect(h.target.config.generation.reasoningEffort).toBe("none");
    expect(h.file.config.calibration.response.generation.reasoningEffort).toBe(
      "medium",
    );
    expect(h.resolve(true)).toMatchObject({
      think: "medium",
      reasoningBudget: budget32,
    });
  },
);

test("server default enables thinking; Inherit removes only the budget", () => {
  const h = configReasoningHarness({ effort: "none", budget: budget32 });
  h.field(
    [...root, "reasoningBudget"],
    "server-default",
    "reasoning-budget-mode",
  );
  expect(h.resolve()).toMatchObject({
    think: "medium",
    reasoningBudget: { mode: "server-default" },
  });
  h.field([...root, "reasoningBudget"], "inherit", "reasoning-budget-mode");
  expect(h.file.config.generation).toEqual({ reasoningEffort: "medium" });
  expect(h.resolve().reasoningBudget).toBeUndefined();
});

test("Off retains the saved limit, marks it inactive and keeps runtime precedence", () => {
  const h = configReasoningHarness({ effort: "high", budget: budget32 });
  h.field([...root, "reasoningEffort"], "none");
  expect(h.file.config.generation.reasoningBudget).toEqual(budget32);
  expect(h.resolve().think).toBe("none");
  expect(h.resolve().reasoningBudget).toBeUndefined();
  expect(h.render()).toContain("Inactive while reasoning is Off");
  expect(h.renderConfigDashboard).toHaveBeenCalledOnce();
});

test("calibrated inherited Off is visible and a positive inherited effort is preserved", () => {
  const h = configReasoningHarness({
    effort: "none",
    targetEffort: "high",
    calibration: {
      response: { generation: { reasoningBudget: budget32 } },
    },
  });
  expect(h.render()).toContain("Inactive while reasoning is Off");
  h.file.config.calibration.response.profileId = "target";
  h.field(
    [...calibration, "reasoningBudget"],
    "server-default",
    "reasoning-budget-mode",
  );
  expect(h.file.config.calibration.response.generation).not.toHaveProperty(
    "reasoningEffort",
  );
  expect(h.resolve(true)).toMatchObject({
    think: "high",
    reasoningBudget: { mode: "server-default" },
  });
});

test("root effort is visible for numeric-budget models and positive effort is preserved", () => {
  const h = configReasoningHarness({ effort: "high" });
  expect(h.render()).toContain(
    'data-path="[&quot;generation&quot;,&quot;reasoningEffort&quot;]',
  );
  h.field(
    [...root, "reasoningBudget"],
    "server-default",
    "reasoning-budget-mode",
  );
  expect(h.resolve().think).toBe("high");
});

test.each(["openai", "ollama"])(
  "ordinary %s calibration effort editing remains unchanged",
  (provider) => {
    const h = configReasoningHarness({
      provider,
      effort: "none",
      calibration: { response: {} },
    });
    expect(h.render()).not.toContain("Thinking budget");
    expect(h.render()).not.toContain(
      'data-path="[&quot;generation&quot;,&quot;reasoningEffort&quot;]',
    );
    h.field([...calibration, "reasoningEffort"], "low");
    expect(h.resolve(true).think).toBe("low");
    expect(h.resolve(true).reasoningBudget).toBeUndefined();
    expect(h.file.config.generation.reasoningEffort).toBe("none");
  },
);

test.each(["", "0", "-1", "1.5"])(
  "zero or invalid numeric edit %s cannot enable a disabled profile",
  (value) => {
    const h = configReasoningHarness({ effort: "none", budget: budget32 });
    h.field([...root, "reasoningBudget", "tokens"], value, "number");
    expect(h.file.config.generation.reasoningEffort).toBe("none");
  },
);

test("explicit request and invocation Off still override a saved enabled budget", () => {
  const h = configReasoningHarness({ effort: "none", budget: budget32 });
  h.field([...root, "reasoningBudget", "tokens"], "32", "number");
  for (const override of [
    { reasoningPreference: { profileId: "local", mode: "off" as const } },
    { reasoningOverride: "none" },
  ]) {
    const resolved = resolveModelInvocation({
      modelPolicy: h.policy(),
      ...override,
    });
    expect(resolved.think).toBe("none");
    expect(resolved.reasoningBudget).toBeUndefined();
  }
});


test("activating root thinking refreshes inherited budget captions without changing explicit or redirected Off", () => {
  const h = configReasoningHarness({ effort: "none", targetEffort: "none", budget: { mode: "tokens", tokens: 64 },
    calibration: {
      response: { generation: { reasoningBudget: budget32 } },
      explicit: { generation: { reasoningEffort: "none", reasoningBudget: budget32 } },
      redirected: { profileId: "target", generation: { reasoningBudget: budget32 } },
    },
  });
  const beforeCalibration = structuredClone(h.file.config.calibration);
  const captions = [root, calibration, ["calibration", "explicit", "generation"], ["calibration", "redirected", "generation"]]
    .map((path) => ({ dataset: { kind: "model", id: "local", reasoningGenerationPath: JSON.stringify(path) },
      value: "", textContent: "Inactive while reasoning is Off." }));
  h.controls.push(...captions);
  h.field([...root, "reasoningBudget", "tokens"], "32", "number");
  expect(h.resolve(true)).toMatchObject({ think: "medium", reasoningBudget: budget32 });
  expect(captions[0]!.textContent).not.toContain("Inactive");
  expect(captions[1]!.textContent).not.toContain("Inactive");
  expect(captions[2]!.textContent).toContain("Inactive while reasoning is Off");
  expect(captions[3]!.textContent).toContain("Inactive while reasoning is Off");
  expect(h.file.config.calibration).toEqual(beforeCalibration);
  expect(h.target.config.generation.reasoningEffort).toBe("none");
  expect(h.renderConfigDashboard).not.toHaveBeenCalled();
});


test("an activation refresh preserves unsupported calibration repair guidance", () => {
  const h = configReasoningHarness({ effort: "none", budget: budget32,
    calibration: { response: { profileId: "target", generation: { reasoningBudget: budget32 } } },
  });
  h.target.config.supportsThinking = false;
  const caption = { dataset: { kind: "model", id: "local", reasoningGenerationPath: JSON.stringify(calibration) },
    value: "", textContent: "This target does not support token budgets. Choose Inherit to remove this override." };
  h.controls.push(caption);
  h.field([...root, "reasoningBudget", "tokens"], "32", "number");
  expect(caption.textContent).toContain("Choose Inherit to remove this override");
  expect(h.renderConfigDashboard).not.toHaveBeenCalled();
});
