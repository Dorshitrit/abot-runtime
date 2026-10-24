import { afterEach, beforeEach, expect, test } from "vitest";
import { loadRuntimeConfig } from "../config.js";
import { resolveModelInvocation } from "../../model-gateway/policy/invocation-policy.js";
import { buildLlamaCppChatPayload } from "../../model-gateway/providers/llamacpp/payload.js";
import {
  getConfigDashboardSnapshot,
  saveConfigDashboardFile,
} from "../../web-ui/config-dashboard-backend.js";
import {
  createModelSetupFixture,
  type ModelSetupFixture,
} from "./support/model-setup-fixture.js";
import { configReasoningHarness } from "./support/config-reasoning-consistency-harness.js";

let fixture: ModelSetupFixture;
beforeEach(async () => {
  fixture = await createModelSetupFixture(
    ".codex/artifacts/supervisor-response-zero-budget-20261020/config-fixtures",
  );
  const config = await fixture.readConfig();
  const profile = await fixture.readModelProfile("default");
  config.models.providers[profile.provider].type = "llamacpp";
  await fixture.writeConfig(config);
  await fixture.writeModelProfile("default", {
    ...profile,
    supportsThinking: true,
    generation: {
      reasoningEffort: "xhigh",
      reasoningBudget: { mode: "tokens", tokens: 64 },
    },
  });
});
afterEach(async () => {
  await fixture?.cleanup();
});

test.each(["linked", "inline"])(
  "dashboard saved zero in a %s profile loads and emits disabled thinking",
  async (storage) => {
    if (storage === "inline") {
      const profile = await fixture.readModelProfile("default");
      const config = await fixture.readConfig();
      config.models.profiles.default = profile;
      await fixture.writeConfig(config);
    }
    const options = {
      rootDir: fixture.rootDir,
      configPath: fixture.configPath,
    };
    const snapshot = await getConfigDashboardSnapshot(options);
    const profile = snapshot.files.models.find(
      (entry) => entry.id === "default",
    )!;
    expect(profile).toBeDefined();
    const candidate = {
      ...profile.config,
      generation: {
        reasoningEffort: "xhigh",
        reasoningBudget: { mode: "tokens", tokens: 0 },
      },
    };
    await saveConfigDashboardFile({
      ...options,
      kind: "model",
      id: profile.id,
      expectedRevision: profile.revision,
      config: candidate,
    });
    expect((await fixture.readModelProfile("default")).generation).toEqual(
      candidate.generation,
    );
    const reloaded = loadRuntimeConfig({ ...options, env: {} });
    const invocation = resolveModelInvocation({
      modelPolicy: reloaded.models,
      modelPreference: { profileId: "default" },
    });
    expect(invocation.think).toBe("none");
    expect(invocation.profile.generation.reasoningEffort).toBe("xhigh");
    const payload = buildLlamaCppChatPayload({
      invocation,
      endpoint: "chat",
      requestBody: { text: "test" },
    });
    expect(payload).toMatchObject({
      reasoning_effort: "none",
      reasoning_budget_tokens: 0,
      chat_template_kwargs: { enable_thinking: false },
    });
  },
);

test("the editor round trip 64 to zero to 64 preserves the effort and toggles thinking", () => {
  const editor = configReasoningHarness({
    effort: "xhigh",
    budget: { mode: "tokens", tokens: 64 },
  });
  const path = ["generation", "reasoningBudget", "tokens"];
  editor.field(path, "0", "number");
  expect(editor.file.config.generation.reasoningEffort).toBe("xhigh");
  expect(editor.resolve().think).toBe("none");
  editor.field(path, "64", "number");
  expect(editor.resolve()).toMatchObject({
    think: "xhigh",
    reasoningBudget: { mode: "tokens", tokens: 64 },
  });
});
