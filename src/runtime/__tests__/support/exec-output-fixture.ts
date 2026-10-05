import { join } from "node:path";
import { readFile, readdir } from "node:fs/promises";
import { createExecHandlers } from "../../../../plugins/exec/source/handlers.js";
import { readExecSettings } from "../../../../plugins/exec/source/settings.js";
import { RequestToolResources } from "../../capabilities/request-tool-resources.js";
import { createRegisteredToolResultBudget } from "../../adapters/registered-tool-normal-invocations/execution/result-budget.js";
import { createExecCommandPathFixture } from "./exec-command-path-fixture.js";
import { disposeCompositionFixtures } from "./runtime-composition-fixture.js";

const requests: RequestToolResources[] = [];
export async function disposeExecOutputFixtures() {
  for (const resources of requests.splice(0)) await resources.dispose();
  await disposeCompositionFixtures();
}

export async function createExecOutputFixture(
  overrides: Readonly<Record<string, unknown>> = {},
) {
  const fixture = await createExecCommandPathFixture();
  const settings = readExecSettings({
    timeoutMs: 5000,
    yieldAfterMs: 5000,
    idleTimeoutMs: 5000,
    ...overrides,
  });
  function createRequest(saved?: ReturnType<RequestToolResources["snapshot"]>) {
    const resources = new RequestToolResources();
    requests.push(resources);
    if (saved) resources.restore(saved);
    const handlers = createExecHandlers(fixture.context, settings, {
      requestState: resources.state,
    });
    resources.assertRestoredStateClaimed();
    const executionContext = {
      sharedState: { currentSessionId: "output-fixture-session" },
      requestWork: resources.work,
    };
    function admittedContext(tool: string, params: Record<string, unknown>) {
      return {
        ...executionContext,
        resultBudget: createRegisteredToolResultBudget({
          call: { tool, params },
          definition: fixture.registry.getDefinition(tool)!,
        }),
      };
    }
    return { resources, handlers, executionContext, admittedContext };
  }
  return { ...fixture, settings, createRequest };
}

export async function readSingleOutputOwner(stateDir: string) {
  const root = join(stateDir, "output");
  const directories = await readdir(root);
  if (directories.length !== 1) throw new Error("expected one output owner");
  const directory = join(root, directories[0]!);
  const path = join(directory, "owner.json");
  return { directory, path, record: JSON.parse(await readFile(path, "utf8")) };
}
