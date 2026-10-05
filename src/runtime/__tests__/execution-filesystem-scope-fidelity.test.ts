import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { successResult } from "../../plugin-sdk/index.js";
import { createConfiguredToolRegistry } from "../capabilities/configured-tool-registry.js";
import { RUNTIME_FILESYSTEM_SCOPE_KIND } from "../context/runtime-filesystem-scope.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import { runtimePluginsToToolModules } from "../plugins/loader.js";
import { loadRuntimeCapabilityPlugins } from "../plugins/runtime-capability-plugins.js";
import {
  assertFilesystemScope,
  capsules,
  decision,
  filesystemScopeFixture,
  type FilesystemModelInput,
} from "./support/filesystem-scope-integration-fixture.js";
import { selectedSystemModules } from "./support/system-request-plugin-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

test("EA 32K and 120K retain identical catalog and control schemas; SYSTEM-first cwd is runtime-scoped before file payload authoring", async () => {
  const projections: unknown[][] = [];
  for (const capacity of [32_000, 120_000]) {
    const fixture = await filesystemScopeFixture(
      "execution-agent-v1",
      capacity,
    );
    const root = fixture.config.paths.agentWorkDir;
    await mkdir(join(root, "LUNA"));
    const systemExecute = vi.fn(async () =>
      successResult({ output: "The selected OS command completed." }),
    );
    const modules = [
      ...runtimePluginsToToolModules(
        loadRuntimeCapabilityPlugins(fixture.config),
      ),
      ...selectedSystemModules(["system_command"]).map((module) => ({
        ...module,
        implementation: systemExecute,
      })),
    ];
    const registry = createConfiguredToolRegistry(fixture.config, modules);
    const body =
      "<!doctype html><title>LUNA</title><main>Stable exact content</main>\n";
    const inputs: FilesystemModelInput[] = [];
    let executionTurn = 0;
    const scripted = fixture.script(
      [
        {
          step: "execution.decision",
          output: decision({
            action: "open_capability_scope",
            catalogGroupIds: ["system"],
            acknowledgement: "I will create the requested file.",
          }),
        },
        {
          step: "execution.decision",
          output: decision({
            action: "invoke_capability",
            capabilityId: "run_system_command",
            intent: "Inspect the selected OS.",
            operationObjective:
              "Inspect the target OS without changing the runtime file root.",
            controlsEvidenceExecutionIds: [],
            workingDirectory: "LUNA",
          }),
        },
        {
          step: "capability.controls",
          output: decision({
            invocations: {
              invocation_1: {
                disposition: "execute",
                controls: {
                  target: "windows",
                  command: "Get-Location",
                  cwd: "C:/fixture-target/work",
                },
              },
            },
          }),
        },
        {
          step: "execution.decision",
          output: decision({
            action: "extend_capability_scope",
            catalogGroupIds: ["write"],
          }),
        },
        {
          step: "execution.decision",
          output: decision({
            action: "invoke_capability",
            capabilityId: "write_complete_file",
            intent: "Create the exact runtime file.",
            operationObjective: `Write exactly ${JSON.stringify(body)}.`,
            selectionControls: { path: "index.html" },
          }),
        },
        { step: "tool_payload.raw", output: body },
        { step: "execution.decision", output: decision({ action: "respond" }) },
        {
          step: "execution.response",
          output: "Created LUNA/index.html under the runtime root.",
        },
      ],
      (input) => {
        inputs.push(input);
        if (input.modelStep === "execution.decision") executionTurn += 1;
        if (input.modelStep === "execution.decision" && executionTurn === 2) {
          assertFilesystemScope(input, root, null, true);
          expect(
            capsules(input, "runtime_execution_capability_catalog_v1")[0],
          ).toMatchObject({
            capabilities: [
              expect.objectContaining({ capabilityId: "run_system_command" }),
            ],
          });
        } else if (
          (input.modelStep === "execution.decision" && executionTurn >= 4) ||
          input.modelStep === "tool_payload.raw"
        ) {
          assertFilesystemScope(input, root, "LUNA", false);
        } else {
          expect(capsules(input, RUNTIME_FILESYSTEM_SCOPE_KIND)).toEqual([]);
        }
      },
    );
    try {
      await fixture.run(scripted.model, registry);
      scripted.assertComplete();
      expect(fixture.events.filter((event) => event.type === "failed")).toEqual(
        [],
      );
      expect(systemExecute).toHaveBeenCalledExactlyOnceWith(
        {
          target: "windows",
          command: "Get-Location",
          cwd: "C:/fixture-target/work",
        },
        expect.anything(),
      );
      expect(await readFile(join(root, "LUNA", "index.html"), "utf8")).toBe(
        body,
      );
      projections.push(
        inputs
          .filter(
            (input) =>
              input.modelStep === "execution.decision" ||
              input.modelStep === "capability.controls",
          )
          .map((input) => ({
            step: input.modelStep,
            groups: capsules(
              input,
              "runtime_execution_capability_group_catalog_v1",
            ),
            capabilities: capsules(
              input,
              "runtime_execution_capability_catalog_v1",
            ),
            schema: input.format,
          })),
      );
    } finally {
      await fixture.close();
    }
  }
  expect(projections[0]).toEqual(projections[1]);
});
