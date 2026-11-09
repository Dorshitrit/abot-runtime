import { expect, test, vi } from "vitest";
// @ts-expect-error Browser presentation module has no declaration surface.
import { configuredProviderConnections } from "../../web-ui/app/components/config-workspace/provider-connections.js";
// @ts-expect-error Browser presentation module has no declaration surface.
import { providerEdits, renderProviderFields } from "../../web-ui/app/components/config-workspace/provider-editor.js";
// @ts-expect-error Browser presentation module has no declaration surface.
import { createProviderManagement } from "../../web-ui/app/components/config-workspace/provider-management.js";
// @ts-expect-error Browser presentation module has no declaration surface.
import { renderModelSetupEntry } from "../../web-ui/app/components/config-workspace/model-setup-entry.js";
// @ts-expect-error Browser presentation module has no declaration surface.
import { createConfigWorkspaceEvents } from "../../web-ui/app/components/config-workspace/workspace-events.js";

function snapshot() {
  return {
    revision: "rev-1", config: { models: {
      providers: {
        local: { type: "llamacpp", baseUrl: "http://old.test/v1", apiKeyEnv: "LOCAL_KEY", settings: { private: "unused-private-data" } },
        other: { type: "ollama" },
        account: { type: "openai-chatgpt", settings: { accountRef: "old" } },
        api: { type: "openai" },
      },
      embeddingProfiles: { documents: { provider: "local" } },
    } },
  };
}
const models = [
  { id: "current", registered: true, config: { provider: "local" } },
  { id: "retained", registered: false, config: { provider: "other" } },
];
const [local, other, account, api] = configuredProviderConnections(snapshot(), models);

test("card actions address saved connection IDs and usage excludes retained model files", () => {
  const cards = renderModelSetupEntry(snapshot(), models);
  expect(cards).toContain('data-config-action="edit-provider" data-provider-id="local"');
  expect(cards).toContain('data-config-action="delete-provider" data-provider-id="other"');
  expect(cards).toContain("1 embedding profile");
  expect(local).toMatchObject({ modelIds: ["current"], embeddingIds: ["documents"] });
  expect(other.modelIds).toEqual([]);
  expect(JSON.stringify(local)).not.toContain("unused-private-data");
});

test("the Models click hands the selected saved connection and root revision to its controller", () => {
  const listener = vi.fn();
  const onProviderAction = vi.fn();
  createConfigWorkspaceEvents({
    state: { configDashboard: { files: { runtime: snapshot(), models } } },
    dom: { configDashboard: { addEventListener: listener }, refreshConfigButton: { addEventListener: vi.fn() } },
    eventTarget: {}, onProviderAction, dashboardIsBusy: () => false,
  }).bind();
  const click = listener.mock.calls.find(([name]) => name === "click")![1];
  const button = { dataset: { configAction: "edit-provider", providerId: "local" } };
  click({ target: { closest: () => button } });
  expect(onProviderAction).toHaveBeenCalledWith("edit-provider", local);
  button.dataset.providerId = "unconfigured";
  click({ target: { closest: () => button } });
  expect(onProviderAction).toHaveBeenCalledOnce();
});

test("each family submits only its edited fields, including explicit clears and unchanged legacy addresses", () => {
  expect(providerEdits(local, { baseUrl: "http://old.test/v1", apiKeyEnv: "", keepAlive: "7m" })).toEqual({ apiKeyEnv: "" });
  expect(providerEdits(other, { baseUrl: "https://new.test/", keepAlive: "7m", apiKeyEnv: "IGNORED" })).toEqual({ baseUrl: "https://new.test", keepAlive: "7m" });
  expect(providerEdits({ ...other, settings: { keepAlive: "7m" } }, { keepAlive: "" })).toEqual({ keepAlive: "" });
  expect(() => providerEdits(local, { baseUrl: "" })).toThrow("HTTP or HTTPS origin");
  expect(() => providerEdits(api, { apiKeyEnv: "invalid-key-name" })).toThrow("variable name");
  expect(renderProviderFields(local)).toContain("Requests to the new address");
  const html = renderProviderFields(account, [
    { accountRef: "good", label: "Plan", status: "connected", planEnabled: true },
    { accountRef: "no-plan", status: "connected", planEnabled: false },
    { accountRef: "expired", status: "reauth_required", planEnabled: true },
  ]);
  expect(html).toContain('value="good"');
  expect(html).not.toMatch(/no-plan|expired/);
  expect(providerEdits(account, { accountRef: "good", apiKeyEnv: "IGNORED" })).toEqual({ accountRef: "good" });
});

function controller() {
  const workspace = {
    beginExternalRuntimeMutation: vi.fn(() => true), endExternalRuntimeMutation: vi.fn(),
    refreshAfterExternalRuntimeMutation: vi.fn(async () => true), setStatus: vi.fn(),
  };
  const client = {
    updateRuntimeProvider: vi.fn(), removeRuntimeProvider: vi.fn(), loadConfigDashboard: vi.fn(),
  };
  const edit = vi.fn(async (): Promise<Record<string, string> | null> => ({ keepAlive: "5m" }));
  const confirm = vi.fn(async () => true);
  const onSaved = vi.fn();
  const environment = vi.fn(() => "dev");
  const { manage } = createProviderManagement({
    root: {}, runtimeClient: client, getEnvironmentId: environment,
    getWorkspace: () => workspace, onSaved, edit, confirm,
  });
  return { client, workspace, edit, confirm, manage, onSaved, environment };
}

test("guards drafts, cancellation, and referenced connections before mutation", async () => {
  const { client, workspace, edit, confirm, manage, onSaved } = controller();
  workspace.beginExternalRuntimeMutation.mockReturnValueOnce(false);
  expect(await manage("edit-provider", other)).toBe(false);
  expect(edit).not.toHaveBeenCalled();
  expect(await manage("delete-provider", local)).toBe(false);
  expect(confirm).not.toHaveBeenCalled();
  expect(workspace.setStatus).toHaveBeenCalledWith(expect.stringMatching(/current.*documents/), "error-text");
  confirm.mockResolvedValueOnce(false);
  expect(await manage("delete-provider", other)).toBe(false);
  expect(client.removeRuntimeProvider).not.toHaveBeenCalled();
  expect(onSaved).not.toHaveBeenCalled();
  expect(workspace.endExternalRuntimeMutation).toHaveBeenCalledTimes(2);
});

test("scopes confirmed changes to the saved revision and environment and marks them pending apply", async () => {
  const { client, confirm, manage, onSaved, workspace } = controller();
  expect(await manage("edit-provider", other)).toBe(true);
  expect(client.updateRuntimeProvider).toHaveBeenCalledWith({ providerId: "other", expectedRevision: "rev-1", keepAlive: "5m" }, "dev");
  expect(await manage("delete-provider", other)).toBe(true);
  expect(confirm).toHaveBeenCalledWith(expect.stringContaining("other"), expect.objectContaining({ tone: "danger" }));
  expect(client.removeRuntimeProvider).toHaveBeenCalledWith({ providerId: "other", expectedRevision: "rev-1" }, "dev");
  expect(onSaved).toHaveBeenCalledTimes(2);
  expect(workspace.refreshAfterExternalRuntimeMutation).toHaveBeenCalledTimes(2);
});

test("rejects stale edits and environment switches and reconciles an uncertain response before reporting success", async () => {
  const { client, manage, onSaved, environment } = controller();
  environment.mockReturnValueOnce("dev").mockReturnValueOnce("other");
  expect(await manage("edit-provider", other)).toBe(false);
  expect(client.updateRuntimeProvider).not.toHaveBeenCalled();
  client.updateRuntimeProvider.mockRejectedValueOnce(Object.assign(new Error("refresh first"), { status: 409 }));
  expect(await manage("edit-provider", other)).toBe(false);
  expect(client.loadConfigDashboard).not.toHaveBeenCalled();
  expect(onSaved).not.toHaveBeenCalled();
  client.removeRuntimeProvider.mockRejectedValueOnce(new Error("response lost"));
  client.loadConfigDashboard.mockResolvedValueOnce({ dashboard: { files: { runtime: { revision: "rev-2", config: { models: { providers: {} } } } } } });
  expect(await manage("delete-provider", other)).toBe(true);
  expect(client.loadConfigDashboard).toHaveBeenCalledWith("dev", { settled: true });
  expect(client.removeRuntimeProvider).toHaveBeenCalledOnce();
  expect(onSaved).toHaveBeenCalledOnce();
});
