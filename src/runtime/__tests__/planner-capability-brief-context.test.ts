import { afterEach, beforeEach, expect, test } from "vitest";
import type { ChatMessage } from "../../model-gateway/types.js";
import { isCapabilityBriefMessage } from "../context/capability-brief.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import { buildPlannerDecisionInput } from "../steps/planner-decision/input.js";
import { parsePlannerDecisionOutput } from "../steps/planner-decision/parser.js";
import {
  createPlannerBriefFixture,
  PLANNER_BRIEF_ENTRIES,
} from "./support/planner-capability-brief-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => resetDebugLoggerConfig());

function withoutBrief(messages: readonly ChatMessage[]) {
  return messages.filter((message) => !isCapabilityBriefMessage(message));
}

test("projects one shared complete catalog without replacing the exact Planner assignment or source", () => {
  const full = createPlannerBriefFixture();
  const partial = createPlannerBriefFixture({ metadataAvailable: false });
  const brief = full.input.context.messages.filter(isCapabilityBriefMessage);
  expect(full.input.capabilityBrief.level).toBe("descriptions");
  expect(brief).toHaveLength(1);
  expect(brief[0]!.role).toBe("system");
  for (const entry of full.entries) {
    expect(brief[0]!.content).toContain(JSON.stringify(entry.summary));
    expect(brief[0]!.content).toContain(entry.operationId);
  }
  expect(withoutBrief(full.input.context.messages)).toEqual(
    withoutBrief(partial.input.context.messages),
  );
  expect(full.input.format).toEqual(partial.input.format);
  const serialized = JSON.stringify(full.input.context.messages);
  expect(serialized.match(/EXACT_TARGET/g)).toHaveLength(1);
  expect(serialized).not.toContain("UNRELATED_HISTORY");
  expect(serialized).not.toContain(
    "runtime_planner_worker_capability_catalog_v1",
  );
  const assignment = JSON.parse(full.input.context.messages.at(-1)!.content);
  expect(assignment).toMatchObject({
    kind: "runtime_planner_assignment",
    objective: full.inputOptions.call.objective,
    workingDirectory: "project",
  });
  expect(assignment).not.toHaveProperty("capabilities");
});

test("disabled operations stay absent and legal groups remain bound to the available registry", () => {
  const fixture = createPlannerBriefFixture({
    entries: PLANNER_BRIEF_ENTRIES.slice(0, 2),
  });
  const brief = fixture.input.context.messages.find(isCapabilityBriefMessage)!;
  expect(brief.content).not.toContain(PLANNER_BRIEF_ENTRIES[2]!.operationId);
  expect(fixture.input.availableWorkerCapabilityCatalog).toEqual([
    { groupId: "read", memberCount: 2, effects: ["observation"] },
  ]);
  const decision = (groups: string[]) =>
    JSON.stringify({
      decision: {
        action: "invoke_role",
        roleId: "worker",
        objective: "Inspect the requested artifact.",
        workerCapabilityScope: { catalogGroupIds: groups },
      },
    });
  const options = {
    availableChildRoleIds: fixture.input.availableChildRoleIds,
    availableWorkerCapabilityCatalog:
      fixture.input.availableWorkerCapabilityCatalog,
    inheritedWorkingDirectory: "project",
  };
  expect(parsePlannerDecisionOutput(decision(["read"]), options)).toMatchObject(
    { ok: true },
  );
  expect(
    parsePlannerDecisionOutput(decision(["disabled"]), options),
  ).toMatchObject({ ok: false });
});

test.each([{ entries: [] }, { workerAvailable: false }])(
  "omits availability when there are no offered Worker operations: %j",
  (options) => {
    const fixture = createPlannerBriefFixture(options);
    expect(fixture.input.context.messages.some(isCapabilityBriefMessage)).toBe(
      false,
    );
    expect(fixture.input.availableWorkerCapabilityCatalog).toEqual([]);
  },
);

test("missing registry metadata uses complete group fallback instead of invented operation identities", () => {
  const fixture = createPlannerBriefFixture({ metadataAvailable: false });
  expect(fixture.input.capabilityBrief.level).toBe("groups");
  const brief = fixture.input.context.messages.find(isCapabilityBriefMessage)!;
  expect(brief.content).toContain("memberCount=6");
  expect(brief.content).not.toContain(fixture.entries[0]!.operationId);
});

test("tight budgets reduce only optional detail while retaining the full allowed group schema", () => {
  const full = createPlannerBriefFixture();
  const tight = createPlannerBriefFixture({
    contextWindowTokens: Math.ceil(
      (full.input.context.budget.estimatedInputTokens - 500) / 0.7,
    ),
  });
  expect(tight.input.capabilityBrief.level).not.toBe("descriptions");
  expect(tight.input.context.budget.estimatedInputTokens).toBeLessThan(
    tight.input.context.budget.compactionTriggerInputTokens,
  );
  expect(withoutBrief(tight.input.context.messages)).toEqual(
    withoutBrief(full.input.context.messages),
  );
  expect(tight.input.format).toEqual(full.input.format);
});

test("root steering does not enter bounded Planner context or consume its catalog budget", () => {
  const fixture = createPlannerBriefFixture();
  fixture.steering.append({
    steerId: "root-update",
    text: "UNRELATED_ROOT_STEERING ".repeat(1000),
  });
  const current = buildPlannerDecisionInput(
    fixture.request,
    fixture.inputOptions,
  );
  expect(current.context.messages).toEqual(fixture.input.context.messages);
  expect(current.capabilityBrief).toEqual(fixture.input.capabilityBrief);
});
