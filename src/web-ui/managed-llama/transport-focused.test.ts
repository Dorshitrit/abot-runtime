import { describe, expect, test, vi } from "vitest";
import { createManagedLlamaRequests } from "../app/services/runtime-web-client/managed-llama.js";
// The existing configuration aggregator is JavaScript without declarations.
const configurationModule = "../app/services/runtime-web-client/configuration.js";
const { createConfigurationRequests } = await import(configurationModule);

function setup(factory = createManagedLlamaRequests) {
  const result = Promise.resolve({ ok: true });
  const requestApi = vi.fn(() => result);
  const environmentQuery = vi.fn((id?: string) => encodeURIComponent(id ?? "default"));
  return { client: factory({ requestApi, environmentQuery }), requestApi, environmentQuery, result };
}

describe("managed llama pure transport", () => {
  test("construction does not request or scope anything", () => {
    for (const factory of [createManagedLlamaRequests, createConfigurationRequests]) {
      const { requestApi, environmentQuery } = setup(factory);
      expect(requestApi).not.toHaveBeenCalled();
      expect(environmentQuery).not.toHaveBeenCalled();
    }
  });
  test("status uses the scoped default GET convention and returns the request", () => {
    const { client, requestApi, environmentQuery, result } = setup();
    expect(client.getManagedLlamaStatus("team & one")).toBe(result);
    expect(environmentQuery).toHaveBeenCalledExactlyOnceWith("team & one");
    expect(requestApi).toHaveBeenCalledExactlyOnceWith("/runtime/managed-llama/status?environment=team%20%26%20one");
  });
  test.each(["inspect", "install", "start", "stop", "cancel"])("%s is an explicit POST with default body", action => {
    const { client, requestApi, environmentQuery, result } = setup();
    expect(client.managedLlamaAction(action, undefined, "local")).toBe(result);
    expect(environmentQuery).toHaveBeenCalledExactlyOnceWith("local");
    expect(requestApi).toHaveBeenCalledExactlyOnceWith("/runtime/managed-llama/" + action + "?environment=local", { method: "POST", body: "{}" });
  });
  test("start serializes the supplied launch payload without mutation", () => {
    const { client, requestApi } = setup();
    const input = Object.freeze({ modelPath: "/synthetic/model.gguf", port: 18443, alias: "unit", contextTokens: 1024, gpuLayers: 0 });
    client.managedLlamaAction("start", input, "unit");
    expect(requestApi).toHaveBeenCalledExactlyOnceWith("/runtime/managed-llama/start?environment=unit", { method: "POST", body: JSON.stringify(input) });
  });
  test.each(["", "status", "save", "restart", "../install", "INSTALL", "toString"])("rejects unknown action %s without requesting", action => {
    const { client, requestApi, environmentQuery } = setup();
    expect(() => client.managedLlamaAction(action)).toThrow("Unknown managed llama.cpp action");
    expect(requestApi).not.toHaveBeenCalled();
    expect(environmentQuery).not.toHaveBeenCalled();
  });
  test("omitted environment is delegated to the existing convention", () => {
    const { client, requestApi, environmentQuery } = setup();
    client.getManagedLlamaStatus();
    expect(environmentQuery).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(requestApi).toHaveBeenCalledExactlyOnceWith("/runtime/managed-llama/status?environment=default");
  });
  test("configuration composes both managed methods and preserves existing transport", () => {
    const { requestApi, environmentQuery } = setup();
    const client = createConfigurationRequests({ requestApi, environmentQuery });
    client.getManagedLlamaStatus("unit");
    client.managedLlamaAction("cancel", {}, "unit");
    client.getRuntimeSetup("unit");
    expect(requestApi.mock.calls).toEqual([
      ["/runtime/managed-llama/status?environment=unit"],
      ["/runtime/managed-llama/cancel?environment=unit", { method: "POST", body: "{}" }],
      ["/runtime/setup?environment=unit"],
    ]);
  });
});
