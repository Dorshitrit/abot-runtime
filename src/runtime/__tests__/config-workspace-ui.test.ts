import { describe, expect, test, vi } from "vitest";

// prettier-ignore
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { configValuesEqual, createConfigWorkspace, executionPolicyValueForConfig, modelContextWindowValidationError, rawConfigDraftHasChanges, resolveModelExecutionRoute, runtimeConfigGraphChanged } from "../../web-ui/app/components/config-workspace.js";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { createWorkspaceShell } from "../../web-ui/app/components/workspace-shell.js";

function fakeElement() {
  const classes = new Set<string>();
  const attributes = new Map<string, string>();
  return {
    hidden: false,
    inert: false,
    tabIndex: 0,
    dataset: {} as Record<string, string>,
    classList: {
      toggle(name: string, active: boolean) {
        if (active) classes.add(name);
        else classes.delete(name);
      },
      contains(name: string) {
        return classes.has(name);
      },
    },
    setAttribute(name: string, value: string) {
      attributes.set(name, value);
    },
    removeAttribute(name: string) {
      attributes.delete(name);
    },
    getAttribute(name: string) {
      return attributes.get(name) ?? null;
    },
    addEventListener() {},
    focus() {},
  };
}

function fakeShellDom() {
  return {
    app: fakeElement(),
    chatPanel: fakeElement(),
    sessionsPanel: fakeElement(),
    operationsWorkspacePanel: fakeElement(),
    configWorkspacePanel: fakeElement(),
    chatWorkspaceButton: fakeElement(),
    operationsWorkspaceButton: fakeElement(),
    configWorkspaceButton: fakeElement(),
    sessionsToggleButton: fakeElement(),
    closeSessionsButton: fakeElement(),
    closeOperationsWorkspaceButton: fakeElement(),
    closeConfigWorkspaceButton: fakeElement(),
    newSessionButton: fakeElement(),
    panelBackdrop: fakeElement(),
    toastRegion: fakeElement(),
    operationsTabButtons: [],
    operationsTabPages: [],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function fakeInteractiveElement() {
  const listeners = new Map<string, Array<(event: unknown) => void>>();
  const attributes = new Map<string, string>();
  return {
    className: "",
    disabled: false,
    inert: false,
    innerHTML: "",
    textContent: "",
    addEventListener(type: string, listener: (event: unknown) => void) {
      listeners.set(type, [...(listeners.get(type) || []), listener]);
    },
    dispatch(type: string, event: Record<string, unknown> = {}) {
      for (const listener of listeners.get(type) || []) {
        listener({ target: this, ...event });
      }
    },
    getAttribute(name: string) {
      return attributes.get(name) ?? null;
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    setAttribute(name: string, value: string) {
      attributes.set(name, value);
    },
  };
}

function configFile(
  kind: "runtime" | "requestRunner" | "model",
  id: string,
  path: string,
  config: Record<string, unknown>,
) {
  return {
    kind,
    id,
    label: id,
    path,
    exists: true,
    config: structuredClone(config),
  };
}

function configDashboardPayload(
  options: {
    runtimeConfig?: Record<string, unknown>;
    runnerConfig?: Record<string, unknown>;
    runnerPath?: string;
    models?: Array<ReturnType<typeof configFile>>;
  } = {},
) {
  return {
    dashboard: {
      files: {
        runtime: configFile(
          "runtime",
          "runtime",
          "runtime.config.json",
          options.runtimeConfig || {
            models: { profiles: {} },
            requestRunner: { configRef: "./runner.config.json" },
          },
        ),
        requestRunner: configFile(
          "requestRunner",
          "requestRunner",
          options.runnerPath || "runner.config.json",
          options.runnerConfig || { value: "A" },
        ),
        models: options.models || [],
      },
    },
  };
}

function configFieldTarget(
  kind: string,
  id: string,
  path: string[],
  value: string,
  valueType = "string",
) {
  const target = {
    dataset: {
      configAction: "field",
      kind,
      id,
      path: JSON.stringify(path),
      valueType,
    },
    value,
    closest: () => target,
    matches: () => false,
  };
  return target;
}

function configActionTarget(action: string, kind: string, id: string) {
  const target = {
    dataset: { configAction: action, kind, id },
    closest: () => target,
  };
  return target;
}

function createConfigHarness(
  options: {
    loadDashboard?: () => Promise<ReturnType<typeof configDashboardPayload>>;
    saveFile?: (input: {
      kind: string;
      id: string;
      config: Record<string, unknown>;
    }) => Promise<Record<string, unknown>>;
  } = {},
) {
  const configDashboard = fakeInteractiveElement();
  const refreshConfigButton = fakeInteractiveElement();
  const configStatus = fakeInteractiveElement();
  const loadDashboard =
    options.loadDashboard || vi.fn(async () => configDashboardPayload());
  const saveFile = options.saveFile || vi.fn(async () => ({ ok: true }));
  const recordControlEvent = vi.fn();
  const memorySetup = { load: vi.fn(async () => {}), mount: vi.fn() };
  const memoryManagement = { load: vi.fn(async () => {}), mount: vi.fn() };
  const workspace = createConfigWorkspace({
    dom: { configDashboard, configStatus, refreshConfigButton },
    loadDashboard,
    saveFile,
    memorySetup,
    memoryManagement,
    recordControlEvent,
    confirmDiscard: vi.fn(() => true),
    eventTarget: {
      addEventListener: vi.fn(),
      document: { activeElement: null },
    },
  });
  workspace.bind();
  return {
    configDashboard,
    configStatus,
    loadDashboard,
    memoryManagement,
    memorySetup,
    recordControlEvent,
    refreshConfigButton,
    saveFile,
    workspace,
  };
}

describe("config workspace ui behavior", () => {
  test("presents the two canonical model execution routes", () => {
    const supervisor = resolveModelExecutionRoute(undefined);
    const executionAgent = resolveModelExecutionRoute("execution-agent-v1");

    expect(supervisor).toMatchObject({
      policy: "supervisor-worker-v1",
      label: "Supervisor",
      implicit: true,
      supported: true,
    });
    expect(executionAgent).toMatchObject({
      policy: "execution-agent-v1",
      label: "Execution Agent",
      implicit: false,
      supported: true,
    });
    expect(supervisor.description.length).toBeGreaterThan(0);
    expect(executionAgent.description.length).toBeGreaterThan(0);
    expect(executionAgent.description).not.toBe(supervisor.description);
  });

  test("preserves an omitted Supervisor default when route edits are reverted", () => {
    expect(
      executionPolicyValueForConfig("supervisor-worker-v1", undefined),
    ).toBeUndefined();
    expect(executionPolicyValueForConfig("execution-agent-v1", undefined)).toBe(
      "execution-agent-v1",
    );
    expect(
      executionPolicyValueForConfig(
        "supervisor-worker-v1",
        "supervisor-worker-v1",
      ),
    ).toBe("supervisor-worker-v1");
  });

  test("compares config baselines by content rather than object key order", () => {
    const baseline = {
      models: { default: "local", enabled: true },
      ports: [3000, 3001],
    };

    expect(
      configValuesEqual(
        { ports: [3000, 3001], models: { enabled: true, default: "local" } },
        baseline,
      ),
    ).toBe(true);
    expect(
      configValuesEqual(
        { ports: [3000, 3002], models: { enabled: true, default: "local" } },
        baseline,
      ),
    ).toBe(false);
  });

  test("tracks semantic and invalid raw drafts without treating formatting as a change", () => {
    const config = { enabled: true, nested: { value: 2 } };

    expect(
      rawConfigDraftHasChanges(
        '{\n  "nested": { "value": 2 },\n  "enabled": true\n}',
        config,
      ),
    ).toBe(false);
    expect(
      rawConfigDraftHasChanges(
        '{"enabled": false, "nested": {"value": 2}}',
        config,
      ),
    ).toBe(true);
    expect(rawConfigDraftHasChanges("{invalid", config)).toBe(true);
    expect(rawConfigDraftHasChanges("[]", config)).toBe(true);
  });

  test("detects changes to the runtime-owned config graph", () => {
    const baseline = {
      models: { profiles: { local: { configRef: "./old-model.json" } } },
      requestRunner: { configRef: "./old-runner.json" },
      features: { diagnostics: false },
    };

    expect(
      runtimeConfigGraphChanged(baseline, {
        ...baseline,
        features: { diagnostics: true },
      }),
    ).toBe(false);
    expect(
      runtimeConfigGraphChanged(baseline, {
        ...baseline,
        requestRunner: { configRef: "./new-runner.json" },
      }),
    ).toBe(true);
    expect(
      runtimeConfigGraphChanged(baseline, {
        ...baseline,
        models: { profiles: { local: { configRef: "./new-model.json" } } },
      }),
    ).toBe(true);
  });

  test("matches the Runtime positive-integer contract for model context windows", () => {
    expect(modelContextWindowValidationError({})).toBe("");
    expect(
      modelContextWindowValidationError({ contextWindowTokens: 32_768 }),
    ).toBe("");
    expect(
      modelContextWindowValidationError({ contextWindowTokens: 0 }),
    ).toContain("positive integer");
    expect(
      modelContextWindowValidationError({ contextWindowTokens: -1 }),
    ).toContain("positive integer");
    expect(
      modelContextWindowValidationError({ contextWindowTokens: 1.5 }),
    ).toContain("positive integer");
    expect(
      modelContextWindowValidationError({
        contextWindowTokens: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).toContain("safe numeric range");
  });

  test.each(["0", "-1", "1.5", "9007199254740992"])(
    "blocks invalid model context window %s before persistence",
    async (contextWindowTokens) => {
      const saveFile = vi.fn(async () => ({ ok: true }));
      const model = configFile("model", "local", "models/local.config.json", {
        provider: "ollama",
        model: "local-model",
        contextWindowTokens: 32_768,
      });
      const harness = createConfigHarness({
        loadDashboard: vi.fn(async () =>
          configDashboardPayload({ models: [model] }),
        ),
        saveFile,
      });
      await harness.workspace.load();

      harness.configDashboard.dispatch("input", {
        target: configFieldTarget(
          "model",
          "local",
          ["contextWindowTokens"],
          contextWindowTokens,
          "number",
        ),
      });
      harness.configDashboard.dispatch("click", {
        target: configActionTarget("save-file", "model", "local"),
      });

      expect(saveFile).not.toHaveBeenCalled();
      expect(harness.workspace.hasUnsavedChanges()).toBe(true);
      expect(harness.configStatus.textContent).toContain("positive integer");
    },
  );

  test("persists a valid model context window as a number", async () => {
    const saveFile = vi.fn(
      async (_input: {
        kind: string;
        id: string;
        config: Record<string, unknown>;
      }) => ({ ok: true }),
    );
    const model = configFile("model", "local", "models/local.config.json", {
      provider: "ollama",
      model: "local-model",
      contextWindowTokens: 32_768,
    });
    const harness = createConfigHarness({
      loadDashboard: vi.fn(async () =>
        configDashboardPayload({ models: [model] }),
      ),
      saveFile,
    });
    await harness.workspace.load();
    expect(harness.configDashboard.innerHTML).toContain('min="1"');
    expect(harness.configDashboard.innerHTML).toContain('step="1"');

    harness.configDashboard.dispatch("input", {
      target: configFieldTarget(
        "model",
        "local",
        ["contextWindowTokens"],
        "64000",
        "number",
      ),
    });
    harness.configDashboard.dispatch("click", {
      target: configActionTarget("save-file", "model", "local"),
    });

    await vi.waitFor(() => expect(saveFile).toHaveBeenCalledOnce());
    expect(saveFile.mock.calls[0]?.[0]).toMatchObject({
      kind: "model",
      id: "local",
      config: { contextWindowTokens: 64_000 },
    });
  });

  test("preserves an object-valued calibration format through structured edits", async () => {
    const customFormat = {
      type: "object",
      properties: {
        result: { type: "string" },
      },
      required: ["result"],
    };
    const saveFile = vi.fn(
      async (_input: {
        kind: string;
        id: string;
        config: Record<string, unknown>;
      }) => ({ ok: true }),
    );
    const model = configFile("model", "local", "models/local.config.json", {
      label: "Local model",
      provider: "ollama",
      model: "local-model",
      calibration: {
        response: {
          name: "Response",
          description: "Structured response",
          format: customFormat,
        },
      },
    });
    const harness = createConfigHarness({
      loadDashboard: vi.fn(async () =>
        configDashboardPayload({ models: [model] }),
      ),
      saveFile,
    });
    await harness.workspace.load();

    expect(harness.configDashboard.innerHTML).toContain(
      "data-config-custom-format",
    );
    expect(harness.configDashboard.innerHTML).toContain("Custom JSON schema");
    expect(harness.configDashboard.innerHTML).toContain("Edit in Raw JSON.");

    harness.configDashboard.dispatch("input", {
      target: configFieldTarget("model", "local", ["label"], "Renamed model"),
    });
    harness.configDashboard.dispatch("click", {
      target: configActionTarget("save-file", "model", "local"),
    });

    await vi.waitFor(() => expect(saveFile).toHaveBeenCalledOnce());
    expect(saveFile.mock.calls[0]?.[0]).toMatchObject({
      config: {
        calibration: { response: { format: customFormat } },
      },
    });
  });

  test("makes the stale dashboard inert for the full configuration load", async () => {
    const pending = deferred<ReturnType<typeof configDashboardPayload>>();
    const harness = createConfigHarness({
      loadDashboard: vi.fn(() => pending.promise),
    });

    const load = harness.workspace.load();

    expect(harness.configDashboard.inert).toBe(true);
    expect(harness.configDashboard.getAttribute("aria-busy")).toBe("true");
    expect(harness.refreshConfigButton.disabled).toBe(true);

    pending.resolve(configDashboardPayload());
    await expect(load).resolves.toBe(true);
    expect(harness.configDashboard.inert).toBe(false);
    expect(harness.configDashboard.getAttribute("aria-busy")).toBe("false");
    expect(harness.refreshConfigButton.disabled).toBe(false);
  });

  test("unlocks refresh while keeping the dashboard empty after an initial load failure", async () => {
    const pending = deferred<ReturnType<typeof configDashboardPayload>>();
    const harness = createConfigHarness({
      loadDashboard: vi.fn(() => pending.promise),
    });

    const load = harness.workspace.load();
    pending.reject(new Error("dashboard unavailable"));

    await expect(load).resolves.toBe(false);
    expect(harness.configDashboard.inert).toBe(false);
    expect(harness.configDashboard.innerHTML).toBe("");
    expect(harness.refreshConfigButton.disabled).toBe(false);
    expect(harness.configStatus.textContent).toBe("dashboard unavailable");
  });

  test("does not reactivate the previous environment after a transition load fails", async () => {
    const loadDashboard = vi
      .fn()
      .mockResolvedValueOnce(configDashboardPayload())
      .mockRejectedValueOnce(new Error("new environment unavailable"));
    const harness = createConfigHarness({ loadDashboard });
    await harness.workspace.load();
    expect(harness.configDashboard.innerHTML).not.toBe("");

    await expect(
      harness.workspace.load({
        protectUnsaved: false,
        clearBeforeLoad: true,
      }),
    ).resolves.toBe(false);

    expect(harness.configDashboard.innerHTML).toBe("");
    expect(harness.configDashboard.inert).toBe(false);
    expect(harness.configStatus.textContent).toBe(
      "new environment unavailable",
    );
  });

  test("keeps only the newest dashboard when environment loads resolve out of order", async () => {
    const oldEnvironment =
      deferred<ReturnType<typeof configDashboardPayload>>();
    const newEnvironment =
      deferred<ReturnType<typeof configDashboardPayload>>();
    const loadDashboard = vi
      .fn()
      .mockReturnValueOnce(oldEnvironment.promise)
      .mockReturnValueOnce(newEnvironment.promise);
    const harness = createConfigHarness({ loadDashboard });

    const oldLoad = harness.workspace.load({ protectUnsaved: false });
    const newLoad = harness.workspace.load({
      protectUnsaved: false,
      clearBeforeLoad: true,
    });
    newEnvironment.resolve(
      configDashboardPayload({ runnerPath: "new-environment-runner.json" }),
    );

    await expect(newLoad).resolves.toBe(true);
    expect(harness.configDashboard.inert).toBe(false);
    expect(harness.configDashboard.innerHTML).toContain(
      "new-environment-runner.json",
    );

    oldEnvironment.resolve(
      configDashboardPayload({ runnerPath: "old-environment-runner.json" }),
    );
    await expect(oldLoad).resolves.toBe(false);
    expect(harness.configDashboard.innerHTML).toContain(
      "new-environment-runner.json",
    );
    expect(harness.configDashboard.innerHTML).not.toContain(
      "old-environment-runner.json",
    );
  });

  test("keeps edits made while a save is in flight dirty", async () => {
    const pendingSave = deferred<Record<string, unknown>>();
    const submitted: Array<Record<string, unknown>> = [];
    const saveFile = vi.fn((input: Record<string, unknown>) => {
      submitted.push(structuredClone(input));
      return pendingSave.promise;
    });
    const harness = createConfigHarness({ saveFile });
    await harness.workspace.load();

    harness.configDashboard.dispatch("input", {
      target: configFieldTarget(
        "requestRunner",
        "requestRunner",
        ["value"],
        "B",
      ),
    });
    harness.configDashboard.dispatch("click", {
      target: configActionTarget("save-file", "requestRunner", "requestRunner"),
    });
    await vi.waitFor(() => expect(saveFile).toHaveBeenCalledOnce());

    harness.configDashboard.dispatch("input", {
      target: configFieldTarget(
        "requestRunner",
        "requestRunner",
        ["value"],
        "C",
      ),
    });
    pendingSave.resolve({ ok: true });

    await vi.waitFor(() =>
      expect(harness.recordControlEvent).toHaveBeenCalledWith(
        expect.objectContaining({ name: "Config saved" }),
      ),
    );
    expect(harness.workspace.hasUnsavedChanges()).toBe(true);
    expect(submitted[0]).toMatchObject({ config: { value: "B" } });
  });

  test("holds an external Runtime mutation lock through its canonical refresh", async () => {
    const refreshedDashboard =
      deferred<ReturnType<typeof configDashboardPayload>>();
    const loadDashboard = vi
      .fn()
      .mockResolvedValueOnce(configDashboardPayload())
      .mockReturnValueOnce(refreshedDashboard.promise);
    const harness = createConfigHarness({ loadDashboard });
    await harness.workspace.load();

    harness.configDashboard.dispatch("input", {
      target: configFieldTarget(
        "requestRunner",
        "requestRunner",
        ["value"],
        "dirty",
      ),
    });
    expect(harness.workspace.beginExternalRuntimeMutation()).toBe(false);
    expect(harness.configStatus.textContent).toContain("Save or reset");
    expect(harness.configDashboard.inert).toBe(false);

    harness.configDashboard.dispatch("click", {
      target: configActionTarget(
        "reset-file",
        "requestRunner",
        "requestRunner",
      ),
    });
    expect(harness.workspace.beginExternalRuntimeMutation()).toBe(true);
    expect(harness.configDashboard.inert).toBe(true);
    expect(harness.workspace.prepareDiscardChanges("change environment")).toBe(
      null,
    );

    const refresh = harness.workspace.refreshAfterExternalRuntimeMutation();
    expect(harness.configDashboard.innerHTML).toBe("");
    refreshedDashboard.resolve(
      configDashboardPayload({ runnerPath: "memory-updated-runner.json" }),
    );
    await expect(refresh).resolves.toBe(true);
    expect(harness.memorySetup.load).toHaveBeenCalledOnce();
    expect(harness.memoryManagement.load).toHaveBeenCalledTimes(2);
    expect(harness.configDashboard.inert).toBe(true);
    expect(harness.configDashboard.innerHTML).toContain(
      "memory-updated-runner.json",
    );

    harness.workspace.endExternalRuntimeMutation();
    expect(harness.configDashboard.inert).toBe(false);
    expect(harness.refreshConfigButton.disabled).toBe(false);
  });

  test("preserves a raw draft written while a structured save is in flight", async () => {
    const pendingSave = deferred<Record<string, unknown>>();
    const harness = createConfigHarness({
      saveFile: vi.fn(() => pendingSave.promise),
    });
    await harness.workspace.load();
    harness.configDashboard.dispatch("change", {
      target: {
        id: "configRawFileSelect",
        value: "requestRunner:requestRunner",
      },
    });
    harness.configDashboard.dispatch("input", {
      target: configFieldTarget(
        "requestRunner",
        "requestRunner",
        ["value"],
        "B",
      ),
    });
    harness.configDashboard.dispatch("click", {
      target: configActionTarget("save-file", "requestRunner", "requestRunner"),
    });
    harness.configDashboard.dispatch("input", {
      target: {
        id: "configRawEditor",
        value: '{"value":"new raw draft"}',
        closest: () => null,
      },
    });

    pendingSave.resolve({ ok: true });

    await vi.waitFor(() =>
      expect(harness.recordControlEvent).toHaveBeenCalledWith(
        expect.objectContaining({ name: "Config saved" }),
      ),
    );
    expect(harness.workspace.hasUnsavedChanges()).toBe(true);
  });

  test("blocks a graph-changing Runtime save while linked edits are pending", async () => {
    const saveFile = vi.fn(async () => ({ ok: true }));
    const harness = createConfigHarness({ saveFile });
    await harness.workspace.load();

    harness.configDashboard.dispatch("input", {
      target: configFieldTarget(
        "requestRunner",
        "requestRunner",
        ["value"],
        "linked edit",
      ),
    });
    harness.configDashboard.dispatch("input", {
      target: configFieldTarget(
        "runtime",
        "runtime",
        ["requestRunner", "configRef"],
        "./new-runner.json",
      ),
    });
    harness.configDashboard.dispatch("click", {
      target: configActionTarget("save-file", "runtime", "runtime"),
    });

    expect(saveFile).not.toHaveBeenCalled();
    expect(harness.workspace.hasUnsavedChanges()).toBe(true);
    expect(harness.configStatus.textContent).toContain(
      "Save or reset linked config changes",
    );
  });

  test("blocks a canonical inline-model save while its raw draft is unapplied", async () => {
    const inlineModel = {
      ...configFile("model", "local", "runtime.config.json", {
        provider: "ollama",
      }),
      source: {
        type: "inlineModelProfile",
        profileId: "local",
        runtimeConfigPath: "runtime.config.json",
      },
    };
    const saveFile = vi.fn(async () => ({ ok: true }));
    const harness = createConfigHarness({
      loadDashboard: vi.fn(async () =>
        configDashboardPayload({ models: [inlineModel] }),
      ),
      saveFile,
    });
    await harness.workspace.load();
    harness.configDashboard.dispatch("input", {
      target: configFieldTarget("model", "local", ["provider"], "openai"),
    });
    harness.configDashboard.dispatch("change", {
      target: {
        id: "configRawFileSelect",
        value: "model:local",
      },
    });
    harness.configDashboard.dispatch("input", {
      target: {
        id: "configRawEditor",
        value: '{"provider":"unapplied"}',
        closest: () => null,
      },
    });

    harness.configDashboard.dispatch("click", {
      target: configActionTarget("save-file", "model", "local"),
    });

    expect(saveFile).not.toHaveBeenCalled();
    expect(harness.workspace.hasUnsavedChanges()).toBe(true);
    expect(harness.configStatus.textContent).toContain(
      "Apply or reset the current raw draft",
    );
  });

  test("refreshes linked descriptors after a graph-changing Runtime save", async () => {
    const oldDashboard = configDashboardPayload();
    const newDashboard = configDashboardPayload({
      runnerPath: "new-runner.json",
      runtimeConfig: {
        models: { profiles: {} },
        requestRunner: { configRef: "./new-runner.json" },
      },
    });
    const pendingSave = deferred<Record<string, unknown>>();
    const loadDashboard = vi
      .fn()
      .mockResolvedValueOnce(oldDashboard)
      .mockResolvedValueOnce(newDashboard);
    const harness = createConfigHarness({
      loadDashboard,
      saveFile: vi.fn(() => pendingSave.promise),
    });
    await harness.workspace.load();

    harness.configDashboard.dispatch("input", {
      target: configFieldTarget(
        "runtime",
        "runtime",
        ["requestRunner", "configRef"],
        "./new-runner.json",
      ),
    });
    harness.configDashboard.dispatch("click", {
      target: configActionTarget("save-file", "runtime", "runtime"),
    });
    expect(harness.configDashboard.inert).toBe(true);

    pendingSave.resolve({ ok: true });
    await vi.waitFor(() => expect(loadDashboard).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(harness.configDashboard.inert).toBe(false));

    expect(harness.configDashboard.innerHTML).toContain("new-runner.json");
    expect(harness.workspace.hasUnsavedChanges()).toBe(false);
  });

  test("refreshes Runtime-owned descriptors after saving an inline model", async () => {
    const inlineModel = {
      ...configFile("model", "local", "runtime.config.json", {
        provider: "ollama",
      }),
      source: {
        type: "inlineModelProfile",
        profileId: "local",
        runtimeConfigPath: "runtime.config.json",
      },
    };
    const loadDashboard = vi
      .fn()
      .mockResolvedValueOnce(configDashboardPayload({ models: [inlineModel] }))
      .mockResolvedValueOnce(
        configDashboardPayload({
          models: [
            configFile("model", "local", "models/local.config.json", {
              provider: "ollama",
            }),
          ],
        }),
      );
    const harness = createConfigHarness({ loadDashboard });
    await harness.workspace.load();
    harness.configDashboard.dispatch("input", {
      target: configFieldTarget(
        "model",
        "local",
        ["configRef"],
        "./models/local.config.json",
      ),
    });

    harness.configDashboard.dispatch("click", {
      target: configActionTarget("save-file", "model", "local"),
    });

    await vi.waitFor(() => expect(loadDashboard).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(harness.configDashboard.inert).toBe(false));
    expect(harness.configDashboard.innerHTML).toContain(
      "models/local.config.json",
    );
    expect(harness.workspace.hasUnsavedChanges()).toBe(false);
  });

  test("fails closed when linked descriptors cannot refresh after Runtime is saved", async () => {
    const loadDashboard = vi
      .fn()
      .mockResolvedValueOnce(configDashboardPayload())
      .mockRejectedValueOnce(new Error("new runner missing"));
    const harness = createConfigHarness({ loadDashboard });
    await harness.workspace.load();
    harness.configDashboard.dispatch("input", {
      target: configFieldTarget(
        "runtime",
        "runtime",
        ["requestRunner", "configRef"],
        "./new-runner.json",
      ),
    });

    harness.configDashboard.dispatch("click", {
      target: configActionTarget("save-file", "runtime", "runtime"),
    });

    await vi.waitFor(() => expect(loadDashboard).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(harness.configStatus.textContent).toContain(
        "Runtime saved; refresh required",
      ),
    );
    expect(harness.configDashboard.innerHTML).toBe("");
    expect(harness.configDashboard.inert).toBe(false);
    expect(harness.refreshConfigButton.disabled).toBe(false);
  });

  test("keeps the config canvas active when leaving is declined", () => {
    const dom = fakeShellDom();
    let allowLeave = false;
    const shell = createWorkspaceShell({
      dom: dom as never,
      viewport: {
        requestAnimationFrame(callback: () => void) {
          callback();
        },
        clearTimeout() {},
        setTimeout() {
          return 0;
        },
      } as never,
      documentRoot: { activeElement: null } as never,
      beforeWorkspaceChange: ({ from, to }: { from: string; to: string }) =>
        from !== "config" || to === "config" || allowLeave,
    });

    shell.load();
    expect(shell.activateWorkspace("config", { focus: false })).toBe(true);
    expect(shell.activateWorkspace("chat", { focus: false })).toBe(false);
    expect(dom.configWorkspacePanel.hidden).toBe(false);
    expect(dom.chatPanel.hidden).toBe(true);

    allowLeave = true;
    expect(shell.activateWorkspace("chat", { focus: false })).toBe(true);
    expect(dom.configWorkspacePanel.hidden).toBe(true);
    expect(dom.chatPanel.hidden).toBe(false);
  });

  test("defers a prepared workspace change until its activation is committed", () => {
    const dom = fakeShellDom();
    const discardPreparedChanges = vi.fn();
    const shell = createWorkspaceShell({
      dom: dom as never,
      viewport: {
        requestAnimationFrame(callback: () => void) {
          callback();
        },
        clearTimeout() {},
        setTimeout() {
          return 0;
        },
      } as never,
      documentRoot: { activeElement: null } as never,
      beforeWorkspaceChange: ({ from, to }: { from: string; to: string }) =>
        from === "config" && to === "chat" ? discardPreparedChanges : true,
    });

    shell.load();
    expect(shell.activateWorkspace("config", { focus: false })).toBe(true);
    const activateChat = shell.prepareWorkspaceActivation("chat", {
      focus: false,
    });

    expect(activateChat).toBeTypeOf("function");
    expect(discardPreparedChanges).not.toHaveBeenCalled();
    expect(dom.configWorkspacePanel.hidden).toBe(false);
    expect(dom.chatPanel.hidden).toBe(true);

    expect(activateChat?.()).toBe(true);
    expect(discardPreparedChanges).toHaveBeenCalledOnce();
    expect(dom.configWorkspacePanel.hidden).toBe(true);
    expect(dom.chatPanel.hidden).toBe(false);

    expect(activateChat?.()).toBe(true);
    expect(discardPreparedChanges).toHaveBeenCalledOnce();
  });
});
