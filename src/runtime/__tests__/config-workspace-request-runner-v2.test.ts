import { describe, expect, test, vi } from "vitest";

// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { createConfigFieldRendering } from "../../web-ui/app/components/config-workspace/field-rendering.js";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { createConfigStepRendering } from "../../web-ui/app/components/config-workspace/step-rendering.js";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { createConfigWorkspaceView } from "../../web-ui/app/components/config-workspace/workspace-view.js";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { createConfigWorkspaceModel } from "../../web-ui/app/components/config-workspace/config-model.js";

function valueAtPath(config: Record<string, any>, path: string[]) {
  return path.reduce((value, key) => value?.[key], config);
}

describe("Config Workspace request-runner v2", () => {
  test("offers raw targets, model profiles, invocation profiles, and calibration slots", () => {
    const state = {
      configDashboard: {
        files: {
          runtime: {
            config: {
              models: {
                profiles: { default: {}, secondary: {} },
                invocationProfiles: { "fast-json": {} },
              },
            },
          },
          requestRunner: {
            config: {
              models: {
                defaults: {
                  steps: {
                    "supervisor.response": "default",
                    "tool_payload.raw": "toolPayload.raw",
                  },
                },
              },
            },
          },
          models: [
            {
              config: {
                calibration: {
                  "supervisor.decision": {},
                  "toolPayload.raw": {},
                },
              },
            },
          ],
        },
      },
      selectedConfigModelId: "",
      savedKeys: new Set(),
      savingKeys: new Set(),
    };
    const rendering = createConfigFieldRendering({
      state,
      configFileKey: () => "requestRunner:requestRunner",
      getConfigPathValue: valueAtPath,
      hasPendingFileChanges: () => false,
      hasRawDraftChanges: () => false,
      isFileDirty: () => false,
    });

    const targets = rendering.configStepTargetOptions();

    expect(targets).toEqual([...new Set(targets)]);
    expect(targets).toEqual(
      expect.arrayContaining([
        "default",
        "secondary",
        "fast-json",
        "supervisor.decision",
        "toolPayload.raw",
      ]),
    );
  });

  test("presents v2 entries as removable routing overrides", () => {
    const file = {
      kind: "requestRunner",
      id: "requestRunner",
      path: "local/request-runner.config.json",
      config: {
        schemaVersion: 2,
        models: {
          defaults: {
            steps: { "supervisor.response": "default" },
          },
        },
      },
    };
    const rendering = createConfigStepRendering({
      calibrationProfileDescription: () => "",
      calibrationProfileLabel: (value: string) => value,
      configStepTargetOptions: () => ["default", "supervisor.response"],
      configStepOptions: () => ["supervisor.decision", "supervisor.response"],
      getConfigPathValue: valueAtPath,
      renderFileActions: () => "",
      renderSelectOptions: (values: string[]) => values.join("|"),
    });

    const html = rendering.renderStepsEditor(
      file,
      "Request pipeline",
      ["models", "defaults", "steps"],
      { sparseOverrides: true },
    );

    expect(html).toContain("<h3>Routing overrides</h3>");
    expect(html).toContain("1 override");
    expect(html).toContain("Unmapped steps use their own model step id.");
    expect(html).toContain('aria-label="Remove supervisor.response override"');
    expect(html).toContain('data-config-action="delete-path"');
    expect(html).toContain("Override target");
    expect(html).toContain("Add override");

    const legacyHtml = rendering.renderStepsEditor(
      { ...file, config: { models: file.config.models } },
      "Request pipeline",
      ["models", "defaults", "steps"],
    );
    expect(legacyHtml).toContain("Mapping target");
    expect(legacyHtml).not.toContain('data-config-action="delete-path"');
  });

  test("edits only the sparse override map", () => {
    const workspaceModel = createConfigWorkspaceModel();
    const config = {
      schemaVersion: 2,
      models: {
        defaults: {
          profileId: "default",
          steps: { "tool_payload.raw": "toolPayload.raw" },
        },
      },
      context: { outputReserveTokens: 1, safetyReserveTokens: 1 },
      stepDefaults: { timeoutMs: 90_000 },
      steps: { "supervisor.response": { instructionRefs: ["./ux.md"] } },
    };

    workspaceModel.setConfigPathValue(
      config,
      ["models", "defaults", "steps", "supervisor.decision"],
      "fast-json",
    );
    workspaceModel.deleteConfigPathValue(config, [
      "models",
      "defaults",
      "steps",
      "tool_payload.raw",
    ]);

    expect(config).toEqual({
      schemaVersion: 2,
      models: {
        defaults: {
          profileId: "default",
          steps: { "supervisor.decision": "fast-json" },
        },
      },
      context: { outputReserveTokens: 1, safetyReserveTokens: 1 },
      stepDefaults: { timeoutMs: 90_000 },
      steps: { "supervisor.response": { instructionRefs: ["./ux.md"] } },
    });
  });

  test("shows registered step and override counts independently", () => {
    const runtime = {
      exists: true,
      kind: "runtime",
      id: "runtime",
      config: {},
    };
    const requestRunner = {
      exists: true,
      kind: "requestRunner",
      id: "requestRunner",
      path: "local/request-runner.config.json",
      config: {
        schemaVersion: 2,
        models: {
          defaults: { steps: { "tool_payload.raw": "toolPayload.raw" } },
        },
      },
    };
    const state = {
      activeCategory: "pipeline",
      configDashboard: {
        modelSteps: [
          "supervisor.decision",
          "supervisor.response",
          "tool_payload.raw",
        ],
        files: { runtime, requestRunner, models: [] },
      },
      selectedConfigModelId: "",
      savedKeys: new Set(),
      savingKeys: new Set(),
    };
    const configDashboard = {
      inert: false,
      innerHTML: "",
      querySelector: () => null,
      querySelectorAll: () => [],
      setAttribute: vi.fn(),
    };
    const renderStepsEditor = vi.fn(() => "<section>overrides</section>");
    const view = createConfigWorkspaceView({
      state,
      dom: {
        configDashboard,
        configStatus: { className: "", textContent: "" },
        refreshConfigButton: { disabled: false },
      },
      eventTarget: { document: { activeElement: null } },
      memorySetup: { mount: vi.fn() },
      memoryManagement: { mount: vi.fn() },
      configFileEntries: () => [runtime, requestRunner],
      configFileKey: (file: { kind: string; id: string }) =>
        `${file.kind}:${file.id}`,
      countObjectKeys: (value: unknown) =>
        value && typeof value === "object" ? Object.keys(value).length : 0,
      dashboardIsBusy: () => false,
      dirtyFiles: () => [],
      ensureRawSelection: () => {},
      fileStatusText: () => "Clean",
      hasPendingFileChanges: () => false,
      hasRawDraftChanges: () => false,
      isFileDirty: () => false,
      rawDraftFor: () => "",
      renderCategoryPanel: (_category: string, content: string) => content,
      renderCategoryTab: () => "",
      renderConfigMap: () => "",
      renderModelList: () => "",
      renderSelectedModelEditor: () => "",
      renderStepsEditor,
      selectedRawConfigFile: () => null,
    });

    view.renderConfigDashboard();

    expect(configDashboard.innerHTML).toContain(
      "data-config-registered-step-count>3 registered",
    );
    expect(configDashboard.innerHTML).toContain(
      "data-config-step-target-count>1 override",
    );
    expect(renderStepsEditor).toHaveBeenCalledWith(
      requestRunner,
      "Request pipeline",
      ["models", "defaults", "steps"],
      { sparseOverrides: true },
    );
  });
});
