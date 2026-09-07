import { afterEach, expect, test, vi } from "vitest";
import { createLocalRuntimeApplication } from "../local-application.js";
import { RuntimeEnvironmentRegistry } from "../../web-ui/local-runtime/environment-registry.js";

vi.mock("../local-application.js", () => ({
  createLocalRuntimeApplication: vi.fn(),
}));
vi.mock("../config.js", () => ({
  loadRuntimeConfig: vi.fn(({ profileId }: { profileId: string }) => ({
    runtimeId: profileId,
  })),
}));
afterEach(() => vi.restoreAllMocks());

test("shutdown fences late environment resolution before its existing facade finishes", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const stop = vi.fn(() => pending);
  const application = { start: vi.fn(async () => {}), stop };
  vi.mocked(createLocalRuntimeApplication).mockReturnValue(
    application as unknown as ReturnType<typeof createLocalRuntimeApplication>,
  );
  const registry = new RuntimeEnvironmentRegistry({
    defaultEnvironmentId: "prod",
  });
  vi.spyOn(registry, "setupRequirement").mockReturnValue(null);
  registry.get("prod");
  const closing = registry.stop();
  const repeated = registry.stop();
  try {
    expect(() => registry.get("late")).toThrow("web_runtime_stopped");
    expect(() => registry.get("prod")).toThrow("web_runtime_stopped");
    await expect(registry.start(["late"])).rejects.toThrow(
      "web_runtime_stopped",
    );
    expect(createLocalRuntimeApplication).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
  } finally {
    release();
    await Promise.all([closing, repeated]);
  }
});
