import { expect, test } from "vitest";
import { RuntimeEnvironmentRegistry } from "../../web-ui/local-runtime/environment-registry.js";
import type {
  RuntimeEnvironment,
  LocalRuntimeBackendOptions,
} from "../../web-ui/local-runtime/contracts.js";

test("removal readiness requires disabled plugins in every loaded owned environment", () => {
  const registry = new RuntimeEnvironmentRegistry({
    defaultEnvironmentId: "dev",
  } as LocalRuntimeBackendOptions);
  const environments = (
    registry as unknown as { environments: Map<string, RuntimeEnvironment> }
  ).environments;
  const owner = (deny: string[], ownership = "owner") =>
    ({
      services: { config: { plugins: { deny } } },
      getOwnership: () => ownership,
    }) as unknown as RuntimeEnvironment;
  expect(() => registry.requirePluginInactive("community", ["ping"])).toThrow(
    "Apply Runtime",
  );
  environments.set("dev", owner(["community"]));
  expect(() =>
    registry.requirePluginInactive("community", ["ping"]),
  ).not.toThrow();
  environments.set("production", owner([]));
  expect(() => registry.requirePluginInactive("community", ["ping"])).toThrow(
    "still available",
  );
  environments.set("production", owner(["community"], "client"));
  expect(() => registry.requirePluginInactive("community", ["ping"])).toThrow(
    "still available",
  );
  environments.set("production", owner(["community"]));
  expect(() =>
    registry.requirePluginInactive("community", ["ping"]),
  ).not.toThrow();
});
