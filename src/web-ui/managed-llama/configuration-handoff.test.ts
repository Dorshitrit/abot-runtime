import { describe, expect, test, vi } from "vitest";
import { createManagedLlamaHandoff } from "./configuration-handoff.js";
import { parseRuntimeSetupInput, RuntimeSetupError } from "../local-runtime/runtime-setup-input.js";
import { parseModelSetupInput, ModelSetupError } from "../local-runtime/model-setup-input.js";

const ready = Object.freeze({ baseUrl: "http://127.0.0.1:18443", model: "unit-model",
  contextWindowTokens: 4096, apiKey: "synthetic-unit-key" });
for (const kind of ["runtime", "models"] as const) {
  describe(kind + " managed configuration handoff", () => {
    const input = (): Record<string, unknown> => kind === "runtime"
      ? { managedLlama: true, provider: "llamacpp", deferActivation: true }
      : { managedLlama: true, profileId: "unit-profile", newProvider: { id: "unit-provider", type: "llamacpp" } };
    const ErrorType = kind === "runtime" ? RuntimeSetupError : ModelSetupError;
    test("manual input passes through by identity without consulting manager", () => {
      const getter = vi.fn(() => { throw new Error("must not call"); });
      const manual = { provider: "ollama", model: "manual" };
      expect(createManagedLlamaHandoff(kind, getter)(manual)).toBe(manual);
      expect(createManagedLlamaHandoff(kind)(manual)).toBe(manual);
      expect(getter).not.toHaveBeenCalled();
    });
    test("injects trusted ready values, strips marker and preserves parser ownership", () => {
      const body = input();
      if (kind === "models") Object.freeze(body.newProvider);
      Object.freeze(body);
      const before = structuredClone(body);
      const getter = vi.fn(() => ready);
      const resolved = createManagedLlamaHandoff(kind, getter)(body);
      expect(getter).toHaveBeenCalledTimes(1);
      expect(resolved).not.toBe(body);
      expect(resolved).not.toHaveProperty("managedLlama");
      expect(body).toEqual(before);
      expect(resolved).toMatchObject({ model: ready.model, contextWindowTokens: ready.contextWindowTokens, apiKey: ready.apiKey });
      if (kind === "runtime") {
        expect(resolved.baseUrl).toBe(ready.baseUrl);
        expect(parseRuntimeSetupInput(resolved)).toMatchObject({ ...ready, provider: "llamacpp", deferActivation: true });
      } else {
        expect(resolved).not.toHaveProperty("baseUrl");
        expect(resolved.newProvider).not.toBe(body.newProvider);
        expect(parseModelSetupInput(resolved)).toMatchObject({ profileId: "unit-profile", model: ready.model,
          apiKey: ready.apiKey, contextWindowTokens: ready.contextWindowTokens,
          newProvider: { id: "unit-provider", type: "llamacpp", baseUrl: ready.baseUrl, useApiKey: true } });
      }
    });
    test.each([false, null, "true", 1, undefined, {}])("rejects invalid marker %j without getter", marker => {
      const getter = vi.fn(() => ready);
      expect(() => createManagedLlamaHandoff(kind, getter)({ ...input(), managedLlama: marker })).toThrow(ErrorType);
      expect(getter).not.toHaveBeenCalled();
    });
    test("rejects incompatible provider before consulting owner", () => {
      const getter = vi.fn(() => ready);
      const body = input();
      if (kind === "runtime") body.provider = "ollama";
      else body.newProvider = { id: "unit", type: "ollama" };
      expect(() => createManagedLlamaHandoff(kind, getter)(body)).toThrow(ErrorType);
      expect(getter).not.toHaveBeenCalled();
    });
    test.each(["apiKey", "baseUrl", "model", "contextWindowTokens"])("rejects conflicting %s without mutation", field => {
      const body = { ...input(), [field]: "conflicting-value" };
      const before = structuredClone(body);
      expect(() => createManagedLlamaHandoff(kind, () => ready)(body)).toThrow("conflict");
      expect(body).toEqual(before);
    });
    test("accepts exactly matching supplied settings", () => {
      const body = { ...input(), ...ready };
      expect(createManagedLlamaHandoff(kind, () => ready)(body)).toMatchObject({ model: ready.model, apiKey: ready.apiKey });
    });
    test("missing resolver or nonready connection yields public 409", () => {
      for (const getter of [undefined, () => null, () => { throw new Error(ready.apiKey); }]) {
        try { createManagedLlamaHandoff(kind, getter)(input()); throw new Error("expected rejection"); }
        catch (error) {
          expect(error).toBeInstanceOf(ErrorType);
          expect(error).toMatchObject({ code: "managed_llama_not_ready", statusCode: 409 });
          expect(String(error)).not.toContain(ready.apiKey);
          expect(JSON.stringify(error)).not.toContain(ready.apiKey);
        }
      }
    });
    test("rejects incomplete ready snapshot", () => {
      expect(() => createManagedLlamaHandoff(kind, () => ({ ...ready, apiKey: "" }))(input())).toThrow(ErrorType);
    });
  });
}
test.each(["existing", "", undefined])("Models rejects any supplied providerId (%j)", providerId => {
  const getter = vi.fn(() => ready);
  expect(() => createManagedLlamaHandoff("models", getter)({ managedLlama: true, providerId,
    newProvider: { id: "unit", type: "llamacpp" } })).toThrow(ModelSetupError);
  expect(getter).not.toHaveBeenCalled();
});
test.each([null, [], undefined, { type: "openai" }])("Models requires a new llama provider (%j)", newProvider => {
  expect(() => createManagedLlamaHandoff("models", () => ready)({ managedLlama: true, newProvider })).toThrow(ModelSetupError);
});
test.each([{ baseUrl: "http://127.0.0.1:9999" }, { useApiKey: false }])("Models rejects nested conflict %j", fields => {
  const body = { managedLlama: true, newProvider: { id: "unit", type: "llamacpp", ...fields } };
  const before = structuredClone(body);
  expect(() => createManagedLlamaHandoff("models", () => ready)(body)).toThrow(ModelSetupError);
  expect(body).toEqual(before);
});
