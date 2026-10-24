import { expect, test, vi } from "vitest";
// @ts-expect-error Browser presentation module has no declaration surface.
import { createConfigWorkspaceEvents } from "../../web-ui/app/components/config-workspace/workspace-events.js";
import { isTokenBudgetModel, renderReasoningBudget } from "../../web-ui/app/components/config-workspace/reasoning-budget.js";

test("model capability edits immediately refresh available budget controls", () => {
  const file = {
    kind: "model", id: "local",
    config: { provider: "llama", supportsThinking: false, generation: {} },
  };
  const dashboard = { files: { models: [file], runtime: { config: { models: {
    providers: { llama: { type: "llamacpp" }, ollama: { type: "ollama" } },
  } } } } };
  let markup = "";
  const renderConfigDashboard = vi.fn(() => {
    markup = renderReasoningBudget(file, ["generation"], () => "<input>", {
      supported: isTokenBudgetModel(file, dashboard),
    });
  });
  const listeners = new Map<string, (event: unknown) => void>();
  const events = createConfigWorkspaceEvents({
    state: {}, eventTarget: {},
    dom: {
      configDashboard: { addEventListener: (type: string, callback: (event: unknown) => void) => listeners.set(type, callback) },
      refreshConfigButton: { addEventListener: () => undefined },
    },
    dashboardIsBusy: () => false,
    parseConfigPath: JSON.parse,
    findConfigFile: () => file,
    parseConfigInputValue: (element: { value: unknown }) => element.value,
    mutateConfigFile: (_kind: string, _id: string, mutate: (config: typeof file.config) => void) => mutate(file.config),
    setConfigPathValue: (config: Record<string, unknown>, path: string[], value: unknown) => { config[path[0]!] = value; },
    renderConfigDashboard,
  });
  events.bind();
  const change = (field: string, value: unknown) => {
    const element = {
      dataset: { configAction: "field", kind: file.kind, id: file.id, path: JSON.stringify([field]) },
      value, matches: () => true, closest: () => element,
    };
    listeners.get("change")!({ target: element });
  };
  change("supportsThinking", true);
  expect(markup).toContain('value="tokens"');
  change("supportsThinking", false);
  expect(markup).toBe("");
  change("supportsThinking", true);
  change("provider", "ollama");
  expect(markup).toBe("");
  change("provider", "llama");
  expect(markup).toContain('value="tokens"');
  expect(renderConfigDashboard).toHaveBeenCalledTimes(5);
});
