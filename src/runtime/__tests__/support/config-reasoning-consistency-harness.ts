import { vi } from "vitest";
// @ts-expect-error Browser presentation module has no declaration surface.
import { createConfigWorkspaceModel } from "../../../web-ui/app/components/config-workspace/config-model.js";
// @ts-expect-error Browser presentation module has no declaration surface.
import { createConfigWorkspaceEvents } from "../../../web-ui/app/components/config-workspace/workspace-events.js";
// @ts-expect-error Browser presentation module has no declaration surface.
import { createConfigFieldRendering } from "../../../web-ui/app/components/config-workspace/field-rendering.js";
// @ts-expect-error Browser presentation module has no declaration surface.
import { createConfigModelRendering } from "../../../web-ui/app/components/config-workspace/model-rendering.js";
import { resolveModelInvocation } from "../../../model-gateway/policy/invocation-policy.js";
import type { ModelGatewayPolicyConfig } from "../../../model-gateway/types.js";

export function configReasoningHarness(
  options: {
    provider?: string;
    effort?: string;
    budget?: unknown;
    calibration?: Record<string, any>;
    targetEffort?: string;
  } = {},
) {
  const model = createConfigWorkspaceModel();
  const file = {
    kind: "model",
    id: "local",
    registered: true,
    path: "local.json",
    config: {
      provider: "local-provider",
      model: "local",
      contextWindowTokens: 32768,
      supportsThinking: true,
      generation: {
        ...(options.effort === undefined
          ? {}
          : { reasoningEffort: options.effort }),
        ...(options.budget === undefined
          ? {}
          : { reasoningBudget: options.budget }),
      } as Record<string, any>,
      calibration: options.calibration ?? {},
    },
  };
  const target = {
    ...file,
    id: "target",
    config: {
      ...file.config,
      model: "target",
      generation: options.targetEffort
        ? { reasoningEffort: options.targetEffort }
        : {},
      calibration: {},
    },
  };
  const providers = {
    "local-provider": { type: options.provider || "llamacpp" },
  };
  model.state.configDashboard = {
    files: {
      models: [file, target],
      runtime: { config: { models: { providers } } },
    },
  };
  const fields = createConfigFieldRendering({ ...model, state: model.state });
  const rendering = createConfigModelRendering({
    ...model,
    ...fields,
    state: model.state,
  });
  const render = () =>
    rendering.renderSelectedModelEditor([file, target]) as string;
  const renderConfigDashboard = vi.fn(render);
  const listeners = new Map<string, Array<(event: unknown) => void>>();
  const controls: Array<{
    dataset: Record<string, string>;
    value: string;
    textContent: string;
  }> = [];
  const root = {
    addEventListener: (type: string, callback: (event: unknown) => void) =>
      listeners.set(type, [...(listeners.get(type) || []), callback]),
    querySelectorAll: () => controls,
  };
  const events = createConfigWorkspaceEvents({
    ...model,
    state: model.state,
    eventTarget: {},
    dom: {
      configDashboard: root,
      refreshConfigButton: { addEventListener: () => undefined },
    },
    mutateConfigFile: (
      _kind: string,
      _id: string,
      mutate: (config: typeof file.config) => void,
    ) => mutate(file.config),
    renderConfigDashboard,
  });
  events.bind();
  function field(path: string[], value: string, valueType = "select") {
    const isSelect = valueType !== "number";
    const element = {
      dataset: {
        configAction: "field",
        kind: "model",
        id: "local",
        path: JSON.stringify(path),
        valueType,
      },
      value,
      matches: () => isSelect,
      closest: () => element,
    };
    for (const listener of listeners.get(isSelect ? "change" : "input") || [])
      listener({ target: element });
  }
  function policy(): ModelGatewayPolicyConfig {
    return JSON.parse(
      JSON.stringify({
        providers,
        profiles: { local: file.config, target: target.config },
        defaults: {
          profileId: "local",
          steps: { "supervisor.response": "response" },
        },
      }),
    );
  }
  return {
    file,
    target,
    field,
    render,
    renderConfigDashboard,
    controls,
    policy,
    resolve: (calibrated = false) =>
      resolveModelInvocation({
        modelPolicy: policy(),
        agentMode: "fast",
        ...(calibrated ? { modelStep: "supervisor.response" } : {}),
      }),
  };
}
