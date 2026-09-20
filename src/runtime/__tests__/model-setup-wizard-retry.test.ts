import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { RuntimeWebClientError } from "../../web-ui/app/services/runtime-web-client.js";
import { createModelWizardHarness } from "./support/model-setup-wizard-harness.js";
import {
  createModelSetupFixture,
  type ModelSetupFixture,
} from "./support/model-setup-fixture.js";

let fixture: ModelSetupFixture;
beforeEach(async () => {
  fixture = await createModelSetupFixture(
    ".codex/artifacts/pr71-apply-recovery-20260908/model-retry",
  );
});
afterEach(async () => {
  await fixture.cleanup();
});

function canonicalFailure(error: any) {
  return new RuntimeWebClientError(error.message, {
    status: error.statusCode,
    code: error.code,
    payload: {
      ok: false,
      error: error.code,
      message: error.message,
      credentialSaved: error.credentialSaved,
    },
  });
}

async function reviewCloud(
  harness: ReturnType<typeof createModelWizardHarness>,
) {
  await harness.wizard.open();
  harness.choose("new:openai");
  harness.click("next");
  harness.input("model-id", "fixture-cloud");
  harness.input("api-key", "fixture-private-key");
  harness.click("next");
}

describe("model wizard uncertain save retry", () => {
  test.each(["lost response", "server failure"])(
    "retries after %s, adopts only the real committed model and then applies once",
    async (failure) => {
      const requests: any[] = [];
      const saveModel = vi.fn(async (input: any) => {
        requests.push({ ...input });
        const result = await fixture.service.add(input);
        if (requests.length !== 1) return result;
        if (failure === "lost response")
          throw new Error("fixture response lost");
        throw new RuntimeWebClientError("Save result unavailable", {
          status: 500,
          payload: { ok: false, error: "model_save_failed" },
        });
      });
      const harness = createModelWizardHarness({
        loadSetup: () => fixture.service.catalog(),
        saveModel,
      });
      await reviewCloud(harness);
      harness.click("finish");
      await harness.settled();
      const committed = await fixture.readConfig();
      const env = await fixture.readEnv();
      expect(saveModel).toHaveBeenCalledOnce();
      expect(harness.dependencies.applySetup).not.toHaveBeenCalled();
      expect(harness.field("api-key")?.value).toBe("");
      expect(harness.dialog.innerHTML).not.toContain("fixture-private-key");
      expect(harness.wizard.isOpen()).toBe(true);
      harness.click("finish");
      await harness.settled();
      expect(saveModel).toHaveBeenCalledTimes(2);
      expect(requests[1]).not.toHaveProperty("apiKey");
      expect(harness.dependencies.onSaved).toHaveBeenCalledOnce();
      expect(harness.dependencies.applySetup).toHaveBeenCalledOnce();
      expect(harness.wizard.isOpen()).toBe(false);
      expect(await fixture.readConfig()).toEqual(committed);
      expect(await fixture.readEnv()).toBe(env);
    },
  );

  test("an uncertain failure before persistence does not claim a saved key, and a canonical missing-key rejection requires entry again", async () => {
    const saveModel = vi.fn(async (input: any) => {
      if (saveModel.mock.calls.length === 1)
        throw new Error("offline before save");
      try {
        return await fixture.service.add(input);
      } catch (error) {
        throw canonicalFailure(error);
      }
    });
    const harness = createModelWizardHarness({
      loadSetup: () => fixture.service.catalog(),
      saveModel,
    });
    await reviewCloud(harness);
    harness.click("finish");
    await harness.settled();
    expect(harness.dialog.textContent).not.toContain("was saved privately");
    harness.click("finish");
    await harness.settled();
    expect(saveModel).toHaveBeenCalledTimes(2);
    expect(harness.dependencies.applySetup).not.toHaveBeenCalled();
    expect((await fixture.service.catalog()).profileIds).toEqual(["default"]);
    harness.click("finish");
    await harness.settled();
    expect(saveModel).toHaveBeenCalledTimes(2);
    expect(harness.field("api-key")?.required).toBe(true);
    expect(harness.dialog.querySelector("[data-model-form]")?.hidden).toBe(
      false,
    );
    harness.input("api-key", "fixture-private-key");
    harness.click("next");
    harness.click("finish");
    await harness.settled();
    expect(saveModel).toHaveBeenCalledTimes(3);
    expect(harness.dependencies.applySetup).toHaveBeenCalledOnce();
  });

  test.each(["model-id", "context-window", "profile-id", "connection-id"])(
    "editing %s clears uncertain retry permission",
    async (field) => {
      const saveModel = vi.fn(async () => {
        throw new Error("fixture response lost");
      });
      const harness = createModelWizardHarness({ saveModel });
      await reviewCloud(harness);
      harness.click("finish");
      await harness.settled();
      harness.click("back");
      harness.input(field, field === "context-window" ? "131072" : "changed");
      expect(harness.field("api-key")?.required).toBe(true);
      harness.click("next");
      harness.click("finish");
      await harness.settled();
      expect(saveModel).toHaveBeenCalledOnce();
      expect(harness.dependencies.applySetup).not.toHaveBeenCalled();
    },
  );

  test("a conflicting persisted model never reaches Apply", async () => {
    const saveModel = vi.fn(async (input: any) => {
      try {
        const result = await fixture.service.add(input);
        if (saveModel.mock.calls.length !== 1) return result;
        const config = await fixture.readConfig();
        config.models.profiles[input.profileId].contextWindowTokens = 131072;
        await fixture.writeConfig(config);
        throw new Error("fixture response lost");
      } catch (error: any) {
        if (error.statusCode) throw canonicalFailure(error);
        throw error;
      }
    });
    const harness = createModelWizardHarness({
      loadSetup: () => fixture.service.catalog(),
      saveModel,
    });
    await reviewCloud(harness);
    harness.click("finish");
    await harness.settled();
    harness.click("finish");
    await harness.settled();
    expect(saveModel).toHaveBeenCalledTimes(2);
    expect(harness.dependencies.onSaved).not.toHaveBeenCalled();
    expect(harness.dependencies.applySetup).not.toHaveBeenCalled();
    expect(harness.wizard.isOpen()).toBe(true);
  });

  test("closing and reopening the wizard clears uncertainty and still requires a new connection key", async () => {
    const saveModel = vi.fn(async () => {
      throw new Error("fixture response lost");
    });
    const harness = createModelWizardHarness({ saveModel });
    await reviewCloud(harness);
    harness.click("finish");
    await harness.settled();
    harness.click("cancel");
    await harness.wizard.open();
    harness.choose("new:openai");
    harness.click("next");
    expect(harness.field("api-key")?.required).toBe(true);
    expect(harness.field("api-key")?.value).toBe("");
  });
});
