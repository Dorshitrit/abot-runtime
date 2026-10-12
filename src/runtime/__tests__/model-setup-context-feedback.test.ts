import { describe, expect, test, vi } from "vitest";
import type { ModelSetupWizardDependencies } from "../../web-ui/app/components/model-setup/wizard.js";
import {
  createRuntimeWebClient,
  RuntimeWebClientError,
} from "../../web-ui/app/services/runtime-web-client.js";
import {
  createModelWizardHarness,
  modelSetupCatalog,
} from "./support/model-setup-wizard-harness.js";

function rejection(details: Record<string, unknown> = {}) {
  return {
    ok: false,
    error: "context_window_too_small",
    message: "synthetic-private /private/config.json",
    credentialSaved: false,
    contextWindow: {
      field: "contextWindowTokens",
      profileId: "small-context",
      declaredTokens: 4096,
      effectiveTokens: 4096,
      reservedTokens: 6320,
      minimumTokens: 6321,
      ...details,
    },
  };
}

function harnessWithResponse(
  payload = rejection(),
  status = 400,
  credentialRequired = false,
) {
  const fetchImpl = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(JSON.stringify(payload), { status }))
    .mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            model: {
              profileId: "small-context",
              providerId: "local",
              provider: "ollama",
              model: "qa-small",
            },
          }),
        ),
    );
  const client = createRuntimeWebClient({
    getConfig: () => null,
    getEnvironmentId: () => "test",
    origin: "http://localhost",
    fetchImpl,
  });
  const harness = createModelWizardHarness({
    loadSetup: async () => ({
      ...modelSetupCatalog,
      providers: modelSetupCatalog.providers.map((provider) => ({
        ...provider,
        credentialConfigured: !credentialRequired,
      })),
    }),
    saveModel: (input) =>
      client.addRuntimeModel(input) as ReturnType<
        ModelSetupWizardDependencies["saveModel"]
      >,
  });
  return { ...harness, fetchImpl };
}

async function review(
  harness: ReturnType<typeof harnessWithResponse>,
  providerId = "local",
  tokens = "4096",
) {
  await harness.wizard.open({ providerId });
  harness.input("model-id", "qa-small");
  harness.input("profile-id", "small-context");
  harness.input("context-window", tokens);
  if (providerId === "cloud") harness.input("api-key", "synthetic-private-key");
  harness.click("next");
}

function fieldFeedback(harness: ReturnType<typeof harnessWithResponse>) {
  return harness.dialog.querySelector(
    '[id="addModelSetupError-context-window"]',
  );
}

describe("add-model context constraint feedback", () => {
  test("shows safe field feedback, preserves the draft and focuses correction before retry", async () => {
    const harness = harnessWithResponse();
    await review(harness);
    const field = harness.field("context-window")!;
    const form = harness.dialog.querySelector("[data-model-form]")!;
    harness.click("finish");
    await harness.settled();
    expect(harness.field("context-window")).toBe(field);
    expect(harness.dialog.querySelector("[data-model-form]")).toBe(form);
    expect(form.hidden).toBe(false);
    expect(form.inert).toBe(false);
    expect(field.value).toBe("4096");
    expect(field.attributes.get("aria-invalid")).toBe("true");
    expect(field.attributes.get("min")).toBe("6321");
    expect(field.attributes.get("aria-describedby")).toBe(
      "addModelSetupHelp-context-window addModelSetupError-context-window",
    );
    expect(fieldFeedback(harness)?.textContent).toContain("6,320");
    expect(fieldFeedback(harness)?.textContent).toContain("6,321");
    expect(harness.dialog.innerHTML).not.toContain("synthetic-private");
    expect(harness.document.activeElement).toBe(field);
    expect(harness.field("model-id")?.value).toBe("qa-small");
    expect(harness.field("profile-id")?.value).toBe("small-context");
    expect(harness.dependencies.applySetup).not.toHaveBeenCalled();
    harness.input("context-window", "6321");
    expect(fieldFeedback(harness)).toBeNull();
    expect(field.attributes.get("aria-invalid")).toBeUndefined();
    expect(field.attributes.get("min")).toBe("1");
    harness.click("next");
    harness.click("finish");
    await harness.settled();
    expect(harness.fetchImpl).toHaveBeenCalledTimes(2);
    expect(
      JSON.parse(String(harness.fetchImpl.mock.calls[1][1]?.body)),
    ).toMatchObject({ contextWindowTokens: 6321 });
    expect(harness.dependencies.applySetup).toHaveBeenCalledOnce();
    expect(harness.wizard.isOpen()).toBe(false);
  });

  test("explains a dynamic reserve and lower Ollama allocation without rendering server text", async () => {
    const harness = harnessWithResponse(
      rejection({
        declaredTokens: 32768,
        effectiveTokens: 7000,
        reservedTokens: 9000,
        minimumTokens: 9001,
        allocationTokens: 7000,
      }),
    );
    await review(harness, "local", "32768");
    harness.click("finish");
    await harness.settled();
    expect(fieldFeedback(harness)?.textContent).toContain("9,001");
    expect(fieldFeedback(harness)?.textContent).toContain("num_ctx");
    expect(fieldFeedback(harness)?.textContent).toContain(
      "increasing this field alone is insufficient",
    );
    expect(harness.dialog.innerHTML).not.toContain("/private/");
  });

  test("keeps submitted secrets cleared and requires re-entry after a rejected save", async () => {
    const harness = harnessWithResponse(rejection(), 400, true);
    await review(harness, "cloud");
    const key = harness.field("api-key")!;
    harness.click("finish");
    await harness.settled();
    expect(harness.field("api-key")).toBe(key);
    expect(key.value).toBe("");
    expect(key.required).toBe(true);
    expect(harness.dialog.innerHTML).not.toContain("synthetic-private-key");
    harness.input("context-window", "8192");
    harness.click("next");
    expect(harness.fetchImpl).toHaveBeenCalledOnce();
    expect(harness.document.activeElement).toBe(key);
  });

  test.each([
    ["different profile", rejection({ profileId: "unrelated" }), 400],
    ["invalid numeric evidence", rejection({ minimumTokens: "unsafe" }), 400],
    ["unexpected HTTP status", rejection(), 500],
  ])(
    "does not mark the context field for %s",
    async (_name, payload, status) => {
      const harness = harnessWithResponse(
        payload as ReturnType<typeof rejection>,
        status as number,
      );
      await review(harness);
      harness.click("finish");
      await harness.settled();
      expect(fieldFeedback(harness)).toBeNull();
      expect(
        harness.field("context-window")?.attributes.get("aria-invalid"),
      ).toBeUndefined();
      expect(harness.dependencies.applySetup).not.toHaveBeenCalled();
      expect(harness.dialog.innerHTML).not.toContain("synthetic-private");
      expect(harness.dialog.innerHTML).not.toContain("/private/");
    },
  );

  test("does not steal focus moved outside while the save is pending", async () => {
    let reject!: (error: Error) => void;
    const pending = new Promise<never>((_resolve, rejectSave) => {
      reject = rejectSave;
    });
    const harness = createModelWizardHarness({ saveModel: () => pending });
    await harness.wizard.open({ providerId: "local" });
    harness.input("model-id", "qa-small");
    harness.input("profile-id", "small-context");
    harness.input("context-window", "4096");
    harness.click("next");
    harness.click("finish");
    const outside = harness.document.createElement("button");
    harness.document.body.append(outside);
    outside.focus();
    reject(
      new RuntimeWebClientError("capacity", {
        status: 400,
        payload: rejection(),
      }),
    );
    await harness.settled();
    expect(harness.document.activeElement).toBe(outside);
    expect(
      harness.field("context-window")?.attributes.get("aria-invalid"),
    ).toBe("true");
  });
});
