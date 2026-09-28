import { describe, expect, test } from "vitest";
import {
  readWorkspaceRoute,
  workspaceRouteUrl,
} from "../../web-ui/app/lib/workspace-route.js";

describe("Web UI workspace addresses", () => {
  test.each(["home", "chat", "schedules", "models", "plugins", "config", "learning", "memory"])(
    "round-trips %s with its scoped identifiers",
    (workspace) => {
      const address = workspaceRouteUrl({
        workspace,
        environment: "dev / one",
        session: "session/a ? b",
      });
      const route = readWorkspaceRoute(
        new URL(address, "http://localhost:5177"),
      );
      expect(route).toMatchObject({
        workspace,
        environment: "dev / one",
        session: workspace === "chat" ? "session/a ? b" : "",
      });
    },
  );

  test("drops unrelated identifiers from standalone pages and keeps saved schedule identity", () => {
    expect(
      workspaceRouteUrl({
        workspace: "plugins",
        category: "operations",
        tab: "logs",
        job: "ignore",
      }),
    ).toBe("/plugins");
    expect(
      workspaceRouteUrl({
        workspace: "schedules",
        category: "ignore",
        tab: "ignore",
        job: "job/1",
        editor: "ignore",
      }),
    ).toBe("/schedules?job=job%2F1");
  });

  test.each([
    ["", "models", "models", "/models"],
    ["models", "models", "models", "/models"],
    ["plugins", "plugins", "plugins", "/plugins"],
    ["computer", "home", "", "/home"],
    ["memory", "memory", "", "/memory"],
    ["operations", "config", "operations", "/system"],
    ["pipeline", "models", "models", "/models"],
    ["advanced", "models", "models", "/models"],
  ])("canonicalizes legacy category %s while preserving environment", (legacy, workspace, category, path) => {
    const route = readWorkspaceRoute(new URL(
      `http://localhost/config?environment=dev&category=${legacy}&tab=health`,
    ));
    expect(route).toMatchObject({ workspace, environment: "dev", category });
    const tab = workspace === "config" ? "&tab=health" : "";
    expect(workspaceRouteUrl({ ...route })).toBe(`${path}?environment=dev${tab}`);
  });

  test("round-trips System together with its active inner view", () => {
    const address = workspaceRouteUrl({
      workspace: "config", environment: "dev", category: "operations", tab: "health",
    });
    expect(address).toBe("/system?environment=dev&tab=health");
    expect(readWorkspaceRoute(new URL(address, "http://localhost"))).toMatchObject({
      workspace: "config", environment: "dev", category: "operations", tab: "health",
    });
  });

  test("uses Home for a root or unknown path without accepting oversized identifiers", () => {
    expect(readWorkspaceRoute(new URL("http://localhost/"))).toMatchObject({
      workspace: "home",
    });
    expect(
      readWorkspaceRoute(
        new URL("http://localhost/unknown?session=" + "x".repeat(513)),
      ),
    ).toMatchObject({ workspace: "home", session: "" });
  });
});
