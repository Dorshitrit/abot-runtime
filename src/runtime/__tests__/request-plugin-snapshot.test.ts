import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import { disposeCompositionFixtures } from "./support/runtime-composition-fixture.js";
import {
  createRequestPluginSnapshotFixture,
  deferred,
} from "./support/request-plugin-snapshot-fixture.js";
import { SNAPSHOT_FINAL } from "./support/request-plugin-model-script.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(async () => {
  vi.restoreAllMocks();
  await disposeCompositionFixtures();
  resetDebugLoggerConfig();
});
const policies = ["supervisor-worker-v1", "execution-agent-v1"] as const;

test.each(policies)(
  "%s awaits one plugin snapshot before any model step and keeps it through execution",
  async (policy) => {
    const fixture = await createRequestPluginSnapshotFixture();
    const release = deferred();
    fixture.pausePreparation(release.promise);
    const observed = vi.fn();
    const pending = fixture.run(policy, {
      beforeModel(input, index) {
        observed(input);
        if (index === 1) fixture.setDestination("private-destination-beta");
      },
    });
    await fixture.preparationStarted.promise;
    expect(observed).not.toHaveBeenCalled();
    expect(fixture.executed).not.toHaveBeenCalled();
    release.resolve();
    const result = await pending;
    expect(result.events.filter(({ type }) => type === "failed")).toEqual([]);
    expect(result.events).toContainEqual(
      expect.objectContaining({ type: "completed", output: SNAPSHOT_FINAL }),
    );
    expect(fixture.prepare).toHaveBeenCalledOnce();
    expect(fixture.executed).toHaveBeenCalledExactlyOnceWith(
      "private-destination-alpha",
      "attached",
    );
    expect(result.session?.messages.at(-1)?.content).toBe(SNAPSHOT_FINAL);
    expect(result.model.invokeRaw).not.toHaveBeenCalled();
  },
);

test.each(policies)(
  "%s narrows disconnected capabilities and refreshes the next request without changing local execution",
  async (policy) => {
    const fixture = await createRequestPluginSnapshotFixture();
    fixture.setDestination(undefined);
    const local = await fixture.run(policy, { channel: "local" });
    expect(local.events.filter(({ type }) => type === "failed")).toEqual([]);
    expect(local.events).toContainEqual(
      expect.objectContaining({ type: "completed", output: SNAPSHOT_FINAL }),
    );
    const localInputs = JSON.stringify(
      local.model.invoke.mock.calls.map(([input]) => ({
        messages: input.messages,
        format: input.format,
      })),
    );
    expect(localInputs).not.toContain("fixture_attached");
    expect(localInputs).not.toContain('"attached"');
    expect(fixture.executed).toHaveBeenNthCalledWith(
      1,
      "fixture-local",
      "local",
    );
    fixture.setDestination("private-destination-beta");
    const connected = await fixture.run(policy);
    expect(connected.events.filter(({ type }) => type === "failed")).toEqual(
      [],
    );
    expect(connected.events).toContainEqual(
      expect.objectContaining({ type: "completed", output: SNAPSHOT_FINAL }),
    );
    expect(JSON.stringify(connected.model.invoke.mock.calls)).toContain(
      "fixture_attached",
    );
    expect(fixture.prepare).toHaveBeenCalledTimes(2);
    expect(fixture.executed).toHaveBeenNthCalledWith(
      2,
      "private-destination-beta",
      "attached",
    );
  },
);

test.each(policies)(
  "%s leaves an unrelated selected module unchanged and never prepares excluded modules",
  async (policy) => {
    const fixture = await createRequestPluginSnapshotFixture(true);
    const result = await fixture.run(policy, {
      capabilityId: "fixture_basic",
      channel: "local",
    });
    expect(result.events.filter(({ type }) => type === "failed")).toEqual([]);
    expect(result.events).toContainEqual(
      expect.objectContaining({ type: "completed", output: SNAPSHOT_FINAL }),
    );
    expect(fixture.prepare).not.toHaveBeenCalled();
    expect(fixture.executed).toHaveBeenCalledExactlyOnceWith(
      "fixture-basic",
      "local",
    );
  },
);

test("overlapping Worker and Execution Agent requests keep separate prepared destinations", async () => {
  const fixture = await createRequestPluginSnapshotFixture();
  const firstEntered = deferred();
  const releaseFirst = deferred();
  const first = fixture.run("supervisor-worker-v1", {
    async beforeModel(_input, index) {
      if (index !== 1) return;
      firstEntered.resolve();
      await releaseFirst.promise;
    },
  });
  await firstEntered.promise;
  fixture.setDestination("private-destination-beta");
  const second = await fixture.run("execution-agent-v1");
  releaseFirst.resolve();
  const firstResult = await first;
  expect(fixture.prepare).toHaveBeenCalledTimes(2);
  expect(fixture.executed.mock.calls).toEqual([
    ["private-destination-beta", "attached"],
    ["private-destination-alpha", "attached"],
  ]);
  for (const result of [firstResult, second]) {
    expect(result.events.filter(({ type }) => type === "failed")).toEqual([]);
    expect(result.session?.messages.at(-1)?.content).toBe(SNAPSHOT_FINAL);
  }
});
