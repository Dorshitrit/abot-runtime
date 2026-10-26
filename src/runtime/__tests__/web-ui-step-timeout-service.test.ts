import { readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
  type Mock,
} from "vitest";
import {
  StepTimeoutService,
  type StepTimeoutServiceOptions,
} from "../../web-ui/local-runtime/step-timeout-service.js";
import type { SessionRequestReplay } from "../../sessions/types.js";
import { toClientReplayEvent } from "../../sessions/record/projection.js";
import {
  createModelSetupFixture,
  type ModelSetupFixture,
} from "./support/model-setup-fixture.js";

let fixture: ModelSetupFixture;
let service: StepTimeoutService;
let replay: SessionRequestReplay;
let event: Record<string, unknown>;
const reference = {
  environment: "dev",
  sessionId: "session",
  requestId: "request",
  invocationId: "invocation",
};
const slot = "toolPayload.raw";
const step = "tool_payload.raw";
let activeEvents: Record<string, unknown>[] | undefined;
type ActiveReplay = NonNullable<
  StepTimeoutServiceOptions["activeReplayForSession"]
>;
let activeReplay: Mock<ActiveReplay>;

beforeEach(async () => {
  fixture = await createModelSetupFixture(
    ".codex/artifacts/timeout-suggestion-20261024/service",
  );
  const profile = await fixture.readModelProfile("default");
  profile.calibration[slot] = {
    timeoutMs: 300_000,
    format: { type: "text" },
    instructions: ["Keep existing instructions."],
  };
  await fixture.writeModelProfile("default", profile);
  event = {
    name: "model.step.timed_out",
    requestId: "request",
    invocationId: "invocation",
    modelStep: step,
    configurationProfileId: "default",
    calibrationSlotId: slot,
    profileId: "default",
    provider: "ollama",
    model: "fixture-chat",
    timeoutMs: 300_000,
    configuredTimeoutMs: 90_000,
    timeoutSource: "model_calibration",
  };
  replay = {
    requestId: "request",
    sessionId: "session",
    events: [event],
    finalState: null,
  };
  activeEvents = undefined;
  activeReplay = vi.fn<ActiveReplay>((requestId, sessionId, environment) =>
    requestId === reference.requestId &&
    sessionId === reference.sessionId &&
    environment === reference.environment
      ? activeEvents
      : undefined,
  );
  service = new StepTimeoutService({
    rootDir: fixture.rootDir,
    configPath: fixture.configPath,
    getEnvironment: () => ({
      services: { sessions: { getRequestReplayById: async () => replay } },
    }),
    activeReplayForSession: activeReplay,
  });
});
afterEach(async () => fixture.cleanup());

async function inspect() {
  return (await service.inspect(reference)).suggestion;
}
async function increase() {
  const suggestion = await inspect();
  return service.increase({
    ...reference,
    expectedRevision: suggestion.revision,
  });
}
async function editRunner(edit: (runner: any) => void) {
  const config = await fixture.readConfig();
  const path = resolve(
    dirname(fixture.configPath),
    config.requestRunner.configRef,
  );
  const runner = JSON.parse(await readFile(path, "utf8"));
  edit(runner);
  await writeFile(path, JSON.stringify(runner));
}

describe("observed model step timeout configuration", () => {
  test("accepts the canonical persisted replay projection", async () => {
    replay.events = [
      toClientReplayEvent({
        requestId: "request",
        type: "event",
        seqNo: 7,
        timestamp: "2026-10-24T00:00:00.000Z",
        payload: event,
      }),
    ];
    expect((await inspect()).canIncrease).toBe(true);
  });

  test("runner step mapping overrides conflicting platform defaults", async () => {
    const config = await fixture.readConfig();
    config.models.defaults = {
      ...config.models.defaults,
      steps: { [step]: "other.slot" },
    };
    await fixture.writeConfig(config);
    expect((await inspect()).canIncrease).toBe(true);
    expect(await increase()).toMatchObject({ status: "saved" });
    expect(
      (await fixture.readModelProfile("default")).calibration[slot].timeoutMs,
    ).toBe(600_000);
  });

  test("compares the actual provider type when a named connection owns it", async () => {
    const config = await fixture.readConfig();
    config.models.providers.named = {
      type: "ollama",
      baseUrl: "http://127.0.0.1:11434",
    };
    await fixture.writeConfig(config);
    const profile = await fixture.readModelProfile("default");
    profile.provider = "named";
    await fixture.writeModelProfile("default", profile);
    expect((await inspect()).canIncrease).toBe(true);
    event.provider = "openai";
    expect(await inspect()).toMatchObject({
      canIncrease: false,
      reason: "model_binding_changed",
    });
  });

  test("saves only the selected profile slot, preserving fields and runner defaults", async () => {
    const config = await fixture.readConfig();
    config.models.profiles.other = {
      ...(await fixture.readModelProfile("default")),
      model: "other-model",
    };
    await fixture.writeConfig(config);
    const before = await fixture.readModelProfile("default");
    const runnerPath = resolve(
      dirname(fixture.configPath),
      config.requestRunner.configRef,
    );
    const runnerBytes = await readFile(runnerPath, "utf8");
    const suggestion = await inspect();
    expect(suggestion).toMatchObject({
      canIncrease: true,
      configurationProfileId: "default",
      calibrationSlotId: slot,
      timeoutMs: 300_000,
      proposedTimeoutMs: 600_000,
    });
    expect(
      await service.increase({
        ...reference,
        expectedRevision: suggestion.revision,
      }),
    ).toEqual({ status: "saved", timeoutMs: 600_000, restartRequired: true });
    before.calibration[slot].timeoutMs = 600_000;
    expect(await fixture.readModelProfile("default")).toEqual(before);
    expect(await fixture.readConfig()).toEqual(config);
    expect(await readFile(runnerPath, "utf8")).toBe(runnerBytes);
  });

  test("adds an override when the observed timeout was inherited from the runner", async () => {
    const profile = await fixture.readModelProfile("default");
    delete profile.calibration[slot].timeoutMs;
    await fixture.writeModelProfile("default", profile);
    Object.assign(event, { timeoutMs: 90_000, timeoutSource: "runner" });
    expect(await increase()).toMatchObject({
      status: "saved",
      timeoutMs: 180_000,
    });
    expect(
      (await fixture.readModelProfile("default")).calibration[slot],
    ).toEqual({ ...profile.calibration[slot], timeoutMs: 180_000 });
  });

  test("saves an inline profile without changing its siblings", async () => {
    const config = await fixture.readConfig();
    const profile = await fixture.readModelProfile("default");
    config.models.profiles.default = profile;
    config.models.profiles.sibling = { ...profile, model: "sibling" };
    await fixture.writeConfig(config);
    expect(await increase()).toMatchObject({ status: "saved" });
    const after = await fixture.readConfig();
    expect(after.models.profiles.sibling).toEqual(
      config.models.profiles.sibling,
    );
    expect(after.models.profiles.default.calibration[slot].timeoutMs).toBe(
      600_000,
    );
  });

  test("uses the calibration owner when the actual model is redirected", async () => {
    const config = await fixture.readConfig();
    config.models.profiles.other = {
      ...(await fixture.readModelProfile("default")),
      model: "other-model",
    };
    await fixture.writeConfig(config);
    const profile = await fixture.readModelProfile("default");
    profile.calibration[slot].profileId = "other";
    await fixture.writeModelProfile("default", profile);
    Object.assign(event, { profileId: "other", model: "other-model" });
    expect(await increase()).toMatchObject({ status: "saved" });
    expect(
      (await fixture.readModelProfile("default")).calibration[slot].timeoutMs,
    ).toBe(600_000);
    expect(
      (await fixture.readConfig()).models.profiles.other.calibration[slot]
        .timeoutMs,
    ).toBe(300_000);
  });

  test("duplicate and concurrent saves cannot multiply the same observed timeout twice", async () => {
    const suggestion = await inspect();
    const input = { ...reference, expectedRevision: suggestion.revision };
    const results = await Promise.all([
      service.increase(input),
      service.increase(input),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([
      "already_saved",
      "saved",
    ]);
    expect(await service.increase(input)).toMatchObject({
      status: "already_saved",
    });
    expect(
      (await fixture.readModelProfile("default")).calibration[slot].timeoutMs,
    ).toBe(600_000);
    expect(await inspect()).toMatchObject({
      canIncrease: false,
      reason: "already_saved",
    });
  });

  test("rejects unrelated changes between inspection and save", async () => {
    const suggestion = await inspect();
    const config = await fixture.readConfig();
    config.webUi = { pageSize: 42 };
    await fixture.writeConfig(config);
    await expect(
      service.increase({ ...reference, expectedRevision: suggestion.revision }),
    ).rejects.toMatchObject({ code: "config_changed" });
    expect(
      (await fixture.readModelProfile("default")).calibration[slot].timeoutMs,
    ).toBe(300_000);
  });

  test.each(["model", "runner", "slot", "timeout"])(
    "rejects changed %s binding",
    async (kind) => {
      const suggestion = await inspect();
      const profile = await fixture.readModelProfile("default");
      if (kind === "model") profile.model = "replacement";
      if (kind === "timeout") profile.calibration[slot].timeoutMs = 400_000;
      await fixture.writeModelProfile("default", profile);
      if (kind === "runner")
        await editRunner((runner) => {
          runner.steps[step] = { timeoutMs: 120_000 };
        });
      if (kind === "slot")
        await editRunner((runner) => {
          runner.models.defaults.steps[step] = "different.slot";
        });
      expect((await inspect()).canIncrease).toBe(false);
      await expect(
        service.increase({
          ...reference,
          expectedRevision: suggestion.revision,
        }),
      ).rejects.toMatchObject({ statusCode: 409 });
    },
  );

  test("shared slot and direct profile selection require manual configuration", async () => {
    await editRunner((runner) => {
      runner.models.defaults.steps["execution.decision"] = slot;
    });
    expect(await inspect()).toMatchObject({
      canIncrease: false,
      reason: "shared_calibration_slot",
    });
    delete event.calibrationSlotId;
    expect(await inspect()).toMatchObject({
      canIncrease: false,
      reason: "no_profile_step_target",
    });
  });

  test.each([false, true])(
    "shared referenced files are manual, including symlink aliases=%s",
    async (aliasViaSymlink) => {
      const config = await fixture.readConfig();
      const referencePath = config.models.profiles.default.configRef;
      config.models.profiles.alias = { configRef: referencePath };
      if (aliasViaSymlink) {
        const alias = resolve(
          dirname(fixture.configPath),
          "models/alias.config.json",
        );
        await symlink(
          resolve(dirname(fixture.configPath), referencePath),
          alias,
        );
        config.models.profiles.alias.configRef = "./models/alias.config.json";
      }
      await fixture.writeConfig(config);
      expect(await inspect()).toMatchObject({
        canIncrease: false,
        reason: "shared_profile_file",
      });
    },
  );

  test("inline overrides on a referenced profile cannot be silently ignored", async () => {
    const config = await fixture.readConfig();
    config.models.profiles.default.calibration = {
      [slot]: { timeoutMs: 300_000 },
    };
    await fixture.writeConfig(config);
    expect(await inspect()).toMatchObject({
      canIncrease: false,
      reason: "profile_inline_overrides",
    });
  });

  test("uses exact scoped live events before persistence catches up", async () => {
    activeEvents = [event];
    replay.events = [];
    expect((await inspect()).canIncrease).toBe(true);
    expect(activeReplay).toHaveBeenCalledWith("request", "session", "dev");
    await expect(
      service.inspect({ ...reference, sessionId: "other" }),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      service.inspect({ ...reference, environment: "other" }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  test.each(["session", "request", "invocation", "name"])(
    "rejects events with the wrong %s identity",
    async (kind) => {
      if (kind === "session") replay.sessionId = "other";
      if (kind === "request") replay.requestId = "other";
      if (kind === "invocation") event.invocationId = "other";
      if (kind === "name") event.name = "model.step.failed";
      await expect(inspect()).rejects.toMatchObject({ statusCode: 404 });
    },
  );

  test("rejects client-selected profile, timeout, and missing revision", async () => {
    await expect(
      service.inspect({ ...reference, profileId: "other" }),
    ).rejects.toMatchObject({ code: "invalid_timeout_reference" });
    await expect(
      service.increase({ ...reference, timeoutMs: 600_000 }),
    ).rejects.toMatchObject({ code: "invalid_timeout_reference" });
    await expect(service.increase(reference)).rejects.toMatchObject({
      statusCode: 428,
    });
  });
});
