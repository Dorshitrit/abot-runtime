import { describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { readAutomationNodePatch, renderAutomationNodeInspector, updateAgentToolPicker } from "../../web-ui/app/components/automations/node-inspector.js";

const agent = (tools: object[] = []) => ({
  kind: "agent", id: "agent-one", title: "Research", modelProfileId: "local", agentMode: "fast",
  onFailure: "stop", prompt: "Research this", roleInstructions: "", inputs: {}, tools,
  result: { kind: "text" },
});

const operation = (toolName: string, operationId: string, label: string, pluginName: string) => ({
  toolName, operationId, contractVersion: 1, label, pluginName,
  permissionMode: "full_plus", approval: "always",
});

describe("ABot Studio agent tool picker", () => {
  test("renders compact step actions with tooltips and accessible names", () => {
    const markup = renderAutomationNodeInspector(agent(), { grantableOperations: [], operations: [], models: [] });
    for (const [action, label] of [
      ["save-step", "Save step"], ["move-up", "Move step earlier in workflow"], ["move-down", "Move step later in workflow"],
      ["parallel", "Parallel with next"], ["remove-node", "Remove step"],
    ]) {
      expect(markup).toContain(`data-action="${action}" aria-label="${label}" title="${label}"><svg`);
    }
    expect(markup).toContain('role="group" aria-label="Workflow actions"');
    expect(markup).toContain('data-action="save-agent">Save as agent</button>');
  });

  test("groups operations under recognizable tool names and keeps details behind disclosure", () => {
    const search = operation("web_search", "search_web", "Search one public query", "web");
    const catalog = operation("fixture_catalog", "list_sample_items",
      "List sample items with identifiers and titles; inspect a selected item separately for more detail.",
      "Fixture Catalog");
    const markup = renderAutomationNodeInspector(agent([{
      operation: { toolName: search.toolName, operationId: search.operationId, contractVersion: 1 },
      usage: "required",
    }]), { grantableOperations: [search, catalog], operations: [], models: [] });

    expect(markup).toContain("Agent tools");
    expect(markup).toContain("Choose the operations this agent may use.");
    expect(markup).toContain("Access is confirmed when publishing.");
    expect(markup).toContain("1 selected");
    expect(markup).toContain('data-agent-tool-search');
    expect(markup).toContain("Web Search");
    expect(markup).toContain("Search Web");
    expect(markup).toContain("Fixture Catalog");
    expect(markup).toContain("List Sample Items");
    expect(markup).toMatch(/data-agent-tool="[^\"]+search_web[^\"]+" checked/);
    expect(markup).toMatch(/data-agent-tool="[^\"]+list_sample_items[^\"]+"/);
    expect(markup).toContain('value="required" selected');
    expect(markup).toContain("FULL+ permission needed when publishing");
    expect(markup).toMatch(/data-agent-tool-options hidden/);
    expect(markup).toMatch(/<details class="automation-agent-operation-help"><summary>What this operation does<\/summary><p>List sample items/);
    expect(markup).not.toMatch(/<label class="automation-agent-operation-choice">[^<]*List sample items/);
  });

  test("search filters groups without changing selections and updates the selected count", () => {
    const searchCheckbox = { checked: true };
    const catalogCheckbox = { checked: false };
    const searchOptions = { hidden: true };
    const catalogOptions = { hidden: false };
    const searchRow = {
      dataset: { agentSearchName: "search web search_web public query" }, hidden: false,
      querySelector: (selector: string) => selector === "[data-agent-tool]" ? searchCheckbox : searchOptions,
    };
    const catalogRow = {
      dataset: { agentSearchName: "list sample items" }, hidden: false,
      querySelector: (selector: string) => selector === "[data-agent-tool]" ? catalogCheckbox : catalogOptions,
    };
    const tool = (name: string, row: typeof searchRow) => {
      const count = { textContent: "" };
      return {
        dataset: { agentSearchName: name }, hidden: false, open: false, count,
        querySelectorAll: () => [row],
        querySelector: () => count,
      };
    };
    const searchTool = tool("web search", searchRow);
    const catalogTool = tool("fixture catalog", catalogRow);
    const plugin = (name: string, item: typeof searchTool) => ({
      dataset: { agentSearchName: name }, hidden: false,
      querySelectorAll: () => [item],
    });
    const webPlugin = plugin("web", searchTool);
    const catalogPlugin = plugin("fixture catalog", catalogTool);
    const search = { value: "sample" };
    const selectedCount = { textContent: "" };
    const noResults = { hidden: true };
    const picker = {
      dataset: { unavailableCount: "0" },
      querySelector: (selector: string) => ({
        "[data-agent-tool-search]": search,
        "[data-agent-tool-count]": selectedCount,
        "[data-agent-tool-no-results]": noResults,
      })[selector as "[data-agent-tool-search]"],
      querySelectorAll: () => [webPlugin, catalogPlugin],
    };
    const form = { querySelector: () => picker };

    updateAgentToolPicker(form);
    expect(webPlugin.hidden).toBe(true);
    expect(catalogPlugin.hidden).toBe(false);
    expect(catalogTool.open).toBe(true);
    expect(selectedCount.textContent).toBe("1 selected");
    expect(searchOptions.hidden).toBe(false);
    expect(catalogOptions.hidden).toBe(true);
    expect(searchCheckbox.checked).toBe(true);

    catalogCheckbox.checked = true;
    search.value = "no match";
    updateAgentToolPicker(form);
    expect(selectedCount.textContent).toBe("2 selected");
    expect(noResults.hidden).toBe(false);
    expect(catalogOptions.hidden).toBe(false);
  });

  test("saves only checked operation references with their existing usage values", () => {
    const chosen = operation("web_search", "search_web", "Search one public query", "web");
    const omitted = operation("fixture_catalog", "list_sample_items", "List sample items", "Fixture Catalog");
    const chosenKey = JSON.stringify([chosen.toolName, chosen.operationId, chosen.contractVersion]);
    const omittedKey = JSON.stringify([omitted.toolName, omitted.operationId, omitted.contractVersion]);
    const form = {
      querySelector: () => null,
      querySelectorAll: (selector: string) => selector === "[data-agent-tool]:checked"
        ? [{ dataset: { agentTool: chosenKey } }]
        : [{ dataset: { toolUsage: chosenKey }, value: "required" },
          { dataset: { toolUsage: omittedKey }, value: "available" }],
    };
    vi.stubGlobal("FormData", class {
      get(name: string) {
        return { title: "Research", onFailure: "stop", modelProfileId: "local", agentMode: "fast",
          roleInstructions: "", prompt: "Research this", resultKind: "text", acceptance: "" }[name as "title"] || "";
      }
    });
    try {
      const patch = readAutomationNodePatch(form, agent(),
        { grantableOperations: [chosen, omitted], operations: [] });
      expect(patch.tools).toEqual([{ operation: {
        toolName: "web_search", operationId: "search_web", contractVersion: 1,
      }, usage: "required" }]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
