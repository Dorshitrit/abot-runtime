import { afterEach, describe, expect, it } from "vitest";
import { createLocalRuntimeApplication } from "../index.js";
import type { RuntimeConfig } from "../ports.js";
import { createEnvironmentPathsFixture } from "./support/environment-paths-fixture.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function managed(config: RuntimeConfig) {
  const application = createLocalRuntimeApplication(config);
  cleanups.push(() => application.stop().catch(() => undefined));
  return application;
}

const jobInput = {
  sessionId: "same-session",
  title: "Future request",
  prompt: "This future request must not execute in the test.",
  modelProfileId: "test-model",
  agentMode: "deep" as const,
  timeZone: "Asia/Jerusalem",
  schedule: { kind: "timer" as const, delayMs: 3_600_000 },
};

describe("public managed environments sharing a base directory", () => {
  it.each(["base", "env"])(
    "starts separate owners, persists isolated Jobs and sessions, and attaches matching clients with %s paths",
    async (kind) => {
      const fixture = await createEnvironmentPathsFixture({
        paths: { runtimeDir: "shared-base" },
        profiles: { alpha: {}, beta: {} },
      });
      cleanups.push(fixture.dispose);
      const env = kind === "env" ? { LLM_RUNTIME_DIR: "env-base" } : {};
      const alphaConfig = fixture.load("alpha", env);
      const alpha = managed(alphaConfig);
      const beta = managed(fixture.load("beta", env));
      await Promise.all([alpha.start(), beta.start()]);
      expect(alpha.getOwnership()).toBe("owner");
      expect(beta.getOwnership()).toBe("owner");
      await alpha.services.sessions.appendMessage(
        "same-session",
        "user",
        "Only alpha",
      );
      await beta.services.sessions.appendMessage(
        "same-session",
        "user",
        "Only beta",
      );
      const alphaJob = await alpha.services.scheduler.create(jobInput);
      const betaJob = await beta.services.scheduler.create(jobInput);
      expect(await alpha.services.scheduler.list()).toEqual([alphaJob]);
      expect(await beta.services.scheduler.list()).toEqual([betaJob]);
      expect(alphaJob.environmentId).toBe("alpha");
      expect(betaJob.environmentId).toBe("beta");
      expect(
        (await alpha.services.sessions.getSessionById(
          "same-session",
        ))!.messages.map((message) => message.content),
      ).toEqual(["Only alpha"]);
      expect(
        (await beta.services.sessions.getSessionById(
          "same-session",
        ))!.messages.map((message) => message.content),
      ).toEqual(["Only beta"]);

      const attachment = await alpha.services.attachments.saveAttachment({
        sessionId: "same-session",
        requestId: "same-request",
        kind: "image",
        mimeType: "image/png",
        bytes: Buffer.from("fixture-image"),
      });
      await expect(
        beta.services.attachments.resolveAttachment(attachment),
      ).rejects.toMatchObject({ code: "ENOENT" });
      const attached = managed(fixture.load("alpha", env));
      await attached.start();
      expect(attached.getOwnership()).toBe("client");
      expect(await attached.services.scheduler.list()).toEqual([alphaJob]);
      await attached.services.scheduler.cancel(alphaJob.id);
      expect((await alpha.services.scheduler.get(alphaJob.id))!.state).toBe(
        "cancelled",
      );
      expect((await beta.services.scheduler.get(betaJob.id))!.state).toBe(
        "active",
      );

      const changed = managed({
        ...alphaConfig,
        modelGatewayUrl: "http://127.0.0.1:2",
      });
      await expect(changed.start()).rejects.toThrow(
        "local_runtime_identity_mismatch",
      );
      await attached.stop();
      await alpha.stop();
      const reopened = managed(fixture.load("alpha", env));
      await reopened.start();
      expect(
        (await reopened.services.scheduler.list()).map((job) => job.id),
      ).toEqual([alphaJob.id]);
      expect(await reopened.services.scheduler.listRuns()).toEqual([]);
      expect(await beta.services.scheduler.listRuns()).toEqual([]);
    },
  );

  it("preserves existing Jobs in place after explicit assignment and starts an isolated inherited sibling", async () => {
    const fixture = await createEnvironmentPathsFixture({
      paths: { runtimeDir: "existing-state" },
    });
    cleanups.push(fixture.dispose);
    const originalConfig = fixture.load();
    const original = managed(originalConfig);
    await original.start();
    await original.services.sessions.appendMessage(
      "same-session",
      "user",
      "Existing conversation",
    );
    const originalJob = await original.services.scheduler.create(jobInput);
    await original.stop();

    fixture.source.environment = {
      paths: { runtimeDir: "existing-state" },
      profiles: { prod: {}, beta: {} },
    };
    await fixture.save();
    expect(() => fixture.load("prod")).toThrow(
      "runtime_environment_storage_assignment_required",
    );
    expect(() => fixture.load("beta")).toThrow(
      "runtime_environment_storage_assignment_required",
    );

    fixture.source.environment = {
      paths: { runtimeDir: "existing-state" },
      profiles: { prod: { paths: { runtimeDir: "existing-state" } }, beta: {} },
    };
    await fixture.save();
    const assignedConfig = fixture.load("prod");
    expect(assignedConfig.paths).toEqual(originalConfig.paths);
    const assigned = managed(assignedConfig);
    const beta = managed(fixture.load("beta"));
    await Promise.all([assigned.start(), beta.start()]);
    expect(await assigned.services.scheduler.list()).toEqual([originalJob]);
    expect(await beta.services.scheduler.list()).toEqual([]);
    expect(
      await beta.services.sessions.getSessionById("same-session"),
    ).toBeNull();
    expect(
      (await assigned.services.sessions.getSessionById("same-session"))!
        .messages[0]!.content,
    ).toBe("Existing conversation");
  });
});
