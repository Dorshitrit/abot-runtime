import { expect, test, vi } from "vitest";
import type { SetupEmbeddingInput } from "../../web-ui/local-runtime/setup-embedding-input.js";
import { createEmbeddingCredentialStatus } from "../../web-ui/app/components/runtime-setup/embedding-credential-status.js";
import {
  createGuideHarness,
  setupSnapshot,
} from "./support/runtime-setup-guide-harness.js";

const existingProvider = { id: "chat", type: "llamacpp" };
const savedProvider = { id: "llamacpp-embedding", type: "llamacpp" };
const key = "synthetic-embedding-recovery-key";
const keyField = 'data-runtime-setup-field="embedding-key"';
const success = (providerId: string) => ({
  status: {
    enabled: true,
    providerId,
    model: "embed-model",
    providers: [existingProvider, savedProvider],
  },
});

function recoveryHarness(
  save: (input: SetupEmbeddingInput) => Promise<Record<string, unknown>>,
) {
  const runtimeClient = {
    loadLongTermMemoryStatus: vi.fn(async () => ({
      status: { enabled: false, providers: [existingProvider] },
    })),
    loadModelSetup: vi.fn(async (): Promise<Record<string, unknown>> => {
      throw new Error("Catalog unavailable");
    }),
    saveRuntimeSetupEmbedding: vi.fn(save),
  };
  const credentials = createEmbeddingCredentialStatus({
    runtimeClient,
    getEnvironmentId: () => "dev",
  });
  const h = createGuideHarness({
    loadSetup: async () => ({
      setup: {
        ...setupSnapshot,
        status: "ready" as const,
        existingModel: { provider: "ollama" as const, model: "chat-model" },
      },
    }),
    loadEmbeddingStatus: () => credentials.loadStatus(),
    saveEmbedding: (input) => credentials.saveEmbedding(input),
  });
  return { ...h, runtimeClient };
}

test("a failed optional catalog still allows a missing llama.cpp credential to be submitted", async () => {
  const submitted: SetupEmbeddingInput[] = [];
  const references: SetupEmbeddingInput[] = [];
  const h = recoveryHarness(async (input) => {
    submitted.push({ ...input });
    references.push(input);
    return success(input.providerId!);
  });
  await h.open();
  expect(h.runtimeClient.loadModelSetup).toHaveBeenCalledWith("dev");
  expect(h.container.innerHTML).toContain(keyField);
  expect(h.fields["embedding-key"].value).toBe("");
  expect(h.container.innerHTML).not.toContain("••••••••");
  h.inputEmbeddingModel("embed-model");
  h.inputEmbeddingKey(key);
  h.submit();
  await h.ready();
  expect(submitted).toEqual([
    { providerId: "chat", model: "embed-model", apiKey: key },
  ]);
  expect(references[0]).not.toHaveProperty("apiKey");
  expect(h.fields["embedding-key"].value).toBe("");
  expect(h.container.innerHTML).not.toContain(key);
  expect(h.container.innerHTML).toContain("Choose your plugins");
});

test("catalog failure after a partial save retains key reentry and retries the canonical saved connection", async () => {
  const submitted: SetupEmbeddingInput[] = [];
  const references: SetupEmbeddingInput[] = [];
  const failure = Object.assign(new Error("Embedding probe failed"), {
    payload: {
      providerSaved: true,
      savedProvider,
      message: "Embedding probe failed.",
    },
  });
  const h = recoveryHarness(async (input) => {
    submitted.push({ ...input });
    references.push(input);
    if (submitted.length === 1) throw failure;
    return success(input.providerId!);
  });
  await h.open();
  h.changeEmbeddingProvider("new:llamacpp");
  h.inputEmbeddingModel("embed-model");
  h.inputEmbeddingKey(key);
  h.submit();
  await h.ready();
  expect(failure.payload.savedProvider).toEqual(savedProvider);
  expect(failure.payload.savedProvider).not.toHaveProperty(
    "credentialConfigured",
  );
  expect(h.container.innerHTML).toContain(
    'value="llamacpp-embedding" selected',
  );
  expect(
    h.container.innerHTML.match(/value="llamacpp-embedding"/g),
  ).toHaveLength(1);
  expect(h.container.innerHTML).not.toContain(
    'data-runtime-setup-field="embedding-connection-id"',
  );
  expect(h.container.innerHTML).toContain(keyField);
  expect(h.fields["embedding-key"].value).toBe("");
  expect(references[0]).not.toHaveProperty("apiKey");
  expect(h.container.innerHTML).not.toContain(key);
  h.inputEmbeddingKey(key);
  h.submit();
  await h.ready();
  expect(submitted).toEqual([
    {
      provider: "llamacpp",
      model: "embed-model",
      baseUrl: "http://127.0.0.1:8080",
      newProviderId: "llamacpp-embedding",
      useApiKey: true,
      apiKey: key,
    },
    { providerId: "llamacpp-embedding", model: "embed-model", apiKey: key },
  ]);
  expect(references.every((input) => !("apiKey" in input))).toBe(true);
  expect(h.fields["embedding-key"].value).toBe("");
  expect(h.container.innerHTML).not.toContain(key);
  expect(h.container.innerHTML).toContain("Choose your plugins");
});
